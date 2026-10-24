@echo off
REM ===========================================================================
REM  VPanel - CREATE or REPLACE the TLS certificate
REM
REM  Every TLS configuration (Trojan, VLESS+TLS, and anything sharing a port)
REM  needs this certificate. Without it those configurations are skipped and
REM  clients cannot connect.
REM
REM  Run it with no arguments to create the pair if it is missing. It REFUSES
REM  to replace an existing pair, because that changes the certificate pin and
REM  breaks every client link already handed out.
REM
REM  To really replace it (you will re-issue every client):
REM      xray-gencert.bat -Force
REM
REM  To set the name on the certificate explicitly:
REM      xray-gencert.bat -Domain your.host.name
REM ===========================================================================
setlocal
title VPanel - Xray Certificate
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\xray.ps1" gencert %*
set "EXITCODE=%ERRORLEVEL%"
echo.
echo   Press any key to close this window.
pause >nul
endlocal
exit /b %EXITCODE%
