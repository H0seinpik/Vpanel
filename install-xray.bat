@echo off
REM ===========================================================================
REM  VPanel - DOWNLOAD AND INSTALL Xray
REM
REM  Xray is the actual proxy server. VPanel only manages it. Without Xray
REM  running, a generated configuration has nothing to connect to.
REM
REM  Installs to C:\xray
REM ===========================================================================
setlocal
title VPanel - Install Xray
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\install-xray.ps1" %*
set "EXITCODE=%ERRORLEVEL%"
echo.
echo   Press any key to close this window.
pause >nul
endlocal
exit /b %EXITCODE%
