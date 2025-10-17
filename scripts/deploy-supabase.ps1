[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRef,

    [Parameter()]
    [string]$EnvFile = ".env",

    [Parameter()]
    [string]$BucketName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)
    Write-Host "`n=== $Message ===" -ForegroundColor Cyan
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Command,
        [switch]$IgnoreError
    )

    $display = $Command -join ' '
    Write-Host "> $display" -ForegroundColor DarkGray
    if ($Command.Count -gt 1) {
        & $Command[0] @Command[1..($Command.Count - 1)]
    }
    else {
        & $Command[0]
    }
    $exit = $LASTEXITCODE
    if ($exit -ne 0) {
        if ($IgnoreError) {
            Write-Warning "Command exited with code $exit but was ignored."
        }
        else {
            throw "Command '$display' failed with exit code $exit."
        }
    }
}

if (-not (Get-Command supabase -ErrorAction SilentlyContinue)) {
    throw "Supabase CLI (supabase) not found in PATH. Install it from https://supabase.com/docs/guides/cli."
}

if (-not (Test-Path $EnvFile)) {
    throw "Environment file '$EnvFile' not found."
}

# Helper to read key=value from env file
function Get-EnvValue {
    param([string]$Key)

    $lines = Get-Content -Path $EnvFile
    foreach ($line in $lines) {
        if ($line -match '^\s*#' -or [string]::IsNullOrWhiteSpace($line)) {
            continue
        }
        $pattern = "^\s*" + [System.Text.RegularExpressions.Regex]::Escape($Key) + "\s*=\s*(.+)$"
        $match = [System.Text.RegularExpressions.Regex]::Match($line, $pattern)
        if ($match.Success) {
            $value = $match.Groups[1].Value.Trim()
            if ($value.StartsWith('"') -and $value.EndsWith('"')) {
                $value = $value.Trim('"')
            }
            elseif ($value.StartsWith("'") -and $value.EndsWith("'")) {
                $value = $value.Trim("'")
            }
            return $value
        }
    }
    return $null
}

if (-not $BucketName) {
    $BucketName = Get-EnvValue -Key 'PROMO_ASSET_BUCKET'
    if (-not $BucketName) {
        $BucketName = 'promo-assets'
    }
}

Write-Step "Setting Edge Function secrets"
Invoke-CheckedCommand -Command @('supabase', 'functions', 'secrets', 'set', '--project-ref', $ProjectRef, '--env-file', $EnvFile)

Write-Step "Creating storage bucket '$BucketName'"
Invoke-CheckedCommand -Command @('supabase', 'storage', 'create-bucket', $BucketName, '--public', '--project-ref', $ProjectRef) -IgnoreError

Write-Step "Applying database schema"
$schemaPath = Join-Path $PSScriptRoot '..' 'supabase' 'schema.sql'
if (-not (Test-Path $schemaPath)) {
    throw "Could not find schema file at $schemaPath"
}
Invoke-CheckedCommand -Command @('supabase', 'db', 'execute', '--file', $schemaPath, '--project-ref', $ProjectRef)

Write-Step "Deploying Edge Functions"
Invoke-CheckedCommand -Command @('supabase', 'functions', 'deploy', 'create-campaign', '--project-ref', $ProjectRef)
Invoke-CheckedCommand -Command @('supabase', 'functions', 'deploy', 'qr', '--project-ref', $ProjectRef)

Write-Step "Deployment completed"

