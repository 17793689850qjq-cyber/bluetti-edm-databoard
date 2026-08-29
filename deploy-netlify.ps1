# Deploy BLUETTI EDM dashboard to Netlify
# Run from project root: .\deploy-netlify.ps1
# Canonical live site (team Pro): https://bluetti-edm-dashboard-794.netlify.app/

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Source = Join-Path $Root "dashboard"
$DeployDir = Join-Path $Root "netlify-deploy"
# Team account (community@bluettipower.com / community-s1hx3-i Pro)
$SiteName = if ($env:NETLIFY_SITE_NAME) { $env:NETLIFY_SITE_NAME } else { "bluetti-edm-dashboard-794" }
$SiteId = if ($env:NETLIFY_SITE_ID) { $env:NETLIFY_SITE_ID } else { "f48b6a0b-d0fc-4465-a63f-26726ef42c53" }

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

Write-Host "Deploying to Netlify (site: $SiteName / $SiteId)..."
Push-Location $DeployDir
try {
    $siteArgs = @("deploy", "--prod", "--dir", ".", "--site", $SiteId)
    if ($env:NETLIFY_AUTH_TOKEN) {
        $siteArgs += @("--auth", $env:NETLIFY_AUTH_TOKEN)
    }
    & netlify @siteArgs
    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "Live URL: https://bluetti-edm-dashboard-794.netlify.app/"
    } else {
        Write-Host "Deploy failed. Run 'netlify login' first if this is your first time."
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}
