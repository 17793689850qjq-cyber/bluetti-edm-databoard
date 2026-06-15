# Deploy BLUETTI EDM dashboard to Netlify
# Run from project root: .\deploy-netlify.ps1

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Source = Join-Path $Root "dashboard"
$DeployDir = Join-Path $Root "netlify-deploy"

if (-not (Test-Path (Join-Path $Source "index.html"))) {
    Write-Error "Missing dashboard\index.html"
    exit 1
}

$TomlPath = Join-Path $Root "netlify.toml"
New-Item -ItemType Directory -Force -Path $DeployDir | Out-Null
Get-ChildItem $DeployDir -Force | Remove-Item -Recurse -Force
Copy-Item "$Source\*" $DeployDir -Recurse -Force
if (Test-Path (Join-Path $DeployDir "CNAME")) {
    Remove-Item (Join-Path $DeployDir "CNAME") -Force
}
if (Test-Path $TomlPath) {
    Copy-Item $TomlPath (Join-Path $DeployDir "netlify.toml") -Force
}
Write-Host "Synced dashboard -> netlify-deploy"

$env:Path = "C:\Program Files\nodejs;C:\Users\BLUETTI\AppData\Roaming\npm;" + $env:Path
$netlify = Get-Command netlify -ErrorAction SilentlyContinue
if (-not $netlify) {
    Write-Host ""
    Write-Host "Netlify CLI not found. Install then deploy:"
    Write-Host "  npm install -g netlify-cli"
    Write-Host "  netlify login"
    Write-Host "  .\deploy-netlify.ps1"
    Write-Host ""
    Write-Host "Or drag netlify-deploy\ to https://app.netlify.com/drop"
    explorer $DeployDir
    exit 0
}

Write-Host "Deploying to Netlify (site: bluetti-edm-databoard)..."
Push-Location $DeployDir
try {
    $siteArgs = @("deploy", "--prod", "--dir", ".", "--site", "bluetti-edm-databoard")
    if ($env:NETLIFY_AUTH_TOKEN) {
        $siteArgs += @("--auth", $env:NETLIFY_AUTH_TOKEN)
    }
    & netlify @siteArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "First deploy attempt failed; creating site bluetti-edm-databoard..."
        & netlify sites:create --name bluetti-edm-databoard
        & netlify deploy --prod --dir .
    }
    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "Live URL: https://bluetti-edm-databoard.netlify.app/"
    } else {
        Write-Host "Deploy failed. Run 'netlify login' first if this is your first time."
    }
} finally {
    Pop-Location
}
