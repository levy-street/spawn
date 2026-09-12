# Run once from an elevated PowerShell on the dedicated Windows CI host.
# The installed service needs outbound HTTPS only; no inbound access is needed.
[CmdletBinding()]
param(
    [ValidateSet('build', 'release')][string]$Role = 'build',
    [string]$Repository = 'levy-street/spawn',
    [switch]$InstallTools,
    [PSCredential]$ServiceCredential,
    [Security.SecureString]$RegistrationToken
)
$ErrorActionPreference = 'Stop'
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Invalid repository' }
$administrator = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $administrator.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this setup once from an elevated PowerShell. Jobs run as the separate service account.'
}
$roleLabel = "spawn-windows-$Role"
$directory = "C:\spawnd-ci\$roleLabel"
if (Test-Path $directory) { throw "Refusing to overwrite $directory; service upgrades must be deliberate" }
$runnerName = "$env:COMPUTERNAME-$roleLabel"
if (Get-Service -Name "actions.runner.*.$runnerName" -ErrorAction SilentlyContinue) {
    throw "A service already exists for $runnerName; inspect it before continuing"
}

if ($InstallTools) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'Install Microsoft App Installer (winget) before using -InstallTools.'
    }
    foreach ($package in @('Git.Git', 'Microsoft.PowerShell', 'Microsoft.DotNet.SDK.8', 'Microsoft.AzureCLI')) {
        $packageOptions = @()
        if ($package -eq 'Microsoft.PowerShell') {
            # PowerShell 7.6 defaults to MSIX, which is unsuitable for these
            # machine-wide services. Select its MSI and leave remoting disabled.
            $packageOptions = @('--installer-type', 'wix', '--custom', 'ADD_PATH=1 ENABLE_PSREMOTING=0')
        }
        & winget install --exact --id $package --source winget --scope machine --architecture x64 --no-upgrade `
            --silent --disable-interactivity --accept-package-agreements --accept-source-agreements @packageOptions
        # winget reports both no applicable upgrade (0x8A15002B) and
        # already installed with --no-upgrade (0x8A150061) as nonzero results.
        if ($LASTEXITCODE -notin @(0, -1978335189, -1978335135)) { throw "Installation failed: $package (exit $LASTEXITCODE)" }
    }
    & winget install --exact --id Microsoft.VisualStudio.2022.BuildTools --source winget `
        --scope machine --no-upgrade --disable-interactivity --accept-package-agreements --accept-source-agreements `
        --override '--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
    if ($LASTEXITCODE -notin @(0, -1978335189, -1978335135)) { throw "Visual Studio Build Tools installation failed (exit $LASTEXITCODE)" }
}
# Resolve tools using the machine PATH that the isolated services will use.
# The operator's per-user installs and credentials are not service prerequisites.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine')

foreach ($tool in @('git', 'pwsh', 'dotnet')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Missing $tool; rerun with -InstallTools" }
}
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { throw 'Visual Studio Build Tools are missing' }
$visualStudio = & $vswhere -latest -version '[17.0,18.0)' -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual Studio C++ tools are missing' }
$sdkRoot = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots').KitsRoot10
$windowsSdk = @(Get-ChildItem (Join-Path $sdkRoot 'Lib') -Directory | Where-Object {
    (Test-Path (Join-Path $_.FullName 'um\x64\kernel32.lib')) -and
    (Test-Path (Join-Path $_.FullName 'ucrt\x64\ucrt.lib')) -and
    (Test-Path (Join-Path $sdkRoot "Include\$($_.Name)\um\Windows.h")) -and
    (Test-Path (Join-Path $sdkRoot "bin\$($_.Name)\x64\rc.exe")) -and
    (Test-Path (Join-Path $sdkRoot "bin\$($_.Name)\x64\signtool.exe"))
})
if (-not $windowsSdk) { throw 'A complete x64 Windows SDK is required' }
if (-not (@(& dotnet --list-sdks) -match '^8\.')) { throw '.NET SDK 8 is required' }
if ($Role -eq 'release' -and -not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Azure CLI is required for the release runner' }

# Build and release accounts must be different, standard local users. The
# build account must not be able to read the release account's profile or keys.
$credential = $ServiceCredential
if (-not $credential) {
    $credential = Get-Credential -Message "Standard local service account for SPAWN D $Role CI (use different accounts for build and release)"
}
# Composite actions request bash. System32's WSL launcher is not Git Bash,
# and the service accounts do not have or need a WSL distribution.
$gitRoot = Split-Path (Split-Path (Get-Command git).Source -Parent) -Parent
$gitBin = Join-Path $gitRoot 'bin'
if (-not (Test-Path (Join-Path $gitBin 'bash.exe'))) { throw 'Git for Windows Bash is required by the workflow actions' }
$env:Path = "$gitBin;$env:Path"
if (-not $credential) { throw 'No service account supplied' }
$account = [Security.Principal.NTAccount]::new($credential.UserName)
$sid = $account.Translate([Security.Principal.SecurityIdentifier]).Value
if (-not (Get-LocalUser | Where-Object { $_.SID.Value -eq $sid })) {
    throw 'Use a standard local service account, not a domain account'
}
$adminMembers = @(Get-LocalGroupMember -SID 'S-1-5-32-544' | ForEach-Object { $_.SID.Value })
if ($sid -in $adminMembers) { throw 'The runner service account must not be an administrator' }
$profileKey = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid"
if (-not (Test-Path $profileKey)) { throw 'Initialize the standard account Windows profile before installing its runner' }
$serviceProfile = (Get-ItemProperty $profileKey).ProfileImagePath
if (-not (Test-Path $serviceProfile)) { throw 'The service account profile directory is missing' }
$otherRole = if ($Role -eq 'build') { 'release' } else { 'build' }
$otherAccountFile = "C:\spawnd-ci\spawn-windows-$otherRole\service-account.txt"
if ((Test-Path $otherAccountFile) -and (Get-Content $otherAccountFile -Raw).Trim() -eq $sid) {
    throw 'Build and release runners cannot share a service account'
}
$versions = Get-Content (Join-Path $PSScriptRoot 'runner-versions.json') -Raw | ConvertFrom-Json
$archive = Join-Path $env:TEMP ("spawnd-runner-" + [guid]::NewGuid().ToString('N') + '.zip')
$secureToken = $RegistrationToken
if (-not $secureToken) { $secureToken = Read-Host 'Paste the short-lived repository runner registration token' -AsSecureString }
try {
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/actions/runner/releases/download/v$($versions.version)/actions-runner-win-x64-$($versions.version).zip" -OutFile $archive
    if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $versions.sha256.'win-x64') {
        throw 'Runner archive checksum mismatch'
    }
    if (-not (Test-Path 'C:\spawnd-ci')) {
        New-Item -ItemType Directory -Path 'C:\spawnd-ci' | Out-Null
        & icacls 'C:\spawnd-ci' /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:RX' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Failed to protect the runner parent directory' }
    }
    New-Item -ItemType Directory -Path $directory | Out-Null
    & icacls $directory /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*${sid}:(OI)(CI)M" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to restrict runner directory permissions' }
    Expand-Archive -LiteralPath $archive -DestinationPath $directory
    Set-Content -Path (Join-Path $directory 'service-account.txt') -Value $sid
    # SCM can retain the PATH from boot even after machine-wide tool installs.
    # The official runner loads .env before starting. Include the role's .NET
    # global tools for AzureSignTool, which workflows install in that profile.
    $runnerEnvironment = @("PATH=$env:Path;$serviceProfile\.dotnet\tools")
    if ($Role -eq 'release') {
        # Install before registration can start the service. Labels alone are
        # not a branch authorization boundary on a persistent runner.
        $hookDirectory = 'C:\spawnd-ci\hooks\release'
        New-Item -ItemType Directory -Path $hookDirectory -Force | Out-Null
        & icacls $hookDirectory /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*${sid}:(OI)(CI)RX" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Failed to protect the release hook directory' }
        $hook = Join-Path $hookDirectory 'release-job-hook.ps1'
        Copy-Item (Join-Path $PSScriptRoot 'release-job-hook.ps1') $hook
        $runnerEnvironment += "ACTIONS_RUNNER_HOOK_JOB_STARTED=$hook"
    }
    [IO.File]::WriteAllLines((Join-Path $directory '.env'), $runnerEnvironment, [Text.UTF8Encoding]::new($false))
    Push-Location $directory
    try {
        # The credential is consumed only during registration. The service
        # keeps its own scoped runner credential, never a GitHub PAT.
        # GitHub consumes, masks and removes these inputs from its environment.
        # Secrets must never appear in the process command line or shell history.
        $env:ACTIONS_RUNNER_INPUT_TOKEN = [Net.NetworkCredential]::new('', $secureToken).Password
        $env:ACTIONS_RUNNER_INPUT_WINDOWSLOGONPASSWORD = $credential.GetNetworkCredential().Password
        try {
            & .\config.cmd --unattended --url "https://github.com/$Repository" `
                --name $runnerName --labels $roleLabel --work _work `
                --runasservice --windowslogonaccount $credential.UserName
        } finally {
            Remove-Item Env:ACTIONS_RUNNER_INPUT_TOKEN, Env:ACTIONS_RUNNER_INPUT_WINDOWSLOGONPASSWORD -ErrorAction SilentlyContinue
        }
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
        & sc.exe failureflag $service 1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Failed to enable recovery for service errors' }
        Get-Service -Name $service | Select-Object Name, Status, StartType
    } finally { Pop-Location }
} finally {
    $secureToken = $null
    $RegistrationToken = $null
    $ServiceCredential = $null
    $credential = $null
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
}
