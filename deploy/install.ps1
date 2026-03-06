# ting.sh installer for Windows
# Run with:
#   irm https://raw.githubusercontent.com/andrewting19/ting.sh/main/deploy/install.ps1 | iex

[CmdletBinding()]
param(
  [string]$Repo = "andrewting19/ting.sh",
  [string]$InstallDir = "$env:ProgramData\\ting.sh"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "==> $Message"
}

Write-Step "Installing ting.sh"

# 1. Install Bun if not present
$bunCommand = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunCommand) {
  Write-Step "Installing Bun..."
  Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
}

# Bun installer updates PATH for future shells; ensure this process can find bun now.
$bunCommand = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunCommand) {
  $candidate = Join-Path $env:USERPROFILE ".bun\\bin\\bun.exe"
  if (Test-Path $candidate) {
    $env:Path = "$(Split-Path -Parent $candidate);$env:Path"
    $bunCommand = Get-Command bun -ErrorAction SilentlyContinue
  }
}

if (-not $bunCommand) {
  throw "Bun was not found after install. Open a new PowerShell window and rerun this script."
}

$bunPath = $bunCommand.Source
Write-Step "Bun version: $(& $bunPath --version)"

# 2. Determine latest release
$latestRelease = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ Accept = "application/vnd.github+json" }
$latestTag = $latestRelease.tag_name
if ([string]::IsNullOrWhiteSpace($latestTag)) {
  throw "Could not determine latest release tag"
}
Write-Step "Latest release: $latestTag"

$expectedZipName = "ting.sh-$latestTag.zip"
$zipAsset = $latestRelease.assets | Where-Object { $_.name -eq $expectedZipName } | Select-Object -First 1
if (-not $zipAsset) {
  $zipAsset = $latestRelease.assets | Where-Object { $_.name -like "*.zip" } | Select-Object -First 1
}
if (-not $zipAsset) {
  throw "No .zip asset found in release $latestTag"
}

# 3. Download and extract
$zipPath = Join-Path $env:TEMP ("ting.sh-$latestTag-{0}.zip" -f [guid]::NewGuid().ToString("N"))
Write-Step "Downloading $($zipAsset.name)"
Invoke-WebRequest -Uri $zipAsset.browser_download_url -OutFile $zipPath

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Write-Step "Extracting to $InstallDir"
Expand-Archive -Path $zipPath -DestinationPath $InstallDir -Force
Remove-Item -Path $zipPath -Force

# 4. Write version marker
Set-Content -Path (Join-Path $InstallDir "CURRENT_VERSION") -Value $latestTag -NoNewline

Write-Step "ting.sh $latestTag installed to $InstallDir"
Write-Host ""
Write-Host "Run it manually:"
Write-Host "  cd \"$InstallDir\""
Write-Host "  bun run server.ts"
Write-Host ""
Write-Host "Optional configuration: set env vars like PORT, SHELL, HOSTS_FILE before starting."
