[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "release-common.ps1")

$repositoryRoot = Get-RepositoryRoot
$version = Get-ExtensionVersion -RepositoryRoot $repositoryRoot
$releaseBaseName = Get-ReleaseBaseName -Version $version
$distDirectory = Join-Path $repositoryRoot "dist"
$stagingDirectory = Join-Path $distDirectory $releaseBaseName
$archivePath = Join-Path $distDirectory "$releaseBaseName.zip"
$temporaryDirectory = Join-Path $distDirectory ".release-$([guid]::NewGuid().ToString('N'))"
$temporaryArchive = Join-Path $distDirectory ".release-$([guid]::NewGuid().ToString('N')).zip"

Assert-ChildPath -Parent $repositoryRoot -Child $distDirectory
Assert-ChildPath -Parent $distDirectory -Child $stagingDirectory
Assert-ChildPath -Parent $distDirectory -Child $archivePath
Assert-ChildPath -Parent $distDirectory -Child $temporaryDirectory
Assert-ChildPath -Parent $distDirectory -Child $temporaryArchive

New-Item -ItemType Directory -Path $distDirectory -Force | Out-Null
$sourceMap = Get-ReleaseSourceMap -RepositoryRoot $repositoryRoot

try {
  New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
  foreach ($relativePath in @($sourceMap.Keys | Sort-Object)) {
    $destination = Join-Path $temporaryDirectory ($relativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
    $destinationParent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    Copy-Item -LiteralPath $sourceMap[$relativePath] -Destination $destination
  }

  Add-Type -AssemblyName System.IO.Compression
  $archiveStream = [System.IO.File]::Open(
    $temporaryArchive,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None
  )
  try {
    $archive = [System.IO.Compression.ZipArchive]::new(
      $archiveStream,
      [System.IO.Compression.ZipArchiveMode]::Create,
      $false
    )
    try {
      $fixedTimestamp = [System.DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [System.TimeSpan]::Zero)
      foreach ($relativePath in @($sourceMap.Keys | Sort-Object)) {
        $entry = $archive.CreateEntry($relativePath, [System.IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = $fixedTimestamp
        $inputStream = [System.IO.File]::OpenRead($sourceMap[$relativePath])
        $outputStream = $entry.Open()
        try {
          $inputStream.CopyTo($outputStream)
        }
        finally {
          $outputStream.Dispose()
          $inputStream.Dispose()
        }
      }
    }
    finally {
      $archive.Dispose()
    }
  }
  finally {
    $archiveStream.Dispose()
  }

  if (Test-Path -LiteralPath $stagingDirectory) {
    Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
  }
  if (Test-Path -LiteralPath $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
  }

  Move-Item -LiteralPath $temporaryDirectory -Destination $stagingDirectory
  Move-Item -LiteralPath $temporaryArchive -Destination $archivePath

  $staleArtifacts = @(
    Get-ChildItem -LiteralPath $distDirectory -Force |
      Where-Object {
        $_.Name -like 'image-screenshot-save-as-chrome-*' -and
        $_.FullName -ne $stagingDirectory -and
        $_.FullName -ne $archivePath
      }
  )
  foreach ($artifact in $staleArtifacts) {
    Assert-ChildPath -Parent $distDirectory -Child $artifact.FullName
    Remove-Item -LiteralPath $artifact.FullName -Recurse -Force
  }

  Write-Host "Packaged $releaseBaseName"
  Write-Host "Staging: $stagingDirectory"
  Write-Host "Archive: $archivePath"
  Write-Host "SHA256: $(Get-Sha256Hex -Path $archivePath)"
}
finally {
  if (Test-Path -LiteralPath $temporaryDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
  }
  if (Test-Path -LiteralPath $temporaryArchive) {
    Remove-Item -LiteralPath $temporaryArchive -Force
  }
}
