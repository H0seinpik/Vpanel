@echo off
REM ===========================================================================
REM  VPanel - FIRST-TIME INSTALL
REM
REM  Run this once. It creates .env, installs dependencies, sets up the
REM  database and creates your administrator account.
REM
REM  Options:
REM    install.bat -Force       regenerate .env secrets
REM    install.bat -SkipSeed    skip roles/plans/admin creation
REM ===========================================================================

setlocal
title VPanel - Install

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\install.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

echo.
echo   Press any key to close this window.
pause >nul

endlocal
exit /b %EXITCODE%
