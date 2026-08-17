param(
  [string]$ZaraaDir = ""
)

$ErrorActionPreference = "Stop"
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

if (!(Test-Path $ZaraaDir)) {
  Write-Host "Zaraa is not installed at $ZaraaDir yet."
  Write-Host "Run .\installers\install-windows.ps1 first."
  exit 1
}

Set-Location $ZaraaDir
Write-Host "Starting Zaraa from $ZaraaDir"
Write-Host "Open http://localhost:3927/ after the gateway is ready."
$env:ZARAA_HOME_DIR = $RuntimeHome
pnpm start
if ($LASTEXITCODE -ne 0) {
  Write-Host "  [ERR] pnpm start failed (exit $LASTEXITCODE)."
  exit $LASTEXITCODE
}
