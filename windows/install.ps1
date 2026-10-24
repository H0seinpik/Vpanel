# =============================================================================
# VPanel - one-time installation.
#
#   powershell -ExecutionPolicy Bypass -File windows\install.ps1
#   powershell -ExecutionPolicy Bypass -File windows\install.ps1 -SkipSeed
#
# Does everything needed for a first run:
#   1. creates .env with freshly generated secrets
#   2. installs dependencies
#   3. creates / migrates the database schema
#   4. builds the application (native mode)
#   5. seeds roles, protocols, plans and your administrator account
# =============================================================================

param(
    [switch]$SkipSeed,
    [switch]$Force
)

. (Join-Path $PSScriptRoot '_vpanel.ps1')

$root = Get-VPanelRoot
$envPath = Join-Path $root '.env'

Write-Head 'VPanel - installation'

# -----------------------------------------------------------------------------
# 1. Environment file
# -----------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $envPath) -or $Force) {
    Write-Step 'creating .env'
    $setupArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'setup-env.ps1'))
    if ($Force) { $setupArgs += '-Force' }
    & powershell @setupArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Err 'environment setup failed'
        exit 1
    }
} else {
    Write-Ok '.env already exists (use -Force to regenerate secrets)'
}

$envMap = Get-DotEnv -Root $root
$mode = Get-VPanelMode
Write-Step "runtime: $mode"

# -----------------------------------------------------------------------------
# 2. Docker path
# -----------------------------------------------------------------------------
if ($mode -eq 'docker') {
    Write-Step 'building images and starting the stack (this can take several minutes)'
    Invoke-Compose @('up', '-d', '--build')
    Write-Ok 'stack started'

    if (-not $SkipSeed) {
        Write-Step 'seeding roles, protocols, plans and the administrator account'
        Invoke-Compose @('run', '--rm', 'seed')
        Write-Ok 'seed complete'
    }

    $port = Get-VPanelPort -Mode 'docker' -Env $envMap
    $url = Get-VPanelUrl -Mode 'docker' -Env $envMap

    Write-Step 'waiting for the panel to respond'
    if (Wait-Health -Url "$url/api/health" -TimeoutSeconds 240) {
        Write-Ok 'the panel is up'
    } else {
        Write-Warn 'the panel did not report healthy yet - it may still be starting'
        Write-Step 'run status.bat in a moment, or logs.bat to watch it come up'
    }

    Write-Host ''
    Write-Host "  Ready. Open $url and sign in." -ForegroundColor Green
    Write-Host ''
    exit 0
}

# -----------------------------------------------------------------------------
# 3. Native path
# -----------------------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue

if (-not $node -or -not $npm) {
    Write-Err 'Node.js and npm are required for native mode.'
    Write-Step 'Install Node.js 20+ from https://nodejs.org, then re-run install.bat.'
    Write-Step 'Or install Docker Desktop and re-run install.bat to use Docker mode.'
    exit 1
}

# --- Database reachability ---------------------------------------------------
$databaseUrl = Get-EnvValue -Env $envMap -Key 'DATABASE_URL'
$db = Get-DatabaseTarget -DatabaseUrl $databaseUrl
$psql = Resolve-PgTool -Tool 'psql'
$service = Get-PostgresService

# A stopped service is the most common cause - try to start it before giving up.
if (-not (Test-TcpPort -ComputerName $db.Host -Port $db.Port) -and $service -and $service.Status -ne 'Running') {
    Write-Step "PostgreSQL is installed but stopped - starting $($service.Name)"
    try {
        Start-Service -Name $service.Name -ErrorAction Stop
        Start-Sleep -Seconds 3
    } catch {
        Write-Warn "could not start $($service.Name) - it needs an elevated window"
    }
}

if (-not (Test-TcpPort -ComputerName $db.Host -Port $db.Port)) {
    Write-Err "PostgreSQL is not reachable at $($db.Host):$($db.Port)"
    Write-Host ''

    if ($service) {
        Write-Host '  PostgreSQL is installed but not running.' -ForegroundColor White
        Write-Host "  Start the service '$($service.Name)':" -ForegroundColor Gray
        Write-Host "      net start $($service.Name)" -ForegroundColor DarkYellow
        Write-Host '  or open services.msc (both need an elevated window).' -ForegroundColor DarkGray
    } elseif ($psql) {
        Write-Host '  psql was found but nothing is listening - is the service running?' -ForegroundColor White
        Write-Host '  Check services.msc for a postgresql* service.' -ForegroundColor Gray
    } else {
        Write-Host '  PostgreSQL is not installed. Install it with:' -ForegroundColor White
        Write-Host '      winget search PostgreSQL       (find the current package id)' -ForegroundColor DarkYellow
        Write-Host '      winget install <id>            (e.g. PostgreSQL.PostgreSQL.18)' -ForegroundColor DarkYellow
        Write-Host '  or download it from https://www.postgresql.org/download/windows/' -ForegroundColor DarkGray
        Write-Host ''
        Write-Host '  Then CLOSE this window, open a new one and run:' -ForegroundColor Gray
        Write-Host '      db-setup.bat     create the role and database' -ForegroundColor DarkYellow
        Write-Host '      install.bat      finish the installation' -ForegroundColor DarkYellow
        Write-Host ''
        Write-Host '  (A new window matters: winget does not refresh PATH in an existing one.)' -ForegroundColor DarkGray
        Write-Host ''
        Write-Host '  Docker Desktop is the alternative, but it needs ~1.5 GB of RAM on top' -ForegroundColor DarkGray
        Write-Host '  of the stack, so on a 4 GB machine PostgreSQL alone is the better fit.' -ForegroundColor DarkGray
    }

    Write-Host ''
    exit 1
}
Write-Ok "PostgreSQL reachable at $($db.Host):$($db.Port)"

# --- Provision the role and database if they are missing ---------------------
if ($psql) {
    $dbUser = Get-EnvValue -Env $envMap -Key 'POSTGRES_USER' -Default 'vpanel'
    $dbName = Get-EnvValue -Env $envMap -Key 'POSTGRES_DB' -Default 'vpanel'
    $dbPassword = Get-EnvValue -Env $envMap -Key 'POSTGRES_PASSWORD'

    # Does the application's own account work yet?
    #
    # Note: PostgreSQL reports "password authentication failed" both for a wrong
    # password AND for a role that does not exist, so this single probe cannot
    # tell them apart - and it does not need to. db-setup handles both cases
    # (it creates the role, or ALTERs its password to match .env).
    $appDbOk = $false
    try {
        $env:PGPASSWORD = $dbPassword
        & $psql -U $dbUser -h $db.Host -p $db.Port -d $dbName -tAc 'SELECT 1' 2>&1 | Out-Null
        $appDbOk = ($LASTEXITCODE -eq 0)
    } catch {
        $appDbOk = $false
    } finally {
        $env:PGPASSWORD = ''
    }

    if (-not $appDbOk) {
        Write-Warn "the application cannot sign in as '$dbUser' yet"
        Write-Step 'running the database setup helper to create or update the role'
        Write-Host ''

        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'db-setup.ps1')
        if ($LASTEXITCODE -ne 0) {
            Write-Host ''
            Write-Err 'database setup did not complete'
            Write-Step 'Run db-setup.bat on its own to see the details, then re-run install.bat.'
            exit 1
        }

        # Confirm the helper actually fixed it before continuing.
        $verified = $false
        try {
            $env:PGPASSWORD = $dbPassword
            & $psql -U $dbUser -h $db.Host -p $db.Port -d $dbName -tAc 'SELECT 1' 2>&1 | Out-Null
            $verified = ($LASTEXITCODE -eq 0)
        } catch {
            $verified = $false
        } finally {
            $env:PGPASSWORD = ''
        }

        if (-not $verified) {
            Write-Err "still cannot sign in as '$dbUser'"
            Write-Step 'Check DATABASE_URL and POSTGRES_PASSWORD in .env, then retry.'
            exit 1
        }
        Write-Ok "database '$dbName' is ready"
    } else {
        Write-Ok "database '$dbName' is ready"
    }
}

# --- Dependencies ------------------------------------------------------------
$modules = Get-NodeModulesStatus

if ($modules.NextCli -and $modules.PrismaCli) {
    Write-Ok 'dependencies already installed'
} else {
    Write-Step 'installing dependencies (this takes a few minutes on the first run)'

    Push-Location -LiteralPath $root
    try {
        & npm install --no-audit --no-fund
        $code = $LASTEXITCODE

        if ($code -ne 0) {
            # The global npm cache is sometimes locked down on managed machines;
            # a project-local cache sidesteps that entirely.
            Write-Warn 'default install failed - retrying with a project-local npm cache'
            & npm install --no-audit --no-fund --cache .npm-cache
            $code = $LASTEXITCODE
        }
    } finally {
        Pop-Location
    }

    if ($code -ne 0) {
        Write-Err "dependency installation failed (exit code $code)"
        exit 1
    }
    Write-Ok 'dependencies installed'
}

# An install can finish with node_modules present but the npm bin shims never
# created. The project's own scripts call CLIs by path so builds still work, but
# it breaks npx and third-party tooling - flag it and offer the repair.
$modules = Get-NodeModulesStatus
if ($modules.BinCount -eq 0) {
    Write-Warn 'the npm bin shims (node_modules\.bin) are empty'
    Write-Step 'VPanel does not need them, but run repair.bat if other tools complain'
}

# --- Prisma client -----------------------------------------------------------
if (-not (Get-NodeModulesStatus).PrismaClient) {
    Write-Step 'generating the database client'
    Push-Location -LiteralPath $root
    try {
        & node 'node_modules/prisma/build/index.js' generate
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($code -ne 0) {
        Write-Err 'prisma generate failed'
        exit 1
    }
    Write-Ok 'database client generated'
} else {
    Write-Ok 'database client already generated'
}

# --- Schema ------------------------------------------------------------------
# `prisma migrate deploy` with no committed migrations succeeds while creating
# NOTHING, which leaves an empty database and a very confusing failure later.
# So: use migrations when they exist, fall back to a direct schema push when they
# do not, then verify the tables actually exist.
if (Test-PrismaMigrations) {
    Write-Step 'applying database migrations'
    Push-Location -LiteralPath $root
    try {
        & node 'node_modules/prisma/build/index.js' migrate deploy
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    if ($code -ne 0) {
        Write-Err 'migrate deploy failed - see the output above'
        Write-Step 'If the database was left half-created, drop it and re-run db-setup.bat.'
        exit 1
    }
    Write-Ok 'migrations applied'
} else {
    Write-Warn 'no migrations are committed - creating the schema directly'
    Push-Location -LiteralPath $root
    try {
        & node 'node_modules/prisma/build/index.js' db push --skip-generate
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    if ($code -ne 0) {
        Write-Err 'prisma db push failed - see the output above'
        exit 1
    }
    Write-Ok 'database schema created'
    Write-Step 'note: no migration history was recorded - see docs/DEPLOYMENT.md'
}

# --- Verify the schema actually landed ---------------------------------------
if ($psql) {
    $tableCount = 0
    try {
        $env:PGPASSWORD = $dbPassword
        $raw = (& $psql -U $dbUser -h $db.Host -p $db.Port -d $dbName -tAc `
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'") 2>&1
        $parsed = 0
        if ([int]::TryParse(("$raw").Trim(), [ref]$parsed)) { $tableCount = $parsed }
    } catch {
        $tableCount = 0
    } finally {
        $env:PGPASSWORD = ''
    }

    if ($tableCount -lt 10) {
        Write-Err "only $tableCount table(s) found - the schema did not apply"
        Write-Host ''
        Write-Host '  The database is reachable but empty. Try:' -ForegroundColor Gray
        Write-Host '      npm run prisma:generate' -ForegroundColor DarkYellow
        Write-Host '      npm run prisma:migrate' -ForegroundColor DarkYellow
        Write-Host '  then re-run install.bat.' -ForegroundColor Gray
        Write-Host ''
        exit 1
    }

    Write-Ok "$tableCount tables present in '$dbName'"
}

# --- Build -------------------------------------------------------------------
Write-Step 'building the application'
Push-Location -LiteralPath $root
try {
    & npm run build
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}

if ($code -ne 0) {
    Write-Err 'the build failed - see the output above'
    exit 1
}
Write-Ok 'build complete'

# --- Seed --------------------------------------------------------------------
if (-not $SkipSeed) {
    Write-Step 'seeding roles, protocols, plans and the administrator account'
    Push-Location -LiteralPath $root
    try {
        & node '--env-file=.env' '--import' 'tsx' 'prisma/seed.ts'
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    if ($code -ne 0) {
        Write-Warn 'seeding reported a problem - check the output above'
    } else {
        Write-Ok 'seed complete'
    }
}

$port = Get-VPanelPort -Mode 'native' -Env $envMap
$url = Get-VPanelUrl -Mode 'native' -Env $envMap

Write-Host ''
Write-Host "  Installation finished. Run start.bat, then open $url" -ForegroundColor Green
Write-Host ''
exit 0
