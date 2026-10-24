# =============================================================================
# VPanel - stop the panel.
#
#   powershell -ExecutionPolicy Bypass -File windows\stop.ps1
#   powershell -ExecutionPolicy Bypass -File windows\stop.ps1 -Down
#
# Default: stop the services but keep the containers / database data intact.
# -Down  : remove the Docker containers entirely (volumes are still kept, so no
#          data is lost - start.bat recreates them on the next run).
# =============================================================================

param(
    [switch]$Down
)

. (Join-Path $PSScriptRoot '_vpanel.ps1')

$root = Get-VPanelRoot
$envMap = Get-DotEnv -Root $root
$mode = Get-VPanelMode

Write-Head 'VPanel - stop'

# -----------------------------------------------------------------------------
# Docker mode
# -----------------------------------------------------------------------------
if ($mode -eq 'docker') {
    if ($Down) {
        Write-Step 'removing containers (named volumes are preserved)'
        Invoke-Compose @('down')
        Write-Ok 'containers removed - your database data is still in the volumes'
    } else {
        Write-Step 'stopping containers'
        Invoke-Compose @('stop')
        Write-Ok 'containers stopped'
        Write-Step 'run start.bat to bring them back up'
    }
    exit 0
}

# -----------------------------------------------------------------------------
# Native mode
# -----------------------------------------------------------------------------
$state = Read-State

if (-not $state) {
    Write-Warn 'no running instance was recorded (.vpanel\runtime.json is absent)'
    Write-Step 'looking for stray VPanel node processes anyway'

    # Fall back to identifying our processes by their command line.
    $stray = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and ($_.CommandLine -like '*next*start*' -or $_.CommandLine -like '*workers/index.ts*') }

    if (-not $stray) {
        Write-Ok 'nothing to stop'
        exit 0
    }

    foreach ($proc in $stray) {
        Write-Step "stopping PID $($proc.ProcessId)"
        Stop-ProcessTree -ProcessId ([int]$proc.ProcessId)
    }
    Write-Ok 'stopped'
    exit 0
}

$stopped = 0

foreach ($name in @('workerPid', 'webPid')) {
    if (-not $state.PSObject.Properties.Name.Contains($name)) { continue }

    $procId = [int]$state.$name
    if ($procId -le 0) { continue }

    if (Test-ProcessAlive -ProcessId $procId) {
        Write-Step "stopping $name (PID $procId)"
        Stop-ProcessTree -ProcessId $procId
        $stopped++
    } else {
        Write-Step "$name (PID $procId) was not running"
    }
}

# --- Xray --------------------------------------------------------------------
# Xray is started by the worker, but it is not always the worker's child: a
# worker that died can leave it orphaned, still holding the public ports. A stop
# that leaves xray running is not a stop - the next start would find its ports
# busy and its own xray would fail to bind, which looks like "the node is down".
# Kill every xray that is running from XRAY_DIR (never another copy elsewhere).
$xrayDir = 'C:\xray'
if ($env:XRAY_DIR) {
    $xrayDir = $env:XRAY_DIR
} else {
    $envFile = Join-Path $root '.env'
    if (Test-Path -LiteralPath $envFile) {
        $match = Select-String -LiteralPath $envFile -Pattern '^\s*XRAY_DIR\s*=\s*(.+)$' -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($match) { $xrayDir = $match.Matches[0].Groups[1].Value.Trim().Trim('"') }
    }
}

$xrayExe = Join-Path $xrayDir 'xray.exe'
$xrays = Get-Process -Name 'xray' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path -ieq $xrayExe }
foreach ($proc in $xrays) {
    Write-Step "stopping xray (PID $($proc.Id))"
    Stop-ProcessTree -ProcessId ([int]$proc.Id)
    $stopped++
}

Clear-State

# Release the single-writer lock. The worker removes it on a clean SIGTERM, but
# a forced stop (or a killed process) leaves it behind; removing it here means
# the next start never has to reclaim a stale lock. The worker's heartbeat and
# stats files go too, so a fresh start cannot read a dead pid's last state.
$lockPath = Join-Path $xrayDir '.vpanel-worker.lock'
if (Test-Path -LiteralPath $lockPath) {
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    Write-Step 'released the node config lock'
}
foreach ($stale in @('.vpanel-worker.heartbeat', '.vpanel-state.json')) {
    $stalePath = Join-Path $xrayDir $stale
    if (Test-Path -LiteralPath $stalePath) {
        Remove-Item -LiteralPath $stalePath -Force -ErrorAction SilentlyContinue
    }
}

if ($stopped -gt 0) {
    Write-Ok "$stopped process(es) stopped"
} else {
    Write-Ok 'nothing was running'
}

Write-Step 'your database and configuration are untouched'
exit 0
