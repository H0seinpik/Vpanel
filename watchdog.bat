@echo off
REM ===========================================================================
REM  VPanel - WATCHDOG
REM
REM  Starts the whole stack in the background and leaves NOTHING open:
REM
REM    * the panel (web server)
REM    * the worker
REM    * the watchdog, which then keeps all three alive and restarts any that
REM      stops
REM
REM  The watchdog runs hidden, so you can close this window (it closes on its
REM  own) without stopping anything.
REM
REM  It also starts automatically at sign-in (see the Startup folder), so you
REM  normally never need to run this by hand.
REM ===========================================================================

setlocal
title VPanel - Watchdog
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

echo.
echo   Starting VPanel: panel + worker + watchdog, all in the background...
echo.
echo   Nothing needs to stay open - this window closes by itself.
echo   The panel will be ready in a few seconds at http://localhost:3000
echo.

wscript.exe "%~dp0scripts\run-watchdog.vbs"

timeout /t 4 >nul

endlocal
