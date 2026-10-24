# =============================================================================
# VPanel - start the panel.
#
# Auto-detects how to run:
#   docker  - a working Docker engine is available (starts the whole stack)
#   native  - Node.js + a reachable PostgreSQL (runs web + worker directly)
#
#   powershell -ExecutionPolicy Bypass -File windows\start.ps1
#   powershell -ExecutionPolicy Bypass -File windows\start.ps1 -Rebuild
#   powershell -ExecutionPolicy Bypass -File windows\start.ps1 -NoBrowser
# =============================================================================

param(
    [switch]$NoBrowser,
    [switch]$Rebuild
)

. (Join-Path $PSScriptRoot '_vpanel.ps1')

$root = Get-VPanelRoot
$envPath = Join-Path $root '.env'

Write-Head 'VPanel - start'

if (-not (Test-Path -LiteralPath $envPath)) {
    Write-Err ".env not found in $root"
    Write-Step 'Run install.bat first to create it.'
    exit 1
}

$envMap = Get-DotEnv -Root $root
$mode = Get-VPanelMode
$port = Get-VPanelPort -Mode $mode -Env $envMap
$url = Get-VPanelUrl -Mode $mode -Env $envMap

Write-Step "runtime: $mode"

# -----------------------------------------------------------------------------
# Docker mode
# -----------------------------------------------------------------------------
if ($mode -eq 'docker') {
    $composeArgs = @('up', '-d')
    if ($Rebuild) { $composeArgs += '--build' }

    Write-Step 'starting containers (postgres, redis, web, worker, nginx)'
    Invoke-Compose $composeArgs
    Write-Ok 'containers started'
}

# -----------------------------------------------------------------------------
# Native mode
# -----------------------------------------------------------------------------
else {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Err 'Node.js was not found on PATH.'
        Write-Step 'Install Node.js 20 or newer from https://nodejs.org, then retry.'
        Write-Step 'Alternatively install Docker Desktop and re-run this script.'
        exit 1
    }

    # --- Database reachability ------------------------------------------------
    $databaseUrl = Get-EnvValue -Env $envMap -Key 'DATABASE_URL'
    if ($databaseUrl -eq '') {
        Write-Err 'DATABASE_URL is missing from .env'
        Write-Step 'Run setup-env.ps1, or edit .env manually.'
        exit 1
    }

    $db = Get-DatabaseTarget -DatabaseUrl $databaseUrl
    $service = Get-PostgresService

    # A stopped service after a reboot is the usual reason start fails.
    if (-not (Test-TcpPort -ComputerName $db.Host -Port $db.Port) -and $service -and $service.Status -ne 'Running') {
        Write-Step "PostgreSQL is stopped - starting $($service.Name)"
        $pgStarted = $false
        try {
            Start-Service -Name $service.Name -ErrorAction Stop
            $pgStarted = $true
        } catch {
            # This console is not elevated. Starting a Windows service needs
            # administrator rights, and it is the only step in a start that does -
            # so ask for them once via UAC instead of failing the whole start.
            Write-Step 'needs administrator rights - asking via UAC'
            try {
                Start-Process -FilePath 'net.exe' -ArgumentList @('start', $service.Name) -Verb RunAs -Wait
                $pgStarted = $true
            } catch {
                Write-Warn "could not start $($service.Name) - the request was declined"
            }
        }
        if ($pgStarted) { Start-Sleep -Seconds 3 }
    }

    if (-not (Test-TcpPort -ComputerName $db.Host -Port $db.Port)) {
        Write-Err "PostgreSQL is not reachable at $($db.Host):$($db.Port)"
        Write-Host ''

        if ($service) {
            Write-Host '  The service exists but is not running. Start it with:' -ForegroundColor White
            Write-Host "      net start $($service.Name)" -ForegroundColor DarkYellow
            Write-Host '  (needs an elevated window), then run start.bat again.' -ForegroundColor DarkGray
        } elseif (Resolve-PgTool -Tool 'psql') {
            Write-Host '  PostgreSQL is installed but nothing is listening.' -ForegroundColor White
            Write-Host '  Check services.msc for a postgresql* service.' -ForegroundColor Gray
        } else {
            Write-Host '  PostgreSQL is not installed. Either:' -ForegroundColor White
            Write-Host '      winget search PostgreSQL       (find the current package id)' -ForegroundColor DarkYellow
            Write-Host '      winget install <id>' -ForegroundColor DarkYellow
            Write-Host '      db-setup.bat      then install.bat' -ForegroundColor DarkYellow
            Write-Host '  or install Docker Desktop and re-run start.bat.' -ForegroundColor Gray
        }

        Write-Host ''
        exit 1
    }
    Write-Ok "PostgreSQL reachable at $($db.Host):$($db.Port)"

    # --- Already running? / what is missing? ---------------------------------
    #
    # Both checks used to be keyed on webPid alone, so a live web server with a
    # DEAD worker printed "already running" and exited - and nothing ever
    # restarted the worker. That exact state is what left every proxy client
    # disconnected on 2026-09-28. start.bat is now a self-healer: it ends with a
    # healthy stack or a clear reason why it could not be one.
    $state = Read-State
    $webAlive = $false
    if ($state -and $state.PSObject.Properties.Name.Contains('webPid') -and ([int]$state.webPid) -gt 0) {
        $webAlive = Test-ProcessAlive -ProcessId ([int]$state.webPid)
    }

    # A live worker with a dead web server is the exact state that produced TWO
    # workers: this script only used to check webPid, so it launched a second
    # worker beside the surviving one. Both then drove the 15 s reconcile loop,
    # rendered contradictory configs and wiped config.json - every port went
    # down for ~12 minutes. Never start a worker while one is already alive.
    $existingWorker = $null

    # 1. The lock file is the authority on which process owns config.json, so it is
    #    checked first. runtime.json can hold a stale pid, or the pid of the tsx
    #    launcher rather than the daemon that actually holds the lock.
    $xrayDir = if ($env:XRAY_DIR) { $env:XRAY_DIR } else { 'C:\xray' }
    $lockPath = Join-Path $xrayDir '.vpanel-worker.lock'
    if (Test-Path -LiteralPath $lockPath) {
        try {
            $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
            if ($lock.pid -and (Test-ProcessAlive -ProcessId ([int]$lock.pid))) {
                $existingWorker = [int]$lock.pid
            }
        } catch { }
    }

    # 2. The pid this script recorded on its previous run.
    if (-not $existingWorker -and $state -and
        $state.PSObject.Properties.Name.Contains('workerPid') -and ([int]$state.workerPid) -gt 0) {
        if (Test-ProcessAlive -ProcessId ([int]$state.workerPid)) {
            $existingWorker = [int]$state.workerPid
        }
    }

    # 3. Last resort: find the worker by command line, EXCLUDING the tsx launcher.
    if (-not $existingWorker) {
        # Last resort: find the worker by command line, EXCLUDING the tsx launcher.
        # `npm run worker` is two processes - a launcher (tsx\dist\cli.mjs) plus its
        # node child - and picking the launcher would report a worker that is not
        # the process which actually holds the lock.
        $found = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -and $_.CommandLine -like '*workers/index.ts*' -and
                $_.CommandLine -notlike '*tsx/dist/cli.mjs*' -and
                $_.CommandLine -notlike '*tsx\dist\cli.mjs*'
            } |
            Select-Object -First 1
        if ($found) { $existingWorker = [int]$found.ProcessId }
    }

    if (-not $webAlive) {
        # The recorded web pid goes stale for the same reason, so identify the web
        # server by its command line exactly as the worker is found above. Without
        # this, start.bat launched a SECOND panel onto an occupied port: the
        # duplicate failed to bind, and the script reported success while the real
        # panel was some other process it no longer knew about.
        $foundWeb = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -like '*next*start*' } |
            Select-Object -First 1
        if ($foundWeb) {
            $webAlive = $true
            $state.webPid = [int]$foundWeb.ProcessId
            Write-Step "a web server is already running (PID $($foundWeb.ProcessId)) - reusing it"
        }
    }

    if ($webAlive -and $existingWorker) {
        Write-Ok "VPanel is already running (web PID $($state.webPid), worker PID $existingWorker)"
        Write-Step "Open $url - use restart.bat to restart, stop.bat to stop."
        if (-not $NoBrowser) { Start-Process $url }
        exit 0
    }

    if ($webAlive -and -not $existingWorker) {
        # The panel answers, but nothing is reconciling the node: traffic is not
        # collected, ceilings are not enforced and config.json is not maintained.
        # Start ONLY the worker - the web server is left untouched, so nobody who
        # is using the panel loses their session.
        Write-Warn "the web server is running (PID $($state.webPid)) but the worker is NOT"
        Write-Step 'starting only the worker - the panel stays up'
    }

    $npm = Get-Command npm -ErrorAction SilentlyContinue

    # --- Build (first run only) ----------------------------------------------
    # Skipped when only the worker needs starting: the web server is already up.
    $buildId = Join-Path $root '.next\BUILD_ID'
    if ($webAlive) {
        Write-Step 'web server already running - skipping the build check'
    } elseif ($Rebuild -or -not (Test-Path -LiteralPath $buildId)) {
        if (-not $npm) {
            Write-Err 'npm was not found on PATH, so the application cannot be built.'
            exit 1
        }
        Write-Step 'building the application (first run only - this takes a few minutes)'
        Push-Location -LiteralPath $root
        try {
            & npm run build
            $code = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        if ($code -ne 0) {
            Write-Err "the build failed (exit code $code) - see the output above"
            Write-Host ''
            Write-Host '  If the output mentions a command that is "not recognized",' -ForegroundColor Gray
            Write-Host '  or a module that cannot be found, the dependencies are broken:' -ForegroundColor Gray
            Write-Host '      repair.bat' -ForegroundColor DarkYellow
            Write-Host '  If it mentions memory, close other applications and retry.' -ForegroundColor DarkGray
            Write-Host ''
            exit 1
        }
        Write-Ok 'build complete'
    }

    # --- Schema ---------------------------------------------------------------
    if ($webAlive) {
        Write-Step 'web server already running - skipping the schema check'
    } elseif (Test-PrismaMigrations) {
        Write-Step 'applying database migrations'
        Push-Location -LiteralPath $root
        try {
            & node 'node_modules/prisma/build/index.js' migrate deploy
            $code = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        if ($code -ne 0) {
            Write-Warn 'migrations reported a problem - check the output above'
        } else {
            Write-Ok 'database schema is up to date'
        }
    } else {
        Write-Warn 'no migrations found in prisma\migrations'
        Write-Step 'run install.bat to create the schema'
    }

    # --- Launch ---------------------------------------------------------------
    $stateDir = Split-Path -Parent (Get-StatePath)
    if (-not (Test-Path -LiteralPath $stateDir)) {
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    }

    $webLog = Join-Path $stateDir 'web.log'
    $workerLog = Join-Path $stateDir 'worker.log'
    $nodeExe = $node.Source

    # The worker is started BEFORE the web server on purpose.
    #
    # The panel calls syncXray() on every configuration mutation, and until the
    # worker owns .vpanel-worker.lock the panel is free to write config.json
    # itself. Starting the worker first means the lock is taken before the panel
    # can serve a request, so the "second writer" guard has something to defer
    # to. Reversed order was observed to produce two node-config writes at
    # startup (the panel's, then the worker's), i.e. one redundant Xray restart.
    # Start-Process builds the child's environment from this process's variables.
    # If two variables differ only by case (Windows happily holds both `Path` and
    # `PATH`), it throws
    #   "Item has already been added. Key in dictionary: 'Path' ... 'PATH'"
    # and leaves the stack half-started with empty pids. That is a property of the
    # calling environment, not of this project - a Git Bash / cygwin session that
    # exported lowercase copies is enough to trigger it.
    #
    # So: keep Start-Process as the normal path, and fall back to the Node launcher
    # (scripts\launch.mjs), which spawns the same two processes detached without
    # ever building an environment dictionary.
    $launched = $false
    $webId = $null
    # Exactly one worker may own config.json. Reuse a live one rather than
    # creating a second writer - see the note above the check.
    $workerId = $existingWorker

    try {
        if (-not $workerId) {
            Write-Step 'starting the background worker'
            $worker = Start-Process -FilePath $nodeExe `
                -ArgumentList @('--env-file=.env', '--import', 'tsx', 'workers/index.ts', 'daemon') `
                -WorkingDirectory $root -PassThru -WindowStyle Hidden `
                -RedirectStandardOutput $workerLog -RedirectStandardError "$workerLog.err"
            $workerId = $worker.Id
        }

        if ($webAlive) {
            # Only the worker was missing - leave the running web server alone,
            # so nobody using the panel right now loses their session.
            Write-Step 'web server already running - leaving it in place'
            $webId = [int]$state.webPid
        } else {
            Write-Step 'starting the web server'
            $web = Start-Process -FilePath $nodeExe `
                -ArgumentList @('--env-file=.env', 'node_modules/next/dist/bin/next', 'start', '-p', "$port") `
                -WorkingDirectory $root -PassThru -WindowStyle Hidden `
                -RedirectStandardOutput $webLog -RedirectStandardError "$webLog.err"
            $webId = $web.Id
        }
        $launched = $true
    } catch {
        Write-Warn "Start-Process could not launch the stack: $($_.Exception.Message)"
        Write-Step 'falling back to the Node launcher (scripts\launch.mjs)'
    }

    if (-not $launched) {
        $launchArgs = @((Join-Path $root 'scripts\launch.mjs'), '--port', "$port", '--node', $nodeExe)
        if ($existingWorker) { $launchArgs += '--no-worker' }
        if ($webAlive) { $launchArgs += '--no-web' }
        & $nodeExe @launchArgs

        # launch.mjs records the real pids in runtime.json.
        Start-Sleep -Seconds 2
        $fresh = Read-State
        if ($fresh) {
            if (-not $workerId) { $workerId = $fresh.workerPid }
            # When only the worker was missing, the live web server is the one we
            # found by command line above - not whatever runtime.json held, which
            # is exactly what went stale in the first place.
            if ($webAlive) { $webId = [int]$state.webPid } else { $webId = $fresh.webPid }
        }
    }

    Write-State @{
        mode      = 'native'
        webPid    = $webId
        workerPid = $workerId
        port      = $port
        startedAt = (Get-Date).ToString('o')
    }

    Write-Ok "web server started (PID $webId)"
    if ($existingWorker) {
        Write-Ok "worker already running (PID $workerId) - not starting a second one"
    } else {
        Write-Ok "worker started (PID $workerId)"
    }
}

# -----------------------------------------------------------------------------
# Wait for health, then report
# -----------------------------------------------------------------------------
Write-Step 'waiting for the panel to respond'
$healthUrl = "$url/api/health"

    if (Wait-Health -Url $healthUrl -TimeoutSeconds 180) {
        Write-Ok 'the panel is up and healthy'
    } else {
        Write-Warn 'the panel did not report healthy in time'
        Write-Step "Open $healthUrl in a browser, or run logs.bat to see what happened."
    }

    # A healthy HTTP endpoint is not the same as a healthy worker: the worker is
    # what keeps config.json, traffic accounting and ceiling enforcement alive.
    # Report it separately, so "the panel is up" can never hide a dead worker.
    if ($workerId -and (Test-ProcessAlive -ProcessId ([int]$workerId))) {
        Write-Ok "worker is running (PID $workerId)"
    } else {
        Write-Warn "the worker is NOT running (pid $workerId)"
        Write-Host '  Without it nothing reconciles the node: no traffic accounting,' -ForegroundColor Gray
        Write-Host '  no ceiling enforcement, no config updates. Run start.bat again,' -ForegroundColor Gray
        Write-Host '  and if it still fails, read .vpanel\worker.log.' -ForegroundColor DarkGray
    }

$lanIp = Get-LanIp
$lanUrl = if ($port -eq 80) { "http://$lanIp" } else { "http://${lanIp}:$port" }
$adminEmail = Get-EnvValue -Env $envMap -Key 'SEED_ADMIN_EMAIL' -Default '(see .env)'

Write-Host ''
Write-Host '  On this PC     : ' -NoNewline -ForegroundColor Gray
Write-Host $url -ForegroundColor Cyan
Write-Host '  From your LAN  : ' -NoNewline -ForegroundColor Gray
Write-Host $lanUrl -ForegroundColor Cyan
Write-Host '  Admin account  : ' -NoNewline -ForegroundColor Gray
Write-Host $adminEmail -ForegroundColor Cyan
Write-Host ''
Write-Host '  To reach it from other devices run firewall.bat once (needs admin).' -ForegroundColor DarkGray

if (-not $NoBrowser) {
    Write-Step 'opening the panel in your browser'
    Start-Process $url
}

exit 0
