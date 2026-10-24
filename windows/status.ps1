# =============================================================================
# VPanel - status report.
#
#   powershell -ExecutionPolicy Bypass -File windows\status.ps1
#
# Shows the runtime mode, whether the panel is running and healthy, the
# database connection, the worker, and the URLs to use.
# =============================================================================

. (Join-Path $PSScriptRoot '_vpanel.ps1')

$root = Get-VPanelRoot
$envPath = Join-Path $root '.env'

Write-Head 'VPanel - status'

# --- Configuration -----------------------------------------------------------
if (-not (Test-Path -LiteralPath $envPath)) {
    Write-Err '.env is missing - run install.bat first'
    exit 1
}

$envMap = Get-DotEnv -Root $root
$mode = Get-VPanelMode
$port = Get-VPanelPort -Mode $mode -Env $envMap
$url = Get-VPanelUrl -Mode $mode -Env $envMap

Write-Host "  Runtime          : $mode" -ForegroundColor Gray

# --- Database ----------------------------------------------------------------
$databaseUrl = Get-EnvValue -Env $envMap -Key 'DATABASE_URL'
$db = Get-DatabaseTarget -DatabaseUrl $databaseUrl
if (Test-TcpPort -ComputerName $db.Host -Port $db.Port) {
    Write-Host "  Database         : " -NoNewline -ForegroundColor Gray
    Write-Host "reachable at $($db.Host):$($db.Port)" -ForegroundColor Green
} else {
    Write-Host "  Database         : " -NoNewline -ForegroundColor Gray
    Write-Host "NOT reachable at $($db.Host):$($db.Port)" -ForegroundColor Red
}

# --- Application health ------------------------------------------------------
$healthUrl = "$url/api/health"
$healthy = $false
$healthBody = $null

try {
    $resp = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5
    if ($resp.StatusCode -eq 200) {
        $healthy = $true
        $healthBody = $resp.Content | ConvertFrom-Json
    }
} catch {
    $healthy = $false
}

if ($healthy) {
    Write-Host "  Panel            : " -NoNewline -ForegroundColor Gray
    Write-Host "healthy (HTTP 200)" -ForegroundColor Green
} else {
    Write-Host "  Panel            : " -NoNewline -ForegroundColor Gray
    Write-Host "not responding" -ForegroundColor Red
}

# --- Per-mode detail ---------------------------------------------------------
if ($mode -eq 'docker') {
    Write-Host ''
    Write-Host '  Containers:' -ForegroundColor Gray
    Push-Location -LiteralPath $root
    try {
        & docker compose ps --format 'table {{.Service}}\t{{.Status}}'
    } catch {
        Write-Warn 'could not read container status'
    } finally {
        Pop-Location
    }
} else {
    $state = Read-State
    Write-Host ''
    if ($state) {
        $webAlive = Test-ProcessAlive -ProcessId ([int]$state.webPid)
        $workerAlive = Test-ProcessAlive -ProcessId ([int]$state.workerPid)

        Write-Host '  Processes:' -ForegroundColor Gray
        Write-Host "    web    PID $($state.webPid)  " -NoNewline -ForegroundColor DarkGray
        if ($webAlive) { Write-Host 'running' -ForegroundColor Green } else { Write-Host 'stopped' -ForegroundColor Red }

        Write-Host "    worker PID $($state.workerPid)  " -NoNewline -ForegroundColor DarkGray
        if ($workerAlive) { Write-Host 'running' -ForegroundColor Green } else { Write-Host 'stopped' -ForegroundColor Red }

        Write-Host "    started $($state.startedAt)" -ForegroundColor DarkGray
    } else {
        Write-Host '  Processes: not running (no state file)' -ForegroundColor Yellow
    }
}

# --- Health payload ----------------------------------------------------------
if ($healthBody) {
    Write-Host ''
    Write-Host '  Reported by /api/health:' -ForegroundColor Gray
    Write-Host "    version       $($healthBody.version)" -ForegroundColor DarkGray
    Write-Host "    environment   $($healthBody.environment)" -ForegroundColor DarkGray
    Write-Host "    database      $($healthBody.checks.database)" -ForegroundColor DarkGray
    Write-Host "    node provider $($healthBody.providers.node)" -ForegroundColor DarkGray
    Write-Host "    redis         $($healthBody.providers.redis)" -ForegroundColor DarkGray
    Write-Host "    uptime        $([math]::Round($healthBody.uptimeSeconds / 60, 1)) minutes" -ForegroundColor DarkGray
}

# --- URLs --------------------------------------------------------------------
$lanIp = Get-LanIp
$lanUrl = if ($port -eq 80) { "http://$lanIp" } else { "http://${lanIp}:$port" }

Write-Host ''
Write-Host '  On this PC     : ' -NoNewline -ForegroundColor Gray
Write-Host $url -ForegroundColor Cyan
Write-Host '  From your LAN  : ' -NoNewline -ForegroundColor Gray
Write-Host $lanUrl -ForegroundColor Cyan
Write-Host '  Health check   : ' -NoNewline -ForegroundColor Gray
Write-Host $healthUrl -ForegroundColor Cyan
Write-Host ''

if (-not $healthy) {
    Write-Step 'Run logs.bat to see why the panel is not responding.'
}

exit 0
