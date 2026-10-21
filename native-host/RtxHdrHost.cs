// RTX HDR Switch 本地组件（native messaging host）：通过 NVIDIA App 自带的 nvcpl.dll
// 读写全局 RTX 视频增强设置（RTX Video HDR / 超分辨率），与 NVIDIA App → 系统 → 视频 同步；
// 另外只读 Windows 显示器信息（SDR 内容亮度、HDR 是否开启），以及「只关 HDR、保留超分」用的 HDR 租约。
// C# 5：用 Windows 自带的 %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe 编译（见 build.cmd）。
// 协议：Chrome native messaging，4 字节小端长度 + UTF-8 JSON（无 BOM）；stdout 只走协议，日志只写 stderr。
// 命令：hello / get / set / display / hdrLease，见 README.md。
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

[assembly: AssemblyTitle("rtx_hdr_host")]
[assembly: AssemblyDescription("RTX HDR Switch native host (NVIDIA RTX Video settings)")]
[assembly: AssemblyProduct("RTX HDR Switch")]
[assembly: AssemblyVersion("1.2.1.0")]
[assembly: AssemblyFileVersion("1.2.1.0")]

// 返回给扩展的错误：{ code, message, ...额外字段 }
sealed class HostError : Exception
{
    public readonly Dictionary<string, object> Info = new Dictionary<string, object>();
    public HostError(string code, string message) : base(message)
    {
        Info["code"] = code;
        Info["message"] = message;
    }
    public HostError With(string key, object value) { Info[key] = value; return this; }
}

// nvcpl.dll 的最小封装（未公开 API，参数类型经反汇编与实测确认）
static class Nv
{
    public const uint VsrInfo = 0x315;     // 20 字节：+0 isSupported, +4 value(0 关, 1..4 手动, 5 自动), +8 status
    public const uint VsrLevel = 0x316;    // 4 字节：当前实际生效的超分档位 0..4
    public const uint VsrValue = 0x317;    // 4 字节：写超分模式
    public const uint HdrInfo = 0x318;     // 48 字节 VIDEO_HDR_INFO
    public const uint HdrActive = 0x319;   // 4 字节：HDR 此刻是否在工作
    public const uint VsrPriority = 0x32F; // 4 字节：自动模式的 GPU 优先级 0 低 / 1 中 / 2 高
    public const uint VideoFlags = 0x330;  // 4 字节：0x1 HDR 指示器, 0x100 超分指示器, 0x4/0x400 无界面（保留）
    public const int HdrSize = 48, VsrSize = 20;

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    delegate int InitFn(IntPtr a, IntPtr b);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    delegate int CloseFn();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    delegate int SettingFn(int scope, ref ulong ctx, uint id, [In, Out] byte[] buf, ulong size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr LoadLibraryExW(string path, IntPtr file, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, ExactSpelling = true, SetLastError = true)]
    static extern IntPtr GetProcAddress(IntPtr module, string name);

    const uint LOAD_WITH_ALTERED_SEARCH_PATH = 0x00000008; // 让 nvcpl.dll 从自己的目录解析依赖 DLL

    public static string DllPath;          // 实际加载的 nvcpl.dll；null = 未加载
    static string loadProblem;
    static bool inited;
    static InitFn init;
    static CloseFn close;
    static SettingFn getSetting, setSetting;

    public static List<string> Candidates()
    {
        var list = new List<string>();
        string pf = Environment.GetEnvironmentVariable("ProgramW6432");
        if (string.IsNullOrEmpty(pf)) pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        if (!string.IsNullOrEmpty(pf)) list.Add(Path.Combine(pf, @"NVIDIA Corporation\NVIDIA App\NvCpl\nvcpl.dll"));
        list.Add(Path.Combine(Environment.SystemDirectory, "nvcpl.dll")); // 驱动自带的副本
        return list;
    }

    // 先试 NVIDIA App 的副本，再试 System32；成功后不再重复加载
    public static bool TryLoad()
    {
        if (DllPath != null) return true;
        var problems = new List<string>();
        foreach (string path in Candidates())
        {
            if (!File.Exists(path)) { problems.Add(path + ": not found"); continue; }
            IntPtr h = LoadLibraryExW(path, IntPtr.Zero, LOAD_WITH_ALTERED_SEARCH_PATH);
            if (h == IntPtr.Zero) { problems.Add(path + ": LoadLibraryEx error " + Marshal.GetLastWin32Error()); continue; }
            IntPtr pInit = GetProcAddress(h, "NvCplApiInit");
            IntPtr pClose = GetProcAddress(h, "NvCplApiClose");
            IntPtr pGet = GetProcAddress(h, "NvCplApiGetSetting");
            IntPtr pSet = GetProcAddress(h, "NvCplApiSetSetting");
            if (pInit == IntPtr.Zero || pClose == IntPtr.Zero || pGet == IntPtr.Zero || pSet == IntPtr.Zero)
            {
                problems.Add(path + ": NvCplApi exports missing");
                continue;
            }
            init = (InitFn)Marshal.GetDelegateForFunctionPointer(pInit, typeof(InitFn));
            close = (CloseFn)Marshal.GetDelegateForFunctionPointer(pClose, typeof(CloseFn));
            getSetting = (SettingFn)Marshal.GetDelegateForFunctionPointer(pGet, typeof(SettingFn));
            setSetting = (SettingFn)Marshal.GetDelegateForFunctionPointer(pSet, typeof(SettingFn));
            DllPath = path;
            Host.Log("loaded " + path);
            return true;
        }
        loadProblem = string.Join("; ", problems.ToArray());
        return false;
    }

    // 进程内只 Init 一次（connectNative 时一个进程服务整个弹窗会话）；失败下次再试
    public static void EnsureReady()
    {
        if (!TryLoad())
            throw new HostError("no-dll", "nvcpl.dll not found (is NVIDIA App installed?) " + loadProblem);
        if (inited) return;
        int rc = init(IntPtr.Zero, IntPtr.Zero);
        if (rc != 0) throw new HostError("init", "NvCplApiInit failed").With("rc", rc);
        inited = true;
    }

    public static void Shutdown()
    {
        if (!inited) return;
        inited = false;
        try { close(); } catch (Exception e) { Host.Log("NvCplApiClose: " + e.Message); }
    }

    public static int TryGet(uint id, int size, out byte[] buf)
    {
        buf = new byte[size];
        ulong ctx = 0; // scope 1 + ctx 0 = 全局（gpu 0 / display 0），与 NVIDIA App 相同
        return getSetting(1, ref ctx, id, buf, (ulong)size);
    }

    public static byte[] Get(uint id, int size)
    {
        byte[] buf;
        int rc = TryGet(id, size, out buf);
        if (rc != 0) throw ApiError("NvCplApiGetSetting", id, rc);
        return buf;
    }

    public static void Set(uint id, byte[] buf)
    {
        ulong ctx = 0;
        int rc = setSetting(1, ref ctx, id, buf, (ulong)buf.Length);
        Host.Log("set 0x" + id.ToString("x") + " rc=" + rc);
        if (rc != 0) throw ApiError("NvCplApiSetSetting", id, rc);
    }

    public static void SetInt(uint id, int value) { Set(id, BitConverter.GetBytes(value)); }

    static HostError ApiError(string fn, uint id, int rc)
    {
        return new HostError("api", fn + "(0x" + id.ToString("x") + ") returned " + rc)
            .With("rc", rc).With("id", "0x" + id.ToString("x"));
    }
}

// 一次完整读取（原始字节，写回时保留未知字段）
sealed class Snapshot
{
    public byte[] Hdr;       // 0x318
    public byte[] Vsr;       // 0x315
    public int? Level;       // 0x316
    public int? Active;      // 0x319
    public int? Priority;    // 0x32F（驱动 ≤570 可能没有）
    public int? Flags;       // 0x330

    public static Snapshot Read()
    {
        var s = new Snapshot();
        s.Hdr = Nv.Get(Nv.HdrInfo, Nv.HdrSize);
        s.Vsr = Nv.Get(Nv.VsrInfo, Nv.VsrSize);
        s.Level = Opt(Nv.VsrLevel);
        s.Active = Opt(Nv.HdrActive);
        s.Priority = Opt(Nv.VsrPriority);
        s.Flags = Opt(Nv.VideoFlags);
        return s;
    }

    // 可选项读失败时记为 null，不让整个面板不可用
    static int? Opt(uint id)
    {
        byte[] b;
        int rc = Nv.TryGet(id, 4, out b);
        if (rc != 0) { Host.Log("get 0x" + id.ToString("x") + " rc=" + rc + " (optional, reported as null)"); return null; }
        return BitConverter.ToInt32(b, 0);
    }

    public int H(int off) { return BitConverter.ToInt32(Hdr, off); }
    public int V(int off) { return BitConverter.ToInt32(Vsr, off); }
    public bool HdrSupported { get { return H(0x00) != 0; } }
    public bool HdrEnabled { get { return H(0x04) != 0; } }
    public int HdrError { get { return H(0x08); } }
    public int PeakMax { get { return H(0x20); } }
    public int PeakMin { get { return H(0x24); } }
    public bool VsrSupported { get { return V(0x00) != 0; } }

    public Dictionary<string, object> ToState()
    {
        var hdr = new Dictionary<string, object>();
        hdr["supported"] = HdrSupported;
        hdr["enabled"] = H(0x04) != 0;
        hdr["active"] = Active.HasValue ? Active.Value != 0 : H(0x0C) != 0;
        hdr["error"] = HdrError;
        hdr["peak"] = H(0x10);
        hdr["peakMin"] = PeakMin;
        hdr["peakMax"] = PeakMax;
        hdr["middleGrey"] = H(0x14);
        hdr["contrast"] = H(0x18) - 100;   // 原始值 = 界面值 + 100
        hdr["saturation"] = H(0x1C) - 100;

        var vsr = new Dictionary<string, object>();
        vsr["supported"] = VsrSupported;
        vsr["mode"] = V(0x04);
        vsr["level"] = Level;
        vsr["priority"] = Priority;

        var state = new Dictionary<string, object>();
        state["hdr"] = hdr;
        state["vsr"] = vsr;
        state["indicator"] = Flags.HasValue ? (object)((Flags.Value & 0x101) != 0) : null;
        state["flags"] = Flags;
        return state;
    }
}

// Windows 显示器信息：user32 DisplayConfig，只读（只查询，不改任何显示设置），不需要管理员，不用 nvcpl.dll。
// 结构布局与 v1.2 规格里在本机验证过的 PowerShell 探针相同（PATH_INFO 72、MODE_INFO 64、TARGET_NAME 420 字节）。
static class Disp
{
    const uint QDC_ONLY_ACTIVE_PATHS = 0x2;
    const int ERROR_INSUFFICIENT_BUFFER = 122;
    const uint MODE_SOURCE = 1;                                       // DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE
    const uint GET_TARGET_NAME = 2, GET_ADVANCED_COLOR_INFO = 9, GET_SDR_WHITE_LEVEL = 11;

    [StructLayout(LayoutKind.Sequential)]
    struct LUID { public uint Low; public int High; }

    [StructLayout(LayoutKind.Sequential)]
    struct PATH_SOURCE { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint statusFlags; }

    [StructLayout(LayoutKind.Sequential)]
    struct PATH_TARGET
    {
        public LUID adapterId; public uint id; public uint modeInfoIdx; public uint outputTechnology;
        public uint rotation; public uint scaling; public uint refreshNum, refreshDen;   // DISPLAYCONFIG_RATIONAL
        public uint scanLineOrdering; public int targetAvailable; public uint statusFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PATH_INFO { public PATH_SOURCE sourceInfo; public PATH_TARGET targetInfo; public uint flags; }

    // 联合体只用到 SOURCE_MODE 的 position：桌面原点 (0,0) 就是主显示器
    [StructLayout(LayoutKind.Sequential, Size = 64)]
    struct MODE_INFO { public uint infoType; public uint id; public LUID adapterId; public uint width, height, pixelFormat; public int x, y; }

    [StructLayout(LayoutKind.Sequential)]
    struct HEADER { public uint type; public uint size; public LUID adapterId; public uint id; }

    [StructLayout(LayoutKind.Sequential)]
    struct SDR_WHITE { public HEADER header; public uint SDRWhiteLevel; }

    [StructLayout(LayoutKind.Sequential)]
    struct ADV_COLOR { public HEADER header; public uint value; public uint colorEncoding; public uint bitsPerColorChannel; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct TARGET_NAME
    {
        public HEADER header; public uint flags; public uint outputTechnology;
        public ushort edidManufactureId; public ushort edidProductCodeId; public uint connectorInstance;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string monitorFriendlyDeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string monitorDevicePath;
    }

    [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint numPaths, out uint numModes);
    [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint numPaths, [Out] PATH_INFO[] paths, ref uint numModes, [Out] MODE_INFO[] modes, IntPtr topology);
    [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref TARGET_NAME info);
    [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref SDR_WHITE info);
    [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref ADV_COLOR info);

    // 所有活动显示器，主显示器排在最前面
    public static List<object> Read()
    {
        PATH_INFO[] paths = null;
        MODE_INFO[] modes = null;
        uint np = 0, nm = 0;
        int rc = ERROR_INSUFFICIENT_BUFFER;
        // 两次调用之间显示器配置变了会返回 ERROR_INSUFFICIENT_BUFFER：重新取大小再查
        for (int i = 0; i < 5 && rc == ERROR_INSUFFICIENT_BUFFER; i++)
        {
            rc = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out np, out nm);
            if (rc != 0) throw Error("GetDisplayConfigBufferSizes", rc);
            if (np == 0) return new List<object>();                 // 没有活动的显示器
            paths = new PATH_INFO[np];
            modes = new MODE_INFO[nm];
            rc = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ref np, paths, ref nm, modes, IntPtr.Zero);
        }
        if (rc != 0) throw Error("QueryDisplayConfig", rc);

        var list = new List<object>();
        var seen = new List<string>();
        int primaries = 0;
        for (int i = 0; i < np; i++)
        {
            PATH_TARGET t = paths[i].targetInfo;
            string key = t.adapterId.High + "." + t.adapterId.Low + "." + t.id;
            if (seen.Contains(key)) continue;                        // 同一个目标只报一次
            seen.Add(key);
            uint m = paths[i].sourceInfo.modeInfoIdx;
            bool primary = m < nm && modes[m].infoType == MODE_SOURCE && modes[m].x == 0 && modes[m].y == 0;
            if (primary) list.Insert(primaries++, Describe(t));
            else list.Add(Describe(t));
        }
        return list;
    }

    static HEADER Header(uint type, Type layout, PATH_TARGET t)
    {
        var h = new HEADER();
        h.type = type;
        h.size = (uint)Marshal.SizeOf(layout);
        h.adapterId = t.adapterId;
        h.id = t.id;
        return h;
    }

    static Dictionary<string, object> Describe(PATH_TARGET t)
    {
        var name = new TARGET_NAME();
        name.header = Header(GET_TARGET_NAME, typeof(TARGET_NAME), t);
        int rc = DisplayConfigGetDeviceInfo(ref name);
        if (rc != 0) throw Error("DisplayConfigGetDeviceInfo(GET_TARGET_NAME)", rc);

        // 下面两项个别显示器（如虚拟显示器）可能取不到：对应字段报 null，不让整个命令失败
        var adv = new ADV_COLOR();
        adv.header = Header(GET_ADVANCED_COLOR_INFO, typeof(ADV_COLOR), t);
        int advRc = DisplayConfigGetDeviceInfo(ref adv);
        if (advRc != 0) Host.Log("GET_ADVANCED_COLOR_INFO rc=" + advRc + " for target " + t.id);

        var white = new SDR_WHITE();
        white.header = Header(GET_SDR_WHITE_LEVEL, typeof(SDR_WHITE), t);
        int whiteRc = DisplayConfigGetDeviceInfo(ref white);
        if (whiteRc != 0) Host.Log("GET_SDR_WHITE_LEVEL rc=" + whiteRc + " for target " + t.id);

        var d = new Dictionary<string, object>();
        d["id"] = name.monitorDevicePath ?? "";
        d["name"] = name.monitorFriendlyDeviceName ?? "";            // 没有 EDID 名称时为 ""
        // value：bit0 advancedColorSupported，bit1 advancedColorEnabled，bit2 wideColorEnforced
        // （SDR 显示器上的「自动颜色管理」，不是 HDR），bit3 advancedColorForceDisabled
        d["hdrSupported"] = advRc == 0 ? (object)((adv.value & 0x1) != 0) : null;
        d["hdrEnabled"] = advRc == 0 ? (object)((adv.value & 0x2) != 0 && (adv.value & 0xC) == 0) : null;
        if (whiteRc == 0)
        {
            // nits = SDRWhiteLevel / 1000 × 80，四舍五入到 0.1（整数运算，没有浮点误差）
            long tenths = ((long)white.SDRWhiteLevel * 4 + 2) / 5;
            d["sdrWhiteNits"] = tenths / 10.0;
            // Windows「SDR 内容亮度」滑块 = round((nits − 80) / 4)，限制在 0..100
            d["sdrSlider"] = (int)Math.Min(100, tenths <= 780 ? 0 : (tenths - 780) / 40);
        }
        else
        {
            d["sdrWhiteNits"] = null;
            d["sdrSlider"] = null;
        }
        d["bitsPerColor"] = advRc == 0 ? (object)(int)adv.bitsPerColorChannel : null;
        return d;
    }

    static HostError Error(string fn, int rc)
    {
        return new HostError("api", fn + " returned " + rc).With("rc", rc);
    }
}

static class Host
{
    public const string Version = "1.2.1";
    const int MaxIn = 64 * 1024 * 1024;   // 浏览器→本地 的安全上限
    const int MaxOut = 1024 * 1024;       // 本地→浏览器 超过 1 MiB 浏览器会断开
    const int FlagIndicators = 0x101;     // HDR 指示器 | 超分指示器

    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true); // 无 BOM，非法字节抛异常
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    // 所有命令（nvcpl 调用）和租约归还都在这把锁里：控制台事件、会话结束的回调在别的线程上
    static readonly object Gate = new object();

    // HDR 租约（「只关 HDR、保留超分」）：只属于本进程，进程退出前一定按 on:false 的规则归还
    static bool leaseHeld;
    static bool leasePrev;                // 租约开始时 HDR 开关（0x318 +4）是否为 1
    static bool watchingSession;
    static bool exiting;                  // 已按退出流程归还过租约：不再接受新租约

    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll")] static extern bool SetStdHandle(int which, IntPtr handle);
    const int STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;

    delegate bool ConsoleCtrlHandler(int ctrlType);
    [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler handler, bool add);
    static ConsoleCtrlHandler ctrlHandler; // 保持引用，防止委托被 GC 回收

    public static void Log(string text)
    {
        try { Console.Error.WriteLine("rtx_hdr_host: " + text); } catch { }
    }

    static int Main(string[] args)
    {
        Json.MaxJsonLength = int.MaxValue;
        // 原始字节流：没有 CRLF 转换、没有 BOM
        Stream stdin = Console.OpenStandardInput();
        Stream stdout = Console.OpenStandardOutput();
        // 之后加载的原生代码若往 stdout 打印，会落到 stderr，不会破坏协议帧
        SetStdHandle(STD_OUTPUT_HANDLE, GetStdHandle(STD_ERROR_HANDLE));
        // Ctrl+C / Ctrl+Break / 关闭控制台窗口、进程正常退出：都先归还 HDR 租约
        ctrlHandler = OnConsoleCtrl;
        SetConsoleCtrlHandler(ctrlHandler, true);
        AppDomain.CurrentDomain.ProcessExit += delegate { ReleaseOnExit("process exit"); };
        Log("start " + Version + (args.Length > 0 ? " origin=" + args[0] : ""));
        string why = "exit";
        try
        {
            while (true)
            {
                byte[] msg = ReadMessage(stdin);
                if (msg == null)              // stdin EOF：浏览器关闭了端口（关闭/崩溃、扩展重载、端口断开）
                {
                    why = "stdin closed";
                    return 0;
                }
                WriteMessage(stdout, HandleRaw(msg));
            }
        }
        catch (Exception e)
        {
            why = "fatal error";
            Log("fatal: " + e);
            return 1;
        }
        finally
        {
            lock (Gate)
            {
                ReleaseOnExit(why);           // 先按 on:false 归还租约，再关 nvcpl
                Nv.Shutdown();
            }
        }
    }

    // 0 Ctrl+C，1 Ctrl+Break，2 关闭控制台；5/6（注销/关机）加载了 user32 的进程收不到，由 SessionEnded 处理
    static bool OnConsoleCtrl(int ctrlType)
    {
        ReleaseOnExit("console event " + ctrlType);
        return false;                         // 继续交给默认处理（结束进程）
    }

    // 进程要结束了：按 on:false（restore:true）归还租约，之后不再接受新租约。
    // 别的线程可能正拿着锁执行命令（nvcpl 调用只要几毫秒）：最多等 5 秒，绝不让退出卡死
    static void ReleaseOnExit(string why)
    {
        if (!Monitor.TryEnter(Gate, 5000))
        {
            Log("lease restore skipped (" + why + "): host busy");
            return;
        }
        try
        {
            exiting = true;
            ReleaseLease(true, why);
        }
        catch (Exception e) { Log("lease restore failed (" + why + "): " + e.Message); }
        finally { Monitor.Exit(Gate); }
    }

    static Dictionary<string, object> HandleRaw(byte[] msg)
    {
        object id = null;
        bool hasId = false;
        Dictionary<string, object> res;
        try
        {
            object parsed;
            try { parsed = Json.DeserializeObject(Utf8.GetString(msg)); }
            catch (ArgumentException e) { throw new HostError("bad-request", "invalid JSON: " + e.Message); }
            catch (InvalidOperationException e) { throw new HostError("bad-request", "invalid JSON: " + e.Message); }
            var req = parsed as Dictionary<string, object>;
            if (req == null) throw new HostError("bad-request", "request must be a JSON object");
            hasId = req.TryGetValue("id", out id);
            lock (Gate) { res = Dispatch(req); }
        }
        catch (HostError e)
        {
            res = Fail(e.Info);
        }
        catch (Exception e)
        {
            Log("internal: " + e);
            var info = new Dictionary<string, object>();
            info["code"] = "internal";
            info["message"] = e.GetType().Name + ": " + e.Message;
            res = Fail(info);
        }
        if (!hasId) return res;
        var withId = new Dictionary<string, object>();
        withId["id"] = id;
        foreach (var kv in res) withId[kv.Key] = kv.Value;
        return withId;
    }

    static Dictionary<string, object> Fail(Dictionary<string, object> info)
    {
        var res = new Dictionary<string, object>();
        res["ok"] = false;
        res["error"] = info;
        return res;
    }

    static Dictionary<string, object> Ok(string key, object value)
    {
        var res = new Dictionary<string, object>();
        res["ok"] = true;
        if (key != null) res[key] = value;
        return res;
    }

    static Dictionary<string, object> Dispatch(Dictionary<string, object> req)
    {
        object cmdObj;
        req.TryGetValue("cmd", out cmdObj);
        string cmd = cmdObj as string;
        switch (cmd)
        {
            case "hello":
            {
                Nv.TryLoad();
                var res = Ok(null, null);
                res["host"] = "rtx_hdr_host";
                res["version"] = Version;
                res["protocol"] = 1;
                res["dll"] = Nv.DllPath;
                res["caps"] = new string[] { "display", "hdrLease" };   // 1.2 新增的命令，扩展据此判断能否使用
                return res;
            }
            case "get":
                Nv.EnsureReady();
                return Ok("state", Snapshot.Read().ToState());
            case "set":
                Nv.EnsureReady();
                return Ok("state", DoSet(req));
            case "display":
                return Ok("displays", Disp.Read());
            case "hdrLease":
                return DoLease(req);
            default:
                throw new HostError("bad-request", cmd == null ? "missing cmd" : "unknown cmd: " + cmd);
        }
    }

    // ---- hdrLease：只关 RTX Video HDR（超分照常），用完按原样恢复 -----------
    // on:true  租约开始时记下 HDR 开关；开着就只把开关写成 0。租约期间再次 on:true 不覆盖记下的值。
    // on:false 租约开始时 HDR 是开的、现在仍是关的 → 写回 1；restore:false 只放弃租约、不碰开关。
    // stdin EOF / 控制台事件 / 进程退出 / 会话结束时，仍持有的租约按 on:false（restore:true）归还。

    static Dictionary<string, object> DoLease(Dictionary<string, object> req)
    {
        // 先校验参数，任何 NVIDIA 调用之前
        bool? on = Bool(req, "on", "on");
        if (!on.HasValue) throw RangeError("on", "must be true or false");
        bool? restore = Bool(req, "restore", "restore");   // 只对 on:false 有意义，默认 true
        try
        {
            return on.Value ? AcquireLease() : ReleaseCommand(!restore.HasValue || restore.Value);
        }
        catch (HostError e)
        {
            e.With("lease", leaseHeld);                     // 出错后本进程是否仍持有租约（持有的话退出时照样恢复）
            throw;
        }
    }

    static Dictionary<string, object> AcquireLease()
    {
        if (exiting) throw new HostError("internal", "host is shutting down");
        Nv.EnsureReady();
        Snapshot cur = Snapshot.Read();
        if (!cur.HdrSupported) throw new HostError("unsupported", "RTX Video HDR is not supported").With("field", "hdr");
        if (cur.HdrError != 0)
            throw new HostError("hdr-error", "HDR cannot be changed now (errorCode " + cur.HdrError + ")")
                .With("errorCode", cur.HdrError);
        if (!leaseHeld)
        {
            leasePrev = cur.HdrEnabled;
            leaseHeld = true;                               // 写之前就记上：写失败时退出也会检查并恢复
            WatchSessionEnd();
            Log("lease acquired (HDR was " + (leasePrev ? "on" : "off") + ")");
        }
        bool changed = false;
        if (cur.HdrEnabled)
        {
            WriteHdrEnabled(cur, false);
            changed = true;
        }
        var res = Ok("lease", true);
        res["prevEnabled"] = leasePrev;
        res["changed"] = changed;
        res["state"] = Snapshot.Read().ToState();
        return res;
    }

    static Dictionary<string, object> ReleaseCommand(bool restore)
    {
        bool held = leaseHeld;
        bool changed = ReleaseLease(restore, "on:false");
        object state = null;
        if (held)
        {
            state = Snapshot.Read().ToState();             // 拿过租约，nvcpl 已就绪
        }
        else
        {
            // 没有租约：空操作，照样成功；能读到就顺便带上当前状态
            try
            {
                Nv.EnsureReady();
                state = Snapshot.Read().ToState();
            }
            catch (HostError e) { Log("hdrLease on:false without a lease, state unavailable: " + e.Message); }
        }
        var res = Ok("lease", false);
        res["changed"] = changed;
        res["state"] = state;
        return res;
    }

    // 归还租约，返回这次是否写了 0x318。restore 且租约开始时 HDR 是开的、现在开关是 0 → 只把开关写回 1。
    // 写失败时抛异常、租约保留：之后的 on:false 或进程退出时会再试
    static bool ReleaseLease(bool restore, string why)
    {
        lock (Gate)
        {
            if (!leaseHeld) return false;
            bool changed = false;
            if (restore && leasePrev)
            {
                Nv.EnsureReady();
                Snapshot cur = Snapshot.Read();
                if (!cur.HdrEnabled)
                {
                    WriteHdrEnabled(cur, true);
                    changed = true;
                }
            }
            leaseHeld = false;
            Log("lease released (" + why + (restore ? "" : ", restore:false") + "): " +
                (changed ? "HDR re-enabled" : "enabled bit not written"));
            return changed;
        }
    }

    // 注销 / 关机：进程加载了 user32，控制台事件收不到，改由 SystemEvents 的隐藏窗口接 WM_ENDSESSION。
    // 只在第一次拿到租约时注册，平时不多开线程和窗口
    static void WatchSessionEnd()
    {
        if (watchingSession) return;
        watchingSession = true;
        try { SystemEvents.SessionEnded += delegate { ReleaseOnExit("session ended"); }; }
        catch (Exception e) { Log("SystemEvents.SessionEnded unavailable: " + e.Message); }
    }

    // 写 0x318 前的统一处理：克隆刚读到的结构（读-改-写，保留 +0x28/+0x2C 等未知字段），
    // errorCode = SUCCESS、status = 0（NVIDIA App 也这样写）
    static byte[] HdrForWrite(Snapshot cur)
    {
        byte[] hdr = (byte[])cur.Hdr.Clone();
        PutInt(hdr, 0x08, 0);
        PutInt(hdr, 0x0C, 0);
        return hdr;
    }

    // 只改 HDR 开关（+4），其余设置按刚读到的值原样写回
    static void WriteHdrEnabled(Snapshot cur, bool on)
    {
        byte[] hdr = HdrForWrite(cur);
        PutInt(hdr, 0x04, on ? 1 : 0);
        Nv.Set(Nv.HdrInfo, hdr);
    }

    // ---- set ---------------------------------------------------------------

    sealed class Patch
    {
        public bool? Enabled;
        public int? Peak, MiddleGrey, Contrast, Saturation;
        public int? Mode, Priority;
        public bool? Indicator;
        public bool Commit;
        public bool AnyHdr { get { return Enabled.HasValue || Peak.HasValue || MiddleGrey.HasValue || Contrast.HasValue || Saturation.HasValue; } }
    }

    static Dictionary<string, object> DoSet(Dictionary<string, object> req)
    {
        // 先读一次实时状态，用于校验（峰值范围、是否支持、errorCode）
        Snapshot cur = Snapshot.Read();
        Patch p = Validate(req, cur);    // 任一字段不合法 → 整个请求拒绝，什么都不写

        // 所有读取都在第一次写入之前：读失败时什么都还没写
        int flags = 0;
        if (p.Indicator.HasValue)
        {
            flags = BitConverter.ToInt32(Nv.Get(Nv.VideoFlags, 4), 0); // 现读现改，保留其它位
            flags = p.Indicator.Value ? (flags | FlagIndicators) : (flags & ~FlagIndicators);
        }

        // 写入顺序与 NVIDIA App 相同：0x318 → 0x317 → 0x32F → 0x330。
        // 中途出错不回滚：错误回复里的 written 列出已经写入的 id，调用方据此判断是否可能写了一部分
        var written = new List<string>();
        try
        {
            if (p.AnyHdr)
            {
                byte[] hdr = HdrForWrite(cur);           // 读-改-写，errorCode = SUCCESS、status = 0
                if (p.Enabled.HasValue) PutInt(hdr, 0x04, p.Enabled.Value ? 1 : 0);
                if (p.Peak.HasValue) PutInt(hdr, 0x10, p.Peak.Value);
                if (p.MiddleGrey.HasValue) PutInt(hdr, 0x14, p.MiddleGrey.Value);
                if (p.Contrast.HasValue) PutInt(hdr, 0x18, p.Contrast.Value + 100);
                if (p.Saturation.HasValue) PutInt(hdr, 0x1C, p.Saturation.Value + 100);
                Nv.Set(Nv.HdrInfo, hdr);
                written.Add("0x318");
            }
            if (p.Mode.HasValue) { Nv.SetInt(Nv.VsrValue, p.Mode.Value); written.Add("0x317"); }
            if (p.Priority.HasValue) { Nv.SetInt(Nv.VsrPriority, p.Priority.Value); written.Add("0x32f"); }
            if (p.Indicator.HasValue) { Nv.SetInt(Nv.VideoFlags, flags); written.Add("0x330"); }
            if (p.Commit) Commit();
            return Snapshot.Read().ToState();
        }
        catch (HostError e)
        {
            e.With("written", written.ToArray());
            throw;
        }
    }

    // commit:true 时调用，目前故意为空。实测（2026-10-21，NVIDIA App 11.0.9 / 驱动 617.42）：单独的
    // NvCplApiSetSetting 在调用返回前就已写入驱动注册表（_User_Global_VAL_* 和每台显示器的 _User_SUB0_* 副本），
    // 新进程立即读到新值，设置进程退出（NvCplApiClose）后也不回滚，NVIDIA App 进程同时收到 OnDataChanged。
    // NVIDIA App 的 NvCplApiExecute(0x10000, …)（"ApplySettings"）只是它自己"确定/取消"事务的一部分，
    // 对持久化不是必需的；参数类型也未经反汇编确认，所以这里不调用它。协议里保留 commit 以便将来需要时补上。
    static void Commit()
    {
    }

    static Patch Validate(Dictionary<string, object> req, Snapshot cur)
    {
        var p = new Patch();
        var hdr = Section(req, "hdr");
        var vsr = Section(req, "vsr");
        if (hdr != null)
        {
            p.Enabled = Bool(hdr, "enabled", "hdr.enabled");
            p.Peak = Int(hdr, "peak", "hdr.peak", cur.PeakMin, cur.PeakMax);
            p.MiddleGrey = Int(hdr, "middleGrey", "hdr.middleGrey", 10, 100);
            p.Contrast = Int(hdr, "contrast", "hdr.contrast", -100, 100);
            p.Saturation = Int(hdr, "saturation", "hdr.saturation", -100, 100);
        }
        if (vsr != null)
        {
            p.Mode = Int(vsr, "mode", "vsr.mode", 0, 5);
            p.Priority = Int(vsr, "priority", "vsr.priority", 0, 2);
        }
        p.Indicator = Bool(req, "indicator", "indicator");
        bool? commit = Bool(req, "commit", "commit");
        p.Commit = commit.HasValue && commit.Value;

        // 能力检查也在写之前做完
        if (p.AnyHdr)
        {
            if (!cur.HdrSupported) throw new HostError("unsupported", "RTX Video HDR is not supported").With("field", "hdr");
            if (cur.HdrError != 0)
                throw new HostError("hdr-error", "HDR cannot be changed now (errorCode " + cur.HdrError + ")")
                    .With("errorCode", cur.HdrError);
        }
        if ((p.Mode.HasValue || p.Priority.HasValue) && !cur.VsrSupported)
            throw new HostError("unsupported", "RTX Video Super Resolution is not supported").With("field", "vsr");
        if (p.Priority.HasValue && !cur.Priority.HasValue)
            throw new HostError("unsupported", "GPU priority (0x32f) is not available on this driver").With("field", "vsr.priority");
        if (p.Indicator.HasValue && !cur.Flags.HasValue)
            throw new HostError("unsupported", "video flags (0x330) are not available on this driver").With("field", "indicator");
        return p;
    }

    static Dictionary<string, object> Section(Dictionary<string, object> req, string key)
    {
        object v;
        if (!req.TryGetValue(key, out v) || v == null) return null;
        var d = v as Dictionary<string, object>;
        if (d == null) throw RangeError(key, "must be an object");
        return d;
    }

    static bool? Bool(Dictionary<string, object> d, string key, string field)
    {
        object v;
        if (!d.TryGetValue(key, out v) || v == null) return null;
        if (!(v is bool)) throw RangeError(field, "must be true or false");
        return (bool)v;
    }

    static int? Int(Dictionary<string, object> d, string key, string field, int min, int max)
    {
        object v;
        if (!d.TryGetValue(key, out v) || v == null) return null;
        long n;
        if (v is int) n = (int)v;
        else if (v is long) n = (long)v;
        else throw RangeError(field, "must be an integer").With("min", min).With("max", max);
        if (n < min || n > max)
            throw RangeError(field, "out of range " + min + ".." + max).With("min", min).With("max", max);
        return (int)n;
    }

    static HostError RangeError(string field, string why)
    {
        return new HostError("range", field + " " + why).With("field", field);
    }

    static void PutInt(byte[] buf, int off, int value)
    {
        byte[] b = BitConverter.GetBytes(value);
        Buffer.BlockCopy(b, 0, buf, off, 4);
    }

    // ---- framing -----------------------------------------------------------

    static byte[] ReadMessage(Stream s)
    {
        byte[] hdr = ReadExactly(s, 4);
        if (hdr == null) return null;
        int len = BitConverter.ToInt32(hdr, 0);      // 本机字节序（x64 = 小端）
        if (len < 0 || len > MaxIn) throw new InvalidDataException("bad message length " + len);
        byte[] body = ReadExactly(s, len);
        if (body == null && len > 0) throw new EndOfStreamException("truncated message");
        return body ?? new byte[0];
    }

    static byte[] ReadExactly(Stream s, int n)
    {
        byte[] buf = new byte[n];
        int off = 0;
        while (off < n)
        {
            int r = s.Read(buf, off, n - off);
            if (r <= 0)
            {
                if (off == 0) return null;
                throw new EndOfStreamException("truncated input");
            }
            off += r;
        }
        return buf;
    }

    static void WriteMessage(Stream s, Dictionary<string, object> obj)
    {
        byte[] body = Utf8.GetBytes(Json.Serialize(obj));
        if (body.Length > MaxOut)
        {
            var info = new Dictionary<string, object>();
            info["code"] = "bad-request";
            info["message"] = "reply too large";
            body = Utf8.GetBytes(Json.Serialize(Fail(info)));
        }
        byte[] frame = new byte[4 + body.Length];
        Buffer.BlockCopy(BitConverter.GetBytes(body.Length), 0, frame, 0, 4);
        Buffer.BlockCopy(body, 0, frame, 4, body.Length);
        s.Write(frame, 0, frame.Length);
        s.Flush();
    }
}
