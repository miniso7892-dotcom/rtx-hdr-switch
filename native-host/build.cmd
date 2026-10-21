@echo off
rem Builds rtx_hdr_host.exe with the C# compiler that ships with Windows 10/11
rem (.NET Framework 4.x csc.exe, C# 5 only). No admin rights needed.
setlocal
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo csc.exe not found: "%CSC%"
  exit /b 1
)
pushd "%~dp0" || exit /b 1
"%CSC%" /nologo /optimize+ /platform:x64 /target:exe /r:System.Web.Extensions.dll /out:rtx_hdr_host.exe RtxHdrHost.cs
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" (
  echo Build failed with exit code %RC%.
  exit /b %RC%
)
echo Built "%~dp0rtx_hdr_host.exe"
