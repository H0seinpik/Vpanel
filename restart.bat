@echo off
REM ===========================================================================
REM  VPanel - RESTART
REM
REM  Stops the panel and starts it again. Useful after changing .env.
REM ===========================================================================

setlocal
title VPanel - Restart

echo.
echo   Stopping VPanel...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\stop.ps1"

echo.
echo   Starting VPanel...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\start.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
    echo.
    echo   Restart failed with code %EXITCODE%. See the messages above.
    echo.
    pause
)

endlocal
exit /b %EXITCODE%
