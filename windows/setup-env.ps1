# =============================================================================
# VPanel - first-run .env setup.
#
# Creates .env from .env.example and fills in freshly generated secrets.
# Safe to re-run: existing values are preserved unless -Force is passed.
#
#   powershell -ExecutionPolicy Bypass -File windows\setup-env.ps1
#   powershell -ExecutionPolicy Bypass -File windows\setup-env.ps1 -Force
# =============================================================================

param(
    [switch]$Force,
    [switch]$NonInteractive
)

. (Join-Path $PSScriptRoot '_vpanel.ps1')

$root = Get-VPanelRoot
$envPath = Join-Path $root '.env'
$examplePath = Join-Path $root '.env.example'

# --- Generators --------------------------------------------------------------

function New-HexSecret {
    param([int]$Bytes = 32)

    $buffer = New-Object byte[] $Bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
    return (($buffer | ForEach-Object { $_.ToString('x2') }) -join '')
}

function New-SafePassword {
    param([int]$Length = 28)

    # Alphanumeric only: special characters break .env parsing and connection
    # strings, and this password is pasted into several places.
    $alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    $buffer = New-Object byte[] $Length
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)

    $chars = for ($i = 0; $i -lt $Length; $i++) { $alphabet[$buffer[$i] % $alphabet.Length] }
    return (-join $chars)
}

# Replace KEY=... in the file body, or append it when absent.
function Set-EnvLine {
    param([string]$Content, [string]$Key, [string]$Value)

    $pattern = '(?m)^[ \t]*' + [regex]::Escape($Key) + '=.*$'
    $line = "$Key=$Value"

    if ([regex]::IsMatch($Content, $pattern)) {
        # '$' must be doubled so the regex engine does not read it as a group
        # reference inside the replacement string.
        $replacement = $Key + '=' + $Value.Replace('$', '$$')
        return [regex]::Replace($Content, $pattern, $replacement)
    }

    return ($Content.TrimEnd() + "`r`n" + $line + "`r`n")
}

function Get-EnvLineValue {
    param([string]$Content, [string]$Key)

    $pattern = '(?m)^[ \t]*' + [regex]::Escape($Key) + '=(.*)$'
    $m = [regex]::Match($Content, $pattern)
    if ($m.Success) { return $m.Groups[1].Value.Trim().Trim('"') }
    return ''
}

# --- Run ---------------------------------------------------------------------

Write-Head 'VPanel - environment setup'

if (-not (Test-Path -LiteralPath $examplePath)) {
    Write-Err ".env.example not found in $root"
    exit 1
}

if ((Test-Path -LiteralPath $envPath) -and -not $Force) {
    Write-Step '.env already exists - checking for placeholder values'
    $content = Get-Content -Raw -LiteralPath $envPath
} else {
    if (Test-Path -LiteralPath $envPath) {
        Write-Warn '.env exists and -Force was passed - regenerating secrets'
    }
    $content = Get-Content -Raw -LiteralPath $examplePath
    Write-Ok 'created .env from .env.example'
}

# Values that should survive a -Force regeneration: nobody wants their admin
# password silently reverted to the template placeholder.
$previous = @{}
if (Test-Path -LiteralPath $envPath) {
    $previousContent = Get-Content -Raw -LiteralPath $envPath
    foreach ($key in @('SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD', 'SEED_ADMIN_USERNAME', 'APP_NAME', 'APP_URL', 'NODE_PROVIDER')) {
        $previous[$key] = Get-EnvLineValue -Content $previousContent -Key $key
    }
}

$changed = @()

# --- Secrets -----------------------------------------------------------------

$placeholders = @(
    'change-me-generate-a-long-random-string-min-32-chars',
    'change-me-generate-a-different-long-random-string'
)

$access = Get-EnvLineValue -Content $content -Key 'JWT_ACCESS_SECRET'
if ($Force -or $access -eq '' -or $placeholders -contains $access) {
    $content = Set-EnvLine -Content $content -Key 'JWT_ACCESS_SECRET' -Value (New-HexSecret 32)
    $changed += 'JWT_ACCESS_SECRET'
}

$refresh = Get-EnvLineValue -Content $content -Key 'JWT_REFRESH_SECRET'
if ($Force -or $refresh -eq '' -or $placeholders -contains $refresh) {
    $content = Set-EnvLine -Content $content -Key 'JWT_REFRESH_SECRET' -Value (New-HexSecret 32)
    $changed += 'JWT_REFRESH_SECRET'
}

# --- Database password (Docker mode) ----------------------------------------

$dbPassword = Get-EnvLineValue -Content $content -Key 'POSTGRES_PASSWORD'
if ($Force -or $dbPassword -eq '') {
    $dbPassword = New-SafePassword 28
    $content = Set-EnvLine -Content $content -Key 'POSTGRES_PASSWORD' -Value $dbPassword
    $changed += 'POSTGRES_PASSWORD'
}

# Keep DATABASE_URL in step with the generated password so native-mode and CLI
# commands work without further editing.
if ($dbPassword -ne '') {
    $dbUser = Get-EnvLineValue -Content $content -Key 'POSTGRES_USER'
    if ($dbUser -eq '') { $dbUser = 'vpanel' }
    $dbName = Get-EnvLineValue -Content $content -Key 'POSTGRES_DB'
    if ($dbName -eq '') { $dbName = 'vpanel' }

    $newUrl = "postgresql://${dbUser}:${dbPassword}@localhost:5432/${dbName}?schema=public&connection_limit=10"
    $content = Set-EnvLine -Content $content -Key 'DATABASE_URL' -Value $newUrl
}

# --- Bootstrap administrator -------------------------------------------------

$adminEmail = Get-EnvLineValue -Content $content -Key 'SEED_ADMIN_EMAIL'
$adminPassword = Get-EnvLineValue -Content $content -Key 'SEED_ADMIN_PASSWORD'

# Carry over a real admin account from a previous .env.
if ($previous.ContainsKey('SEED_ADMIN_EMAIL') -and $previous['SEED_ADMIN_EMAIL'] -ne '') {
    $adminEmail = $previous['SEED_ADMIN_EMAIL']
}
if ($previous.ContainsKey('SEED_ADMIN_PASSWORD') -and
    $previous['SEED_ADMIN_PASSWORD'] -ne '' -and
    $previous['SEED_ADMIN_PASSWORD'] -ne 'ChangeMe_Str0ng_Password!') {
    $adminPassword = $previous['SEED_ADMIN_PASSWORD']
}

if (-not $NonInteractive) {
    Write-Host ''
    Write-Host '  Bootstrap administrator (used once, by the seed step)' -ForegroundColor White

    $answer = Read-Host "  Email [$adminEmail]"
    if ($answer.Trim() -ne '') { $adminEmail = $answer.Trim() }

    if ($adminPassword -eq '' -or $adminPassword -eq 'ChangeMe_Str0ng_Password!') {
        $generated = New-SafePassword 20
        Write-Host "  Generated password: $generated" -ForegroundColor Yellow
        $answer = Read-Host '  Press Enter to accept, or type your own'
        if ($answer.Trim() -ne '') { $adminPassword = $answer.Trim() } else { $adminPassword = $generated }
    }
}

if ($adminEmail -ne '') {
    $content = Set-EnvLine -Content $content -Key 'SEED_ADMIN_EMAIL' -Value $adminEmail
}
if ($adminPassword -ne '') {
    $content = Set-EnvLine -Content $content -Key 'SEED_ADMIN_PASSWORD' -Value $adminPassword
}

# --- Persist -----------------------------------------------------------------

Set-Content -LiteralPath $envPath -Value $content -Encoding ASCII

Write-Ok ".env written to $envPath"
if ($changed.Count -gt 0) {
    Write-Step ('generated: ' + ($changed -join ', '))
}
Write-Host ''
Write-Host '  Keep .env private - it holds the database password and the' -ForegroundColor DarkGray
Write-Host '  keys that encrypt stored agent tokens.' -ForegroundColor DarkGray
