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

function Invoke-External {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter()][string[]]$Arguments = @()
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed (exit code ${LASTEXITCODE}): $FilePath $($Arguments -join ' ')"
  }
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "This installer must run in an elevated PowerShell session (Run as Administrator)."
  }
}

function Ensure-BundledNode {
  param([Parameter(Mandatory = $true)][string]$InstallDir)

  $nodeDir = Join-Path $InstallDir "node"
  $nodeExe = Join-Path $nodeDir "node.exe"
  if (Test-Path $nodeExe) {
    Write-Step "Bundled Node version: $(& $nodeExe --version)"
    return
  }

  $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
  $fileName = "win-$arch-zip"
  $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
  $release = $index | Where-Object { $_.lts -and $_.files -contains $fileName } | Select-Object -First 1
  if (-not $release) {
    throw "Could not find a Node.js LTS release for $fileName"
  }

  $version = $release.version
  $zipName = "node-$version-win-$arch.zip"
  $zipUrl = "https://nodejs.org/dist/$version/$zipName"
  $zipPath = Join-Path $env:TEMP ("node-$version-{0}.zip" -f [guid]::NewGuid().ToString("N"))
  $tempDir = Join-Path $env:TEMP ("node-$version-{0}" -f [guid]::NewGuid().ToString("N"))

  Write-Step "Downloading bundled Node.js $version"
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath

  Write-Step "Extracting bundled Node.js"
  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
  Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force
  Remove-Item -Path $zipPath -Force

  $extractedDir = Join-Path $tempDir "node-$version-win-$arch"
  if (-not (Test-Path $extractedDir)) {
    throw "Node.js extraction failed: expected $extractedDir"
  }

  if (Test-Path $nodeDir) {
    Remove-Item -Path $nodeDir -Recurse -Force
  }
  New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null
  Copy-Item -Path (Join-Path $extractedDir "*") -Destination $nodeDir -Recurse -Force
  Remove-Item -Path $tempDir -Recurse -Force

  if (-not (Test-Path $nodeExe)) {
    throw "Bundled Node.js executable not found: $nodeExe"
  }

  Write-Step "Bundled Node version: $(& $nodeExe --version)"
}

Write-Step "Installing ting.sh"
Assert-Administrator

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

# 3. Stop existing service before touching files
$serviceName = "ting.sh"
$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existingService -and $existingService.Status -ne "Stopped") {
  Write-Step "Stopping existing service '$serviceName'"
  Stop-Service -Name $serviceName -Force
  (Get-Service -Name $serviceName).WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
}

# 4. Download and extract
$zipPath = Join-Path $env:TEMP ("ting.sh-$latestTag-{0}.zip" -f [guid]::NewGuid().ToString("N"))
Write-Step "Downloading $($zipAsset.name)"
Invoke-WebRequest -Uri $zipAsset.browser_download_url -OutFile $zipPath

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Write-Step "Extracting to $InstallDir"
Expand-Archive -Path $zipPath -DestinationPath $InstallDir -Force
Remove-Item -Path $zipPath -Force

# 5. Write version marker
Set-Content -Path (Join-Path $InstallDir "CURRENT_VERSION") -Value $latestTag -NoNewline

# 6. Ensure bundled Node.js exists for the PTY sidecar runtime
Ensure-BundledNode -InstallDir $InstallDir

# 7. Install dependencies in release dir
Write-Step "Installing runtime dependencies (bun install)"
Push-Location $InstallDir
try {
  Invoke-External -FilePath $bunPath -Arguments @("install")
}
finally {
  Pop-Location
}

# 8. Download and install NSSM (skip if already present)
$nssmVersion = "2.24"
$nssmInstallDir = Join-Path $InstallDir "nssm"
$nssmArch = if ([Environment]::Is64BitOperatingSystem) { "win64" } else { "win32" }
$nssmExe = Join-Path $nssmInstallDir "$nssmArch\\nssm.exe"

if (-not (Test-Path $nssmExe)) {
  $nssmZipUrl = "https://nssm.cc/release/nssm-$nssmVersion.zip"
  $nssmZipPath = Join-Path $env:TEMP ("nssm-$nssmVersion-{0}.zip" -f [guid]::NewGuid().ToString("N"))
  $nssmTempDir = Join-Path $env:TEMP ("nssm-$nssmVersion-{0}" -f [guid]::NewGuid().ToString("N"))

  Write-Step "Downloading NSSM $nssmVersion"
  Invoke-WebRequest -Uri $nssmZipUrl -OutFile $nssmZipPath

  Write-Step "Extracting NSSM"
  New-Item -ItemType Directory -Path $nssmTempDir -Force | Out-Null
  Expand-Archive -Path $nssmZipPath -DestinationPath $nssmTempDir -Force
  Remove-Item -Path $nssmZipPath -Force

  $nssmExtractedDir = Join-Path $nssmTempDir "nssm-$nssmVersion"
  if (-not (Test-Path $nssmExtractedDir)) {
    throw "NSSM extraction failed: expected $nssmExtractedDir"
  }

  New-Item -ItemType Directory -Path $nssmInstallDir -Force | Out-Null
  Copy-Item -Path (Join-Path $nssmExtractedDir "*") -Destination $nssmInstallDir -Recurse -Force
  Remove-Item -Path $nssmTempDir -Recurse -Force
} else {
  Write-Step "NSSM already installed, skipping download"
}

if (-not (Test-Path $nssmExe)) {
  throw "NSSM executable not found: $nssmExe"
}

# 9. Register and start the Windows service
$logsDir = Join-Path $InstallDir "logs"
$stdoutLog = Join-Path $logsDir "service-stdout.log"
$stderrLog = Join-Path $logsDir "service-stderr.log"

New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
if (-not (Test-Path $stdoutLog)) { New-Item -ItemType File -Path $stdoutLog | Out-Null }
if (-not (Test-Path $stderrLog)) { New-Item -ItemType File -Path $stderrLog | Out-Null }

if (-not $existingService) {
  Write-Step "Creating Windows service '$serviceName'"
  Invoke-External -FilePath $nssmExe -Arguments @("install", $serviceName, $bunPath, "run", "server.ts")
}

Write-Step "Configuring service '$serviceName'"
Invoke-External -FilePath $nssmExe -Arguments @("set", $serviceName, "Application", $bunPath)
Invoke-External -FilePath $nssmExe -Arguments @("set", $serviceName, "AppDirectory", $InstallDir)
Invoke-External -FilePath $nssmExe -Arguments @("set", $serviceName, "AppParameters", "run server.ts")
Invoke-External -FilePath $nssmExe -Arguments @("set", $serviceName, "AppExit", "Default", "Restart")
Invoke-External -FilePath $nssmExe -Arguments @("set", $serviceName, "Start", "SERVICE_AUTO_START")
Invoke-External -FilePath $nssmExe -Arguments @("set", $serviceName, "AppStdout", $stdoutLog)
Invoke-External -FilePath $nssmExe -Arguments @("set", $serviceName, "AppStderr", $stderrLog)

Write-Step "Starting service '$serviceName'"
Start-Service -Name $serviceName
(Get-Service -Name $serviceName).WaitForStatus("Running", [TimeSpan]::FromSeconds(30))

$service = Get-Service -Name $serviceName
Write-Step "Service status: $($service.Status)"
Write-Step "ting.sh $latestTag installed to $InstallDir"
Write-Host "Logs:"
Write-Host "  Stdout: $stdoutLog"
Write-Host "  Stderr: $stderrLog"
Write-Host "Service management:"
Write-Host "  Get-Service -Name '$serviceName'"
Write-Host "  Restart-Service -Name '$serviceName'"
