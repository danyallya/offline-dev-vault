$ErrorActionPreference = 'Stop'
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
docker compose up -d --build
Write-Host "Dashboard: http://localhost:7373"
Write-Host "Registry:  http://localhost:4873"

