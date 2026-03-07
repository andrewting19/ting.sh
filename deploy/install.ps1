# ting.sh installer for Windows
# Run with:
#   irm https://raw.githubusercontent.com/andrewting19/ting.sh/main/deploy/install.ps1 | iex

[CmdletBinding()]
param(
  [string]$Repo = "andrewting19/ting.sh",
  [string]$InstallDir = "$env:ProgramData\\ting.sh",
  [string]$ServiceName = "ting.sh",
  [int]$Port = 7681,
  [string]$ServiceUser = "",
  [string]$ServicePassword = "",
  [string]$SessionHome = ""
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

function Test-BuiltinServiceAccount {
  param([string]$AccountName)

  if ([string]::IsNullOrWhiteSpace($AccountName)) {
    return $false
  }

  $normalized = $AccountName.Trim().ToLowerInvariant()
  return $normalized -eq "localsystem" `
    -or $normalized -eq "localservice" `
    -or $normalized -eq "networkservice" `
    -or $normalized -eq "nt authority\\system" `
    -or $normalized -eq "nt authority\\localsystem" `
    -or $normalized -eq "nt authority\\localservice" `
    -or $normalized -eq "nt authority\\networkservice"
}

function Get-LeafWindowsUserName {
  param([string]$AccountName)

  if ([string]::IsNullOrWhiteSpace($AccountName)) {
    return ""
  }

  $trimmed = $AccountName.Trim()
  if ($trimmed.Contains("\")) {
    return ($trimmed.Split("\") | Select-Object -Last 1)
  }
  return $trimmed
}

function Normalize-OptionalPath {
  param([string]$PathValue)

  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return ""
  }

  return [System.IO.Path]::GetFullPath($PathValue.Trim())
}

function Resolve-PreferredUserName {
  param(
    [string]$RequestedServiceUser
  )

  if (-not (Test-BuiltinServiceAccount $RequestedServiceUser)) {
    $serviceLeaf = Get-LeafWindowsUserName $RequestedServiceUser
    if (-not [string]::IsNullOrWhiteSpace($serviceLeaf)) {
      return $serviceLeaf
    }
  }

  return $env:USERNAME
}

function Resolve-SessionHome {
  param(
    [string]$PreferredUserName,
    [string]$RequestedServiceUser
  )

  if (-not (Test-BuiltinServiceAccount $RequestedServiceUser)) {
    $leaf = Get-LeafWindowsUserName $RequestedServiceUser
    if (-not [string]::IsNullOrWhiteSpace($leaf)) {
      $systemDrive = if ([string]::IsNullOrWhiteSpace($env:SystemDrive)) { "C:" } else { $env:SystemDrive }
      $candidate = Join-Path $systemDrive ("Users\\{0}" -f $leaf)
      if (Test-Path $candidate) {
        return (Normalize-OptionalPath $candidate)
      }
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($PreferredUserName) -and -not [string]::IsNullOrWhiteSpace($env:SystemDrive)) {
    $candidate = Join-Path $env:SystemDrive ("Users\\{0}" -f $PreferredUserName)
    if (Test-Path $candidate) {
      return (Normalize-OptionalPath $candidate)
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    return (Normalize-OptionalPath $env:USERPROFILE)
  }

  return ""
}

function Get-ExistingServiceEnvironment {
  param([string]$ServiceName)

  $parametersPath = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\$ServiceName\\Parameters"
  if (-not (Test-Path $parametersPath)) {
    return @()
  }

  $value = (Get-ItemProperty -Path $parametersPath -Name AppEnvironmentExtra -ErrorAction SilentlyContinue).AppEnvironmentExtra
  if ($null -eq $value) {
    return @()
  }

  return @($value)
}

function Merge-ServiceEnvironment {
  param(
    [string[]]$ExistingEntries,
    [hashtable]$ManagedEntries
  )

  $merged = [ordered]@{}
  foreach ($line in $ExistingEntries) {
    if ([string]::IsNullOrWhiteSpace($line)) {
      continue
    }

    $separator = $line.IndexOf("=")
    if ($separator -lt 1) {
      continue
    }

    $key = $line.Substring(0, $separator)
    if ($ManagedEntries.ContainsKey($key)) {
      continue
    }

    $merged[$key] = $line.Substring($separator + 1)
  }

  foreach ($key in $ManagedEntries.Keys) {
    $value = $ManagedEntries[$key]
    if ([string]::IsNullOrWhiteSpace($value)) {
      continue
    }
    $merged[$key] = [string]$value
  }

  return @(
    $merged.Keys | ForEach-Object { "${_}=$($merged[$_])" }
  )
}

function Set-ServiceIdentity {
  param(
    [Parameter(Mandatory = $true)][string]$NssmExe,
    [Parameter(Mandatory = $true)][string]$ServiceName,
    [string]$ServiceUser,
    [string]$ServicePassword
  )

  if ([string]::IsNullOrWhiteSpace($ServiceUser)) {
    Invoke-External -FilePath $NssmExe -Arguments @("set", $ServiceName, "ObjectName", "LocalSystem")
    return
  }

  if ([string]::IsNullOrWhiteSpace($ServicePassword)) {
    throw "ServicePassword is required when ServiceUser is provided."
  }

  Invoke-External -FilePath $NssmExe -Arguments @("set", $ServiceName, "ObjectName", $ServiceUser, $ServicePassword)
}

Write-Step "Installing ting.sh"
Assert-Administrator

if ([string]::IsNullOrWhiteSpace($ServiceUser) -and -not [string]::IsNullOrWhiteSpace($ServicePassword)) {
  throw "ServicePassword cannot be provided without ServiceUser."
}

$preferredUserName = Resolve-PreferredUserName -RequestedServiceUser $ServiceUser
$requestedSessionHomeOverride = Normalize-OptionalPath $SessionHome
$resolvedSessionHome = ""
if (-not [string]::IsNullOrWhiteSpace($requestedSessionHomeOverride)) {
  $resolvedSessionHome = $requestedSessionHomeOverride
} elseif ([string]::IsNullOrWhiteSpace($ServiceUser) -or (Test-BuiltinServiceAccount $ServiceUser)) {
  $resolvedSessionHome = Resolve-SessionHome -PreferredUserName $preferredUserName -RequestedServiceUser $ServiceUser
}

if (-not [string]::IsNullOrWhiteSpace($resolvedSessionHome)) {
  Write-Step "Shell home override: $resolvedSessionHome"
} elseif (-not [string]::IsNullOrWhiteSpace($ServiceUser) -and -not (Test-BuiltinServiceAccount $ServiceUser)) {
  Write-Step "Shell home override: none (service account profile will be used)"
}
if ([string]::IsNullOrWhiteSpace($ServiceUser)) {
  Write-Step "Service account: LocalSystem"
} else {
  Write-Step "Service account: $ServiceUser"
}

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
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService -and $existingService.Status -ne "Stopped") {
  Write-Step "Stopping existing service '$ServiceName'"
  Stop-Service -Name $ServiceName -Force
  (Get-Service -Name $ServiceName).WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
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
$managedServiceEnv = [ordered]@{
  PORT = [string]$Port
  TING_WINDOWS_SESSION_HOME = $resolvedSessionHome
}

New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
if (-not (Test-Path $stdoutLog)) { New-Item -ItemType File -Path $stdoutLog | Out-Null }
if (-not (Test-Path $stderrLog)) { New-Item -ItemType File -Path $stderrLog | Out-Null }

if (-not $existingService) {
  Write-Step "Creating Windows service '$ServiceName'"
  Invoke-External -FilePath $nssmExe -Arguments @("install", $ServiceName, $bunPath, "run", "server.ts")
}

Write-Step "Configuring service '$ServiceName'"
Invoke-External -FilePath $nssmExe -Arguments @("set", $ServiceName, "Application", $bunPath)
Invoke-External -FilePath $nssmExe -Arguments @("set", $ServiceName, "AppDirectory", $InstallDir)
Invoke-External -FilePath $nssmExe -Arguments @("set", $ServiceName, "AppParameters", "run server.ts")
Invoke-External -FilePath $nssmExe -Arguments @("set", $ServiceName, "AppExit", "Default", "Restart")
Invoke-External -FilePath $nssmExe -Arguments @("set", $ServiceName, "Start", "SERVICE_AUTO_START")
Invoke-External -FilePath $nssmExe -Arguments @("set", $ServiceName, "AppStdout", $stdoutLog)
Invoke-External -FilePath $nssmExe -Arguments @("set", $ServiceName, "AppStderr", $stderrLog)
Set-ServiceIdentity -NssmExe $nssmExe -ServiceName $ServiceName -ServiceUser $ServiceUser -ServicePassword $ServicePassword
$existingEnv = if ($existingService) { Get-ExistingServiceEnvironment -ServiceName $ServiceName } else { @() }
$mergedEnv = Merge-ServiceEnvironment -ExistingEntries $existingEnv -ManagedEntries $managedServiceEnv
Invoke-External -FilePath $nssmExe -Arguments (@("set", $ServiceName, "AppEnvironmentExtra") + $mergedEnv)

Write-Step "Starting service '$ServiceName'"
Start-Service -Name $ServiceName
(Get-Service -Name $ServiceName).WaitForStatus("Running", [TimeSpan]::FromSeconds(30))

$service = Get-Service -Name $ServiceName
Write-Step "Service status: $($service.Status)"
Write-Step "ting.sh $latestTag installed to $InstallDir"
Write-Host "Logs:"
Write-Host "  Stdout: $stdoutLog"
Write-Host "  Stderr: $stderrLog"
Write-Host "Service management:"
Write-Host "  Get-Service -Name '$ServiceName'"
Write-Host "  Restart-Service -Name '$ServiceName'"
