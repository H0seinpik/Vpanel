# =============================================================================
# VPanel - run automatically when you sign in.
#
#   powershell -ExecutionPolicy Bypass -File windows\autostart.ps1 install
#   powershell -ExecutionPolicy Bypass -File windows\autostart.ps1 remove
#   powershell -ExecutionPolicy Bypass -File windows\autostart.ps1 status
#
# Creates a per-user Scheduled Task that starts the panel at sign-in. No
# administrator rights are required, and it is trivial to undo.
#
# This is the right option for a PC that acts as a server and signs itself in.
# If your machine must start the panel before anyone logs in, create a task in
# Task Scheduler manually with the trigger "At startup" and the account "SYSTEM"
# (that variant does require administrator rights).
# =============================================================================

param(
    [ValidateSet('install', 'remove', 'status')]
    [string]$Action = 'status'
)

. (Join-Path $PSScriptRoot '_vpanel.ps1')

$taskName = 'VPanel'
$startScript = Join-Path $PSScriptRoot 'start.ps1'

Write-Head "VPanel - autostart ($Action)"

switch ($Action) {

    'install' {
        if (-not (Test-Path -LiteralPath $startScript)) {
            Write-Err "start.ps1 not found at $startScript"
            exit 1
        }

        # -NoBrowser so a sign-in does not hijack the desktop with a browser tab.
        $action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -NoBrowser"

        Write-Step "registering scheduled task '$taskName' (trigger: at sign-in)"
        & schtasks.exe /Create /TN $taskName /TR $action /SC ONLOGON /F | Out-Null
        $code = $LASTEXITCODE

        if ($code -ne 0) {
            Write-Err "could not create the task (exit code $code)"
            exit 1
        }

        Write-Ok 'autostart enabled'
        Write-Step "VPanel will start automatically next time you sign in"
        Write-Step "to start it now, run start.bat"
    }

    'remove' {
        Write-Step "removing scheduled task '$taskName'"
        & schtasks.exe /Delete /TN $taskName /F 2>&1 | Out-Null
        $code = $LASTEXITCODE

        if ($code -ne 0) {
            Write-Warn 'the task was not found - nothing to remove'
        } else {
            Write-Ok 'autostart disabled'
        }
    }

    'status' {
        $existing = & schtasks.exe /Query /TN $taskName 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Ok 'autostart is enabled'
            Write-Host ''
            $existing | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
        } else {
            Write-Step 'autostart is not configured'
            Write-Step 'run autostart.bat install to enable it'
        }
    }
}

exit 0
