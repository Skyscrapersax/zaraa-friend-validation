param(
  [string]$ZaraaDir = ""
)

$ErrorActionPreference = "Stop"
$KitDir = Resolve-Path (Join-Path $PSScriptRoot "..")

function Step($Message) { Write-Host ""; Write-Host "-- $Message --" }
function Ok($Message) { Write-Host "  [OK]  $Message" }
function Fail($Message) { Write-Host "  [ERR] $Message"; exit 1 }

$RuntimeHome = if (Test-Path Env:ZARAA_HOME_DIR) {
  $Value = $env:ZARAA_HOME_DIR.Trim()
  if ([string]::IsNullOrWhiteSpace($Value)) { Fail "ZARAA_HOME_DIR must be a non-empty absolute path" }
  $Value
} else { $env:USERPROFILE }
if (-not [IO.Path]::IsPathRooted($RuntimeHome)) { Fail "ZARAA_HOME_DIR must be an absolute path" }
$RuntimeHome = [IO.Path]::GetFullPath($RuntimeHome)
if ($RuntimeHome -eq [IO.Path]::GetPathRoot($RuntimeHome)) { Fail "ZARAA_HOME_DIR cannot be a filesystem root" }
if (-not $ZaraaDir) { $ZaraaDir = Join-Path $RuntimeHome "zaraa" }
$ConfigDir = Join-Path $RuntimeHome ".zaraa"
$ConfigFile = Join-Path $ConfigDir "zaraa.config.json"

Write-Host ""
Write-Host "  Zaraa Friend Harness Installer"
Write-Host "  Package: zaraa-harness-2026.07.24-rc.6"
Write-Host ""

Step "Checking Node.js"
try {
  $NodeVersion = node -p "process.versions.node"
  $NodeMajor = [int]($NodeVersion.Split(".")[0])
} catch {
  Fail "Node.js 22+ is required. Install it from https://nodejs.org/ and rerun this installer."
}

if ($NodeMajor -lt 22) {
  Fail "Node.js 22+ is required, found v$NodeVersion."
}
Ok "Node.js v$NodeVersion"

Step "Preparing install directory"
New-Item -ItemType Directory -Force -Path $ZaraaDir | Out-Null
Ok "Install target ready at $ZaraaDir"

Step "Preparing local gateway key"
# Fail-closed: refuse reparse points (symlink/junction) before minting a gateway key.
function Test-ZaraaReparsePoint([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return $false }
  try {
    $item = Get-Item -LiteralPath $Path -Force
    return [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
  } catch { return $false }
}
if (Test-ZaraaReparsePoint $ConfigDir) {
  Fail "Refusing install: config directory is a reparse point/symlink ($ConfigDir). Materialize a real directory under $env:USERPROFILE\.zaraa."
}
if (Test-ZaraaReparsePoint $ConfigFile) {
  Fail "Refusing install: config file is a reparse point/symlink ($ConfigFile). Replace it with a regular file."
}
if ((Test-Path -LiteralPath $ConfigFile) -and -not ((Get-Item -LiteralPath $ConfigFile -Force) -is [System.IO.FileInfo])) {
  Fail "Refusing install: config path is not a regular file ($ConfigFile)."
}
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
if (Test-ZaraaReparsePoint $ConfigDir) {
  Fail "Refusing install: config directory is a reparse point after create ($ConfigDir)."
}
# Current Windows identity (DOMAIN\user), not bare $env:USERNAME — domain-joined hosts.
$AclUser = $null
try { $AclUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name } catch {}
if ([string]::IsNullOrWhiteSpace($AclUser)) {
  if ($env:USERDOMAIN -and $env:USERNAME) { $AclUser = "$($env:USERDOMAIN)\$($env:USERNAME)" }
  else { $AclUser = $env:USERNAME }
}
# Restrict ACLs so multi-user Windows hosts cannot read gateway keys / pre-pin backups.
try {
  icacls $ConfigDir /inheritance:r /grant:r "${AclUser}:(OI)(CI)F" | Out-Null
} catch {}
if (!(Test-Path $ConfigFile)) {
  $Bytes = New-Object byte[] 32
  $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $Rng.GetBytes($Bytes) } finally { $Rng.Dispose() }
  $Key = [Convert]::ToBase64String($Bytes).Replace("+", "-").Replace("/", "_").TrimEnd("=")
  $Json = @{
    gateway = @{
      trusted = $false
      auth = @{
        apiKey = $Key
      }
    }
    performance = "minimal"
    autonomy = @{
      mode = "off"
      creativeJoy = @{
        enabled = $false
      }
    }
    scheduler = @{
      tasks = @(
        @{
          id = "daily-crypto-discipline"
          enabled = $false
          schedule = "daily 09:00 UTC"
          zone = "guarded"
          prompt = "Daily trading discipline snapshot."
          notify = "none"
          silent = $true
        }
      )
      overnight = @{
        enabled = $false
      }
    }
    trading = @{
      backgroundAutomation = $false
      paperMode = $true
      autoExecuteLive = $false
    }
    predictions = @{
      paperMode = $true
      autoExecuteLive = $false
    }
    calendar = @{
      enabled = $false
    }
    messaging = @{
      imessage = @{
        enabled = $false
      }
    }
    voice = @{
      provider = "pipeline"
      enabled = $false
      facetime = @{
        enabled = $false
      }
    }
  } | ConvertTo-Json -Depth 10
  # No BOM: Windows PowerShell 5 Set-Content -Encoding UTF8 writes U+FEFF and Node JSON.parse fails.
  [System.IO.File]::WriteAllText($ConfigFile, ($Json + [Environment]::NewLine))
  try {
    icacls $ConfigFile /inheritance:r /grant:r "${AclUser}:(R,W)" | Out-Null
  } catch {}
  Ok "Created local gateway config at $ConfigFile"
} else {
  Ok "Keeping existing local gateway config"
}

# Always re-pin paper-only money rails (preserves gateway key; forces paperMode true).
# PowerShell does not fail on native exit codes unless we check $LASTEXITCODE.
Step "Pinning friend paper-only trading rails"
node (Join-Path $KitDir "scripts/friend-config-safety.mjs") --config $ConfigFile
if ($LASTEXITCODE -ne 0) {
  Fail "Friend config safety pin failed (exit $LASTEXITCODE). Refusing to continue install."
}

Step "Setting up package manager"
# Node 25+ no longer bundles corepack, so bring it in via npm before using it.
if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
  try { npm install -g corepack | Out-Null } catch {}
}
try {
  corepack enable | Out-Null
  corepack prepare pnpm@9.15.4 --activate | Out-Null
} catch {}

# Last resort: npm ships with Node on every supported platform.
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  try { npm install -g pnpm@9.15.4 | Out-Null } catch {}
}

try {
  pnpm --version | Out-Null
} catch {
  Fail "pnpm is required. Install it with: npm install -g pnpm@9.15.4"
}

Ok "pnpm $(pnpm --version)"

Step "Installing or updating Zaraa"
node (Join-Path $KitDir "scripts/friend-kit-update.mjs") --source $KitDir --target $ZaraaDir --home-config $ConfigFile
if ($LASTEXITCODE -ne 0) {
  Fail "Friend kit update failed (exit $LASTEXITCODE). Refusing to mark install complete."
}

Write-Host ""
Write-Host "Install complete."
Write-Host "1. Connect a model provider:"
Write-Host "  cd $ZaraaDir; $env:ZARAA_HOME_DIR='$RuntimeHome'; pnpm setup"
Write-Host ""
Write-Host "2. Verify setup:"
Write-Host "  cd $ZaraaDir; $env:ZARAA_HOME_DIR='$RuntimeHome'; pnpm doctor"
Write-Host ""
Write-Host "3. Start Zaraa:"
Write-Host "  cd $ZaraaDir; $env:ZARAA_HOME_DIR='$RuntimeHome'; pnpm start"
Write-Host ""
Write-Host "4. Open:"
Write-Host "  http://localhost:3927/"
