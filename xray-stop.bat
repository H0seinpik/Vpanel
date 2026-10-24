@echo off
REM ===========================================================================
REM  VPanel - STOP Xray
REM ===========================================================================
setlocal
title VPanel - Xray Stop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\xray.ps1" stop
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
    echo.
    echo   Failed with code %EXITCODE%.
    echo.
    pause
)
endlocal
exit /b %EXITCODE%
