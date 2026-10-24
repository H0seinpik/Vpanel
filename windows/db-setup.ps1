# =============================================================================
# VPanel - create the PostgreSQL role and database.
#
#   powershell -ExecutionPolicy Bypass -File windows\db-setup.ps1
#
# Only needed in native mode (no Docker). Reads the credentials from .env and
# uses them to create the role and database, so you never have to write SQL.
#
# You will be asked for the PostgreSQL superuser password - the one you chose
# when PostgreSQL was installed. It is used once and never stored.
# =============================================================================

param(
    [string]$SuperUser = 'postgres',
    [string]$SuperPassword = '',
    [switch]$NonInteractive
)

. (Join-Path $PSScriptRoot '_vpanel.ps1')

$root = Get-VPanelRoot
$envPath = Join-Path $root '.env'

Write-Head 'VPanel - database setup'

# --- Read configuration ------------------------------------------------------
if (-not (Test-Path -LiteralPath $envPath)) {
    Write-Err '.env not found - run install.bat first'
    exit 1
}

$envMap = Get-DotEnv -Root $root
$databaseUrl = Get-EnvValue -Env $envMap -Key 'DATABASE_URL'

$dbUser = Get-EnvValue -Env $envMap -Key 'POSTGRES_USER' -Default 'vpanel'
$dbName = Get-EnvValue -Env $envMap -Key 'POSTGRES_DB' -Default 'vpanel'
$dbPassword = Get-EnvValue -Env $envMap -Key 'POSTGRES_PASSWORD'

$target = Get-DatabaseTarget -DatabaseUrl $databaseUrl
$dbHost = $target.Host
$dbPort = $target.Port

if ($dbPassword -eq '') {
    Write-Err 'POSTGRES_PASSWORD is empty in .env'
    Write-Step 'Run setup-env.ps1 to generate one, or set it manually.'
    exit 1
}

Write-Step "target : $dbUser@${dbHost}:${dbPort}/$dbName"

# --- Locate psql -------------------------------------------------------------
$psql = Resolve-PgTool -Tool 'psql'
if (-not $psql) {
    Write-Err 'psql was not found.'
    Write-Host ''
    Write-Host '  PostgreSQL does not appear to be installed. Install it with:' -ForegroundColor White
    Write-Host '    winget search PostgreSQL        (find the current package id)' -ForegroundColor DarkYellow
    Write-Host '    winget install <id>             (e.g. PostgreSQL.PostgreSQL.18)' -ForegroundColor DarkYellow
    Write-Host '  or download the installer from:' -ForegroundColor Gray
    Write-Host '    https://www.postgresql.org/download/windows/' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  When installing, remember the superuser password you choose -' -ForegroundColor Gray
    Write-Host '  db-setup needs it once to create the role and database.' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  Then close this window, open a new one, and run db-setup.bat again.' -ForegroundColor Gray
    Write-Host '  (A new window matters: winget does not refresh PATH in an existing one.)' -ForegroundColor DarkGray
    Write-Host ''
    exit 1
}
Write-Ok "psql found: $psql"

# --- Make sure the server is running -----------------------------------------
$service = Get-PostgresService

if ($service) {
    if ($service.Status -ne 'Running') {
        Write-Step "starting the PostgreSQL service ($($service.Name))"
        try {
            Start-Service -Name $service.Name -ErrorAction Stop
            Start-Sleep -Seconds 3
            Write-Ok 'service started'
        } catch {
            Write-Err "could not start $($service.Name)"
            Write-Step 'Open services.msc and start it manually, then re-run this script.'
            Write-Step '(Starting a service needs an elevated window.)'
            exit 1
        }
    } else {
        Write-Ok "PostgreSQL service is running ($($service.Name))"
    }
}

if (-not (Test-TcpPort -ComputerName $dbHost -Port $dbPort)) {
    Write-Err "nothing is listening on ${dbHost}:${dbPort}"
    Write-Step 'Is PostgreSQL installed and running? Check services.msc.'
    exit 1
}
Write-Ok "PostgreSQL is accepting connections on ${dbHost}:${dbPort}"

# --- Superuser password ------------------------------------------------------
if ($SuperPassword -eq '' -and -not $NonInteractive) {
    Write-Host ''
    Write-Host "  Enter the password for the PostgreSQL superuser '$SuperUser'." -ForegroundColor White
    Write-Host '  This is the password you set when installing PostgreSQL.' -ForegroundColor DarkGray
    Write-Host '  It is used once here and never saved.' -ForegroundColor DarkGray
    $secure = Read-Host -Prompt "  Password for $SuperUser" -AsSecureString
    $credential = [System.Net.NetworkCredential]::new('', $secure)
    $SuperPassword = $credential.Password
}

if ($SuperPassword -eq '') {
    Write-Err 'no superuser password supplied'
    exit 1
}

# --- Create role + database --------------------------------------------------
# Single quotes are doubled so a password containing one cannot break the SQL.
$safePassword = $dbPassword.Replace("'", "''")
$safeUser = $dbUser.Replace('"', '""')
$safeDb = $dbName.Replace('"', '""')

$roleSql = @"
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$safeUser') THEN
    CREATE ROLE "$safeUser" LOGIN PASSWORD '$safePassword';
  ELSE
    ALTER ROLE "$safeUser" WITH LOGIN PASSWORD '$safePassword';
  END IF;
END
`$`$;
"@

Write-Step "creating role '$dbUser'"
$env:PGPASSWORD = $SuperPassword

try {
    & $psql -U $SuperUser -h $dbHost -p $dbPort -d postgres -v ON_ERROR_STOP=1 -q -c $roleSql 2>&1 |
        ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

    if ($LASTEXITCODE -ne 0) {
        Write-Err 'could not connect as the PostgreSQL superuser'
        Write-Host ''
        Write-Host '  Check the superuser name and password, then try again:' -ForegroundColor Gray
        Write-Host "      db-setup.bat -SuperUser postgres" -ForegroundColor DarkYellow
        Write-Host ''
        Write-Host '  If you have forgotten the superuser password, reset it by' -ForegroundColor Gray
        Write-Host '  temporarily trusting local connections:' -ForegroundColor Gray

        # Resolve the real paths rather than assuming a version number.
        $dataDir = Get-PgDataDir
        $hbaPath = if ($dataDir) { Join-Path $dataDir 'pg_hba.conf' } else { '<data dir>\pg_hba.conf' }
        $svcName = if ($service) { $service.Name } else { 'postgresql-x64-<version>' }

        Write-Host '    1. Open this file in an elevated editor:' -ForegroundColor DarkGray
        Write-Host "       $hbaPath" -ForegroundColor DarkYellow
        Write-Host '    2. Change "scram-sha-256" to "trust" on the 127.0.0.1 and ::1 lines' -ForegroundColor DarkGray
        Write-Host "    3. Restart the service:  net stop $svcName" -ForegroundColor DarkGray
        Write-Host "                             net start $svcName" -ForegroundColor DarkGray
        Write-Host '    4. Run db-setup.bat again (no password needed while trust is set)' -ForegroundColor DarkGray
        Write-Host '    5. Put "scram-sha-256" back and restart the service again' -ForegroundColor DarkGray
        Write-Host ''
        exit 1
    }
    Write-Ok 'role ready'

    # CREATE DATABASE cannot run inside a transaction block, so it needs its own
    # statement and an existence check first.
    $exists = (& $psql -U $SuperUser -h $dbHost -p $dbPort -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$safeDb'") 2>&1
    $existsText = ("$exists").Trim()

    if ($existsText -eq '1') {
        Write-Ok "database '$dbName' already exists"
    } else {
        Write-Step "creating database '$dbName'"
        & $psql -U $SuperUser -h $dbHost -p $dbPort -d postgres -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE `"$safeDb`" OWNER `"$safeUser`" ENCODING 'UTF8'" 2>&1 |
            ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

        if ($LASTEXITCODE -ne 0) {
            Write-Err 'could not create the database'
            exit 1
        }
        Write-Ok 'database created'
    }
} finally {
    $env:PGPASSWORD = ''
}

# --- Verify with the application credentials ---------------------------------
Write-Step 'verifying the application can connect'
$env:PGPASSWORD = $dbPassword

try {
    $check = (& $psql -U $dbUser -h $dbHost -p $dbPort -d $dbName -tAc 'SELECT current_user || ''@'' || current_database()') 2>&1
    $checkText = ("$check").Trim()

    if ($LASTEXITCODE -ne 0 -or $checkText -eq '') {
        Write-Err 'the application credentials do not work yet'
        Write-Host "    $checkText" -ForegroundColor DarkGray
        exit 1
    }

    Write-Ok "connected as $checkText"
} finally {
    $env:PGPASSWORD = ''
}

Write-Host ''
Write-Host '  Database is ready. Next:' -ForegroundColor Green
Write-Host '    install.bat     create the schema and your admin account' -ForegroundColor Gray
Write-Host '    start.bat       start the panel' -ForegroundColor Gray
Write-Host ''

exit 0
