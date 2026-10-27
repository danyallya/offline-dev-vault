param([string]$ProjectPath = ".")
$ErrorActionPreference = 'Stop'
$target = (Resolve-Path $ProjectPath).Path
$npmrc = Join-Path $target '.npmrc'
@"
registry=http://localhost:4873/
audit=false
fund=false
fetch-retries=1
"@ | Set-Content -Path $npmrc -Encoding utf8
Write-Host "Created $npmrc"

