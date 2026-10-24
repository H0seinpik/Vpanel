@echo off
REM ===========================================================================
REM  VPanel - START
REM
REM  Double-click this file to start the panel, or run it from a terminal.
REM
REM  Options (pass after the file name):
REM    start.bat -Rebuild      rebuild images / the app before starting
REM    start.bat -NoBrowser    do not open a browser window
REM ===========================================================================

setlocal
title VPanel - Start

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\start.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
    echo.
    echo   Start failed with code %EXITCODE%. See the messages above.
    echo.
    pause
)

endlocal
exit /b %EXITCODE%
