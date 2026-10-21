/*
 * RTX HDR 开关 —— service worker（经典脚本）。
 * 记录每个 tab 各 frame 的报告，选出最佳 frame 设置角标、转发快捷键和弹窗请求；
 * 汇总各标签页上报的观看时间做「连续观看提醒」；
 * 通过本地组件（native messaging）读写 NVIDIA 全局设置：定时切换预设、「下一个预设」快捷键、弹窗兜底。
 */
'use strict';

importScripts('lib.js');
const L = self.RtxHdrLib;

const STALE_MS = 10000;
// 子 frame 有视频时每 3 秒一次心跳；超过这么久没消息就当它已经不在了（iframe 被移除、页面已离开）
const CHILD_DEAD_MS = 10000;
// 更久没消息的子 frame 报告直接删掉（隐藏标签页里的 iframe 回到前台时会马上重新上报）
const CHILD_PURGE_MS = 60000;
const PERSIST_DELAY_MS = 500;
const MAX_FRAMES_PER_TAB = 32;
const SESSION_PREFIX = 'tab:';
const EYE_SESSION_KEY = 'eye';
const MAX_EYE_INC_MS = 60000;
const NV_TIMEOUT_MS = 10000;
const NV_ALARM = 'nv-schedule';
const NV_PHASE_KEY = 'nvLastPhase';
const NV_LAST_PRESET_KEY = 'nvLastPresetId';
const NV_HOTKEY_ERROR_KEY = 'nvHotkeyError';
// 定时套用预设失败时下一分钟再试；这些错误重试也没用，本时段放弃
const NV_GIVE_UP = new Set(['no-dll', 'host-forbidden', 'bad-request', 'range']);
// 写入前就被拒、确定什么都没写的错误；写入阶段的其它错误（api、timeout、host-exit 等）可能已经写了一部分
const NV_NOT_WRITTEN = new Set(['host-missing', 'host-forbidden', 'no-dll', 'init', 'bad-request', 'range', 'unsupported', 'hdr-error']);
// 写入阶段出错时本时段最多试这么多次，免得每分钟把用户的手动修改覆盖回去
const NV_MAX_WRITE_FAILS = 3;
const BADGE = {
  on: { text: 'HDR', color: '#2e7d32' },
  off: { text: 'SDR', color: '#616161' },
  // DRM 视频扩展管不了：不显示 HDR/SDR，免得和实际情况相反
  drm: { text: 'DRM', color: '#8d6e00' }
};

const tabState = new Map(); // tabId → {frames: {frameId: report}, topDoc}
const tabLoads = new Map(); // tabId → 正在从 storage.session 恢复的 Promise
const badgeSig = new Map();
const persistTimers = new Map();
const recheckTimers = new Map();

function noop() {}

// 把同步异常也变成 rejected Promise，调用方统一 .catch
function call(fn) {
  try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); }
}

function validTabId(id) {
  return Number.isInteger(id) && id >= 0;
}

// ---------- 报告存储（内存 + storage.session，service worker 会被回收） ----------

function sanitizeReport(msg, ts, doc) {
  const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
  const str = (x) => (typeof x === 'string' ? x.slice(0, 2048) : null);
  return {
    hasVideo: !!msg.hasVideo,
    videoCount: num(msg.videoCount) || 0,
    offscreen: !!msg.offscreen,
    area: num(msg.area) || 0,
    playing: !!msg.playing,
    state: msg.state === 'on' || msg.state === 'off' ? msg.state : null,
    reason: str(msg.reason),
    key: str(msg.key),
    hostname: str(msg.hostname),
    drm: !!msg.drm,
    pip: !!msg.pip,
    contested: !!msg.contested,
    mean: num(msg.mean),
    white: num(msg.white),
    autoUnknown: str(msg.autoUnknown),
    fullscreen: !!msg.fullscreen,
    doc: doc || null,
    ts: ts
  };
}

function sanitizeTab(raw) {
  const out = { frames: {}, topDoc: null };
  if (raw && typeof raw === 'object') {
    if (raw.frames && typeof raw.frames === 'object') out.frames = raw.frames;
    if (typeof raw.topDoc === 'string') out.topDoc = raw.topDoc;
  }
  return out;
}

function getTab(tabId) {
  const t = tabState.get(tabId);
  if (t) return Promise.resolve(t);
  let p = tabLoads.get(tabId);
  if (!p) {
    const id = SESSION_PREFIX + tabId;
    p = call(() => chrome.storage.session.get(id))
      .then((r) => sanitizeTab(r && r[id]), () => sanitizeTab(null))
      .then((loaded) => {
        // 加载期间 tab 被关掉了就不再放回缓存
        if (tabLoads.get(tabId) === p) {
          tabLoads.delete(tabId);
          if (!tabState.has(tabId)) tabState.set(tabId, loaded);
        }
        return tabState.get(tabId) || loaded;
      });
    tabLoads.set(tabId, p);
  }
  return p;
}

function schedulePersist(tabId) {
  if (persistTimers.has(tabId)) return;
  persistTimers.set(tabId, setTimeout(() => {
    persistTimers.delete(tabId);
    const t = tabState.get(tabId);
    if (t) call(() => chrome.storage.session.set({ [SESSION_PREFIX + tabId]: t })).catch(noop);
  }, PERSIST_DELAY_MS));
}

function forgetTab(tabId) {
  tabState.delete(tabId);
  tabLoads.delete(tabId);
  badgeSig.delete(tabId);
  clearTimeout(persistTimers.get(tabId));
  persistTimers.delete(tabId);
  clearTimeout(recheckTimers.get(tabId));
  recheckTimers.delete(tabId);
  call(() => chrome.storage.session.remove(SESSION_PREFIX + tabId)).catch(noop);
}

function bestFrame(t) {
  return L.pickBestFrame(t.frames, Date.now(), STALE_MS, CHILD_DEAD_MS);
}

async function handleReport(msg, sender) {
  const now = Date.now();
  const eyeReply = await updateEye(msg, now).catch(() => null);

  const tabId = sender.tab && sender.tab.id;
  if (!validTabId(tabId)) return eyeReply;
  // 预渲染、往返缓存（bfcache）里的文档和正在卸载的旧文档发来的报告不算数
  const life = sender.documentLifecycle;
  if (typeof life === 'string' && life !== 'active') return eyeReply;
  const frameId = Number.isInteger(sender.frameId) && sender.frameId >= 0 ? sender.frameId : 0;
  const doc = typeof sender.documentId === 'string' ? sender.documentId : '';
  const t = await getTab(tabId);

  // 顶层文档换了（整页导航、从往返缓存恢复）：旧页面的子 frame 报告全部作废，
  // 新页面里有视频的 iframe 会在 3 秒内通过心跳重新报上来
  if (frameId === 0) {
    const top = doc || (typeof msg.timeOrigin === 'number' && isFinite(msg.timeOrigin) ? 't' + msg.timeOrigin : '');
    if (top && t.topDoc !== top) {
      if (msg.bye) return eyeReply; // 不认识的旧顶层文档在告别，不用管
      t.topDoc = top;
      badgeSig.delete(tabId);
      for (const id of Object.keys(t.frames)) if (id !== '0') delete t.frames[id];
    }
  }

  if (msg.bye) {
    // 文档要离开（pagehide）：只处理确实来自当前记录的那个文档的告别
    const cur = t.frames[frameId];
    if (cur && (!doc || !cur.doc || cur.doc === doc)) {
      if (frameId === 0) t.frames[0] = sanitizeReport({ hasVideo: false }, now, doc);
      else delete t.frames[frameId];
    }
  } else {
    t.frames[frameId] = sanitizeReport(msg, now, doc);
  }

  for (const id of Object.keys(t.frames)) {
    if (id !== '0' && !(now - ((t.frames[id] && t.frames[id].ts) || 0) <= CHILD_PURGE_MS)) delete t.frames[id];
  }
  const ids = Object.keys(t.frames);
  if (ids.length > MAX_FRAMES_PER_TAB) {
    ids.sort((a, b) => (t.frames[a].ts || 0) - (t.frames[b].ts || 0));
    for (const id of ids.slice(0, ids.length - MAX_FRAMES_PER_TAB)) delete t.frames[id];
  }

  schedulePersist(tabId);
  await refreshBadge(tabId, t);
  return eyeReply;
}

// ---------- 角标 ----------

// 最佳 frame 是子 frame 时，到它该有下一次心跳的时间再看一眼：iframe 悄悄消失（SPA 换页移除了它、
// 告别消息没送到）时角标不会一直停在旧状态
function scheduleRecheck(tabId, best) {
  clearTimeout(recheckTimers.get(tabId));
  recheckTimers.delete(tabId);
  if (!best || best.frameId === 0) return;
  const delay = Math.max(0, (+best.report.ts || 0) + CHILD_DEAD_MS - Date.now()) + 100;
  recheckTimers.set(tabId, setTimeout(() => {
    recheckTimers.delete(tabId);
    const t = tabState.get(tabId);
    if (t) refreshBadge(tabId, t).catch(noop);
  }, delay));
}

function badgeFor(report) {
  if (!report) return null;
  if (report.drm) return BADGE.drm;
  return BADGE[report.state] || null;
}

async function refreshBadge(tabId, t) {
  const best = bestFrame(t);
  scheduleRecheck(tabId, best);
  const b = badgeFor(best && best.report);
  const text = b ? b.text : '';
  if (badgeSig.get(tabId) === text) return;
  badgeSig.set(tabId, text);
  const a = chrome.action;
  const jobs = [call(() => a.setBadgeText({ tabId, text }))];
  if (b) {
    jobs.push(call(() => a.setBadgeBackgroundColor({ tabId, color: b.color })));
    jobs.push(call(() => a.setBadgeTextColor({ tabId, color: '#ffffff' })));
  }
  const results = await Promise.allSettled(jobs);
  // tab 已关闭等原因失败时，下次报告再试
  if (results.some((r) => r.status === 'rejected') && badgeSig.get(tabId) === text) badgeSig.delete(tabId);
}

// ---------- 护眼计时（跨视频、跨标签页累计） ----------

let eyeState = null;
let eyeLoading = null;
let eyePersistTimer = 0;
let settingsCache = null;
let settingsLoading = null;

function getSettings() {
  if (settingsCache) return Promise.resolve(settingsCache);
  if (!settingsLoading) {
    settingsLoading = call(() => chrome.storage.local.get('settings'))
      .then((r) => L.mergeSettings(r && r.settings), () => L.mergeSettings(null))
      .then((s) => {
        settingsLoading = null;
        if (!settingsCache) settingsCache = s;
        return settingsCache;
      });
  }
  return settingsLoading;
}

// 计时放在 storage.session（浏览器重启清零）；「护眼 SDR」以 storage.local 里的标记为准（内容脚本读它）
function getEye() {
  if (eyeState) return Promise.resolve(eyeState);
  if (!eyeLoading) {
    eyeLoading = Promise.all([
      call(() => chrome.storage.session.get(EYE_SESSION_KEY)).catch(() => null),
      call(() => chrome.storage.local.get(L.EYE_REST_KEY)).catch(() => null)
    ]).then(([ses, loc]) => {
      const s = L.eyeState(ses && ses[EYE_SESSION_KEY]);
      s.rest = !!L.eyeRestAt(loc && loc[L.EYE_REST_KEY]);
      eyeLoading = null;
      if (!eyeState) eyeState = s;
      return eyeState;
    });
  }
  return eyeLoading;
}

function persistEye() {
  if (eyePersistTimer) return;
  eyePersistTimer = setTimeout(() => {
    eyePersistTimer = 0;
    if (eyeState) call(() => chrome.storage.session.set({ [EYE_SESSION_KEY]: eyeState })).catch(noop);
  }, PERSIST_DELAY_MS);
}

function writeRest(on, now) {
  return call(() => (on
    ? chrome.storage.local.set({ [L.EYE_REST_KEY]: { on: true, at: now } })
    : chrome.storage.local.remove(L.EYE_REST_KEY))).catch(noop);
}

async function toggleShortcut() {
  try {
    const cmds = await chrome.commands.getAll();
    const c = (cmds || []).find((x) => x && x.name === 'toggle-hdr');
    return (c && c.shortcut) || '';
  } catch (e) {
    return '';
  }
}

function eyeInc(x) {
  return typeof x === 'number' && isFinite(x) && x > 0 ? Math.min(x, MAX_EYE_INC_MS) : 0;
}

// 返回给发报告的内容脚本：到点时带上 remind，由它在视频上显示提醒
async function updateEye(msg, now) {
  const [s, settings] = await Promise.all([getEye(), getSettings()]);
  const res = L.eyeUpdate(s, { hdr: eyeInc(msg.eyeHdr), watch: eyeInc(msg.eyeWatch) }, settings.eye, now);
  persistEye();
  if (res.restChanged) writeRest(s.rest, now);
  if (!res.remind) return null;
  return {
    remind: {
      minutes: settings.eye.minutes,
      autoOff: s.rest && !msg.drm, // DRM 视频切不了
      shortcut: await toggleShortcut()
    }
  };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes) return;
  if (changes.settings) {
    const prev = L.mergeSettings(changes.settings.oldValue);
    settingsCache = L.mergeSettings(changes.settings.newValue);
    // 改了时段或时段预设：马上检查一次（记录里的时段或预设对不上就套用新的）
    if (nvScheduleSig(prev) !== nvScheduleSig(settingsCache)) nvScheduleCheck();
    const e = settingsCache.eye;
    // 关掉提醒或「到时自动切回 SDR」：正在进行的护眼 SDR 也结束
    if (!e.minutes || !e.autoOff) {
      getEye().then((s) => {
        if (!s.rest) return;
        s.rest = false;
        persistEye();
        writeRest(false, Date.now());
      }).catch(noop);
    }
  }
  if (changes[L.EYE_REST_KEY]) {
    // 内容脚本在护眼 SDR 期间手动切回 HDR 时会删掉标记
    const on = !!L.eyeRestAt(changes[L.EYE_REST_KEY].newValue);
    getEye().then((s) => {
      if (s.rest === on) return;
      s.rest = on;
      persistEye();
    }).catch(noop);
  }
});

// ---------- 快捷键 ----------

async function activeTab() {
  const tabs = await call(() => chrome.tabs.query({ active: true, lastFocusedWindow: true })).catch(() => []);
  return tabs && tabs[0];
}

async function toggleAutoInStorage() {
  const r = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: L.toggleAutoMode(r && r.settings) });
}

// 先发给有视频的 frame，失败再发给顶层 frame；都没送到返回 false
async function sendToBestFrame(tabId, msg) {
  const best = bestFrame(await getTab(tabId));
  const frames = best && best.frameId !== 0 ? [best.frameId, 0] : [0];
  for (const frameId of frames) {
    try {
      await chrome.tabs.sendMessage(tabId, msg, { frameId: frameId });
      return true;
    } catch (e) {
      // chrome:// 页面、内容脚本未注入或 frame 已不存在：试下一个
    }
  }
  return false;
}

async function handleCommand(command, tab) {
  if (command === 'nv-next-preset') return nvNextPreset();
  if (!tab || !validTabId(tab.id)) tab = await activeTab();
  if (!tab || !validTabId(tab.id)) return;
  if (await sendToBestFrame(tab.id, { type: 'command', command: command })) return;
  // 页面上没有内容脚本时，「开/关 自动检测」仍然可以直接改设置
  if (command === 'toggle-auto') await toggleAutoInStorage().catch(noop);
}

chrome.commands.onCommand.addListener((command, tab) => {
  handleCommand(command, tab).catch(noop);
});

// ---------- NVIDIA 设置（本地组件） ----------

let nvQueue = Promise.resolve();
let nvChecking = null;
let nvCheckAgain = false;

// 一次请求起一个本地组件进程；lastError 和超时都变成 {ok:false, error}，永远不 reject
function nvSend(msg) {
  return new Promise((resolve) => {
    let timer = 0;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    timer = setTimeout(() => finish({ ok: false, error: { code: 'timeout' } }), NV_TIMEOUT_MS);
    try {
      chrome.runtime.sendNativeMessage(L.NV_HOST, msg, (res) => {
        const err = chrome.runtime.lastError;
        if (err) finish(L.nvPortError(err.message));
        else finish(res && typeof res === 'object' ? res : { ok: false, error: { code: 'host-error' } });
      });
    } catch (e) {
      finish(L.nvPortError((e && e.message) || 'error'));
    }
  });
}

// 所有请求排队一个一个来（定时切换、快捷键、弹窗兜底可能同时到）
function nvCall(msg) {
  const p = nvQueue.then(() => nvSend(msg));
  nvQueue = p;
  return p;
}

// 先读实时状态（最高亮度范围、是否支持、HDR 是否出错），再写入并提交。
// HDR 出错（Windows 没开 HDR、显示器休眠或还没重新识别等）时只写超分，成功的回复带 hdrSkipped；
// onlyHdr：只补写之前跳过的 HDR 部分，不再写超分。失败的回复带 stage（'get'：什么都还没写）
async function nvApplyPreset(preset, onlyHdr) {
  const fail = { ok: false, error: { code: 'host-error' } };
  const got = await nvCall({ cmd: 'get' });
  if (!got || got.ok !== true) return Object.assign(fail, got, { stage: 'get' });
  const st = L.nvNormState(got.state);
  const hdrSkipped = !!(st && st.hdr.supported && st.hdr.error);
  const patch = L.nvPresetPatch(preset, got.state);
  if (patch && onlyHdr) delete patch.vsr;
  if (!patch || !(patch.hdr || patch.vsr)) {
    const error = hdrSkipped ? { code: 'hdr-error', errorCode: st.hdr.error } : { code: 'unsupported' };
    return { ok: false, error: error, stage: 'get' };
  }
  const res = await nvCall(Object.assign({ cmd: 'set' }, patch));
  if (!res || res.ok !== true) return Object.assign(fail, res, { stage: 'set' });
  await call(() => chrome.storage.local.set({ [NV_LAST_PRESET_KEY]: preset.id })).catch(noop);
  return hdrSkipped ? Object.assign({}, res, { hdrSkipped: true }) : res;
}

async function nvNextPreset() {
  const s = await getSettings();
  const presets = s.nv.presets;
  let text;
  let warn = true; // 失败或只套用了一部分
  if (!presets.length) {
    text = '还没有 NVIDIA 预设，请先在弹窗里保存';
  } else {
    const r = await call(() => chrome.storage.local.get(NV_LAST_PRESET_KEY)).catch(() => null);
    const id = L.nvNextPresetId(presets, r && r[NV_LAST_PRESET_KEY]);
    const preset = presets.find((p) => p.id === id);
    const res = await nvApplyPreset(preset, false);
    if (res.ok !== true) {
      text = 'NVIDIA 预设切换失败：' + L.nvErrorText(res.error);
    } else if (res.hdrSkipped) {
      text = 'NVIDIA 预设：' + preset.name + '（HDR 当前不可用，只套用了超分辨率）';
    } else {
      text = 'NVIDIA 预设：' + preset.name;
      warn = false;
    }
  }
  const tab = await activeTab();
  const shown = !!tab && validTabId(tab.id) && await sendToBestFrame(tab.id, { type: 'osd', text: text, warn: warn });
  // 当前标签页显示不了（chrome:// 页面、新标签页等）：留到下次打开弹窗时显示
  if (warn && !shown) await call(() => chrome.storage.local.set({ [NV_HOTKEY_ERROR_KEY]: { text: text, at: Date.now() } })).catch(noop);
}

function nvScheduled(s) {
  return !!(s.nv.nightPresetId || s.nv.dayPresetId);
}

function nvScheduleSig(s) {
  return JSON.stringify([s.night.start, s.night.end, s.nv.nightPresetId, s.nv.dayPresetId]);
}

// 选了时段预设才每分钟叫醒一次 service worker
async function nvSyncAlarm(s) {
  if (nvScheduled(s)) {
    const a = await call(() => chrome.alarms.get(NV_ALARM)).catch(() => null);
    if (!a) await call(() => chrome.alarms.create(NV_ALARM, { periodInMinutes: 1 })).catch(noop);
  } else {
    await call(() => chrome.alarms.clear(NV_ALARM)).catch(noop);
  }
}

// 本地组件的写入错误带 written（已经写入的 id）；空数组说明第一次写入就失败了，什么都没改
function nvNothingWritten(err) {
  return !!err && Array.isArray(err.written) && err.written.length === 0;
}

// nvLastPhase：{phase, id, hdrPending?, fails?}——这个时段套用的是哪个预设、还差什么
function nvPhaseRecord(v) {
  if (!v || typeof v !== 'object' || typeof v.phase !== 'string') return null;
  return {
    phase: v.phase,
    id: typeof v.id === 'string' ? v.id : null,
    hdrPending: v.hdrPending === true,
    fails: Number.isInteger(v.fails) && v.fails > 0 ? v.fails : 0
  };
}

// 时段（夜间 / 其余时间）或该时段选的预设变了才套用；套用完后同一时段内不覆盖用户之后的手动修改。
// 记录里带着预设 id：套用途中用户又改了选择，下一轮发现 id 对不上会再套用新的
async function nvScheduleOnce() {
  const s = await getSettings();
  await nvSyncAlarm(s);
  if (!nvScheduled(s)) return;
  const phase = L.nvSchedulePhase(s.night, L.minutesOfDay(Date.now()));
  const id = (phase === 'night' ? s.nv.nightPresetId : s.nv.dayPresetId) || null;
  const r = await chrome.storage.local.get(NV_PHASE_KEY);
  const last = nvPhaseRecord(r && r[NV_PHASE_KEY]);
  const same = !!last && last.phase === phase && last.id === id;
  if (same && !last.hdrPending && !last.fails) return;
  const preset = id ? s.nv.presets.find((p) => p.id === id) : null;
  const rec = { phase: phase, id: id };
  if (preset) {
    // 上次 HDR 不可用、只套用了超分：这次只补 HDR 部分（不再写超分，免得覆盖用户之后改的超分）
    const pending = same && last.hdrPending;
    const res = await nvApplyPreset(preset, pending);
    const code = res.error && res.error.code;
    if (res.ok === true) {
      if (res.hdrSkipped) rec.hdrPending = true; // 每分钟看一次，HDR 可用了再补
    } else if (NV_GIVE_UP.has(code)) {
      // 重试也没用：本时段放弃
    } else if (res.stage === 'set' && !NV_NOT_WRITTEN.has(code) && !nvNothingWritten(res.error)) {
      // 写入阶段出错，可能已经写了一部分：本时段最多试 NV_MAX_WRITE_FAILS 次
      const fails = (same ? last.fails : 0) + 1;
      if (fails < NV_MAX_WRITE_FAILS) {
        rec.fails = fails;
        if (pending) rec.hdrPending = true;
      }
    } else {
      // 什么都没写（没装本地组件、本地组件没响应、HDR 还不可用等）：不记，下一分钟再试
      return;
    }
  }
  // 这个时段没选预设也要记下，下次进入另一个时段时才会套用
  await chrome.storage.local.set({ [NV_PHASE_KEY]: rec });
}

function nvScheduleCheck() {
  if (nvChecking) {
    nvCheckAgain = true;
    return nvChecking;
  }
  nvChecking = (async () => {
    do {
      nvCheckAgain = false;
      await nvScheduleOnce().catch(noop);
    } while (nvCheckAgain);
    nvChecking = null;
  })();
  return nvChecking;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === NV_ALARM) nvScheduleCheck();
});

chrome.runtime.onStartup.addListener(() => {
  nvScheduleCheck();
});

// 弹窗的兜底通道（弹窗自己的 connectNative 端口不可用时）
function nvHandle(msg) {
  if (msg.op === 'hello' || msg.op === 'get') return nvCall({ cmd: msg.op });
  if (msg.op === 'set') {
    const v = L.nvValidatePatch(msg.payload, null);
    return v.ok ? nvCall(Object.assign({ cmd: 'set' }, v.patch)) : Promise.resolve({ ok: false, error: v.error });
  }
  return Promise.resolve({ ok: false, error: { code: 'bad-request', message: 'unknown op' } });
}

// ---------- 消息 ----------

function fromExtensionPage(sender) {
  try {
    return typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  } catch (e) {
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || !sender || sender.id !== chrome.runtime.id) return false;

  if (msg.type === 'report') {
    if (!sender.tab) {
      sendResponse({ ok: true });
      return false;
    }
    handleReport(msg, sender).then(
      (r) => sendResponse(Object.assign({ ok: true }, r)),
      () => sendResponse({ ok: true })
    );
    return true;
  }

  if (msg.type === 'popup-get' && fromExtensionPage(sender)) {
    if (!validTabId(msg.tabId)) {
      sendResponse({ frameId: null });
      return false;
    }
    getTab(msg.tabId)
      .then((t) => {
        const best = bestFrame(t);
        sendResponse(best ? { frameId: best.frameId, report: best.report } : { frameId: null });
      })
      .catch(() => sendResponse({ frameId: null }));
    return true;
  }

  if (msg.type === 'nv' && fromExtensionPage(sender)) {
    nvHandle(msg).then(sendResponse, (e) => sendResponse(L.nvPortError((e && e.message) || 'error')));
    return true;
  }
  return false;
});

// ---------- 安装 / 更新 ----------

async function initSettings() {
  const r = await chrome.storage.local.get('settings');
  const cur = r && r.settings;
  const merged = L.mergeSettings(cur); // 补齐缺失字段，保留已有的合法设置
  if (JSON.stringify(cur) !== JSON.stringify(merged)) await chrome.storage.local.set({ settings: merged });
}

// 安装前已打开的页面没有内容脚本，主动注入一次（content.js 自带防重复；扩展重新加载后由新实例接管旧实例）
async function injectOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.map((t) => {
    if (!validTabId(t.id) || t.discarded) return null;
    return call(() => chrome.scripting.executeScript({
      target: { tabId: t.id, allFrames: true },
      files: ['lib.js', 'content.js']
    })).catch(noop);
  }));
}

chrome.runtime.onInstalled.addListener((details) => {
  initSettings().catch(noop).then(nvScheduleCheck);
  const reason = details && details.reason;
  if (reason === 'install' || reason === 'update') injectOpenTabs().catch(noop);
});

// ---------- tab 生命周期 ----------

chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => forgetTab(removedTabId));

// 整页导航时 Chrome 会清掉该 tab 的角标，缓存也要作废
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo && changeInfo.status === 'loading') badgeSig.delete(tabId);
});
