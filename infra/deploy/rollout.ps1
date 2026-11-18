param([Parameter(Mandatory)][string]$PublicOrigin)
$ErrorActionPreference = 'Stop'
# Validate before pulling images or applying any database migration. Do not
# include the input in diagnostics: an invalid URL may contain credentials.
$candidateOrigin = $null
if (-not [Uri]::TryCreate($PublicOrigin, [UriKind]::Absolute, [ref]$candidateOrigin) -or
    $candidateOrigin.Scheme -ne 'https' -or
    $candidateOrigin.IsLoopback -or
    [string]::IsNullOrWhiteSpace($candidateOrigin.Host) -or
    $candidateOrigin.AbsolutePath -ne '/' -or
    $candidateOrigin.Query -ne '' -or
    $candidateOrigin.Fragment -ne '' -or
    $candidateOrigin.UserInfo -ne '') {
  throw 'PublicOrigin must be a public HTTPS origin without credentials, path, query or fragment.'
}
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
