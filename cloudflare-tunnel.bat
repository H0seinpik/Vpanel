@echo off
REM ===========================================================================
REM  VPanel - Cloudflare quick tunnel (the ONLY Cloudflare option with no domain)
REM
REM  Usage:   cloudflare-tunnel.bat 443
REM           cloudflare-tunnel.bat 8443
REM
REM  WHAT IT DOES
REM    Runs "cloudflared" and gives your local proxy port a public hostname on
REM    https://xxxx.trycloudflare.com  — no domain and no Cloudflare account.
REM
REM  READ THIS BEFORE USING IT
REM    1. The hostname CHANGES EVERY TIME you restart this. A quick tunnel is a
REM       temporary testing feature, not a production address. Your users would
REM       need a new link after every restart — the opposite of "stays connected".
REM    2. Cloudflare does NOT reduce your traffic. A proxy carries no cacheable
REM       content, so every request still reaches this machine. What it does is
REM       hide the origin IP, which stops internet scanners and bots from hitting
REM       your ports directly.
REM    3. It adds an extra hop, so latency usually gets worse, not better.
REM    4. For a STABLE hostname you need a real domain on a Cloudflare account.
REM
REM  If you want this to be stable, get a domain first. Everything else here is
REM  a stopgap.
REM ===========================================================================

setlocal
title VPanel - Cloudflare quick tunnel

set "PORT=%~1"
if "%PORT%"=="" set "PORT=443"

set "CF=C:\xray\cloudflared.exe"

if not exist "%CF%" (
  echo.
  echo   Downloading cloudflared... this happens once.
  echo.
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ProgressPreference='SilentlyContinue';" ^
    "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%CF%';"
  if errorlevel 1 (
    echo   Download failed - check the internet connection on this machine.
    pause
    exit /b 1
  )
)

echo.
echo   Starting the tunnel on local port %PORT%.
echo.
echo   Cloudflare will print a line like:
echo      Your quick Tunnel has been created! Visit it at:
echo      https://something.trycloudflare.com
echo.
echo   COPY THAT ADDRESS - it is your temporary hostname.
echo   Press Ctrl+C here to stop the tunnel.
echo.

"%CF%" tunnel --no-autoupdate --url http://127.0.0.1:%PORT%

endlocal
