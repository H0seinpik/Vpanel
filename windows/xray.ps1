# =============================================================================
# VPanel - control the Xray server process.
#
#   powershell -ExecutionPolicy Bypass -File windows\xray.ps1 status
#   powershell -ExecutionPolicy Bypass -File windows\xray.ps1 start
#   powershell -ExecutionPolicy Bypass -File windows\xray.ps1 stop
#   powershell -ExecutionPolicy Bypass -File windows\xray.ps1 restart
#   powershell -ExecutionPolicy Bypass -File windows\xray.ps1 sync
#   powershell -ExecutionPolicy Bypass -File windows\xray.ps1 gencert
#
# Xray is what actually accepts proxy connections. VPanel only decides what it
# should serve; `sync` renders the panel's configurations into Xray's config.json
# and then restarts the process so the change takes effect.
#
# `gencert` creates the self-signed certificate that every TLS configuration
# (Trojan, VLESS+TLS, and anything sharing a port) needs. It REFUSES to
# overwrite an existing pair, because replacing it invalidates the certificate
# pin already baked into every issued client link - an existing client would
# fail to connect with no obvious reason. Pass -Force only when you intend to
# re-issue every client.
#
# Override the install location with the XRAY_DIR environment variable.
# =============================================================================

param(
    [ValidateSet('start', 'stop', 'restart', 'status', 'sync', 'gencert')]
    [string]$Action = 'status',

    [string]$Domain = '',

    [switch]$Force
)

. (Join-Path $PSScriptRoot '_vpanel.ps1')

$root = Get-VPanelRoot

$XrayDir = 'C:\xray'
if ($env:XRAY_DIR) { $XrayDir = $env:XRAY_DIR }

$XrayExe = Join-Path $XrayDir 'xray.exe'
$XrayConfig = Join-Path $XrayDir 'config.json'
$XrayLog = Join-Path $XrayDir 'xray.log'
$XrayCert = Join-Path $XrayDir 'cert.pem'
$XrayKey = Join-Path $XrayDir 'key.pem'

# --- Helpers -----------------------------------------------------------------

function Get-XrayPid {
    $state = Read-State
    if ($state -and $state.PSObject.Properties.Name -contains 'xrayPid') {
        $pid0 = [int]$state.xrayPid
        if ($pid0 -gt 0 -and (Test-ProcessAlive -ProcessId $pid0)) { return $pid0 }
    }
    # Fall back to looking for the process by name.
    $proc = Get-Process -Name 'xray' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc) { return $proc.Id }
    return 0
}

function Save-XrayPid {
    param([int]$ProcessId)

    $state = Read-State
    if (-not $state) { $state = [pscustomobject]@{} }

    $merged = @{}
    if ($state) {
        foreach ($p in $state.PSObject.Properties) { $merged[$p.Name] = $p.Value }
    }
    $merged['xrayPid'] = $ProcessId
    Write-State $merged
}

function Get-XrayPorts {
    if (-not (Test-Path -LiteralPath $XrayConfig)) { return @() }
    try {
        $cfg = Get-Content -Raw -LiteralPath $XrayConfig | ConvertFrom-Json
        return @($cfg.inbounds | ForEach-Object { [int]$_.port })
    } catch {
        return @()
    }
}

function Show-XrayStatus {
    $procId = Get-XrayPid
    $ports = Get-XrayPorts

    Write-Host "  Xray folder : $XrayDir" -ForegroundColor Gray
    Write-Host "  xray.exe    : " -NoNewline -ForegroundColor Gray
    if (Test-Path -LiteralPath $XrayExe) { Write-Host 'present' -ForegroundColor Green }
    else { Write-Host "NOT FOUND - run install-xray.bat" -ForegroundColor Red }

    Write-Host "  config.json : " -NoNewline -ForegroundColor Gray
    if (Test-Path -LiteralPath $XrayConfig) { Write-Host 'present' -ForegroundColor Green }
    else { Write-Host 'missing - run xray-sync.bat' -ForegroundColor Yellow }

    Write-Host "  process     : " -NoNewline -ForegroundColor Gray
    if ($procId -gt 0) { Write-Host "running (PID $procId)" -ForegroundColor Green }
    else { Write-Host 'not running' -ForegroundColor Yellow }

    if ($ports.Count -gt 0) {
        Write-Host '  listening   :' -ForegroundColor Gray
        foreach ($p in $ports) {
            $open = Test-TcpPort -ComputerName '127.0.0.1' -Port $p -TimeoutMs 1200
            Write-Host "    port $p : " -NoNewline -ForegroundColor DarkGray
            if ($open) { Write-Host 'OPEN' -ForegroundColor Green } else { Write-Host 'closed' -ForegroundColor Red }
        }
    }

    $lanIp = Get-LanIp
    if ($ports.Count -gt 0) {
        Write-Host ''
        Write-Host "  This server is reachable at $lanIp on port $($ports -join ', ')" -ForegroundColor Gray
        Write-Host '  For connections from the internet, allow that port through the firewall:' -ForegroundColor DarkGray
        Write-Host '      firewall.bat add-port' -ForegroundColor DarkYellow
    }
}

# --- Actions -----------------------------------------------------------------

Write-Head "VPanel - xray ($Action)"

if (-not (Test-Path -LiteralPath $XrayExe)) {
    Write-Err "xray.exe not found in $XrayDir"
    Write-Step 'Run install-xray.bat to download it.'
    exit 1
}

switch ($Action) {

    'status' { Show-XrayStatus }

    'start' {
        $existing = Get-XrayPid
        if ($existing -gt 0) {
            Write-Warn "Xray is already running (PID $existing)"
            Show-XrayStatus
            exit 0
        }

        if (-not (Test-Path -LiteralPath $XrayConfig)) {
            Write-Err "config.json not found in $XrayDir"
            Write-Step 'Run xray-sync.bat first - it renders the config from the panel.'
            exit 1
        }

        Write-Step 'starting xray'
        $proc = Start-Process -FilePath $XrayExe `
            -ArgumentList @('run', '-c', $XrayConfig) `
            -WorkingDirectory $XrayDir -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $XrayLog -RedirectStandardError "$XrayLog.err"

        Save-XrayPid -ProcessId $proc.Id
        Start-Sleep -Seconds 3

        if (Test-ProcessAlive -ProcessId $proc.Id) {
            Write-Ok "xray started (PID $($proc.Id))"
        } else {
            Write-Err 'xray exited immediately - check the log'
            Write-Step "log: $XrayLog"
            if (Test-Path -LiteralPath "$XrayLog.err") {
                Get-Content -LiteralPath "$XrayLog.err" -Tail 10 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
            }
            exit 1
        }
        Show-XrayStatus
    }

    'stop' {
        $procId = Get-XrayPid
        if ($procId -le 0) {
            Write-Ok 'xray is not running'
            exit 0
        }

        Write-Step "stopping xray (PID $procId)"
        Stop-ProcessTree -ProcessId $procId
        Start-Sleep -Seconds 1
        Write-Ok 'xray stopped'
    }

    'restart' {
        $procId = Get-XrayPid
        if ($procId -gt 0) {
            Write-Step "stopping xray (PID $procId)"
            Stop-ProcessTree -ProcessId $procId
            Start-Sleep -Seconds 2
        }

        if (-not (Test-Path -LiteralPath $XrayConfig)) {
            Write-Err "config.json not found - run xray-sync.bat"
            exit 1
        }

        Write-Step 'starting xray'
        $proc = Start-Process -FilePath $XrayExe `
            -ArgumentList @('run', '-c', $XrayConfig) `
            -WorkingDirectory $XrayDir -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $XrayLog -RedirectStandardError "$XrayLog.err"

        Save-XrayPid -ProcessId $proc.Id
        Start-Sleep -Seconds 3

        if (Test-ProcessAlive -ProcessId $proc.Id) {
            Write-Ok "xray restarted (PID $($proc.Id))"
        } else {
            Write-Err 'xray exited immediately - check the log'
            exit 1
        }
        Show-XrayStatus
    }

    'sync' {
        Write-Step 'reconciling the node config with the panel'

        $node = Get-Command node -ErrorAction SilentlyContinue
        if (-not $node) {
            Write-Err 'node was not found on PATH'
            exit 1
        }

        # The sync script now owns the whole job: it renders the config, compares
        # it with what is applied, and restarts Xray only if it changed.
        Push-Location -LiteralPath $root
        try {
            & node '--env-file=.env' '--import' 'tsx' 'scripts/xray-sync.ts'
            $code = $LASTEXITCODE
        } finally {
            Pop-Location
        }

        if ($code -ne 0) {
            Write-Err 'the sync step failed - see the output above'
            exit 1
        }

        Write-Host ''
        Show-XrayStatus
    }

    'gencert' {
        # A TLS inbound has nothing to present without this pair, and the panel
        # then reports the configuration as skipped rather than serving it.
        $haveCert = Test-Path -LiteralPath $XrayCert
        $haveKey = Test-Path -LiteralPath $XrayKey

        if (($haveCert -or $haveKey) -and -not $Force) {
            Write-Warn 'a certificate already exists - refusing to replace it'
            Write-Host ''
            Write-Host "    cert : $XrayCert" -ForegroundColor Gray
            Write-Host "    key  : $XrayKey" -ForegroundColor Gray
            Write-Host ''
            Write-Step 'Replacing it changes the certificate pin, so every client'
            Write-Step 'link you have already handed out stops working until you'
            Write-Step 're-issue it. If you really mean to, run:'
            Write-Host ''
            Write-Host '    xray-gencert.bat -Force' -ForegroundColor Yellow
            Write-Host ''
            exit 1
        }

        if (-not (Test-Path -LiteralPath $XrayDir)) {
            New-Item -ItemType Directory -Path $XrayDir -Force | Out-Null
        }

        # Default the certificate name to the machine's public address when the
        # operator does not supply one. That is what the client actually
        # connects to, so it belongs in the certificate.
        $name = $Domain
        if (-not $name) {
            $name = (Resolve-DnsName -Name ([System.Net.Dns]::GetHostName()) -Type A `
                    -ErrorAction SilentlyContinue |
                    Where-Object { $_.IPAddress -and $_.IPAddress -notmatch '^(127\.|169\.254\.|10\.|192\.168\.)' } |
                    Select-Object -First 1 -ExpandProperty IPAddress)
        }
        if (-not $name) { $name = 'vpanel' }

        Write-Step "generating a self-signed certificate for $name"

        # xray tls cert writes a JSON document to stdout; -file would also save
        # a combined PEM we do not want, so capture stdout and split it instead.
        $json = & $XrayExe tls cert -domain $name -name $name -expire 87600h -json 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Err 'xray refused to generate the certificate'
            $json | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
            exit 1
        }

        try {
            $parsed = ($json -join "`n") | ConvertFrom-Json
        } catch {
            Write-Err 'could not parse the certificate xray produced'
            exit 1
        }

        if (-not $parsed.certificate -or -not $parsed.key) {
            Write-Err 'the certificate output was missing its certificate or key'
            exit 1
        }

        # Write ASCII with LF endings: PowerShell 5.1 would otherwise emit a BOM
        # and CRLF, and OpenSSL (which Xray uses to read the PEM) rejects a BOM.
        $certText = (($parsed.certificate -join "`n") + "`n")
        $keyText = (($parsed.key -join "`n") + "`n")
        [System.IO.File]::WriteAllText($XrayCert, $certText, [System.Text.ASCIIEncoding]::new())
        [System.IO.File]::WriteAllText($XrayKey, $keyText, [System.Text.ASCIIEncoding]::new())

        Write-Ok "wrote $XrayCert"
        Write-Ok "wrote $XrayKey"

        # Show the pin so the operator can sanity-check it against the panel.
        $pin = & $XrayExe tls hash --cert $XrayCert 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host ''
            Write-Step 'certificate pin (the panel adds this to every TLS client):'
            ($pin -join "`n").Split("`n") | Where-Object { $_.Trim() } | ForEach-Object {
                Write-Host "    $($_.Trim())" -ForegroundColor DarkGray
            }
        }

        Write-Host ''
        Write-Step 'next: xray-sync.bat   (re-render the node and restart Xray)'
    }
}

exit 0
