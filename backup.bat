@echo off
REM ===========================================================================
REM  VPanel - BACKUP
REM
REM  Writes a compressed database dump plus a checksum into .\backups and
REM  prunes dumps older than the retention window.
REM
REM  Options:
REM    backup.bat -KeepDays 30
REM ===========================================================================

setlocal
title VPanel - Backup

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\backup.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

echo.
echo   Press any key to close this window.
pause >nul

endlocal
exit /b %EXITCODE%
