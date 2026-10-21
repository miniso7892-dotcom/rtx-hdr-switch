# RTX HDR Switch 本地组件安装：按需编译 rtx_hdr_host.exe，并为 Chrome / Edge / Chromium
# 注册 native messaging host（只写 HKCU，无需管理员）。由 install.cmd 调用，也可以直接运行。
# Installs the RTX HDR Switch native host for the current user (HKCU only, no admin).
param([switch]$NoBuild)
$ErrorActionPreference = 'Stop'

$HostName = 'io.github.rtx_hdr_switch'
$Dir = $PSScriptRoot
$Manifest = Join-Path $Dir "$HostName.json"
$Exe = Join-Path $Dir 'rtx_hdr_host.exe'
$Src = Join-Path $Dir 'RtxHdrHost.cs'
$Csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$Keys = @(
  'Software\Google\Chrome\NativeMessagingHosts',
  'Software\Microsoft\Edge\NativeMessagingHosts',
  'Software\Chromium\NativeMessagingHosts'
)

function Say([string]$zh, [string]$en) {
  Write-Host $zh
  Write-Host "  $en" -ForegroundColor DarkGray
}

function Fail([string]$zh, [string]$en) {
  Write-Host $zh -ForegroundColor Red
  Write-Host "  $en" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path -LiteralPath $Manifest)) {
  Fail "找不到 $Manifest" "Host manifest not found: $Manifest"
}
if ($Dir -match '[&^%]') {
  Write-Warning "当前路径含有 & ^ % 之一，浏览器通过 cmd.exe 启动本地组件时会出错。请把扩展文件夹移到不含这些字符的路径后重新安装。"
  Write-Warning "The folder path contains & ^ or %. Browsers start the host through cmd.exe, which breaks on these characters. Move the extension folder and run install again."
}

# 1) 编译：exe 不存在或比 .cs 旧时才编译
$needBuild = -not (Test-Path -LiteralPath $Exe)
if (-not $needBuild) {
  $needBuild = (Get-Item -LiteralPath $Exe).LastWriteTimeUtc -lt (Get-Item -LiteralPath $Src).LastWriteTimeUtc
}
if ($needBuild -and $NoBuild) {
  Fail "rtx_hdr_host.exe 不存在或已过期，但指定了 -NoBuild。" "rtx_hdr_host.exe is missing or older than RtxHdrHost.cs, and -NoBuild was given."
}
if ($needBuild) {
  if (-not (Test-Path -LiteralPath $Csc)) {
    Fail "找不到系统自带的 C# 编译器：$Csc" "In-box C# compiler not found: $Csc (.NET Framework 4.x is required)"
  }
  Say "正在编译 rtx_hdr_host.exe …" "Building rtx_hdr_host.exe with $Csc"
  Push-Location -LiteralPath $Dir
  try {
    & $Csc /nologo /optimize+ /platform:x64 /target:exe /r:System.Web.Extensions.dll /out:rtx_hdr_host.exe RtxHdrHost.cs
    $rc = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($rc -ne 0) {
    Fail "编译失败（退出码 $rc）。如果弹窗正开着，请先关闭弹窗再重试。" "Build failed (exit code $rc). Close the extension popup (the host may be running) and try again."
  }
} else {
  Say "rtx_hdr_host.exe 已是最新，跳过编译。" "rtx_hdr_host.exe is up to date, skipping the build."
}

# 2) 注册：HKCU\<浏览器>\NativeMessagingHosts\io.github.rtx_hdr_switch 的默认值 = 清单的绝对路径
foreach ($k in $Keys) {
  $sub = "$k\$HostName"
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($sub)
  try {
    $key.SetValue('', $Manifest, [Microsoft.Win32.RegistryValueKind]::String)
  } finally {
    $key.Close()
  }
  Say "已注册 HKCU\$sub" "Registered HKCU\$sub = $Manifest"
}

# 3) 自检：按浏览器的方式发一条 hello，确认能启动并找到 nvcpl.dll
try {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.Arguments = 'chrome-extension://omgekmljdifpghaimigdbbbcmnjddmdd/ --parent-window=0'
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  # 控制台是 UTF-8 代码页时，Windows PowerShell 会先往子进程 stdin 写一个 BOM，破坏长度头；启动期间临时换成无 BOM 编码
  $savedIn = $null
  try { $savedIn = [Console]::InputEncoding; [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
  try {
    $p = [System.Diagnostics.Process]::Start($psi)
  } finally {
    if ($savedIn) { try { [Console]::InputEncoding = $savedIn } catch { } }
  }
  $errTask = $p.StandardError.ReadToEndAsync()
  $body = [System.Text.Encoding]::UTF8.GetBytes('{"cmd":"hello"}')
  $in = $p.StandardInput.BaseStream
  $in.Write([BitConverter]::GetBytes([int]$body.Length), 0, 4)
  $in.Write($body, 0, $body.Length)
  $in.Flush()
  $p.StandardInput.Close()
  $out = $p.StandardOutput.BaseStream
  $hdr = New-Object byte[] 4
  $got = 0
  while ($got -lt 4) { $r = $out.Read($hdr, $got, 4 - $got); if ($r -le 0) { break }; $got += $r }
  if ($got -lt 4) { throw "no reply" }
  $len = [BitConverter]::ToInt32($hdr, 0)
  $buf = New-Object byte[] $len
  $got = 0
  while ($got -lt $len) { $r = $out.Read($buf, $got, $len - $got); if ($r -le 0) { break }; $got += $r }
  if (-not $p.WaitForExit(5000)) { $p.Kill() }
  $null = $errTask.Wait(1000)
  $reply = [System.Text.Encoding]::UTF8.GetString($buf, 0, $got) | ConvertFrom-Json
  if (-not $reply.ok) { throw "bad reply" }
  if ($reply.dll) {
    Say "自检通过：本地组件 $($reply.version) 可用，使用 $($reply.dll)" "Self-test OK: host $($reply.version) runs and found $($reply.dll)"
  } else {
    Write-Warning "本地组件可以运行，但没找到 NVIDIA App 的 nvcpl.dll。请安装或更新 NVIDIA App。"
    Write-Warning "The host runs but nvcpl.dll was not found. Install or update NVIDIA App."
  }
} catch {
  Write-Warning "自检失败：$($_.Exception.Message)"
  Write-Warning "Self-test failed: $($_.Exception.Message)"
}

Write-Host ""
Say "安装完成。重新打开扩展弹窗即可使用「NVIDIA 视频设置」。卸载请运行 uninstall.cmd。" "Done. Reopen the extension popup to use the NVIDIA settings panel. Run uninstall.cmd to remove."
exit 0
