# =============================================================================
# VPanel - Windows Firewall rules. Requires administrator rights.
#
#   powershell -ExecutionPolicy Bypass -File windows\firewall.ps1            (all)
#   powershell -ExecutionPolicy Bypass -File windows\firewall.ps1 add        (alias)
#   powershell -ExecutionPolicy Bypass -File windows\firewall.ps1 add-port
#   powershell -ExecutionPolicy Bypass -File windows\firewall.ps1 remove
#   powershell -ExecutionPolicy Bypass -File windows\firewall.ps1 remove-port
#   powershell -ExecutionPolicy Bypass -File windows\firewall.ps1 status
#
# Two different kinds of rule, because they have different audiences:
#
#   * the PANEL port   - reached from the LAN, so Private+Domain only
#   * every PROXY port - reached from the internet by the customers' apps, so
#                        it has to cover every profile
#
# The default action opens BOTH. It used to open only the panel port, and the
# proxy ports silently stayed blocked: every client outside the machine was
# refused while a test run ON the machine still succeeded, which is exactly the
# "you said it was open but it was closed" report.
# =============================================================================

param(
    [ValidateSet('all', 'add', 'add-port', 'remove', 'remove-port', 'status')]
    [string]$Action = 'all'
)

. (Join-Path $PSScriptRoot '_vpanel.ps1')

$root = Get-VPanelRoot
$envMap = Get-DotEnv -Root $root
$mode = Get-VPanelMode
$panelPort = Get-VPanelPort -Mode $mode -Env $envMap
$panelRule = "VPanel HTTP $panelPort"
$proxyPrefix = 'VPanel Xray '
$udpPrefix = 'VPanel Xray UDP '

Write-Head "VPanel - firewall ($Action)"

# --- Elevation check ---------------------------------------------------------
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin -and $Action -ne 'status') {
    Write-Err 'This needs administrator rights.'
    Write-Host ''
    Write-Host '  Right-click firewall.bat and choose "Run as administrator".' -ForegroundColor Yellow
    Write-Host ''
    exit 1
}

# --- Helpers -----------------------------------------------------------------

function Get-XrayProxyPorts {
    <#
      Every public port the node is actually serving, read from the rendered
      Xray config rather than from a hand-written list - a configuration added
      in the panel must be reachable without anyone remembering this script.
    #>
    $xrayDir = 'C:\xray'
    if ($env:XRAY_DIR) { $xrayDir = $env:XRAY_DIR }
    $xrayConfig = Join-Path $xrayDir 'config.json'

    if (-not (Test-Path -LiteralPath $xrayConfig)) { return @() }

    try {
        $cfg = Get-Content -Raw -LiteralPath $xrayConfig | ConvertFrom-Json
        $ports = @(
            $cfg.inbounds |
                Where-Object { $_.listen -ne '127.0.0.1' -and [int]$_.port -gt 0 } |
                ForEach-Object { [int]$_.port } |
                Sort-Object -Unique
        )
        return $ports
    } catch {
        return @()
    }
}

function Get-XrayUdpPorts {
    <#
      Tunnels can forward UDP as well as TCP. Windows Firewall treats the two
      protocols separately, so a UDP tunnel needs its own inbound rule; opening
      only TCP leaves the tunnel looking broken for DNS, QUIC and game traffic.
    #>
    $xrayDir = 'C:\xray'
    if ($env:XRAY_DIR) { $xrayDir = $env:XRAY_DIR }
    $xrayConfig = Join-Path $xrayDir 'config.json'

    if (-not (Test-Path -LiteralPath $xrayConfig)) { return @() }

    try {
        $cfg = Get-Content -Raw -LiteralPath $xrayConfig | ConvertFrom-Json
        $ports = @(
            $cfg.inbounds |
                Where-Object {
                    $_.listen -ne '127.0.0.1' -and
                    [int]$_.port -gt 0 -and
                    ($_.protocol -eq 'tunnel' -or $_.protocol -eq 'dokodemo-door') -and
                    ([string]$_.settings.allowedNetwork) -match 'udp'
                } |
                ForEach-Object { [int]$_.port } |
                Sort-Object -Unique
        )
        return $ports
    } catch {
        return @()
    }
}

function Get-ExistingProxyRulePorts {
    <#
      Ports that already have a 'VPanel Xray <port>' rule, so stale rules for
      ports that are no longer served can be removed.
    #>
    $ports = @()
    $output = & netsh.exe advfirewall firewall show rule name=all 2>&1
    foreach ($line in $output) {
        $text = [string]$line
        if ($text -match 'VPanel Xray (\d+)') {
            $ports += [int]$Matches[1]
        }
    }
    return @($ports | Sort-Object -Unique)
}

function Get-ExistingProxyUdpRulePorts {
    <#
      Same as Get-ExistingProxyRulePorts, but for the UDP rules. The regex
      requires the "UDP " token, so TCP rules are never matched here.
    #>
    $ports = @()
    $output = & netsh.exe advfirewall firewall show rule name=all 2>&1
    foreach ($line in $output) {
        $text = [string]$line
        if ($text -match 'VPanel Xray UDP (\d+)') {
            $ports += [int]$Matches[1]
        }
    }
    return @($ports | Sort-Object -Unique)
}

function Add-ProxyRules {
    param([int[]]$Ports, [int[]]$UdpPorts = @())

    if ($Ports.Count -eq 0) {
        Write-Warn 'no proxy ports found - create a configuration or tunnel in the panel first'
        return
    }

    foreach ($p in $Ports) {
        $name = "$proxyPrefix$p"
        & netsh.exe advfirewall firewall delete rule name="$name" 2>&1 | Out-Null
        & netsh.exe advfirewall firewall add rule `
            name="$name" dir=in action=allow protocol=TCP localport=$p `
            profile=any description="VPanel proxy (Xray)" 2>&1 | Out-Null

        if ($LASTEXITCODE -eq 0) {
            Write-Ok "opened TCP $p (all profiles - proxy clients come from the internet)"
        } else {
            Write-Err "could not open TCP $p"
        }
    }

    foreach ($p in $UdpPorts) {
        $name = "$udpPrefix$p"
        & netsh.exe advfirewall firewall delete rule name="$name" 2>&1 | Out-Null
        & netsh.exe advfirewall firewall add rule `
            name="$name" dir=in action=allow protocol=UDP localport=$p `
            profile=any description="VPanel tunnel (Xray UDP)" 2>&1 | Out-Null

        if ($LASTEXITCODE -eq 0) {
            Write-Ok "opened UDP $p (tunnel forwards UDP)"
        } else {
            Write-Err "could not open UDP $p"
        }
    }

    # A port that is no longer served must not stay open.
    $stale = @(Get-ExistingProxyRulePorts | Where-Object { $Ports -notcontains $_ })
    foreach ($p in $stale) {
        & netsh.exe advfirewall firewall delete rule name="$proxyPrefix$p" 2>&1 | Out-Null
        Write-Step "closed TCP $p (no longer served)"
    }

    $staleUdp = @(Get-ExistingProxyUdpRulePorts | Where-Object { $UdpPorts -notcontains $_ })
    foreach ($p in $staleUdp) {
        & netsh.exe advfirewall firewall delete rule name="$udpPrefix$p" 2>&1 | Out-Null
        Write-Step "closed UDP $p (no longer served)"
    }
}

function Add-PanelRule {
    Write-Step "allowing inbound TCP $panelPort on the Private and Domain profiles"
    & netsh.exe advfirewall firewall delete rule name="$panelRule" 2>&1 | Out-Null
    & netsh.exe advfirewall firewall add rule `
        name="$panelRule" dir=in action=allow protocol=TCP localport=$panelPort `
        profile=private,domain description="VPanel administrative panel" 2>&1 | Out-Null

    if ($LASTEXITCODE -ne 0) {
        Write-Err 'could not add the panel firewall rule'
        return $false
    }
    Write-Ok "rule added: $panelRule"
    return $true
}

function Get-AllowedInboundPorts {
    param([ValidateSet('TCP', 'UDP')][string]$Protocol = 'TCP')

    <#
      Every local port that SOME inbound allow rule covers — not just the rules
      this script created. A port opened by hand ("Xray TCP 443") is just as open,
      and a status that ignored it would send the operator chasing a rule that
      already exists. `Protocol: Any` counts for both TCP and UDP.
    #>
    $ports = @()
    $output = @(& netsh.exe advfirewall firewall show rule name=all dir=in 2>&1 | ForEach-Object { [string]$_ })

    # netsh prints each rule as a block whose "Action:" line comes AFTER
    # "LocalPort:", so a single pass cannot know whether a port is allowed yet.
    # Split into blocks first, then read the ports of the allow ones.
    for ($i = 0; $i -lt $output.Count; $i++) {
        if ($output[$i] -notmatch '^Rule Name:') { continue }

        $block = @()
        $j = $i + 1
        while ($j -lt $output.Count -and $output[$j] -notmatch '^Rule Name:') {
            $block += $output[$j]
            $j += 1
        }

        $isAllow = $false
        foreach ($line in $block) {
            if ($line -match 'Action:\s*Allow') { $isAllow = $true; break }
        }
        if (-not $isAllow) { continue }

        $protocolOk = $false
        foreach ($line in $block) {
            if ($line -match 'Protocol:\s*(TCP|UDP|Any)') {
                if ($Matches[1] -eq 'Any' -or $Matches[1] -eq $Protocol) {
                    $protocolOk = $true
                    break
                }
            }
        }
        if (-not $protocolOk) { continue }

        foreach ($line in $block) {
            if ($line -match 'LocalPort:\s*(.+)$') {
                foreach ($piece in ($Matches[1] -split ',')) {
                    $p = $piece.Trim()
                    if ($p -match '^\d+$') { $ports += [int]$p }
                }
            }
        }
    }

    return @($ports | Sort-Object -Unique)
}

# --- Actions -----------------------------------------------------------------

if ($Action -eq 'add-port') {
    $ports = Get-XrayProxyPorts
    $udpPorts = Get-XrayUdpPorts
    Add-ProxyRules -Ports $ports -UdpPorts $udpPorts

    Write-Host ''
    Write-Host '  Clients can now reach the proxy on:' -ForegroundColor Gray
    foreach ($p in $ports) {
        Write-Host "    ${env:COMPUTERNAME}:$p" -ForegroundColor Cyan
    }
    Write-Host ''
    exit 0
}

if ($Action -eq 'remove-port') {
    foreach ($p in (Get-ExistingProxyRulePorts)) {
        & netsh.exe advfirewall firewall delete rule name="$proxyPrefix$p" 2>&1 | Out-Null
        Write-Ok "closed TCP $p"
    }
    foreach ($p in (Get-ExistingProxyUdpRulePorts)) {
        & netsh.exe advfirewall firewall delete rule name="$udpPrefix$p" 2>&1 | Out-Null
        Write-Ok "closed UDP $p"
    }
    exit 0
}

switch ($Action) {

    'all' {
        $ok = Add-PanelRule
        Write-Host ''
        $ports = Get-XrayProxyPorts
        $udpPorts = Get-XrayUdpPorts
        Add-ProxyRules -Ports $ports -UdpPorts $udpPorts

        $lanIp = Get-LanIp
        $lanUrl = if ($panelPort -eq 80) { "http://$lanIp" } else { "http://${lanIp}:$panelPort" }
        Write-Host ''
        Write-Host '  Panel (from your network): ' -NoNewline -ForegroundColor Gray
        Write-Host $lanUrl -ForegroundColor Cyan
        Write-Host "  Proxy ports open          : " -NoNewline -ForegroundColor Gray
        Write-Host ($ports -join ', ') -ForegroundColor Cyan
        Write-Host ''
        if (-not $ok) { exit 1 }
    }

    'add' {
        # Kept as an alias: the old name only opened the panel port, which is
        # what let the proxy ports stay blocked.
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath all
        exit $LASTEXITCODE
    }

    'remove' {
        Write-Step "removing rule '$panelRule'"
        & netsh.exe advfirewall firewall delete rule name="$panelRule" 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Warn 'the panel rule was not found' } else { Write-Ok 'panel rule removed' }

        foreach ($p in (Get-ExistingProxyRulePorts)) {
            & netsh.exe advfirewall firewall delete rule name="$proxyPrefix$p" 2>&1 | Out-Null
            Write-Ok "closed TCP $p"
        }
        foreach ($p in (Get-ExistingProxyUdpRulePorts)) {
            & netsh.exe advfirewall firewall delete rule name="$udpPrefix$p" 2>&1 | Out-Null
            Write-Ok "closed UDP $p"
        }
    }

    'status' {
        $existing = Get-ExistingProxyRulePorts
        $existingUdp = Get-ExistingProxyUdpRulePorts
        $wanted = Get-XrayProxyPorts
        $wantedUdp = Get-XrayUdpPorts
        $allowedTcp = @(Get-AllowedInboundPorts -Protocol TCP)
        $allowedUdp = @(Get-AllowedInboundPorts -Protocol UDP)

        Write-Step 'panel rule'
        $panelFound = & netsh.exe advfirewall firewall show rule name="$panelRule" 2>&1 |
            Select-String -Pattern $panelRule -SimpleMatch
        if ($panelFound) { Write-Ok "present: $panelRule" } else { Write-Warn "MISSING: $panelRule" }

        Write-Host ''
        Write-Step 'proxy ports'
        foreach ($p in $wanted) {
            if ($allowedTcp -contains $p) {
                Write-Ok "TCP $p is allowed"
            } else {
                Write-Warn "TCP $p is NOT allowed - clients outside this machine cannot connect"
            }

            if ($wantedUdp -contains $p) {
                if ($allowedUdp -contains $p) {
                    Write-Ok "UDP $p is allowed (tunnel forwards UDP)"
                } else {
                    Write-Warn "UDP $p is NOT allowed - UDP through this tunnel will fail"
                }
            }
        }

        $extra = @($existing | Where-Object { $wanted -notcontains $_ })
        foreach ($p in $extra) {
            Write-Step "TCP $p has a VPanel rule but is no longer served"
        }

        $extraUdp = @($existingUdp | Where-Object { $wantedUdp -notcontains $_ })
        foreach ($p in $extraUdp) {
            Write-Step "UDP $p has a VPanel rule but is no longer served"
        }

        Write-Host ''
        Write-Host '  Run firewall.bat as administrator to open everything at once.' -ForegroundColor DarkGray
    }
}

exit 0
