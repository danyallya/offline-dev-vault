$ErrorActionPreference = 'Stop'
docker compose -f compose.yaml -f compose.offline.yaml up -d --force-recreate registry
Write-Host "Registry is now in strict offline mode (no upstream configured)."

