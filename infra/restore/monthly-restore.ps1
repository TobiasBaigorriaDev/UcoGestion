param([string]$EvidencePath = 'restore-evidence.json')
$ErrorActionPreference = 'Stop'
$drillId = [guid]::NewGuid().ToString('N')
$network = "uco-restore-$drillId"
$container = "uco-restore-db-$drillId"
$database = "uco_restore_$drillId"
$custodyPath = Join-Path ([System.IO.Path]::GetTempPath()) "uco-restore-$drillId.json"
$password = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$previousPassword = $env:POSTGRES_PASSWORD
$previousNodeEnvironment = $env:NODE_ENV
try {
  # The drill uses an isolated application harness with an ephemeral object-storage port.
  $env:NODE_ENV = 'test'
  docker network create --internal $network | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot create isolated restore network.' }
  $env:POSTGRES_PASSWORD = $password
  docker run -d --name $container --network $network -p '127.0.0.1::5432' -e POSTGRES_PASSWORD -e "POSTGRES_DB=$database" postgres:16-alpine | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot start isolated restore database.' }
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    docker exec $container pg_isready -U postgres -d $database *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw 'Isolated restore database not ready.' }
  $mapping = docker port $container 5432/tcp
  if ($LASTEXITCODE -ne 0 -or $mapping -notmatch '^127\.0\.0\.1:(\d+)$') { throw 'Restore must bind only to loopback.' }
  $env:RESTORE_DATABASE_URL = "postgresql://postgres:${password}@127.0.0.1:$($Matches[1])/$database"
  $env:RESTORE_CUSTODY_OUTPUT = $custodyPath
  $env:RESTORE_EVIDENCE_OUTPUT = $EvidencePath
  node apps/api/dist/operations/restore-cli.js
  if ($LASTEXITCODE -ne 0) { throw 'Restore drill failed; preserve protected diagnostics.' }
} finally {
  $env:POSTGRES_PASSWORD = $previousPassword
  $env:NODE_ENV = $previousNodeEnvironment
  Remove-Item Env:RESTORE_DATABASE_URL -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $custodyPath) { Remove-Item -LiteralPath $custodyPath -Force }
  # Exact task-created resource names; never enumerate or remove unrelated containers.
  docker rm -f $container *> $null
  docker network rm $network *> $null
}
