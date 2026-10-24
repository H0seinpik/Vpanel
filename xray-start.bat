@echo off
REM ===========================================================================
REM  VPanel - START Xray (the process that actually accepts connections)
REM ===========================================================================
setlocal
title VPanel - Xray Start
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\xray.ps1" start
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
    echo.
    echo   Failed with code %EXITCODE%. See the messages above.
    echo.
    pause
)
endlocal
exit /b %EXITCODE%
