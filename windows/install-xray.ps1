# =============================================================================
# VPanel - download and install Xray.
#
#   powershell -ExecutionPolicy Bypass -File windows\install-xray.ps1
#   powershell -ExecutionPolicy Bypass -File windows\install-xray.ps1 -Version v26.3.27
#
# Installs to C:\xray (override with the XRAY_DIR environment variable).
#
# Xray is the actual proxy server. VPanel is only the management panel - without
# Xray running, a generated configuration has nothing to connect to.
# =============================================================================

param(
    [string]$Version = '',
    [string]$TargetDir = ''
)

. (Join-Path $PSScriptRoot '_vpanel.ps1')

if ($TargetDir -eq '') {
    $TargetDir = 'C:\xray'
    if ($env:XRAY_DIR) { $TargetDir = $env:XRAY_DIR }
}

Write-Head 'VPanel - install Xray'

$XrayExe = Join-Path $TargetDir 'xray.exe'

if ((Test-Path -LiteralPath $XrayExe) -and $Version -eq '') {
    Write-Ok "xray.exe already present in $TargetDir"
    Push-Location -LiteralPath $TargetDir
    try { & $XrayExe version 2>&1 | Select-Object -First 1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
    finally { Pop-Location }
    Write-Host ''
    Write-Host '  Nothing to do. Use -Version to force a specific release.' -ForegroundColor Gray
    Write-Host ''
    exit 0
}

# --- Work out which release --------------------------------------------------
$release = $null
try {
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/XTLS/Xray-core/releases/latest' `
        -Headers @{ 'User-Agent' = 'vpanel' } -TimeoutSec 30 -ErrorAction Stop
} catch {
    Write-Err 'could not reach the GitHub API'
    Write-Step 'Check your internet connection, or download Xray manually from:'
    Write-Step '  https://github.com/XTLS/Xray-core/releases'
    exit 1
}

$tag = $release.tag_name
if ($Version -ne '') { $tag = $Version }

$asset = $release.assets | Where-Object { $_.name -eq 'Xray-windows-64.zip' } | Select-Object -First 1
if (-not $asset) {
    Write-Err "could not find Xray-windows-64.zip in release $tag"
    exit 1
}

$url = $asset.browser_download_url
Write-Step "release : $tag"
Write-Step "asset   : Xray-windows-64.zip ($([math]::Round($asset.size / 1MB, 1)) MB)"

if (-not (Test-Path -LiteralPath $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    Write-Ok "created $TargetDir"
}

# --- Download ----------------------------------------------------------------
$zipPath = Join-Path $TargetDir 'Xray-windows-64.zip'
Write-Step 'downloading'

try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -TimeoutSec 300 -ErrorAction Stop
} catch {
    Write-Err 'download failed'
    Write-Step $_.Exception.Message
    exit 1
}
Write-Ok "downloaded ($([math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 1)) MB)"

# --- Extract -----------------------------------------------------------------
Write-Step 'extracting'
try {
    Expand-Archive -Path $zipPath -DestinationPath $TargetDir -Force -ErrorAction Stop
} catch {
    Write-Err 'extraction failed'
    Write-Step $_.Exception.Message
    exit 1
}

Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue

if (-not (Test-Path -LiteralPath $XrayExe)) {
    Write-Err "xray.exe was not found after extraction - check $TargetDir"
    exit 1
}

Write-Ok "installed to $TargetDir"

Push-Location -LiteralPath $TargetDir
try { & $XrayExe version 2>&1 | Select-Object -First 1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
finally { Pop-Location }

Write-Host ''
Write-Host '  Next:' -ForegroundColor Green
Write-Host '    1. create a configuration in the panel (Configurations -> Create)' -ForegroundColor Gray
Write-Host '    2. xray-sync.bat     render it into Xray and start the server' -ForegroundColor Gray
Write-Host '    3. firewall.bat add-port   allow the port through the firewall' -ForegroundColor Gray
Write-Host ''

exit 0
