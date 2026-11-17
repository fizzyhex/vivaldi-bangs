<#
.SYNOPSIS
  Installs (or removes) Helium-style !bangs into Vivaldi's browser UI.

.DESCRIPTION
  Puts helium-bangs.js into Vivaldi's resources folder and loads it from
  window.html. Uses the copy next to this script if there is one, otherwise
  downloads the latest from GitHub. Vivaldi replaces these files on every
  update, so run this again after updating Vivaldi, then restart Vivaldi.

.EXAMPLE
  irm https://raw.githubusercontent.com/fizzyhex/vivaldi-bangs/main/install.ps1 | iex
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/fizzyhex/vivaldi-bangs/main/install.ps1))) -Uninstall
  .\install.ps1 -VivaldiDir "C:\Program Files\Vivaldi\Application"
#>
param(
  [string]$VivaldiDir = (Join-Path $env:LOCALAPPDATA 'Vivaldi\Application'),
  [switch]$Uninstall,
  [string]$Source = 'https://raw.githubusercontent.com/fizzyhex/vivaldi-bangs/main/helium-bangs.js'
)

# Runs in its own scope so `irm | iex` leaves the caller's session untouched.
& {
  $ErrorActionPreference = 'Stop'
  $ModName = 'helium-bangs.js'
  $Tag = "<script src=`"$ModName`"></script>"

  if (-not (Test-Path $VivaldiDir)) { throw "Vivaldi not found at $VivaldiDir (use -VivaldiDir)." }

  # Patch the newest installed version (older folders are left behind by updates).
  $versionDir = Get-ChildItem $VivaldiDir -Directory |
    Where-Object { $_.Name -match '^\d+(\.\d+)+$' -and (Test-Path (Join-Path $_.FullName 'resources\vivaldi\window.html')) } |
    Sort-Object { [version]$_.Name } -Descending |
    Select-Object -First 1
  if (-not $versionDir) { throw "No Vivaldi version folder with resources\vivaldi\window.html under $VivaldiDir." }

  $res = Join-Path $versionDir.FullName 'resources\vivaldi'
  $windowHtml = Join-Path $res 'window.html'
  $target = Join-Path $res $ModName
  $html = [IO.File]::ReadAllText($windowHtml)

  if ($Uninstall) {
    $html = $html.Replace("  $Tag`n", '').Replace($Tag, '')
    [IO.File]::WriteAllText($windowHtml, $html)
    Remove-Item $target -ErrorAction SilentlyContinue
    Write-Host "Removed !bangs from Vivaldi $($versionDir.Name). Restart Vivaldi."
    return
  }

  $local = if ($PSScriptRoot) { Join-Path $PSScriptRoot $ModName }
  if ($local -and (Test-Path $local)) {
    Copy-Item $local $target -Force
  } else {
    Write-Host "Downloading $ModName..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $download = "$target.download"
    Invoke-WebRequest $Source -OutFile $download -UseBasicParsing
    if ((Get-Item $download).Length -lt 1000) { Remove-Item $download; throw "Download of $ModName failed." }
    Move-Item $download $target -Force
  }

  if (-not $html.Contains($Tag)) {
    $backup = "$windowHtml.bak"
    if (-not (Test-Path $backup)) { Copy-Item $windowHtml $backup }
    if ($html -notmatch '</body>') { throw "Unexpected window.html layout; not patching." }
    $html = $html -replace '</body>', "  $Tag`n</body>"
    [IO.File]::WriteAllText($windowHtml, $html)
  }

  Write-Host "Installed !bangs into Vivaldi $($versionDir.Name). Restart Vivaldi to load it."
}
