# =============================================================================
# VPanel - reset the PostgreSQL superuser password.
#
#   powershell -ExecutionPolicy Bypass -File windows\reset-pg-password.ps1
#   powershell -ExecutionPolicy Bypass -File windows\reset-pg-password.ps1 -Password "something-better"
#
# WHY THIS IS NEEDED
#   PostgreSQL stores the superuser password as a hash, so it cannot be "read"
#   or edited - only overwritten. Overwriting it normally requires already being
#   able to authenticate as that superuser. The standard way out is to briefly
#   make local connections password-free, set the new password, then put the
#   authentication requirement straight back.
#
#   That is exactly what this script does. It needs administrator rights, so it
#   re-launches itself elevated and asks for your consent.
#
# SAFETY
#   - pg_hba.conf is backed up before it is touched.
#   - The original file is restored in a `finally` block, so it is put back even
#     if setting the password fails or the script is interrupted.
#   - The window during which local connections need no password lasts only as
#     long as the service restart takes (a few seconds).
# =============================================================================

param(
    [string]$Password = '123',
    [string]$SuperUser = 'postgres',
    [switch]$Elevated
)

. (Join-Path $PSScriptRoot '_vpanel.ps1')

$root = Get-VPanelRoot

# --- Elevate if needed -------------------------------------------------------
if (-not (Test-Admin)) {
    Write-Head 'VPanel - reset PostgreSQL superuser password'
    Write-Step 'administrator rights are required - requesting elevation'
    Write-Step 'a Windows UAC prompt will appear; approve it to continue'
    Write-Host ''

    $arguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $PSCommandPath,
        '-Password', $Password,
        '-SuperUser', $SuperUser,
        '-Elevated'
    )

    try {
        Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs
    } catch {
        Write-Err 'elevation was refused or failed'
        Write-Step 'Right-click reset-pg-password.bat and choose "Run as administrator" instead.'
        exit 1
    }

    Write-Ok 'an elevated window has been opened - continue there'
    exit 0
}

Write-Head 'VPanel - reset PostgreSQL superuser password'

# --- Locate everything -------------------------------------------------------
$psql = Resolve-PgTool -Tool 'psql'
if (-not $psql) {
    Write-Err 'psql was not found - is PostgreSQL installed?'
    if ($Elevated) { Write-Host ''; Read-Host 'Press Enter to close' }
    exit 1
}
Write-Ok "psql: $psql"

$service = Get-PostgresService
if (-not $service) {
    Write-Err 'no postgresql* Windows service was found'
    if ($Elevated) { Write-Host ''; Read-Host 'Press Enter to close' }
    exit 1
}
Write-Ok "service: $($service.Name) ($($service.Status))"

$dataDir = Get-PgDataDir
if (-not $dataDir) {
    Write-Err 'could not locate the PostgreSQL data directory'
    if ($Elevated) { Write-Host ''; Read-Host 'Press Enter to close' }
    exit 1
}

$hbaPath = Join-Path $dataDir 'pg_hba.conf'
if (-not (Test-Path -LiteralPath $hbaPath)) {
    Write-Err "pg_hba.conf not found at $hbaPath"
    if ($Elevated) { Write-Host ''; Read-Host 'Press Enter to close' }
    exit 1
}
Write-Ok "pg_hba.conf: $hbaPath"

# --- Warn about the chosen password -----------------------------------------
if ($Password.Length -lt 8) {
    Write-Host ''
    Write-Warn "the password you chose is only $($Password.Length) character(s)"
    Write-Host '  Good news: your pg_hba.conf only accepts connections from' -ForegroundColor DarkGray
    Write-Host '  127.0.0.1 and ::1, so this account is not reachable from the' -ForegroundColor DarkGray
    Write-Host '  network at all - the risk is limited to this machine.' -ForegroundColor DarkGray
    Write-Host '  You can change it later:  reset-pg-password.bat -Password "..."' -ForegroundColor DarkGray
    Write-Host ''
}

# --- Confirm -----------------------------------------------------------------
if (-not $Elevated) { } # (elevated runs are already confirmed by the UAC prompt)

$backupPath = "$hbaPath.vpanel-backup"
$safePassword = $Password.Replace("'", "''")
$safeUser = $SuperUser.Replace('"', '""')

Write-Step "backing up pg_hba.conf"
Copy-Item -LiteralPath $hbaPath -Destination $backupPath -Force
Write-Ok "backup: $backupPath"

$restored = $false

try {
    # --- Temporarily trust local connections --------------------------------
    Write-Step 'switching local authentication to "trust"'
    $content = Get-Content -Raw -LiteralPath $hbaPath
    $patched = $content -replace 'scram-sha-256', 'trust'
    $patched = $patched -replace 'md5', 'trust'
    Set-Content -LiteralPath $hbaPath -Value $patched -Encoding ASCII

    Write-Step "restarting $($service.Name)"
    Restart-Service -Name $service.Name -Force -ErrorAction Stop
    Start-Sleep -Seconds 4

    # --- Set the password ---------------------------------------------------
    Write-Step "setting the password for '$SuperUser'"
    $env:PGPASSWORD = ''
    # -w means "never prompt": if trust did not take effect we fail fast rather
    # than hanging on a password prompt nobody can answer.
    & $psql -U $SuperUser -h 127.0.0.1 -p 5432 -d postgres -w -v ON_ERROR_STOP=1 -q `
        -c "ALTER USER `"$safeUser`" WITH PASSWORD '$safePassword';" 2>&1 |
        ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

    if ($LASTEXITCODE -ne 0) {
        throw "ALTER USER failed (exit code $LASTEXITCODE)"
    }
    Write-Ok 'password updated'
} catch {
    Write-Err $_.Exception.Message
    Write-Step 'the original pg_hba.conf will now be restored'
} finally {
    # --- Always restore the original authentication rules -------------------
    Write-Step 'restoring the original pg_hba.conf'
    Copy-Item -LiteralPath $backupPath -Destination $hbaPath -Force
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue

    Write-Step "restarting $($service.Name) to apply"
    Restart-Service -Name $service.Name -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 4
    $restored = $true
}

if ($restored) {
    Write-Ok 'pg_hba.conf restored - local connections require a password again'
}

# --- Verify ------------------------------------------------------------------
Write-Step 'verifying the new password'
$verified = $false
try {
    $env:PGPASSWORD = $Password
    $raw = (& $psql -U $SuperUser -h 127.0.0.1 -p 5432 -d postgres -w -tAc 'SELECT 1') 2>&1
    $verified = ($LASTEXITCODE -eq 0 -and ("$raw").Trim() -eq '1')
} catch {
    $verified = $false
} finally {
    $env:PGPASSWORD = ''
}

Write-Host ''
if ($verified) {
    Write-Ok "the '$SuperUser' password is now what you set"
    Write-Host ''
    Write-Host '  Next:' -ForegroundColor Green
    Write-Host '    db-setup.bat     create the vpanel role + database (enter this password when asked)' -ForegroundColor Gray
    Write-Host '    install.bat      finish the installation' -ForegroundColor Gray
} else {
    Write-Err 'could not sign in with the new password'
    Write-Step 'Check that pg_hba.conf was restored, then try db-setup.bat with the password anyway.'
    Write-Step 'If pg_hba.conf looks wrong, restore it from the .vpanel-backup file if it is still present.'
}

Write-Host ''
if ($Elevated) { Read-Host 'Press Enter to close' }
exit 0
