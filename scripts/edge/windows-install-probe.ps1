<#
.SYNOPSIS
  Report what a Paseo install actually put on this machine, as JSON.

.DESCRIPTION
  Written for the install-directory collision between Paseo Edge and a stock Paseo: both
  used to land in %LOCALAPPDATA%\Programs\Paseo because electron-builder takes the install
  directory from executableName, not productName. See scripts/edge/windows-install-dir.nsh.

  This only reports. The caller decides what is wrong with it, so the same script serves
  the CI check in .github/workflows/edge-windows-install-test.yml and a hand-driven VM.

  Per-user installs only (nsis.perMachine is false), so no elevation is needed and
  everything lives under HKCU and %LOCALAPPDATA%.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$programs = Join-Path $env:LOCALAPPDATA "Programs"

$installs = @()
if (Test-Path $programs) {
  $installs = Get-ChildItem $programs -Directory |
    Where-Object { $_.Name -like "Paseo*" } |
    ForEach-Object {
      [pscustomobject]@{
        directory   = $_.Name
        path        = $_.FullName
        # Named rather than globbed: which of these exists, and under what name, is the
        # whole question. A rename shows up as a missing key, not a silently empty list.
        exes        = @(Get-ChildItem $_.FullName -Filter *.exe -ErrorAction SilentlyContinue |
                        Select-Object -ExpandProperty Name | Sort-Object)
      }
    }
}

$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$shortcuts = @()
if (Test-Path $startMenu) {
  $shortcuts = @(Get-ChildItem $startMenu -Filter "*.lnk" -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.BaseName -like "Paseo*" } |
    ForEach-Object {
      $target = $null
      try {
        $target = (New-Object -ComObject WScript.Shell).CreateShortcut($_.FullName).TargetPath
      } catch {}
      [pscustomobject]@{ name = $_.BaseName; target = $target }
    })
}

$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
$records = @()
if (Test-Path $uninstallKey) {
  $records = @(Get-ChildItem $uninstallKey -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue } |
    Where-Object { $_.DisplayName -like "Paseo*" } |
    ForEach-Object {
      [pscustomobject]@{
        displayName     = $_.DisplayName
        installLocation = $_.InstallLocation
        uninstallString = $_.UninstallString
      }
    })
}

# The Electron userData directory, shared by both builds on purpose: main.ts hardcodes
# app.setName, so this is %APPDATA%\Paseo either way. Reported because uninstaller.nsh:237
# deletes it by APP_FILENAME, which means uninstalling one build can take the other's data.
$userData = Join-Path $env:APPDATA "Paseo"

[pscustomobject]@{
  installs        = @($installs)
  startMenu       = @($shortcuts)
  uninstallRecords = @($records)
  sharedUserData  = [pscustomobject]@{ path = $userData; exists = (Test-Path $userData) }
} | ConvertTo-Json -Depth 6
