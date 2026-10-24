# =============================================================================
# VPanel - view logs.
#
#   powershell -ExecutionPolicy Bypass -File windows\logs.ps1
#   powershell -ExecutionPolicy Bypass -File windows\logs.ps1 -Target worker -Follow
# =============================================================================

param(
    [ValidateSet('all', 'web', 'worker')]
    [string]$Target = 'all',
    [switch]$Follow,
    [int]$Lines = 60
)

. (Join-Path $PSScriptRoot '_vpanel.ps1')

$root = Get-VPanelRoot
$mode = Get-VPanelMode

Write-Head "VPanel - logs ($Target)"

# -----------------------------------------------------------------------------
# Docker mode
# -----------------------------------------------------------------------------
if ($mode -eq 'docker') {
    $composeArgs = @('logs', "--tail=$Lines")
    if ($Target -ne 'all') { $composeArgs += $Target }
    if ($Follow) { $composeArgs += '-f' }

    Write-Step ('docker compose ' + ($composeArgs -join ' '))
    if ($Follow) {
        Write-Step 'press Ctrl+C to stop following'
    }
    Write-Host ''

    Push-Location -LiteralPath $root
    try {
        & docker compose @composeArgs
    } finally {
        Pop-Location
    }
    exit 0
}

# -----------------------------------------------------------------------------
# Native mode
# -----------------------------------------------------------------------------
$stateDir = Split-Path -Parent (Get-StatePath)
$targets = switch ($Target) {
    'web' { @('web') }
    'worker' { @('worker') }
    default { @('web', 'worker') }
}

$anyShown = $false

foreach ($name in $targets) {
    $log = Join-Path $stateDir "$name.log"
    $errLog = "$log.err"

    Write-Host ''
    Write-Host "  --- $name ---" -ForegroundColor Cyan

    if (-not (Test-Path -LiteralPath $log)) {
        Write-Warn "no log file yet at $log"
        continue
    }

    $anyShown = $true

    if ($Follow -and $name -eq $targets[0]) {
        Write-Step "following $log - press Ctrl+C to stop"
        Write-Host ''
        Get-Content -LiteralPath $log -Tail $Lines -Wait
    } else {
        Get-Content -LiteralPath $log -Tail $Lines
        if (Test-Path -LiteralPath $errLog) {
            $errContent = Get-Content -LiteralPath $errLog -Tail 20
            if ($errContent) {
                Write-Host ''
                Write-Host '  (stderr)' -ForegroundColor DarkYellow
                $errContent
            }
        }
    }
}

if (-not $anyShown) {
    Write-Host ''
    Write-Step 'Nothing logged yet. If the panel is not running, start it with start.bat.'
}

exit 0
