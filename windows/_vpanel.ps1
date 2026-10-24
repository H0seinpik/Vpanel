# =============================================================================
# VPanel - shared helpers for the Windows control scripts.
#
# Dot-sourced by install/start/stop/status/logs/backup. ASCII-only on purpose:
# Windows PowerShell 5.1 mis-decodes BOM-less UTF-8, and a garbled helper is
# worse than a plain-English one.
# =============================================================================

# IMPORTANT: 'Continue', not 'Stop'.
#
# With $ErrorActionPreference = 'Stop', PowerShell 5.1 converts anything a native
# command writes to *stderr* into a terminating NativeCommandError - even when the
# script fully expects the command to fail and handles it via $LASTEXITCODE.
# psql, docker and pg_dump all write diagnostics to stderr, so 'Stop' turns a
# routine "credentials not set up yet" probe into a hard crash with a stack trace.
#
# Errors that should genuinely abort are raised explicitly with `throw`, and
# cmdlets that must terminate use -ErrorAction Stop so try/catch still works.
$ErrorActionPreference = 'Continue'

# PowerShell 7.3+ honours this switch instead of $ErrorActionPreference for native
# commands; pin it to the 5.1 behaviour so both versions behave the same.
if (Test-Path 'variable:PSNativeCommandUseErrorActionPreference') {
    $PSNativeCommandUseErrorActionPreference = $false
}

# --- Paths -------------------------------------------------------------------

function Get-VPanelRoot {
    # This file lives in <root>\windows, so the project root is one level up.
    return (Split-Path -Parent $PSScriptRoot)
}

function Get-StatePath {
    return (Join-Path (Get-VPanelRoot) '.vpanel\runtime.json')
}

# --- .env --------------------------------------------------------------------

function Get-DotEnv {
    param([string]$Root)

    $map = @{}
    $path = Join-Path $Root '.env'
    if (-not (Test-Path -LiteralPath $path)) { return $map }

    foreach ($line in (Get-Content -LiteralPath $path)) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }

        $idx = $trimmed.IndexOf('=')
        if ($idx -lt 1) { continue }

        $key = $trimmed.Substring(0, $idx).Trim()
        $val = $trimmed.Substring($idx + 1).Trim()
        if ($val.Length -ge 2 -and $val.StartsWith('"') -and $val.EndsWith('"')) {
            $val = $val.Substring(1, $val.Length - 2)
        }
        $map[$key] = $val
    }

    return $map
}

function Get-EnvValue {
    param($Env, [string]$Key, [string]$Default = '')

    if ($null -ne $Env -and $Env.ContainsKey($Key)) {
        $v = $Env[$Key]
        if ($null -ne $v -and "$v".Trim() -ne '') { return "$v".Trim() }
    }
    return $Default
}

# --- Mode detection ----------------------------------------------------------

function Test-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
    try {
        & docker info --format '{{.ServerVersion}}' 2>&1 | Out-Null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

# Returns 'docker' when a working Docker engine is available, otherwise 'native'.
function Get-VPanelMode {
    if (Test-Docker) { return 'docker' }
    return 'native'
}

# Port the browser should use, per mode.
function Get-VPanelPort {
    param([string]$Mode, $Env)

    if ($Mode -eq 'docker') {
        return [int](Get-EnvValue -Env $Env -Key 'HTTP_PORT' -Default '80')
    }
    return [int](Get-EnvValue -Env $Env -Key 'PORT' -Default '3000')
}

function Get-VPanelUrl {
    param([string]$Mode, $Env)

    $port = Get-VPanelPort -Mode $Mode -Env $Env
    $scheme = if ($Mode -eq 'docker') { 'http' } else { 'http' }
    if ($port -eq 80 -or $port -eq 443) {
        return "$scheme`://localhost"
    }
    return "$scheme`://localhost:$port"
}

function Get-LanIp {
    try {
        $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object {
                $_.IPAddress -notlike '127.*' -and
                $_.IPAddress -notlike '169.254.*' -and
                $_.PrefixOrigin -ne 'WellKnown'
            }
        if ($ips) { return ($ips | Select-Object -First 1).IPAddress }
    } catch {
        # Fall through to the loopback name.
    }
    return 'localhost'
}

# --- Network -----------------------------------------------------------------

# Fast, quiet TCP reachability probe (Test-NetConnection is far too noisy/slow).
function Test-TcpPort {
    param(
        [string]$ComputerName,
        [int]$Port,
        [int]$TimeoutMs = 2500
    )

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect($ComputerName, $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

# Pull host/port out of a postgresql:// connection string.
function Get-DatabaseTarget {
    param([string]$DatabaseUrl)

    $target = @{ Host = 'localhost'; Port = 5432 }
    if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) { return $target }

    if ($DatabaseUrl -match '@([^/:?]+):(\d+)') {
        $target.Host = $Matches[1]
        $target.Port = [int]$Matches[2]
    } elseif ($DatabaseUrl -match '@([^/:?]+)') {
        $target.Host = $Matches[1]
    }
    return $target
}

# --- node_modules health -----------------------------------------------------

# Reports whether the pieces the build actually needs are present. The npm
# bin shims (node_modules\.bin) are checked too, but the project's own npm
# scripts invoke every CLI by its real entry point, so a missing .bin is a
# warning rather than a failure.
function Get-NodeModulesStatus {
    $root = Get-VPanelRoot
    $binDir = Join-Path $root 'node_modules\.bin'

    $binCount = 0
    if (Test-Path -LiteralPath $binDir) {
        $binCount = @(Get-ChildItem -LiteralPath $binDir -ErrorAction SilentlyContinue).Count
    }

    return [pscustomobject]@{
        NextCli      = (Test-Path -LiteralPath (Join-Path $root 'node_modules\next\dist\bin\next'))
        PrismaCli    = (Test-Path -LiteralPath (Join-Path $root 'node_modules\prisma\build\index.js'))
        TsxCli       = (Test-Path -LiteralPath (Join-Path $root 'node_modules\tsx\dist\cli.mjs'))
        PrismaClient = (Test-Path -LiteralPath (Join-Path $root 'node_modules\.prisma\client\index.js'))
        BinCount     = $binCount
    }
}

# --- PostgreSQL discovery ----------------------------------------------------

# winget installs PostgreSQL under Program Files but does NOT put psql on PATH,
# so a fresh install is invisible to Get-Command until the machine restarts.
# Probe the install directory directly instead.
function Resolve-PgTool {
    param([string]$Tool)

    $cmd = Get-Command $Tool -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $roots = @(
        'C:\Program Files\PostgreSQL',
        'C:\Program Files (x86)\PostgreSQL'
    )

    $best = $null
    $bestMajor = -1

    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }

        foreach ($version in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
            $exe = Join-Path $version.FullName "bin\$Tool.exe"
            if (-not (Test-Path -LiteralPath $exe)) { continue }

            # Pick the newest major version when several are installed.
            $major = 0
            if ($version.Name -match '^(\d+)') { $major = [int]$Matches[1] }

            if ($major -gt $bestMajor) {
                $bestMajor = $major
                $best = $exe
            }
        }
    }

    return $best
}

function Get-PostgresService {
    return (Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1)
}

# <install>\bin\psql.exe -> <install>, e.g. "C:\Program Files\PostgreSQL\18"
function Get-PgInstallDir {
    $psql = Resolve-PgTool -Tool 'psql'
    if (-not $psql) { return $null }
    return (Split-Path -Parent (Split-Path -Parent $psql))
}

# The data directory (holding pg_hba.conf) for the resolved installation.
function Get-PgDataDir {
    $install = Get-PgInstallDir
    if (-not $install) { return $null }
    $data = Join-Path $install 'data'
    if (Test-Path -LiteralPath $data) { return $data }
    return $null
}

# --- Prisma migrations -------------------------------------------------------

# Are there committed migrations to apply? Without them `prisma migrate deploy`
# succeeds while creating nothing, which is a silent and very confusing failure.
function Test-PrismaMigrations {
    $root = Get-VPanelRoot
    $dir = Join-Path $root 'prisma\migrations'
    if (-not (Test-Path -LiteralPath $dir)) { return $false }

    $found = @(Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'migration.sql') })

    return ($found.Count -gt 0)
}

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# --- Docker helpers ----------------------------------------------------------

function Invoke-Compose {
    param([string[]]$ComposeArgs)

    $root = Get-VPanelRoot
    Push-Location -LiteralPath $root
    try {
        & docker compose @ComposeArgs
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    if ($code -ne 0) {
        throw "docker compose $($ComposeArgs -join ' ') failed (exit code $code)."
    }
}

# --- Health ------------------------------------------------------------------

function Wait-Health {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 120,
        [int]$IntervalSeconds = 3
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
            if ($resp.StatusCode -eq 200) { return $true }
        } catch {
            # Not up yet - keep waiting.
        }
        Start-Sleep -Seconds $IntervalSeconds
    }
    return $false
}

# --- Process state (native mode) ---------------------------------------------

function Read-State {
    $path = Get-StatePath
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        return (Get-Content -Raw -LiteralPath $path | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Write-State {
    param($State)

    $path = Get-StatePath
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    ($State | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $path -Encoding ASCII
}

function Clear-State {
    $path = Get-StatePath
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}

function Test-ProcessAlive {
    param([int]$ProcessId)

    if ($ProcessId -le 0) { return $false }
    try {
        return ($null -ne (Get-Process -Id $ProcessId -ErrorAction Stop))
    } catch {
        return $false
    }
}

function Stop-ProcessTree {
    param([int]$ProcessId)

    if ($ProcessId -le 0) { return }
    try {
        # /T kills the whole tree (tsx and Next both spawn helpers).
        & taskkill.exe /PID $ProcessId /T /F 2>&1 | Out-Null
    } catch {
        # Already gone - nothing to do.
    }
}

# --- Output ------------------------------------------------------------------

function Write-Head {
    param([string]$Text)

    Write-Host ''
    Write-Host ('=' * 62) -ForegroundColor DarkCyan
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host ('=' * 62) -ForegroundColor DarkCyan
}

function Write-Step {
    param([string]$Text)
    Write-Host "  -> $Text" -ForegroundColor Gray
}

function Write-Ok {
    param([string]$Text)
    Write-Host "  OK  $Text" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Text)
    Write-Host "  !!  $Text" -ForegroundColor Yellow
}

function Write-Err {
    param([string]$Text)
    Write-Host "  XX  $Text" -ForegroundColor Red
}
