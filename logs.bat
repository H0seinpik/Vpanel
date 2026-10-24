@echo off
REM ===========================================================================
REM  VPanel - LOGS
REM
REM  Usage:
REM    logs.bat                 recent web + worker output
REM    logs.bat worker          worker output only
REM    logs.bat web follow      follow the web log live (Ctrl+C to stop)
REM    logs.bat worker follow   follow the worker log live
REM ===========================================================================

setlocal
title VPanel - Logs

set "PSARGS=-Target all"
if /I "%~1"=="web"    set "PSARGS=-Target web"
if /I "%~1"=="worker" set "PSARGS=-Target worker"
if /I "%~1"=="follow" set "PSARGS=%PSARGS% -Follow"
if /I "%~2"=="follow" set "PSARGS=%PSARGS% -Follow"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\logs.ps1" %PSARGS%
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
    echo.
    echo   Logs failed with code %EXITCODE%.
    echo.
    pause
)

endlocal
exit /b %EXITCODE%
