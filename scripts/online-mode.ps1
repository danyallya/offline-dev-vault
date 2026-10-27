$ErrorActionPreference = 'Stop'
docker compose -f compose.yaml up -d --force-recreate registry
Write-Host "Registry is back in online proxy/cache mode."

