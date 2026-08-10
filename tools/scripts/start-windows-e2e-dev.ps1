[CmdletBinding()]
param(
  [string]$RepoRoot = "",
  [string]$StateDir = "",
  [string]$AppVersion = "",
  [int]$RemoteDebuggingPort = 9229,
  [switch]$ResetState,
  [switch]$NoVite,
  [switch]$IsolatedUserData
)

$ErrorActionPreference = "Stop"

function Resolve-AbsolutePath([string]$Path) {
  return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path)
}

function Test-HttpReady([string]$Url) {
  try {
    $curl = (Get-Command curl.exe -ErrorAction Stop).Source
    & $curl --silent --show-error --max-time 2 --output NUL $Url 2>$null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Stop-WorktreeDevProcesses([string]$Root, [string]$OwnedStateDir) {
  $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $rootToken = $Root.TrimEnd("\")
  $stateToken = if ($OwnedStateDir) { $OwnedStateDir.TrimEnd("\") } else { "" }
  $targets = @(
    $processes | Where-Object {
      if ($_.ProcessId -eq $PID) { return $false }
      $commandLine = [string]$_.CommandLine
      $executablePath = [string]$_.ExecutablePath
      $isFromThisWorktree =
        ($commandLine -and $commandLine.IndexOf($rootToken, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) -or
        ($executablePath -and $executablePath.IndexOf($rootToken, [System.StringComparison]::OrdinalIgnoreCase) -eq 0)
      $isCoreDevProcess = $commandLine -match "electron(?:\.cmd|\.exe)|electron-vite|vite\.js|tuttid\.exe"
      $isOwnedElectronProcess =
        $_.Name -ieq "electron.exe" -and
        $executablePath -and
        $executablePath.IndexOf($rootToken, [System.StringComparison]::OrdinalIgnoreCase) -eq 0
      $isOwnedRuntimeProcess = $stateToken -and
        $commandLine -and
        $commandLine.IndexOf($stateToken, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.Name -match "^(bash|node|sleep|tutti-onboarding-server)\.exe$"
      return ($isFromThisWorktree -and ($isCoreDevProcess -or $isOwnedElectronProcess)) -or $isOwnedRuntimeProcess
    }
  )

  foreach ($process in ($targets | Sort-Object ProcessId -Descending)) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($targets.Count -gt 0) {
    Start-Sleep -Milliseconds 700
    Write-Host ("[ok] stopped {0} stale Tutti dev processes" -f $targets.Count)
  }
}

function Wait-Until([scriptblock]$Condition, [int]$TimeoutSeconds, [string]$FailureMessage) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 500
  }
  throw $FailureMessage
}

if (-not $RepoRoot) {
  $RepoRoot = Join-Path $PSScriptRoot "..\.."
}
$RepoRoot = Resolve-AbsolutePath $RepoRoot
$resolvedAppVersion = $AppVersion.Trim()
if (-not $resolvedAppVersion) {
  try {
    $tag = (& git -C $RepoRoot describe --tags --match "v[0-9]*" --abbrev=0 2>$null).Trim()
    if ($tag -match '^v([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$') {
      $resolvedAppVersion = $Matches[1]
    }
  } catch {
    $resolvedAppVersion = ""
  }
}
$desktopRoot = Join-Path $RepoRoot "apps\desktop"
$desktopTuttidRelease = Join-Path $desktopRoot "build\tuttid\tuttid.exe"
$desktopTuttidDev = Join-Path $desktopRoot "build\tuttid\tuttid-dev.exe"
$desktopTuttid = if (Test-Path -LiteralPath $desktopTuttidDev) {
  $desktopTuttidDev
} else {
  $desktopTuttidRelease
}
$electronCmd = Join-Path $desktopRoot "node_modules\.bin\electron.cmd"
$managedShellRoot = Join-Path $desktopRoot "build\managed-posix-shell"
$managedShellMetadata = Join-Path $managedShellRoot "runtime.json"

foreach ($requiredPath in @($desktopRoot, $desktopTuttid, $electronCmd, $managedShellMetadata)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "required Tutti dev artifact is missing: $requiredPath`nRun the Windows build once before using this no-build launcher."
  }
}

if (-not $StateDir) {
  $StateDir = Join-Path $RepoRoot ".tmp\tutti-windows-e2e-dev"
} else {
  $StateDir = [System.IO.Path]::GetFullPath($StateDir)
}

$runtimeMetadata = Get-Content -Raw -LiteralPath $managedShellMetadata | ConvertFrom-Json
if ($runtimeMetadata.schemaVersion -ne "tutti.managed-posix-shell.v1" -or
    [string]::IsNullOrWhiteSpace([string]$runtimeMetadata.executable)) {
  throw "managed POSIX shell runtime metadata is invalid: $managedShellMetadata"
}
$managedShell = [System.IO.Path]::GetFullPath(
  (Join-Path $managedShellRoot ([string]$runtimeMetadata.executable).Replace("/", "\"))
)
if (-not (Test-Path -LiteralPath $managedShell)) {
  throw "managed POSIX shell executable is missing: $managedShell"
}

$packageJson = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "package.json") | ConvertFrom-Json
$requiredPnpm = ([string]$packageJson.packageManager -split "@", 2)[1]
$nodeVersionFile = (Get-Content -Raw -LiteralPath (Join-Path $RepoRoot ".node-version")).Trim()
$requiredNodeMajor = [int](($nodeVersionFile -split "\.")[0])
$nodeVersion = (& (Get-Command node.exe -ErrorAction Stop).Source --version).Trim().TrimStart("v")
$nodeMajor = [int](($nodeVersion -split "\.")[0])
if ($nodeMajor -lt $requiredNodeMajor) {
  throw "Node $requiredNodeMajor+ is required, but found $nodeVersion"
}
$corepack = (Get-Command corepack.cmd -ErrorAction Stop).Source
$pnpmCommand = "pnpm@$requiredPnpm"
$pnpmVersion = (& $corepack $pnpmCommand --version).Trim()
if ($pnpmVersion -ne $requiredPnpm) {
  throw "pnpm $requiredPnpm is required, but Corepack resolved $pnpmVersion"
}

$tmpRoot = (Join-Path $RepoRoot ".tmp").TrimEnd("\") + "\"
if ($ResetState -and -not $StateDir.StartsWith($tmpRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "-ResetState is restricted to a state directory under $tmpRoot"
}

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$logsDir = Join-Path $StateDir "logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
Stop-WorktreeDevProcesses -Root $RepoRoot -OwnedStateDir $StateDir
if ($ResetState) {
  Remove-Item -LiteralPath $StateDir -Recurse -Force
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
  Write-Host "[ok] reset isolated E2E state: $StateDir"
}

$env:TUTTI_DESKTOP_USER_DATA_DIR = if ($IsolatedUserData) {
  Join-Path $StateDir "electron-user-data"
} else {
  $null
}
$env:TUTTI_STATE_DIR = $StateDir
$env:TUTTID_BIN = $desktopTuttid
$env:TUTTI_MANAGED_POSIX_SHELL = $managedShell
$env:TUTTI_ANALYTICS_DISABLED = "1"
$env:ELECTRON_RENDERER_URL = "http://127.0.0.1:5173"
$env:TUTTI_DESKTOP_PERFORMANCE_HEADLESS = $null
$env:TUTTI_ELECTRON_REMOTE_DEBUGGING_PORT = [string]$RemoteDebuggingPort
if ($resolvedAppVersion) {
  $env:TUTTI_APP_VERSION = $resolvedAppVersion
}

$shellSmokeStdout = Join-Path $logsDir "managed-shell-smoke.stdout.log"
$shellSmokeStderr = Join-Path $logsDir "managed-shell-smoke.stderr.log"
$shellSmoke = Start-Process -FilePath $managedShell `
  -ArgumentList @("--noprofile", "--norc", "-c", "true") `
  -WindowStyle Hidden `
  -Wait `
  -PassThru `
  -RedirectStandardOutput $shellSmokeStdout `
  -RedirectStandardError $shellSmokeStderr
if ($shellSmoke.ExitCode -ne 0) {
  throw "managed POSIX shell smoke check failed: $managedShell"
}

$viteUrl = "http://127.0.0.1:5173/"
if (-not $NoVite -and -not (Test-HttpReady $viteUrl)) {
  $viteStdout = Join-Path $logsDir "vite.stdout.log"
  $viteStderr = Join-Path $logsDir "vite.stderr.log"
  Start-Process -FilePath $corepack `
    -ArgumentList @($pnpmCommand, "--filter", "@tutti-os/desktop", "dev:web") `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $viteStdout `
    -RedirectStandardError $viteStderr | Out-Null
  Wait-Until `
    -Condition { Test-HttpReady $viteUrl } `
    -TimeoutSeconds 45 `
    -FailureMessage "Vite renderer did not become ready at $viteUrl. See $viteStderr"
} elseif ($NoVite -and -not (Test-HttpReady $viteUrl)) {
  throw "-NoVite was specified, but no renderer is ready at $viteUrl"
}

$desktopLog = Join-Path $logsDir "tutti-desktop.log"
if (Test-Path -LiteralPath $desktopLog) {
  $previousDesktopLog = Join-Path $logsDir ("tutti-desktop.previous-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
  Move-Item -LiteralPath $desktopLog -Destination $previousDesktopLog -Force
}

$electronProcess = Start-Process -FilePath $electronCmd `
  -ArgumentList @(".") `
  -WorkingDirectory $desktopRoot `
  -PassThru

Wait-Until `
  -Condition {
    if ($electronProcess.HasExited) {
      throw "Tutti Dev exited before becoming ready (exit code $($electronProcess.ExitCode)). Inspect $desktopLog"
    }
    (Test-Path -LiteralPath $desktopLog) -and
    ((Get-Content -Raw -LiteralPath $desktopLog) -match 'desktop app ready')
  } `
  -TimeoutSeconds 60 `
  -FailureMessage "Tutti Dev did not reach desktop app ready. Inspect $desktopLog"

Write-Host "[ok] Tutti Windows E2E dev is ready"
Write-Host "    repo:  $RepoRoot"
Write-Host "    state: $StateDir"
Write-Host "    shell: $managedShell"
Write-Host "    logs:  $logsDir"
Write-Host ("    electron launcher pid: {0}" -f $electronProcess.Id)
