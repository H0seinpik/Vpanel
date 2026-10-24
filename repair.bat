@echo off
REM ===========================================================================
REM  VPanel - REPAIR node_modules
REM
REM  Run this if you see errors like:
REM      'prisma' is not recognized as an internal or external command
REM      'next' is not recognized ...
REM      Cannot find module '...'
REM
REM  It checks what is actually present, recreates missing npm bin shims and
REM  regenerates the Prisma client.
REM
REM  Options:
REM    repair.bat -Reinstall    delete node_modules and reinstall from scratch
REM                             (slow, but fixes almost anything)
REM ===========================================================================

setlocal
title VPanel - Repair

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\repair.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

echo.
echo   Press any key to close this window.
pause >nul

endlocal
exit /b %EXITCODE%
