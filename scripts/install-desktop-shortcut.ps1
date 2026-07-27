# Instaluje skrot "Fenix Dashboard" na pulpicie
# Uruchom: powershell -ExecutionPolicy Bypass -File scripts\install-desktop-shortcut.ps1

$ErrorActionPreference = "Stop"

# Ustal sciezki
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop "Fenix Dashboard.lnk"
$vbsPath = Join-Path $root "bin\dashboard-hidden.vbs"
$icoPath = Join-Path $root "ui\public\favicon.ico"

Write-Host "[INFO] Root repo: $root"
Write-Host "[INFO] Pulpit:    $desktop"

# Stworz skrot
$wsh = New-Object -ComObject WScript.Shell
$s = $wsh.CreateShortcut($shortcutPath)
$s.TargetPath = "wscript.exe"
$s.Arguments = "`"$vbsPath`""
$s.WorkingDirectory = $root

if (Test-Path $icoPath) {
    $s.IconLocation = $icoPath
    Write-Host "[INFO] Ikona: favicon.ico"
} else {
    $s.IconLocation = "shell32.dll,13"
    Write-Host "[INFO] Ikona: shell32.dll,13 (fallback - brak ui/public/favicon.ico)"
}

$s.Save()

Write-Host "[OK] Skrot utworzony: $shortcutPath"
