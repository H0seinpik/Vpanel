@echo off
REM ===========================================================================
REM  VPanel - Xray STATUS (running? which ports are open?)
REM ===========================================================================
setlocal
title VPanel - Xray Status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\xray.ps1" status
echo.
echo   Press any key to close this window.
pause >nul
endlocal
exit /b 0
