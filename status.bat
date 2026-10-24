@echo off
REM ===========================================================================
REM  VPanel - STATUS
REM
REM  Shows whether the panel is running, how healthy it is, and the URLs to use
REM  from this PC and from other devices on your network.
REM ===========================================================================

setlocal
title VPanel - Status

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\status.ps1"
set "EXITCODE=%ERRORLEVEL%"

echo.
echo   Press any key to close this window.
pause >nul

endlocal
exit /b %EXITCODE%
