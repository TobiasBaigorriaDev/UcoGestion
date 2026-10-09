# Recuperar UcoNext con RPO ≤24 h y RTO objetivo ≤8 h

El responsable de guardia coordina el incidente; el responsable de base de datos restaura y valida; el custodio de secretos recupera las claves y el responsable de plataforma cambia DNS/proxy y habilita tráfico. Registrar nombres, hora UTC del incidente, backup elegido, versión de imágenes y evidencia en el ticket del incidente. El simulacro mensual usa infraestructura descartable y no cambia DNS.

## Preparación obligatoria

- Cuenta/bucket de backup independiente del primario, credenciales exclusivas y lifecycle de **35 días**. El runner nocturno escribe backups; el runner de restore solo los lee. El bucket es exclusivo: el job configura su política de retención. Usar versionado e IAM que impida al runtime API/worker borrar backups; comprobar identidad de cuenta y permisos en el proveedor al provisionar.
- Custodia independiente del primario para la clave AES-256 del backup, con referencia y versión `BACKUP_KEY_REFERENCE`. Entregar 32 bytes base64 en `BACKUP_KEY_FILE`, archivo protegido. Mantener todas sus versiones mientras existan backups que las usen. Nunca publicar este archivo ni el JSON de custodia como artefactos CI.
- Escrow independiente y versionado de `OFFLINE_INGESTION_KEYS`, claves privadas ACK actuales/históricas, firmante de configuración y `DEVICE_CERTIFICATE_KEY`. **Antes de publicar una rotación**, guardar en escrow el inventario completo y realizar un backup verificable. No retirar claves por edad del backup, vencimiento del grant o dispositivo irrecuperable: aún pueden existir sobres pendientes.
- Runner `operations-backup` con Node 24.15.0, pnpm 11.19.0, PowerShell 7 y cliente PostgreSQL 16, acceso de lectura completa para `pg_dump`. El rol de respaldo es separado del runtime y debe poder leer todas las tablas tenant; RLS no puede producir un dump parcial.
- Runner `operations-restore-isolated` separado, Docker y cliente PostgreSQL 16, sin credenciales ni rutas de red al primario, email real ni destinos de jobs comerciales. Restaurar a PostgreSQL del mismo major version y con las extensiones disponibles.
- DNS/proxy: mantener los valores anteriores y documentar TTL, certificado TLS, origen público, trusted proxies y cómo dirigir `/api/v1` al API. Secretos runtime, base de datos, email y S3 se inyectan desde custodia; no están en las imágenes.

## Procedimiento del incidente

1. **0–30 min:** declarar incidente, registrar `RECOVERY_INCIDENT_AT` UTC y detener escrituras/worker mediante el mecanismo del proveedor. Mantener una pantalla de mantenimiento. Conservar sobres offline byte por byte y la cola local; no emitir ACKs ficticios ni forzar resync destruyendo IndexedDB.
2. **30–60 min:** seleccionar el manifiesto de backup confirmado más reciente cuya fecha del snapshot esté a ≤24 h del incidente. Los directorios sin `manifest.json` son cargas incompletas. Obtener la clave AES de la referencia/version exacta. Si el backup supera RPO, registrar incumplimiento y escalar; el script falla para impedir una declaración falsa de cumplimiento.
3. **1–4 h:** ejecutar primero el restore aislado. Configurar `PRIMARY_DATABASE_IDENTITY_URL` sin credenciales, `BACKUP_*` de lectura, `RESTORE_BACKUP_ID` opcional, `RECOVERY_INCIDENT_AT` y ejecutar `pwsh -File infra/restore/monthly-restore.ps1`. El script crea red Docker interna y una DB nueva `uco_restore_*` publicada solo en loopback. Verifica checksum y autenticación GCM antes de `pg_restore --single-transaction --exit-on-error`, preserva grants/RLS, aplica migraciones versionadas y valida constraints, stock/caja y claves históricas contra material público referenciado.
4. **4–6 h:** recuperar objetos desde la copia independiente del proveedor S3 cuando exista. Los recibos se regeneran desde snapshots inmutables; las exportaciones temporales vencidas pueden regenerarse por su caso de uso, sin reescribir historial. Verificar lectura de objetos vigentes y tamaños/content types. Reconstruir credenciales DB runtime sin ownership ni BYPASSRLS, credenciales worker separadas y secretos de email/S3/proxy. Repetir validaciones sobre el candidato definitivo de recuperación.
5. **6–7 h:** confrontar el inventario de claves restaurado con el escrow más reciente, incluidas claves publicadas después del snapshot. Importar el inventario completo mediante custodia antes del bootstrap. Nunca sustituir una clave conservando su ID. Ante clave faltante o discrepancia, bloquear nuevas publicaciones, conservar sobres y escalar al custodio. La prueba criptográfica de restore debe pasar antes de activar ingestión y ACK.
6. **7–8 h:** arrancar API/web/worker de la misma versión después del job único de migración. Ejecutar smoke de rutas, readiness, worker y PDF/archivos; comprobar aislamiento y auditoría. Solo entonces cambiar DNS/proxy, retirar mantenimiento y observar error rate, dead-letter y sync. Recibir reintentos con la misma clave/payload/sobre; los ACK persistidos y las claves históricas evitan duplicación o pérdida. Registrar inicio/fin y RPO/RTO reales.

El script de simulacro destruye su DB al finalizar; no se usa para promover una DB a producción. Para el candidato definitivo, ejecutar los mismos pasos de descarga/verificación/restore y validaciones en infraestructura nueva aprobada por el responsable, conservarla y configurar el proxy con el procedimiento del proveedor. No restaurar encima del primario ni usar `schema push`.

## Evidencia y fallos

`restore-evidence.json` contiene ID/fecha/checksum del backup, tiempo de restauración, RPO/RTO y resultados de migraciones, claves, ledgers, RLS, API, worker y archivos. El smoke crea una organización canaria únicamente en la DB descartable y genera un PDF por el handler real de reportes; usa almacenamiento efímero de prueba y no llama al S3/email productivo. Las referencias y custodia privada no se publican en logs.

La automatización mensual selecciona el último backup confirmado, conserva evidencia 90 días y falla ante backup viejo, clave equivocada/faltante, corrupción, constraint pendiente, ledger divergente, RLS deshabilitado o smoke fallido. Investigar el fallo y repetir; nunca autocorregir proyecciones. Un simulacro pequeño prueba el procedimiento, pero el RTO para el volumen real necesita medición periódica con un backup representativo.

Si el rollout falla, volver a las imágenes y routing anteriores solo si son compatibles con el schema migrado. Las migraciones son forward-only; no borrar tablas ni restaurar el backup de forma automática para deshacer un deploy. Si el candidato recuperado falla validaciones, mantener mantenimiento y preservar primario, backup, sobres y evidencia.

## Verificación reproducible

```powershell
pnpm --filter @uconext/api test -- backup.test.ts restore.test.ts recovery-targets.test.ts backup-restore.integration.test.ts
pwsh -File infra/restore/monthly-restore.ps1 -EvidencePath restore-evidence.json
```

La primera orden ejecuta pruebas de corrupción/clave incorrecta, independencia/retención, `pg_dump`/`pg_restore` reales entre dos Testcontainers PostgreSQL, claves referenciadas, grants/default-deny y smoke API/worker/PDF. La segunda requiere el bucket y custodia provisionados: es el simulacro operacional programado el día 1 de cada mes, 05:00 UTC. El backup diario corre a las 03:00 UTC. Revisar alertas y última ejecución diariamente; GitHub schedule no garantiza un intervalo máximo exacto de 24 h, por lo que el proveedor debe monitorizar la edad del último backup y disparar un reintento si se retrasa.
