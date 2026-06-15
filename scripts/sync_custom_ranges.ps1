# Sync useful custom dashboard ranges using Klaviyo API keys from local MCP config.
# Usage: .\scripts\sync_custom_ranges.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$McpPath = Join-Path $env:USERPROFILE ".cursor\mcp.json"

if (-not (Test-Path $McpPath)) {
    Write-Error "MCP config not found: $McpPath"
}

$mcp = Get-Content $McpPath -Raw | ConvertFrom-Json
$map = @{
    US = "klaviyo US"
    AU = "klaviyo AU"
    CA = "klaviyo CA"
    UK = "klaviyo UK"
    EU = "klaviyo EU"
    FR = "klaviyo FR"
    DE = "klaviyo DE"
    IT = "klaviyo IT"
    ES = "klaviyo ES"
    CL = "klaviyo CL"
    JP = "klaviyo JP"
}

foreach ($code in $map.Keys) {
    $server = $map[$code]
    $key = $mcp.mcpServers.$server.env.PRIVATE_API_KEY
    if (-not $key) {
        Write-Warning "Missing key for $code ($server)"
        continue
    }
    Set-Item -Path "env:KLAVIYO_API_KEY_$code" -Value $key
}

function Get-CustomRanges {
    $today = [DateTime]::UtcNow.Date
    $firstThisMonth = [DateTime]::new($today.Year, $today.Month, 1)
    $lastMonthEnd = $firstThisMonth.AddDays(-1)
    $lastMonthStart = [DateTime]::new($lastMonthEnd.Year, $lastMonthEnd.Month, 1)
    $ranges = @(
        @{
            Start = $lastMonthStart.ToString("yyyy-MM-dd")
            End = $lastMonthEnd.ToString("yyyy-MM-dd")
            Label = "last calendar month"
        }
    )
    $mtdStart = $firstThisMonth.ToString("yyyy-MM-dd")
    $mtdEnd = $today.ToString("yyyy-MM-dd")
    if ($mtdStart -ne $ranges[0].Start -or $mtdEnd -ne $ranges[0].End) {
        $ranges += @{
            Start = $mtdStart
            End = $mtdEnd
            Label = "month to date"
        }
    }
    return $ranges
}

Push-Location (Join-Path $Root "scripts")
try {
    foreach ($range in Get-CustomRanges) {
        Write-Host "Syncing $($range.Label): $($range.Start) .. $($range.End)"
        python sync_dashboard.py --start $range.Start --end $range.End
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
} finally {
    Pop-Location
}

Write-Host "Done. Files in dashboard/data/dashboard-custom-*.json"
