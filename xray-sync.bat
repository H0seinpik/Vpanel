@echo off
REM ===========================================================================
REM  VPanel - SYNC configs from the panel into Xray, then restart Xray
REM
REM  Run this after creating, editing or deleting a configuration in the panel.
REM  Without it, Xray keeps serving the old config.
REM ===========================================================================
setlocal
title VPanel - Xray Sync
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\xray.ps1" sync
set "EXITCODE=%ERRORLEVEL%"
echo.
echo   Press any key to close this window.
pause >nul
endlocal
exit /b %EXITCODE%
