@echo off
REM ===========================================================================
REM  VPanel - FIREWALL
REM
REM  Opens EVERYTHING the panel needs, in one go:
REM    * the panel port          (from your LAN only)
REM    * every proxy port        (from the internet - this is what your
REM                               customers' apps connect to)
REM
REM  The proxy ports are read from the live Xray config, so a configuration you
REM  add in the panel is opened without editing anything here. A port that is no
REM  longer served is closed again.
REM
REM  Usage:
REM    firewall.bat             open the panel port AND every proxy port
REM    firewall.bat status      show which ports are open and which are missing
REM    firewall.bat add-port    open only the proxy ports
REM    firewall.bat remove      close everything VPanel opened
REM
REM  RIGHT-CLICK THIS FILE AND CHOOSE "Run as administrator".
REM  Without it the rules cannot be created, and every client outside this
REM  machine is refused while a test run on the machine itself still succeeds.
REM ===========================================================================

setlocal
title VPanel - Firewall

set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=all"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\firewall.ps1" %ACTION%
set "EXITCODE=%ERRORLEVEL%"

echo.
echo   Press any key to close this window.
pause >nul

endlocal
exit /b %EXITCODE%
