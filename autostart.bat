@echo off
REM ===========================================================================
REM  VPanel - AUTOSTART AT SIGN-IN
REM
REM  Usage:
REM    autostart.bat            show the current setting
REM    autostart.bat install    start VPanel automatically when you sign in
REM    autostart.bat remove     stop doing that
REM
REM  Needs no administrator rights.
REM ===========================================================================

setlocal
title VPanel - Autostart

set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=status"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\autostart.ps1" %ACTION%
set "EXITCODE=%ERRORLEVEL%"

echo.
echo   Press any key to close this window.
pause >nul

endlocal
exit /b %EXITCODE%
