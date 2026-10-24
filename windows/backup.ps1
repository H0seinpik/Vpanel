# =============================================================================
# VPanel - database backup.
#
#   powershell -ExecutionPolicy Bypass -File windows\backup.ps1
#   powershell -ExecutionPolicy Bypass -File windows\backup.ps1 -KeepDays 30
#
# Writes a compressed custom-format dump plus a SHA-256 checksum into .\backups
# and prunes dumps older than -KeepDays.
#
# IMPORTANT: .\backups contains your credentials and audit trail. Keep it off
# any web-served path and copy it somewhere else (see docs\BACKUP.md).
# =============================================================================

param(
    [int]$KeepDays = 14
)

. (Join-Path $PSScriptRoot '_vpanel.ps1')

$root = Get-VPanelRoot
$envMap = Get-DotEnv -Root $root
$mode = Get-VPanelMode

Write-Head 'VPanel - backup'

$backupDir = Join-Path $root 'backups'
if (-not (Test-Path -LiteralPath $backupDir)) {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
}

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$file = Join-Path $backupDir "vpanel-$stamp.dump"

$dbUser = Get-EnvValue -Env $envMap -Key 'POSTGRES_USER' -Default 'vpanel'
$dbName = Get-EnvValue -Env $envMap -Key 'POSTGRES_DB' -Default 'vpanel'
$dbPassword = Get-EnvValue -Env $envMap -Key 'POSTGRES_PASSWORD'

# -----------------------------------------------------------------------------
# Dump
# -----------------------------------------------------------------------------
if ($mode -eq 'docker') {
    Write-Step "dumping '$dbName' via the postgres container"

    Push-Location -LiteralPath $root
    try {
        # cmd.exe performs the redirection: PowerShell would corrupt the binary
        # dump by decoding it as text.
        $command = "docker compose exec -T postgres pg_dump -U $dbUser -d $dbName -Fc --no-owner --no-privileges > `"$file`""
        & cmd.exe /c $command
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    if ($code -ne 0) {
        Write-Err 'pg_dump failed - is the stack running? Try start.bat first.'
        exit 1
    }
} else {
    $pgDump = Resolve-PgTool -Tool 'pg_dump'

    if (-not $pgDump) {
        Write-Err 'pg_dump was not found.'
        Write-Host ''
        Write-Host '  Options:' -ForegroundColor White
        Write-Host '    - install the PostgreSQL client tools and re-run, or' -ForegroundColor Gray
        Write-Host '    - switch to Docker mode (compose ships pg_dump inside the container).' -ForegroundColor Gray
        Write-Host ''
        exit 1
    }

    $databaseUrl = Get-EnvValue -Env $envMap -Key 'DATABASE_URL'
    Write-Step "dumping '$dbName' with $pgDump"

    $previousPassword = $env:PGPASSWORD
    if ($dbPassword -ne '') { $env:PGPASSWORD = $dbPassword }

    try {
        # cmd.exe performs the redirection: PowerShell would corrupt the binary
        # dump by decoding it as text.
        $command = "`"$pgDump`" --dbname=`"$databaseUrl`" -Fc --no-owner --no-privileges > `"$file`""
        & cmd.exe /c $command
        $code = $LASTEXITCODE
    } finally {
        $env:PGPASSWORD = $previousPassword
    }

    if ($code -ne 0) {
        Write-Err 'pg_dump failed'
        exit 1
    }
}

# -----------------------------------------------------------------------------
# Verify + checksum
# -----------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $file) -or (Get-Item -LiteralPath $file).Length -eq 0) {
    Write-Err 'the dump is empty - removing it'
    if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
    exit 1
}

$size = [math]::Round((Get-Item -LiteralPath $file).Length / 1MB, 2)
$hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower()
"$hash  $(Split-Path -Leaf $file)" | Set-Content -LiteralPath "$file.sha256" -Encoding ASCII

Write-Ok "backup written: $file ($size MB)"
Write-Step "sha256: $hash"

# -----------------------------------------------------------------------------
# Retention
# -----------------------------------------------------------------------------
$cutoff = (Get-Date).AddDays(-$KeepDays)
$old = Get-ChildItem -LiteralPath $backupDir -Filter 'vpanel-*.dump*' -File |
    Where-Object { $_.LastWriteTime -lt $cutoff }

foreach ($item in $old) {
    Remove-Item -LiteralPath $item.FullName -Force
}
Write-Step "pruned $($old.Count) file(s) older than $KeepDays days"

Write-Host ''
Write-Host '  Reminder: copy these dumps off this machine.' -ForegroundColor DarkGray
Write-Host '  They contain credentials and the full audit log.' -ForegroundColor DarkGray

exit 0
