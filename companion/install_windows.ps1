# LockIn companion installer for Windows 10/11.
#
# Creates companion\.venv with psutil, writes the launcher
# companion\lockin_host.bat and the host manifest companion\com.lockin.companion.json,
# and registers native messaging host "com.lockin.companion" for Chrome, Edge
# and Brave under HKCU (no admin rights needed).
#
# Usage:  powershell -ExecutionPolicy Bypass -File companion\install_windows.ps1 [EXTENSION_ID]
# Without an argument the ID is read from ..\extension\EXTENSION_ID.txt.

param([string]$ExtensionId = "")

$ErrorActionPreference = "Stop"
$HostName = "com.lockin.companion"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Venv = Join-Path $Here ".venv"
$Bat = Join-Path $Here "lockin_host.bat"
$JsonPath = Join-Path $Here "$HostName.json"

# 1. Extension ID
if (-not $ExtensionId) {
    $IdFile = Join-Path $Here "..\extension\EXTENSION_ID.txt"
    if (-not (Test-Path $IdFile)) {
        Write-Host "Error: extension ID not found." -ForegroundColor Red
        Write-Host "  Expected file: $IdFile"
        Write-Host "  Run 'python scripts\generate_key.py' first, or pass the ID as an argument."
        exit 1
    }
    $ExtensionId = (Get-Content -Raw $IdFile).Trim()
}
if ($ExtensionId -notmatch '^[a-p]{32}$') {
    Write-Host "Error: '$ExtensionId' does not look like a Chrome extension ID (32 letters a-p)." -ForegroundColor Red
    exit 1
}

# 2. Find Python 3: py -3 first, then python
$PyExe = $null
$PyArgs = @()
try {
    & py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" 2>$null
    if ($LASTEXITCODE -eq 0) { $PyExe = "py"; $PyArgs = @("-3") }
} catch { }
if (-not $PyExe) {
    try {
        & python -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" 2>$null
        if ($LASTEXITCODE -eq 0) { $PyExe = "python"; $PyArgs = @() }
    } catch { }
}
if (-not $PyExe) {
    Write-Host "Error: Python 3.9 or newer was not found." -ForegroundColor Red
    Write-Host "  Install it from https://www.python.org/downloads/ (tick 'Add python.exe to PATH'), then run this again."
    exit 1
}

# 3. Virtual environment + requirements
Write-Host "Creating virtual environment in $Venv ..."
& $PyExe @PyArgs -m venv "$Venv"
if ($LASTEXITCODE -ne 0) { Write-Host "Error: could not create the virtual environment." -ForegroundColor Red; exit 1 }
$VenvPy = Join-Path $Venv "Scripts\python.exe"
& $VenvPy -m pip install --quiet --disable-pip-version-check -r (Join-Path $Here "requirements.txt")
if ($LASTEXITCODE -ne 0) { Write-Host "Error: pip install failed." -ForegroundColor Red; exit 1 }

# 4. Launcher (.bat)
$BatText = "@echo off`r`n`"%~dp0.venv\Scripts\python.exe`" `"%~dp0lockin_host.py`" %*`r`n"
[System.IO.File]::WriteAllText($Bat, $BatText, [System.Text.Encoding]::ASCII)

# 5. Host manifest (UTF-8 without BOM)
$Manifest = [ordered]@{
    name            = $HostName
    description     = "LockIn desktop companion"
    path            = (Resolve-Path $Bat).Path
    type            = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$Json = $Manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($JsonPath, $Json, (New-Object System.Text.UTF8Encoding($false)))

# 6. Registry (HKCU, default value = full path of the JSON manifest)
$Keys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
)
foreach ($Key in $Keys) {
    New-Item -Path $Key -Force | Out-Null
    Set-Item -Path $Key -Value $JsonPath
    Write-Host "Registered: $Key"
}

Write-Host ""
Write-Host "LockIn companion installed (extension ID $ExtensionId)." -ForegroundColor Green
Write-Host "Restart Chrome if it was open."
Write-Host "Test it with:  `"$Bat`" --diagnose"
