$ErrorActionPreference = 'Stop'
node apps/api/dist/operations/backup-cli.js
if ($LASTEXITCODE -ne 0) { throw 'Backup failed; consult structured operations logs.' }
