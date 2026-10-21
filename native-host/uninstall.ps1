# RTX HDR Switch 本地组件卸载：删除 install.ps1 写入的 HKCU 注册表项（无需管理员）。文件本身不删除。
# Removes the HKCU registry keys written by install.ps1 (no admin). Files are left in place.
$ErrorActionPreference = 'Stop'

$HostName = 'io.github.rtx_hdr_switch'
$Keys = @(
  'Software\Google\Chrome\NativeMessagingHosts',
  'Software\Microsoft\Edge\NativeMessagingHosts',
  'Software\Chromium\NativeMessagingHosts'
)

function Say([string]$zh, [string]$en) {
  Write-Host $zh
  Write-Host "  $en" -ForegroundColor DarkGray
}

foreach ($k in $Keys) {
  $sub = "$k\$HostName"
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub)
  if ($key) {
    $key.Close()
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($sub)
    Say "已删除 HKCU\$sub" "Removed HKCU\$sub"
  } else {
    Say "未注册 HKCU\$sub（跳过）" "Not registered: HKCU\$sub (skipped)"
  }
}

Write-Host ""
Say "卸载完成。NVIDIA 设置保持当前值不变；如不再需要，可以删除 rtx_hdr_host.exe。" "Done. Your NVIDIA settings keep their current values. You can delete rtx_hdr_host.exe if you no longer need it."
exit 0
