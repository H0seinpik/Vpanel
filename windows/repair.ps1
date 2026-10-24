# =============================================================================
# VPanel - repair a broken node_modules.
#
#   powershell -ExecutionPolicy Bypass -File windows\repair.ps1
#   powershell -ExecutionPolicy Bypass -File windows\repair.ps1 -Reinstall
#
# Use this when a command fails with messages like:
#     'prisma' is not recognized as an internal or external command
#     'next' is not recognized ...
#     Cannot find module '...'
#
# The usual cause is an incomplete install: node_modules exists but the npm bin
# shims (node_modules\.bin) were never created, so anything that calls a CLI by
# name fails. This script diagnoses that and repairs it.
# =============================================================================

param(
    [switch]$Reinstall
)

. (Join-Path $PSScriptRoot '_vpanel.ps1')

$root = Get-VPanelRoot

Write-Head 'VPanel - repair'

# --- Report ------------------------------------------------------------------
$status = Get-NodeModulesStatus

Write-Host '  Current state:' -ForegroundColor Gray
Write-Host "    next CLI entry point : " -NoNewline -ForegroundColor DarkGray
if ($status.NextCli) { Write-Host 'present' -ForegroundColor Green } else { Write-Host 'MISSING' -ForegroundColor Red }

Write-Host "    prisma CLI           : " -NoNewline -ForegroundColor DarkGray
if ($status.PrismaCli) { Write-Host 'present' -ForegroundColor Green } else { Write-Host 'MISSING' -ForegroundColor Red }

Write-Host "    tsx CLI              : " -NoNewline -ForegroundColor DarkGray
if ($status.TsxCli) { Write-Host 'present' -ForegroundColor Green } else { Write-Host 'MISSING' -ForegroundColor Red }

Write-Host "    generated client     : " -NoNewline -ForegroundColor DarkGray
if ($status.PrismaClient) { Write-Host 'present' -ForegroundColor Green } else { Write-Host 'MISSING' -ForegroundColor Red }

Write-Host "    npm bin shims        : " -NoNewline -ForegroundColor DarkGray
if ($status.BinCount -gt 0) {
    Write-Host "$($status.BinCount) entries" -ForegroundColor Green
} else {
    Write-Host 'EMPTY' -ForegroundColor Yellow
}

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Err 'npm was not found on PATH - install Node.js 20+ first.'
    exit 1
}

# A repair can touch files the running panel holds open (npm install above all),
# so stop the stack first. It is started again at the end - a repair that leaves
# the panel down is not a repair, it is a longer outage.
Write-Step 'stopping the running stack (it is started again at the end)'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'stop.ps1')

Write-Host ''

# --- Full reinstall ----------------------------------------------------------
if ($Reinstall) {
    Write-Warn '-Reinstall was passed: deleting node_modules and starting over'
    Write-Step 'this takes several minutes'

    $modules = Join-Path $root 'node_modules'
    if (Test-Path -LiteralPath $modules) {
        Remove-Item -LiteralPath $modules -Recurse -Force -ErrorAction SilentlyContinue
    }

    Push-Location -LiteralPath $root
    try {
        & npm install --no-audit --no-fund
        $code = $LASTEXITCODE
        if ($code -ne 0) {
            Write-Warn 'default install failed - retrying with a project-local cache'
            & npm install --no-audit --no-fund --cache .npm-cache
            $code = $LASTEXITCODE
        }
    } finally {
        Pop-Location
    }

    if ($code -ne 0) {
        Write-Err "npm install failed (exit code $code)"
        exit 1
    }
    Write-Ok 'reinstall complete'
    $status = Get-NodeModulesStatus
}

# --- Dependencies missing entirely ------------------------------------------
if (-not $status.NextCli -or -not $status.PrismaCli) {
    Write-Step 'dependencies are incomplete - running npm install'

    Push-Location -LiteralPath $root
    try {
        & npm install --no-audit --no-fund
        $code = $LASTEXITCODE
        if ($code -ne 0) {
            Write-Warn 'default install failed - retrying with a project-local cache'
            & npm install --no-audit --no-fund --cache .npm-cache
            $code = $LASTEXITCODE
        }
    } finally {
        Pop-Location
    }

    if ($code -ne 0) {
        Write-Err "npm install failed (exit code $code)"
        exit 1
    }

    Write-Ok 'dependencies installed'
    $status = Get-NodeModulesStatus
}

# --- Bin shims missing -------------------------------------------------------
if ($status.BinCount -eq 0) {
    Write-Warn 'the npm bin shims are missing'
    Write-Step 'the project scripts invoke CLIs directly, so builds still work,'
    Write-Step 'but npx and third-party tooling expect these shims. Repairing...'

    $attempts = @(
        @{ Label = 'npm install --force'; Action = { & npm install --no-audit --no-fund --force } },
        @{ Label = 'npm rebuild'; Action = { & npm rebuild } },
        @{ Label = 'npm install after clearing .bin'; Action = {
                $binDir = Join-Path $root 'node_modules\.bin'
                if (Test-Path -LiteralPath $binDir) {
                    Remove-Item -LiteralPath $binDir -Recurse -Force -ErrorAction SilentlyContinue
                }
                & npm install --no-audit --no-fund --force
            } }
    )

    foreach ($attempt in $attempts) {
        Push-Location -LiteralPath $root
        try {
            Write-Step $attempt.Label
            & $attempt.Action | Out-Null
        } finally {
            Pop-Location
        }

        $check = Get-NodeModulesStatus
        if ($check.BinCount -gt 0) {
            Write-Ok "repaired - $($check.BinCount) bin entries created"
            $status = $check
            break
        }
    }

    if ($status.BinCount -eq 0) {
        Write-Warn 'the shims could not be recreated automatically'
        Write-Host ''
        Write-Host '  This does not block VPanel: its npm scripts call every CLI by' -ForegroundColor Gray
        Write-Host '  its real entry point. If another tool needs the shims, run:' -ForegroundColor Gray
        Write-Host '      repair.bat -Reinstall' -ForegroundColor DarkYellow
        Write-Host '  and if that still fails, check your antivirus is not blocking' -ForegroundColor DarkGray
        Write-Host '  symlink creation inside the project folder.' -ForegroundColor DarkGray
        Write-Host ''
    }
}

# --- Generated Prisma client -------------------------------------------------
if (-not (Get-NodeModulesStatus).PrismaClient) {
    Write-Step 'generating the Prisma client'
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
    Write-Ok 'Prisma client generated'
}

# --- Final report ------------------------------------------------------------
$final = Get-NodeModulesStatus

Write-Host ''
Write-Host '  Result:' -ForegroundColor Gray
Write-Host "    next / prisma / tsx  : " -NoNewline -ForegroundColor DarkGray
if ($final.NextCli -and $final.PrismaCli -and $final.TsxCli) {
    Write-Host 'all present' -ForegroundColor Green
} else {
    Write-Host 'still incomplete - try repair.bat -Reinstall' -ForegroundColor Red
}

Write-Host "    generated client     : " -NoNewline -ForegroundColor DarkGray
if ($final.PrismaClient) { Write-Host 'present' -ForegroundColor Green } else { Write-Host 'MISSING' -ForegroundColor Red }

Write-Host "    npm bin shims        : " -NoNewline -ForegroundColor DarkGray
if ($final.BinCount -gt 0) { Write-Host "$($final.BinCount) entries" -ForegroundColor Green } else { Write-Host 'empty (non-blocking)' -ForegroundColor Yellow }

Write-Host ''

# --- Bring the panel back up -------------------------------------------------
# Repairing node_modules is pointless while the panel stays down: the operator
# ran repair because something was broken, so finish by starting the stack.
# start.ps1 builds when .next\BUILD_ID is missing, starts the worker first, and
# reports the panel and the worker separately - so this ends with proof either
# way rather than a "run start.bat now" instruction nobody needed.
Write-Step 'starting VPanel (this also builds it if the build is missing)'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start.ps1') -NoBrowser
$started = $LASTEXITCODE

Write-Host ''
if ($started -eq 0) {
    Write-Host '  Repair complete and the panel is up.' -ForegroundColor Green
} else {
    Write-Host '  Repair finished but the panel did not come up - see the output above.' -ForegroundColor Red
    Write-Host '  Read .vpanel\web.log and .vpanel\worker.log for the reason.' -ForegroundColor DarkGray
}
Write-Host ''

exit $started
