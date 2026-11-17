<#
.SYNOPSIS
  Installs (or removes) Helium-style !bangs into Vivaldi's browser UI.

.DESCRIPTION
  Copies helium-bangs.js into Vivaldi's resources folder and loads it from
  window.html. Vivaldi replaces these files on every update, so run this
  script again after updating Vivaldi. Restart Vivaldi afterwards.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -Uninstall
  .\install.ps1 -VivaldiDir "C:\Program Files\Vivaldi\Application"
#>
param(
  [string]$VivaldiDir = (Join-Path $env:LOCALAPPDATA 'Vivaldi\Application'),
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ModName = 'helium-bangs.js'
$Tag = "<script src=`"$ModName`"></script>"
$Source = Join-Path $PSScriptRoot $ModName

if (-not (Test-Path $VivaldiDir)) { throw "Vivaldi not found at $VivaldiDir (use -VivaldiDir)." }

# Patch the newest installed version (older folders are left behind by updates).
$versionDir = Get-ChildItem $VivaldiDir -Directory |
  Where-Object { $_.Name -match '^\d+(\.\d+)+$' -and (Test-Path (Join-Path $_.FullName 'resources\vivaldi\window.html')) } |
  Sort-Object { [version]$_.Name } -Descending |
  Select-Object -First 1
if (-not $versionDir) { throw "No Vivaldi version folder with resources\vivaldi\window.html under $VivaldiDir." }

$res = Join-Path $versionDir.FullName 'resources\vivaldi'
$windowHtml = Join-Path $res 'window.html'
$html = [IO.File]::ReadAllText($windowHtml)

if ($Uninstall) {
  $html = $html.Replace("  $Tag`n", '').Replace($Tag, '')
  [IO.File]::WriteAllText($windowHtml, $html)
  Remove-Item (Join-Path $res $ModName) -ErrorAction SilentlyContinue
  Write-Host "Removed !bangs from Vivaldi $($versionDir.Name). Restart Vivaldi."
  return
}

if (-not (Test-Path $Source)) { throw "$ModName not found next to this script." }
Copy-Item $Source (Join-Path $res $ModName) -Force

if (-not $html.Contains($Tag)) {
  $backup = "$windowHtml.bak"
  if (-not (Test-Path $backup)) { Copy-Item $windowHtml $backup }
  if ($html -notmatch '</body>') { throw "Unexpected window.html layout; not patching." }
  $html = $html -replace '</body>', "  $Tag`n</body>"
  [IO.File]::WriteAllText($windowHtml, $html)
}

Write-Host "Installed !bangs into Vivaldi $($versionDir.Name). Restart Vivaldi to load it."
