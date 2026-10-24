@echo off
REM ===========================================================================
REM  VPanel - STOP
REM
REM  Stops the panel. Your database and settings are kept.
REM
REM  Options:
REM    stop.bat -Down    also remove the Docker containers (data volumes kept)
REM ===========================================================================

setlocal
title VPanel - Stop

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\stop.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
    echo.
    echo   Stop failed with code %EXITCODE%. See the messages above.
    echo.
    pause
)

endlocal
exit /b %EXITCODE%
