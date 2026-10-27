param(
  [string]$Package = "zod",
  [string]$Version = "4.4.1"
)
$ErrorActionPreference = 'Stop'
if ($Package -notmatch '^(?:@[a-zA-Z0-9._~-]+/[a-zA-Z0-9._~-]+|[a-zA-Z0-9._~-]+)$') { throw "Invalid npm package name." }
if ($Version -notmatch '^[0-9A-Za-z.+-]+$') { throw "Invalid npm version." }
$spec = "$Package@$Version"

Write-Host "Testing $spec with a fresh client cache and no Verdaccio uplink..."
docker compose -f compose.yaml -f compose.offline.yaml up -d --force-recreate registry
try {
  $health = ''
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $health = docker inspect --format '{{.State.Health.Status}}' offline-dev-vault-registry-1 2>$null
    if ($health -eq 'healthy') { break }
    Start-Sleep -Seconds 1
  }
  if ($health -ne 'healthy') { throw "Offline registry did not become healthy." }

  docker run --rm public.ecr.aws/docker/library/node:24-alpine sh -c "mkdir -p /tmp/e2e && cd /tmp/e2e && npm init -y >/dev/null && npm install '$spec' --registry=http://host.docker.internal:4873 --cache=/tmp/fresh-client-cache --ignore-scripts --no-audit --no-fund && npm ls '$Package' --depth=0"
  if ($LASTEXITCODE -ne 0) { throw "Offline installation failed for $spec" }
  Write-Host "Offline installation passed for $spec" -ForegroundColor Green
} finally {
  docker compose -f compose.yaml up -d --force-recreate registry
}
