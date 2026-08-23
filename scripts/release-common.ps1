Set-StrictMode -Version Latest

function Get-RepositoryRoot {
  return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
}

function Get-ManifestObject {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot
  )

  $manifestPath = Join-Path $RepositoryRoot "manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Missing manifest: $manifestPath"
  }

  try {
    return Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  }
  catch {
    throw "Invalid manifest JSON at ${manifestPath}: $($_.Exception.Message)"
  }
}

function Get-ExtensionVersion {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot
  )

  $manifest = Get-ManifestObject -RepositoryRoot $RepositoryRoot
  $version = [string]$manifest.version
  if ($version -notmatch '^\d+(?:\.\d+){0,3}$') {
    throw "Manifest version '$version' is not a valid Chrome extension version."
  }

  $parts = $version.Split('.')
  foreach ($part in $parts) {
    if (($part.Length -gt 1 -and $part.StartsWith('0')) -or [int64]$part -gt 65535) {
      throw "Manifest version '$version' is not a valid Chrome extension version."
    }
  }

  return $version
}

function Get-ReleaseBaseName {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Version
  )

  return "image-screenshot-save-as-chrome-$Version"
}

function ConvertTo-NormalizedRelativePath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  return $Path.Replace('\', '/')
}

function Assert-SafeReleaseRelativePath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RelativePath
  )

  $normalized = ConvertTo-NormalizedRelativePath -Path $RelativePath
  if (
    [string]::IsNullOrWhiteSpace($normalized) -or
    $normalized.StartsWith('/') -or
    [System.IO.Path]::IsPathRooted($normalized) -or
    $normalized.Contains('\') -or
    $normalized -match '(^|/)\.\.?(/|$)'
  ) {
    throw "Unsafe release path: $RelativePath"
  }

  $developmentMetadataPattern = '(^|/)(?:\.git(?:hub)?|\.codegraph|\.cursor|\.pi|\.rpiv|node_modules|tests?|scripts?|docs?)(?:/|$)'
  $developmentFilePattern = '(^|/)(?:\.DS_Store|Thumbs\.db|desktop\.ini|package(?:-lock)?\.json|.*\.(?:map|log|tmp))$'
  if ($normalized -match $developmentMetadataPattern -or $normalized -match $developmentFilePattern) {
    throw "Development metadata is not allowed in the extension archive: $normalized"
  }
}

function Get-ReleaseSourceMap {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot
  )

  $releaseRoots = @(
    "manifest.json",
    "_locales",
    "assets/icons/icon-16.png",
    "assets/icons/icon-32.png",
    "assets/icons/icon-48.png",
    "assets/icons/icon-128.png",
    "src"
  )
  $map = @{}

  foreach ($releaseRoot in $releaseRoots) {
    $absoluteRoot = Join-Path $RepositoryRoot $releaseRoot
    if (-not (Test-Path -LiteralPath $absoluteRoot)) {
      throw "Missing release input: $absoluteRoot"
    }

    $item = Get-Item -LiteralPath $absoluteRoot
    $files = if ($item.PSIsContainer) {
      @(Get-ChildItem -LiteralPath $absoluteRoot -Recurse -File)
    }
    else {
      @($item)
    }

    foreach ($file in $files) {
      $relativePath = ConvertTo-NormalizedRelativePath -Path ([System.IO.Path]::GetRelativePath($RepositoryRoot, $file.FullName))
      Assert-SafeReleaseRelativePath -RelativePath $relativePath
      if ($map.ContainsKey($relativePath)) {
        throw "Duplicate release path: $relativePath"
      }

      $map[$relativePath] = $file.FullName
    }
  }

  return $map
}

function Get-DirectoryFileMap {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Directory
  )

  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
    throw "Missing release staging directory: $Directory"
  }

  $map = @{}
  foreach ($file in Get-ChildItem -LiteralPath $Directory -Recurse -File) {
    $relativePath = ConvertTo-NormalizedRelativePath -Path ([System.IO.Path]::GetRelativePath($Directory, $file.FullName))
    Assert-SafeReleaseRelativePath -RelativePath $relativePath
    if ($map.ContainsKey($relativePath)) {
      throw "Duplicate staging path: $relativePath"
    }

    $map[$relativePath] = $file.FullName
  }

  return $map
}

function Get-Sha256Hex {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-ChildPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Parent,

    [Parameter(Mandatory = $true)]
    [string]$Child
  )

  $parentPath = [System.IO.Path]::GetFullPath($Parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $childPath = [System.IO.Path]::GetFullPath($Child)
  $prefix = "$parentPath$([System.IO.Path]::DirectorySeparatorChar)"
  if (-not $childPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify path outside '$parentPath': $childPath"
  }
}
