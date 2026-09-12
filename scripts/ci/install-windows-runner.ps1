# Run once from an elevated PowerShell on the dedicated Windows CI host.
# The installed service needs outbound HTTPS only; no inbound access is needed.
[CmdletBinding()]
param(
    [ValidateSet('build', 'release')][string]$Role = 'build',
    [string]$Repository = 'levy-street/spawn',
    [switch]$InstallTools
)
$ErrorActionPreference = 'Stop'
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Invalid repository' }
$administrator = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $administrator.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this setup once from an elevated PowerShell. Jobs run as the separate service account.'
}

if ($InstallTools) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'Install Microsoft App Installer (winget) before using -InstallTools.'
    }
    foreach ($package in @('Git.Git', 'Microsoft.PowerShell', 'Microsoft.DotNet.SDK.8', 'Microsoft.AzureCLI')) {
        & winget install --exact --id $package --source winget --silent --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) { throw "Installation failed: $package" }
    }
    & winget install --exact --id Microsoft.VisualStudio.2022.BuildTools --source winget `
        --accept-package-agreements --accept-source-agreements `
        --override '--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) { throw 'Visual Studio Build Tools installation failed' }
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

foreach ($tool in @('git', 'pwsh', 'dotnet')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Missing $tool; rerun with -InstallTools" }
}
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { throw 'Visual Studio Build Tools are missing' }
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual Studio C++ tools are missing' }
if ($Role -eq 'release' -and -not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Azure CLI is required for the release runner' }

# Build and release accounts must be different, standard local users. The
# build account must not be able to read the release account's profile or keys.
$credential = Get-Credential -Message "Standard local service account for SPAWN D $Role CI (use different accounts for build and release)"
if (-not $credential) { throw 'No service account supplied' }
$account = [Security.Principal.NTAccount]::new($credential.UserName)
$sid = $account.Translate([Security.Principal.SecurityIdentifier]).Value
if (-not (Get-LocalUser | Where-Object { $_.SID.Value -eq $sid })) {
    throw 'Use a standard local service account, not a domain account'
}
$adminMembers = @(Get-LocalGroupMember -SID 'S-1-5-32-544' | ForEach-Object { $_.SID.Value })
if ($sid -in $adminMembers) { throw 'The runner service account must not be an administrator' }
$roleLabel = "spawn-windows-$Role"
$directory = "C:\spawnd-ci\$roleLabel"
if (Test-Path $directory) { throw "Refusing to overwrite $directory; service upgrades must be deliberate" }
$otherRole = if ($Role -eq 'build') { 'release' } else { 'build' }
$otherAccountFile = "C:\spawnd-ci\spawn-windows-$otherRole\service-account.txt"
if ((Test-Path $otherAccountFile) -and (Get-Content $otherAccountFile -Raw).Trim() -eq $sid) {
    throw 'Build and release runners cannot share a service account'
}
$versions = Get-Content (Join-Path $PSScriptRoot 'runner-versions.json') -Raw | ConvertFrom-Json
$archive = Join-Path $env:TEMP ("spawnd-runner-" + [guid]::NewGuid().ToString('N') + '.zip')
$secureToken = Read-Host 'Paste the short-lived repository runner registration token' -AsSecureString
$token = [Net.NetworkCredential]::new('', $secureToken).Password
try {
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/actions/runner/releases/download/v$($versions.version)/actions-runner-win-x64-$($versions.version).zip" -OutFile $archive
    if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $versions.sha256.'win-x64') {
        throw 'Runner archive checksum mismatch'
    }
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    & icacls $directory /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*${sid}:(OI)(CI)M" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to restrict runner directory permissions' }
    Expand-Archive -LiteralPath $archive -DestinationPath $directory
    Set-Content -Path (Join-Path $directory 'service-account.txt') -Value $sid
    if ($Role -eq 'release') {
        # Install before registration can start the service. Labels alone are
        # not a branch authorization boundary on a persistent runner.
        $hookDirectory = 'C:\spawnd-ci\hooks\release'
        New-Item -ItemType Directory -Path $hookDirectory -Force | Out-Null
        & icacls $hookDirectory /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*${sid}:(OI)(CI)RX" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Failed to protect the release hook directory' }
        $hook = Join-Path $hookDirectory 'release-job-hook.ps1'
        Copy-Item (Join-Path $PSScriptRoot 'release-job-hook.ps1') $hook
        Set-Content -Path (Join-Path $directory '.env') -Encoding UTF8 -Value "ACTIONS_RUNNER_HOOK_JOB_STARTED=$hook"
    }
    Push-Location $directory
    try {
        # The credential is consumed only during registration. The service
        # keeps its own scoped runner credential, never a GitHub PAT.
        & .\config.cmd --unattended --url "https://github.com/$Repository" --token $token `
            --name "$env:COMPUTERNAME-$roleLabel" --labels $roleLabel --work _work `
            --runasservice --windowslogonaccount $credential.UserName `
            --windowslogonpassword ($credential.GetNetworkCredential().Password)
        if ($LASTEXITCODE -ne 0) { throw 'Runner service registration failed' }
        $service = (Get-Content '.service' -Raw).Trim()
        if ($Role -eq 'release' -and -not (Select-String -LiteralPath '.env' -SimpleMatch "ACTIONS_RUNNER_HOOK_JOB_STARTED=$hook" -Quiet)) {
            Stop-Service -Name $service
            throw 'Release hook was not preserved during configuration'
        }
        Set-Service -Name $service -StartupType Automatic
        Start-Service -Name $service
        & sc.exe failure $service reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Failed to configure service recovery' }
        Get-Service -Name $service | Select-Object Name, Status, StartType
    } finally { Pop-Location }
} finally {
    $token = $null
    $credential = $null
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
}
