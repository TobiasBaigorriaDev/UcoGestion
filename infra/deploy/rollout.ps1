param([string]$PublicOrigin)
$ErrorActionPreference = 'Stop'
foreach ($name in @('API_IMAGE', 'WORKER_IMAGE', 'WEB_IMAGE')) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value -notmatch '@sha256:[a-f0-9]{64}$') { throw "$name must identify an immutable image digest." }
}
$compose = Join-Path $PSScriptRoot 'compose.yaml'
docker compose -f $compose pull api worker web migrate
if ($LASTEXITCODE -ne 0) { throw 'Image pull failed; rollout stopped.' }
# One job before service rollout, additionally serialized by the PostgreSQL advisory lock.
docker compose -f $compose run --rm migrate
if ($LASTEXITCODE -ne 0) { throw 'Migration failed; rollout stopped.' }
docker compose -f $compose up -d --wait api worker web
if ($LASTEXITCODE -ne 0) { throw 'Readiness failed; inspect release and use recovery runbook.' }
& (Join-Path $PSScriptRoot 'smoke.ps1') -PublicOrigin $PublicOrigin -ComposeFile $compose
