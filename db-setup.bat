@echo off
REM ===========================================================================
REM  VPanel - CREATE THE DATABASE (native mode only)
REM
REM  Creates the PostgreSQL role and database that .env points at. Run this
REM  once after installing PostgreSQL, or any time the database is missing.
REM
REM  You will be asked for the PostgreSQL superuser password - the one you set
REM  when installing PostgreSQL. It is used once and never stored.
REM
REM  Options:
REM    db-setup.bat -SuperUser postgres
REM ===========================================================================

setlocal
title VPanel - Database Setup

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\db-setup.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

echo.
echo   Press any key to close this window.
pause >nul

endlocal
exit /b %EXITCODE%
