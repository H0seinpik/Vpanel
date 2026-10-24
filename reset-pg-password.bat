@echo off
REM ===========================================================================
REM  VPanel - RESET THE POSTGRESQL SUPERUSER PASSWORD
REM
REM  Use this if you do not know the password you chose when installing
REM  PostgreSQL. It briefly makes local connections password-free, sets the new
REM  password, then puts the original authentication rules straight back.
REM
REM  A Windows UAC prompt will appear - approve it.
REM
REM  Default new password: 123
REM  Choose your own:
REM      reset-pg-password.bat -Password "SomethingBetter123"
REM ===========================================================================

setlocal
title VPanel - Reset PostgreSQL Password

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\reset-pg-password.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

echo.
echo   If an elevated window opened, continue in that window.
echo.
echo   Press any key to close this one.
pause >nul

endlocal
exit /b %EXITCODE%
