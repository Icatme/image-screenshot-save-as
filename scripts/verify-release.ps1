[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "release-common.ps1")

function Assert-Condition {
  param(
    [Parameter(Mandatory = $true)]
    [bool]$Condition,

    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function Get-JsonObject {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  try {
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  }
  catch {
    throw "Invalid JSON at ${Path}: $($_.Exception.Message)"
  }
}

function Get-ObjectPropertyMap {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Object
  )

  $map = @{}
  foreach ($property in $Object.PSObject.Properties) {
    $map[$property.Name.ToLowerInvariant()] = $property.Value
  }
  return $map
}

function Get-OptionalPropertyValue {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Object,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }
  return $property.Value
}

function Get-MessagePlaceholderNames {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  return @(
    [regex]::Matches($Message, '\$([A-Za-z][A-Za-z0-9_]*)\$') |
      ForEach-Object { $_.Groups[1].Value.ToLowerInvariant() } |
      Sort-Object -Unique
  )
}

function Assert-SameKeys {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [string[]]$Expected,

    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [string[]]$Actual,

    [Parameter(Mandatory = $true)]
    [string]$Context
  )

  $missing = @($Expected | Where-Object { $_ -notin $Actual })
  $unexpected = @($Actual | Where-Object { $_ -notin $Expected })
  if ($missing.Count -gt 0 -or $unexpected.Count -gt 0) {
    throw "$Context keys differ. Missing: [$($missing -join ', ')]. Unexpected: [$($unexpected -join ', ')]."
  }
}

function Assert-LocaleContracts {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot,

    [Parameter(Mandatory = $true)]
    [object]$Manifest
  )

  $localeRoot = Join-Path $RepositoryRoot "_locales"
  $localeFiles = @(Get-ChildItem -LiteralPath $localeRoot -Filter "messages.json" -File -Recurse | Sort-Object FullName)
  Assert-Condition ($localeFiles.Count -gt 0) "No locale catalogs were found."

  $catalogs = @{}
  foreach ($localeFile in $localeFiles) {
    $locale = Split-Path -Leaf (Split-Path -Parent $localeFile.FullName)
    $catalogs[$locale] = Get-JsonObject -Path $localeFile.FullName
  }

  $defaultLocale = [string]$Manifest.default_locale
  Assert-Condition ($catalogs.ContainsKey($defaultLocale)) "Manifest default_locale '$defaultLocale' has no catalog."
  $baseCatalog = Get-ObjectPropertyMap -Object $catalogs[$defaultLocale]
  $baseKeys = @($baseCatalog.Keys | Sort-Object)

  foreach ($locale in @($catalogs.Keys | Sort-Object)) {
    $catalog = Get-ObjectPropertyMap -Object $catalogs[$locale]
    $catalogKeys = @($catalog.Keys | Sort-Object)
    Assert-SameKeys -Expected $baseKeys -Actual $catalogKeys -Context "Locale '$locale'"

    foreach ($messageName in $baseKeys) {
      $baseEntry = $baseCatalog[$messageName]
      $entry = $catalog[$messageName]
      $baseMessage = Get-OptionalPropertyValue -Object $baseEntry -Name "message"
      $message = Get-OptionalPropertyValue -Object $entry -Name "message"
      Assert-Condition ($message -is [string] -and -not [string]::IsNullOrWhiteSpace($message)) "Locale '$locale' message '$messageName' is empty."

      $baseTokens = @(Get-MessagePlaceholderNames -Message ([string]$baseMessage))
      $tokens = @(Get-MessagePlaceholderNames -Message ([string]$message))
      Assert-SameKeys -Expected $baseTokens -Actual $tokens -Context "Locale '$locale' message '$messageName' placeholder"

      $basePlaceholderObject = Get-OptionalPropertyValue -Object $baseEntry -Name "placeholders"
      $placeholderObject = Get-OptionalPropertyValue -Object $entry -Name "placeholders"
      $basePlaceholders = if ($null -ne $basePlaceholderObject) { Get-ObjectPropertyMap -Object $basePlaceholderObject } else { @{} }
      $placeholders = if ($null -ne $placeholderObject) { Get-ObjectPropertyMap -Object $placeholderObject } else { @{} }
      Assert-SameKeys -Expected @($basePlaceholders.Keys) -Actual @($placeholders.Keys) -Context "Locale '$locale' message '$messageName' placeholder definition"
      Assert-SameKeys -Expected $tokens -Actual @($placeholders.Keys) -Context "Locale '$locale' message '$messageName' placeholder usage"

      foreach ($placeholderName in $basePlaceholders.Keys) {
        $baseContent = [string](Get-OptionalPropertyValue -Object $basePlaceholders[$placeholderName] -Name "content")
        $content = [string](Get-OptionalPropertyValue -Object $placeholders[$placeholderName] -Name "content")
        Assert-Condition ($content -match '^\$[1-9]\d*$') "Locale '$locale' message '$messageName' placeholder '$placeholderName' has invalid content '$content'."
        Assert-Condition ($content -eq $baseContent) "Locale '$locale' message '$messageName' placeholder '$placeholderName' must use '$baseContent', got '$content'."
      }
    }
  }

  $manifestJson = Get-Content -LiteralPath (Join-Path $RepositoryRoot "manifest.json") -Raw -Encoding UTF8
  $manifestMessages = @(
    [regex]::Matches($manifestJson, '__MSG_([A-Za-z0-9_]+)__') |
      ForEach-Object { $_.Groups[1].Value.ToLowerInvariant() } |
      Sort-Object -Unique
  )
  $missingManifestMessages = @($manifestMessages | Where-Object { -not $baseCatalog.ContainsKey($_) })
  Assert-Condition ($missingManifestMessages.Count -eq 0) "Manifest references missing locale messages: $($missingManifestMessages -join ', ')."
}

function Assert-JavaScriptSyntax {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot,

    [Parameter(Mandatory = $true)]
    [string]$StagingDirectory
  )

  $syntaxRoots = @("src", "scripts", "tests")
  $javascriptFiles = @()
  foreach ($syntaxRoot in $syntaxRoots) {
    $root = Join-Path $RepositoryRoot $syntaxRoot
    if (Test-Path -LiteralPath $root) {
      $javascriptFiles += Get-ChildItem -LiteralPath $root -Recurse -File |
        Where-Object { $_.Extension -in @(".js", ".mjs", ".cjs") }
    }
  }
  $javascriptFiles += Get-ChildItem -LiteralPath $StagingDirectory -Recurse -File -Filter "*.js"

  foreach ($javascriptFile in @($javascriptFiles | Sort-Object FullName -Unique)) {
    & node --check $javascriptFile.FullName
    if ($LASTEXITCODE -ne 0) {
      throw "JavaScript syntax check failed: $($javascriptFile.FullName)"
    }
  }
}

function Assert-FileMapsEqual {
  param(
    [Parameter(Mandatory = $true)]
    [hashtable]$Expected,

    [Parameter(Mandatory = $true)]
    [hashtable]$Actual,

    [Parameter(Mandatory = $true)]
    [string]$Context
  )

  Assert-SameKeys -Expected @($Expected.Keys) -Actual @($Actual.Keys) -Context $Context
  foreach ($relativePath in $Expected.Keys) {
    $expectedHash = Get-Sha256Hex -Path $Expected[$relativePath]
    $actualHash = Get-Sha256Hex -Path $Actual[$relativePath]
    if ($expectedHash -ne $actualHash) {
      throw "$Context content differs for '$relativePath': expected $expectedHash, got $actualHash."
    }
  }
}

$repositoryRoot = Get-RepositoryRoot
$manifest = Get-ManifestObject -RepositoryRoot $repositoryRoot
Assert-Condition ([int]$manifest.manifest_version -eq 3) "manifest_version must be 3."
$version = Get-ExtensionVersion -RepositoryRoot $repositoryRoot
$packageMetadata = Get-JsonObject -Path (Join-Path $repositoryRoot "package.json")
$packageVersionParts = @($version.Split('.'))
Assert-Condition ($packageVersionParts.Count -le 3) "Manifest version '$version' cannot be represented by package semver."
while ($packageVersionParts.Count -lt 3) {
  $packageVersionParts += "0"
}
$expectedPackageVersion = $packageVersionParts -join "."
Assert-Condition ([string]$packageMetadata.version -eq $expectedPackageVersion) "package.json version must be '$expectedPackageVersion' for manifest version '$version'."
$releaseBaseName = Get-ReleaseBaseName -Version $version
$distDirectory = Join-Path $repositoryRoot "dist"
$stagingDirectory = Join-Path $distDirectory $releaseBaseName
$archivePath = Join-Path $distDirectory "$releaseBaseName.zip"

Assert-Condition (Test-Path -LiteralPath $stagingDirectory -PathType Container) "Missing staging directory for manifest version ${version}: $stagingDirectory"
Assert-Condition (Test-Path -LiteralPath $archivePath -PathType Leaf) "Missing ZIP for manifest version ${version}: $archivePath"

$releaseArtifacts = @(
  Get-ChildItem -LiteralPath $distDirectory -Force |
    Where-Object { $_.Name -like 'image-screenshot-save-as-chrome-*' }
)
$unexpectedArtifacts = @($releaseArtifacts | Where-Object { $_.FullName -ne $stagingDirectory -and $_.FullName -ne $archivePath })
$unexpectedArtifactNames = @($unexpectedArtifacts | ForEach-Object { $_.Name })
Assert-Condition ($unexpectedArtifacts.Count -eq 0) "Stale or mismatched release artifacts exist: $($unexpectedArtifactNames -join ', ')."

Assert-LocaleContracts -RepositoryRoot $repositoryRoot -Manifest $manifest

$sourceMap = Get-ReleaseSourceMap -RepositoryRoot $repositoryRoot
$stagingMap = Get-DirectoryFileMap -Directory $stagingDirectory
Assert-FileMapsEqual -Expected $sourceMap -Actual $stagingMap -Context "Source to staging"

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $entryMap = @{}
  $entryHashes = @{}
  foreach ($entry in $archive.Entries) {
    Assert-Condition (-not $entry.FullName.Contains('\')) "ZIP entry paths must use forward slashes: $($entry.FullName)"
    $relativePath = ConvertTo-NormalizedRelativePath -Path $entry.FullName
    Assert-SafeReleaseRelativePath -RelativePath $relativePath
    if ([string]::IsNullOrEmpty($entry.Name)) {
      continue
    }

    $caseInsensitiveKey = $relativePath.ToLowerInvariant()
    Assert-Condition (-not $entryMap.ContainsKey($caseInsensitiveKey)) "Duplicate ZIP entry: $relativePath"
    $entryMap[$caseInsensitiveKey] = $relativePath

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $entryStream = $entry.Open()
    try {
      $entryHashes[$relativePath] = [System.Convert]::ToHexString($sha256.ComputeHash($entryStream)).ToLowerInvariant()
    }
    finally {
      $entryStream.Dispose()
      $sha256.Dispose()
    }
  }

  Assert-SameKeys -Expected @($stagingMap.Keys) -Actual @($entryHashes.Keys) -Context "Staging to ZIP"
  foreach ($relativePath in $stagingMap.Keys) {
    $stagingHash = Get-Sha256Hex -Path $stagingMap[$relativePath]
    if ($stagingHash -ne $entryHashes[$relativePath]) {
      throw "Staging to ZIP content differs for '$relativePath': expected $stagingHash, got $($entryHashes[$relativePath])."
    }
  }
}
finally {
  $archive.Dispose()
}

$stagedManifest = Get-JsonObject -Path (Join-Path $stagingDirectory "manifest.json")
Assert-Condition ([string]$stagedManifest.version -eq $version) "Staged manifest version does not match source manifest version $version."
Assert-JavaScriptSyntax -RepositoryRoot $repositoryRoot -StagingDirectory $stagingDirectory

Write-Host "Release verification passed for $releaseBaseName."
Write-Host "Files: $($sourceMap.Count)"
Write-Host "ZIP SHA256: $(Get-Sha256Hex -Path $archivePath)"
