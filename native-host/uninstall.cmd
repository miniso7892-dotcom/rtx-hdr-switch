@echo off
rem Double-click to remove the RTX HDR Switch native host registry keys (HKCU, no admin).
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
set "RC=%ERRORLEVEL%"
rem Keep the window open when started by double-click from Explorer.
rem CMDCMDLINE is read with delayed expansion so an ampersand in the folder name is not run as a command.
setlocal EnableDelayedExpansion
set "CL=!CMDCMDLINE!"
if /i not "!CL:%~nx0=!"=="!CL!" pause
endlocal
exit /b %RC%
