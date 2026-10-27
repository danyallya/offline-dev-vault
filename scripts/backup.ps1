param([string]$Output = "./backups")
$ErrorActionPreference = 'Stop'
$resolvedRoot = (Resolve-Path .).Path
$outputPath = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot $Output))
if (-not $outputPath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Backup output must stay inside the project directory." }
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
docker compose stop registry manager
try {
  docker run --rm -v offline-dev-vault_registry-storage:/source:ro -v "${outputPath}:/backup" alpine tar czf "/backup/registry-$stamp.tgz" -C /source .
  docker run --rm -v offline-dev-vault_manager-data:/source:ro -v "${outputPath}:/backup" alpine tar czf "/backup/manager-$stamp.tgz" -C /source .
  Copy-Item config/packages.yaml (Join-Path $outputPath "packages-$stamp.yaml")
} finally { docker compose start registry manager }
Write-Host "Backup written to $outputPath"

