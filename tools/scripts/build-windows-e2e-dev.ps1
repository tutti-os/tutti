[CmdletBinding()]
param(
  [string]$RepoRoot = "",
  [switch]$ForceBuiltinApps,
  [switch]$BuildCli
)

$ErrorActionPreference = "Stop"

function Resolve-AbsolutePath([string]$Path) {
  return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path)
}

function Invoke-CheckedProcess(
  [string]$FilePath,
  [string[]]$ArgumentList,
  [string]$WorkingDirectory
) {
  $process = Start-Process -FilePath $FilePath `
    -ArgumentList $ArgumentList `
    -WorkingDirectory $WorkingDirectory `
    -NoNewWindow `
    -Wait `
    -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Command failed with exit code $($process.ExitCode): $FilePath $($ArgumentList -join ' ')"
  }
}

function Get-LatestSourceWriteTime([string]$Root) {
  $files = @(Get-ChildItem -LiteralPath $Root -Recurse -File | Where-Object {
      $_.FullName -notmatch "[\\/](node_modules|build|dist)([\\/]|$)"
    })
  if ($files.Count -eq 0) {
    return [DateTime]::MinValue
  }
  return ($files | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc
}

function Get-LatestBuiltinArchive([string]$GeneratedRoot) {
  return Get-ChildItem -LiteralPath $GeneratedRoot -Filter "*.zip" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
}

function Test-BuiltinAppsUpToDate([string]$BuiltinRoot, [string]$GeneratedRoot) {
  $archive = Get-LatestBuiltinArchive $GeneratedRoot
  if ($null -eq $archive) {
    return $false
  }
  return $archive.LastWriteTimeUtc -ge (Get-LatestSourceWriteTime $BuiltinRoot)
}

function Set-ProcessEnvironment([string]$Name, [string]$Value) {
  if ($null -eq $Value) {
    Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue
  } else {
    Set-Item -LiteralPath "Env:$Name" -Value $Value
  }
}

if (-not $RepoRoot) {
  $RepoRoot = Join-Path $PSScriptRoot "..\.."
}
$RepoRoot = Resolve-AbsolutePath $RepoRoot

$packageJsonPath = Join-Path $RepoRoot "package.json"
$packageJson = Get-Content -Raw -LiteralPath $packageJsonPath | ConvertFrom-Json
$requiredPnpm = ([string]$packageJson.packageManager -split "@", 2)[1]
$corepack = (Get-Command corepack.cmd -ErrorAction Stop).Source
$pnpmCommand = "pnpm@$requiredPnpm"

$desktopRoot = Join-Path $RepoRoot "apps\desktop"
$daemonRoot = Join-Path $RepoRoot "services\tuttid"
$daemonOutput = Join-Path $desktopRoot "build\tuttid\tuttid-dev.exe"
$builtinRoot = Join-Path $RepoRoot "services\tuttid\builtin-apps\tutti-onboarding"
$builtinGeneratedRoot = Join-Path $RepoRoot "services\tuttid\builtin-apps\generated\tutti-onboarding"

if (-not (Test-Path -LiteralPath $daemonRoot)) {
  throw "tuttid source directory is missing: $daemonRoot"
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $daemonOutput) | Out-Null

$runningDaemon = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -ieq "tuttid.exe" -and
    ([string]$_.ExecutablePath).Equals($daemonOutput, [System.StringComparison]::OrdinalIgnoreCase)
  })
if ($runningDaemon.Count -gt 0) {
  throw "The dev tuttid-dev.exe is still running and locks the output. Stop the Windows E2E app first, then rerun this command: $daemonOutput"
}

if ($ForceBuiltinApps -or -not (Test-BuiltinAppsUpToDate $builtinRoot $builtinGeneratedRoot)) {
  Write-Host "[build] packaging builtin apps"
  Invoke-CheckedProcess $corepack @(
    $pnpmCommand,
    "--filter",
    "@tutti-os/builtin-tutti-onboarding",
    "package:builtin"
  ) $RepoRoot
} else {
  Write-Host "[build] builtin apps unchanged; skipped packaging"
}

$oldCgoEnabled = [Environment]::GetEnvironmentVariable("CGO_ENABLED", "Process")
$oldGoos = [Environment]::GetEnvironmentVariable("GOOS", "Process")
$oldGoarch = [Environment]::GetEnvironmentVariable("GOARCH", "Process")
try {
  $env:CGO_ENABLED = "0"
  $env:GOOS = "windows"
  $env:GOARCH = "amd64"

  Write-Host "[build] incremental tuttid-dev.exe -> $daemonOutput"
  Invoke-CheckedProcess "go.exe" @("build", "-o", $daemonOutput, ".") $daemonRoot

  if ($BuildCli) {
    $cliRoot = Join-Path $RepoRoot "apps\cli"
    $cliOutput = Join-Path $desktopRoot "build\tutti\tutti.exe"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cliOutput) | Out-Null
    Write-Host "[build] incremental tutti.exe -> $cliOutput"
    Invoke-CheckedProcess "go.exe" @("build", "-o", $cliOutput, ".\cmd\tutti") $cliRoot
  }
} finally {
  Set-ProcessEnvironment "CGO_ENABLED" $oldCgoEnabled
  Set-ProcessEnvironment "GOOS" $oldGoos
  Set-ProcessEnvironment "GOARCH" $oldGoarch
}

Write-Host "[ok] Windows E2E dev build is ready"
Write-Host "     tests: skipped"
Write-Host "     daemon: $daemonOutput"
