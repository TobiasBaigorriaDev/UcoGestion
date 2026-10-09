param([Parameter(Mandatory)][string]$PublicOrigin, [Parameter(Mandatory)][string]$ComposeFile)
$ErrorActionPreference = 'Stop'
foreach ($path in @('/', '/manifest.webmanifest', '/sw.js', '/icon-192.png', '/api/v1', '/api/v1/health/live', '/api/v1/health/ready')) {
  $response = Invoke-WebRequest -Uri "$($PublicOrigin.TrimEnd('/'))$path" -TimeoutSec 15
  if ($response.StatusCode -ne 200 -or $response.RawContentLength -eq 0) { throw "Smoke failed: $path" }
}
docker compose -f $ComposeFile exec -T worker node -e "fetch('http://127.0.0.1:3001/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
if ($LASTEXITCODE -ne 0) { throw 'Worker smoke failed.' }
if (-not $env:SMOKE_FILE_URL) { throw 'SMOKE_FILE_URL must reference a generated PDF in the candidate environment.' }
$file = Invoke-WebRequest -Uri $env:SMOKE_FILE_URL -TimeoutSec 15
if ($file.StatusCode -ne 200 -or $file.RawContentLength -lt 100 -or $file.Headers['Content-Type'] -notmatch '^application/pdf') { throw 'Generated PDF smoke failed.' }
