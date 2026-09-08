[CmdletBinding()]
param(
    [string] $SpawndPath = '',
    [string] $WorkerPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$ProgressPreference = 'SilentlyContinue'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $SpawndPath) {
    $SpawndPath = Join-Path $repoRoot 'daemon\target\x86_64-pc-windows-msvc\release\spawnd.exe'
}
if (-not $WorkerPath) {
    $WorkerPath = Join-Path $repoRoot 'daemon\target\x86_64-pc-windows-msvc\release\spawn-worker.exe'
}
if (-not [IO.Path]::IsPathRooted($SpawndPath)) {
    $SpawndPath = Join-Path $repoRoot $SpawndPath
}
if (-not [IO.Path]::IsPathRooted($WorkerPath)) {
    $WorkerPath = Join-Path $repoRoot $WorkerPath
}
$SpawndPath = [IO.Path]::GetFullPath($SpawndPath)
$WorkerPath = [IO.Path]::GetFullPath($WorkerPath)

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw 'smoke-install-prebuilt: uv is required'
}
& uv python find 3.13 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'smoke-install-prebuilt: Python 3.13 is required' }
if (-not (Test-Path -LiteralPath $SpawndPath -PathType Leaf)) {
    throw "smoke-install-prebuilt: spawnd.exe is missing: $SpawndPath"
}
if (-not (Test-Path -LiteralPath $WorkerPath -PathType Leaf)) {
    throw "smoke-install-prebuilt: spawn-worker.exe is missing: $WorkerPath"
}

$tempParent = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$tempRoot = Join-Path $tempParent ("spawn-windows-install-smoke.{0}" -f [Guid]::NewGuid().ToString('N'))
$prebuiltRoot = Join-Path $tempRoot 'prebuilt'
$targetDir = Join-Path $prebuiltRoot 'windows-x86_64'
$installRoot = Join-Path $tempRoot 'install'
$stdoutLog = Join-Path $tempRoot 'server.stdout.log'
$stderrLog = Join-Path $tempRoot 'server.stderr.log'
$databasePath = (Join-Path $tempRoot 'spawn-install-smoke.db').Replace('\', '/')
$serverProcess = $null
$savedEnvironment = @{}
$environmentNames = @(
    'SPAWN_DATABASE_URL',
    'SPAWN_USE_INPROCESS_PUBSUB',
    'SPAWN_JWT_SECRET',
    'SPAWN_PUBLIC_URL',
    'SPAWN_PREBUILT_DIR',
    'SPAWN_INSTALL_ROOT',
    'SPAWN_INSTALL_NO_PATH'
)

function Get-Sha256([string] $Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-Equal([object] $Actual, [object] $Expected, [string] $Description) {
    if ($Actual -ne $Expected) {
        throw "$Description mismatch: expected '$Expected', got '$Actual'"
    }
}

try {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    $stagedSpawnd = Join-Path $targetDir 'spawnd.exe'
    $stagedWorker = Join-Path $targetDir 'spawn-worker.exe'
    Copy-Item -LiteralPath $SpawndPath -Destination $stagedSpawnd
    Copy-Item -LiteralPath $WorkerPath -Destination $stagedWorker

    $versionOutput = @(& $stagedSpawnd --version)
    if ($LASTEXITCODE -ne 0 -or $versionOutput.Count -eq 0) {
        throw 'smoke-install-prebuilt: spawnd.exe --version failed'
    }
    $versionParts = @($versionOutput[0] -split '\s+' | Where-Object { $_ })
    if ($versionParts.Count -lt 2) {
        throw "smoke-install-prebuilt: could not parse version from '$($versionOutput[0])'"
    }
    $version = $versionParts[1]
    $spawndSha = Get-Sha256 $stagedSpawnd
    $workerSha = Get-Sha256 $stagedWorker
    $manifest = [ordered]@{
        commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        tree = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
        version = $version
        release_counter = 1700000000
        signing_key_id = 'e65c013f'
        targets = [ordered]@{
            'windows-x86_64' = [ordered]@{
                spawnd_sha256 = $spawndSha
                spawn_worker_sha256 = $workerSha
            }
        }
    }
    $manifestJson = ($manifest | ConvertTo-Json -Depth 5) + "`n"
    [IO.File]::WriteAllText(
        (Join-Path $prebuiltRoot 'manifest.json'),
        $manifestJson,
        [Text.UTF8Encoding]::new($false)
    )

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([Net.IPEndPoint] $listener.LocalEndpoint).Port
    $listener.Stop()
    $baseUrl = "http://127.0.0.1:$port"

    foreach ($name in $environmentNames) {
        $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    $env:SPAWN_DATABASE_URL = "sqlite+aiosqlite:///$databasePath"
    $env:SPAWN_USE_INPROCESS_PUBSUB = '1'
    $env:SPAWN_JWT_SECRET = 'smoke-install-secret-with-enough-length'
    $env:SPAWN_PUBLIC_URL = $baseUrl
    $env:SPAWN_PREBUILT_DIR = $prebuiltRoot

    $serverDir = Join-Path $repoRoot 'server'
    $serverProcess = Start-Process -FilePath (Get-Command uv).Source `
        -ArgumentList @(
            'run', '--frozen', 'uvicorn', 'spawn_server.main:app',
            '--host', '127.0.0.1', '--port', [string] $port
        ) `
        -WorkingDirectory $serverDir `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog `
        -PassThru

    $healthy = $false
    foreach ($attempt in 1..100) {
        if ($serverProcess.HasExited) { break }
        try {
            $health = Invoke-RestMethod -UseBasicParsing -Uri "$baseUrl/healthz" -TimeoutSec 2
            if ($health.status -eq 'ok') {
                $healthy = $true
                break
            }
        } catch {
            Start-Sleep -Milliseconds 100
        }
    }
    if (-not $healthy) { throw 'smoke-install-prebuilt: local server did not become healthy' }

    $installerResponse = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/install.ps1"
    Assert-Equal $installerResponse.StatusCode 200 'install.ps1 status'
    $source = [string] $installerResponse.Content
    if ($source -match '(?i)\$iswindows\b') {
        throw 'smoke-install-prebuilt: install.ps1 assigns PowerShell automatic variable $IsWindows'
    }
    if ($source -notmatch '\$spawnPlatformIsWindows\b') {
        throw 'smoke-install-prebuilt: install.ps1 is missing its collision-safe platform check'
    }
    $tokens = $null
    $parseErrors = $null
    [Management.Automation.Language.Parser]::ParseInput(
        $source,
        [ref] $tokens,
        [ref] $parseErrors
    ) | Out-Null
    if ($parseErrors.Count -ne 0) {
        throw "smoke-install-prebuilt: install.ps1 parser errors: $($parseErrors -join '; ')"
    }

    $manifestResponse = Invoke-RestMethod -UseBasicParsing -Uri "$baseUrl/api/install/manifest.json"
    $manifestTarget = $manifestResponse.targets.'windows-x86_64'
    Assert-Equal $manifestTarget.spawnd_sha256 $spawndSha 'manifest spawnd sha256'
    Assert-Equal $manifestTarget.spawn_worker_sha256 $workerSha 'manifest worker sha256'

    foreach ($kind in @('spawnd', 'spawn-worker')) {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/api/install/$kind/windows-x86_64"
        $expectedName = if ($kind -eq 'spawnd') { 'spawnd.exe' } else { 'spawn-worker.exe' }
        $disposition = [string] $response.Headers['Content-Disposition']
        if ($disposition -notmatch ('filename="?' + [Regex]::Escape($expectedName) + '"?')) {
            throw "smoke-install-prebuilt: $kind Content-Disposition is '$disposition'"
        }
    }

    $env:SPAWN_INSTALL_ROOT = $installRoot
    $env:SPAWN_INSTALL_NO_PATH = '1'
    & ([scriptblock]::Create($source)) -NoLogin -NoStart -NoService -PrebuiltOnly

    $installedSpawnd = Join-Path $installRoot 'bin\spawnd.exe'
    $installedWorker = Join-Path $installRoot 'bin\spawn-worker.exe'
    Assert-Equal (Get-Sha256 $installedSpawnd) $spawndSha 'installed spawnd sha256'
    Assert-Equal (Get-Sha256 $installedWorker) $workerSha 'installed worker sha256'
    & $installedSpawnd --version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'smoke-install-prebuilt: installed spawnd.exe failed' }

    $spawndTimestamp = (Get-Item -LiteralPath $installedSpawnd).LastWriteTimeUtc.Ticks
    $workerTimestamp = (Get-Item -LiteralPath $installedWorker).LastWriteTimeUtc.Ticks
    & ([scriptblock]::Create($source)) -NoLogin -NoStart -NoService -PrebuiltOnly
    Assert-Equal (Get-Sha256 $installedSpawnd) $spawndSha 'reinstalled spawnd sha256'
    Assert-Equal (Get-Sha256 $installedWorker) $workerSha 'reinstalled worker sha256'
    Assert-Equal (Get-Item -LiteralPath $installedSpawnd).LastWriteTimeUtc.Ticks `
        $spawndTimestamp 'idempotent spawnd timestamp'
    Assert-Equal (Get-Item -LiteralPath $installedWorker).LastWriteTimeUtc.Ticks `
        $workerTimestamp 'idempotent worker timestamp'

} catch {
    Write-Host "smoke-install-prebuilt: failed: $_"
    foreach ($log in @($stdoutLog, $stderrLog)) {
        if (Test-Path -LiteralPath $log) {
            Write-Host "---- $log ----"
            Get-Content -LiteralPath $log -Tail 200
            Write-Host "::notice title=Windows installer smoke log::$log"
        }
    }
    throw
} finally {
    if ($serverProcess -and -not $serverProcess.HasExited) {
        & taskkill.exe /PID $serverProcess.Id /T /F 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
        }
        $serverProcess.WaitForExit()
    }
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

# GitHub's PowerShell runner propagates the last native command's exit code.
# A taskkill race handled by Stop-Process above is cleanup, not a failed smoke;
# assertion failures still throw before reaching this successful completion.
Write-Host 'smoke-install-prebuilt: passed'
exit 0
