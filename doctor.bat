@echo off
REM ===========================================================================
REM  VPanel - DOCTOR
REM
REM  Answers "is my panel actually working?" without opening a browser.
REM
REM  It reports whether the panel, worker and watchdog are alive, whether Xray is
REM  running, whether the generated node config is valid, how much traffic each
REM  configuration has used against its ceiling, and whether the traffic counters
REM  can be read.
REM
REM  Pass --connect to also open a real connection through every active
REM  configuration (slower, but it proves the configs are reachable).
REM ===========================================================================

setlocal
title VPanel - Doctor

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   Node.js was not found on PATH.
    echo   Run install.bat first.
    echo.
    pause >nul
    exit /b 1
)

if /i "%~1"=="--connect" (
    node --env-file=.env --import tsx scripts\doctor.ts --connect
) else (
    node --env-file=.env --import tsx scripts\doctor.ts
)
set "EXITCODE=%ERRORLEVEL%"

echo.
echo   Press any key to close this window.
pause >nul

endlocal
exit /b %EXITCODE%
