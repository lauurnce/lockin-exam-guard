# LockIn companion uninstaller for Windows 10/11.
#
# Removes the HKCU native messaging registry keys for Chrome, Edge and Brave,
# plus companion\com.lockin.companion.json, companion\lockin_host.bat and
# companion\.venv. The log folder %LOCALAPPDATA%\LockIn is left in place.
#
# Usage:  powershell -ExecutionPolicy Bypass -File companion\uninstall_windows.ps1

$ErrorActionPreference = "Stop"
$HostName = "com.lockin.companion"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

$Keys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
)
foreach ($Key in $Keys) {
    if (Test-Path $Key) {
        Remove-Item -Path $Key -Recurse -Force
        Write-Host "Removed: $Key"
    }
}

foreach ($Item in @("$HostName.json", "lockin_host.bat", ".venv")) {
    $Path = Join-Path $Here $Item
    if (Test-Path $Path) {
        Remove-Item -Path $Path -Recurse -Force
        Write-Host "Removed: $Path"
    }
}

Write-Host "LockIn companion uninstalled. Restart your browser if it was open." -ForegroundColor Green
