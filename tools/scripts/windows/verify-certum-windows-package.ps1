[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$DistDirectory,
  [Parameter(Mandatory = $true)][string]$SevenZipExecutable,
  [Parameter(Mandatory = $true)][string]$ExpectedPublisher
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$dist = [IO.Path]::GetFullPath($DistDirectory)
$sevenZip = [IO.Path]::GetFullPath($SevenZipExecutable)
if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
  throw 'ExpectedPublisher is required for signed Windows packages.'
}

function Assert-AuthenticodeBoundary {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Role)
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  $subject = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }
  $timestampSubject = if ($null -ne $signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { '' }
  if ($signature.Status -ne 'Valid') {
    throw "Windows package boundary '$Role' has invalid Authenticode status '$($signature.Status)'."
  }
  if ($subject.IndexOf($ExpectedPublisher, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "Windows package boundary '$Role' signer '$subject' does not match '$ExpectedPublisher'."
  }
  if ([string]::IsNullOrWhiteSpace($timestampSubject)) {
    throw "Windows package boundary '$Role' has no timestamp certificate."
  }
}

$installers = @(Get-ChildItem -LiteralPath $dist -File -Filter '*.exe')
if ($installers.Count -ne 1) {
  throw "Expected exactly one Windows NSIS installer, found $($installers.Count)."
}
Assert-AuthenticodeBoundary -Path $installers[0].FullName -Role 'installer'

$extractionRoot = Join-Path $env:RUNNER_TEMP ('tutti-certum-' + [Guid]::NewGuid().ToString('N'))
$outer = Join-Path $extractionRoot 'outer'
$inner = Join-Path $extractionRoot 'inner'
New-Item -ItemType Directory -Force -Path $outer, $inner | Out-Null
try {
  & $sevenZip x -y "-o$outer" $installers[0].FullName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Extracting the NSIS installer failed with exit code $LASTEXITCODE." }

  $outerExecutables = @(Get-ChildItem -LiteralPath $outer -Recurse -File -Filter '*.exe')
  if ($outerExecutables.Count -eq 0) { throw 'The NSIS installer does not contain a signed embedded uninstaller.' }
  foreach ($executable in $outerExecutables) {
    $role = [IO.Path]::GetRelativePath($outer, $executable.FullName).Replace('\', '/')
    Assert-AuthenticodeBoundary -Path $executable.FullName -Role $role
  }

  $appArchives = @(Get-ChildItem -LiteralPath $outer -Recurse -File -Filter 'app-64.7z')
  if ($appArchives.Count -ne 1) { throw "Expected one app-64.7z in the NSIS installer, found $($appArchives.Count)." }
  & $sevenZip x -y "-o$inner" $appArchives[0].FullName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Extracting app-64.7z failed with exit code $LASTEXITCODE." }

  $applicationExecutables = @(Get-ChildItem -LiteralPath $inner -Recurse -File -Filter '*.exe')
  if ($applicationExecutables.Count -eq 0) { throw 'The packaged application contains no Windows executables.' }
  foreach ($executable in $applicationExecutables) {
    $role = [IO.Path]::GetRelativePath($inner, $executable.FullName).Replace('\', '/')
    Assert-AuthenticodeBoundary -Path $executable.FullName -Role $role
  }
  Write-Output "Verified $($applicationExecutables.Count) application executables and $($outerExecutables.Count) NSIS executables."
}
finally {
  Remove-Item -LiteralPath $extractionRoot -Recurse -Force -ErrorAction SilentlyContinue
}
