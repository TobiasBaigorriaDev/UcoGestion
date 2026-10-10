# Entrega de web, API y worker

Construir las tres imágenes desde el mismo checkout con `pnpm run build:images` y ejecutar `pnpm run test:operations`. Node 24.15.0 está fijado por digest, pnpm 11.19.0 por versión y ambas instalaciones usan el lockfile congelado. npm solo instala el ejecutable pnpm en la imagen base; las dependencias del workspace se resuelven exclusivamente con pnpm. El runtime API/worker incluye solo dependencias de producción y código compilado, con migraciones SQL; web usa Next standalone. Todos los servicios ejecutan como usuario `node`.

## Construcción y smoke local

```powershell
$env:NEXT_PUBLIC_WEB_ORIGIN = 'http://localhost:3000'
pnpm run build:images
pnpm run test:operations
```

`SOURCE_REVISION` y `SOURCE_DATE_EPOCH` permiten reproducir los inputs/version de release; por defecto salen del commit actual. Para producción usar checkout limpio, origen HTTPS definitivo, arquitectura `linux/amd64`, la misma versión de BuildKit y las variables exactas. `NEXT_PUBLIC_WEB_ORIGIN` se fija al construir web; cambiar el origen requiere reconstruir. Las tags locales `*:operations` sirven al harness; el rollout exige referencias publicadas `@sha256:...`. La publicación a un registry y la elección de proveedor se configuran fuera del repositorio.

Para comprobar igualdad binaria ejecutar `pnpm run build:images --verify`: recompila API/worker/web sin caché de compilación y compara los digests. El exporter fija timestamps mediante `SOURCE_DATE_EPOCH`; `unpack=false` evita la incompatibilidad de BuildKit entre reescritura de timestamps y unpack automático.

Next 16.3.5 genera metadatos aleatorios de preview y Server Actions aunque no se usen. El paso de build normaliza consistentemente esos cuatro manifiestos con HMAC por propósito y release, sin modificar Next ni su criptografía runtime. Rechaza manifiestos con Server Actions. **Producción requiere `WEB_BUILD_KEY`**, 32 bytes base64 desde custodia de build independiente, entregados mediante BuildKit secret y borrados del workspace temporal al terminar. Repetir una release exige la misma versión de esa clave. Rotar la clave entre releases rota los metadatos; nunca usar las claves offline para este propósito. La clave local predeterminada se admite exclusivamente para localhost/127.0.0.1 y no autoriza una imagen de producción.

El test de contenedores ejecuta las imágenes reales con PostgreSQL real, un tenant canario y fixtures HTTP de S3 y email (puertos externos reemplazables). Verifica web/rutas/assets PWA, API/readiness, PDF, recuperación de contraseña, invitaciones y expiración mediante el worker compilado. El gateway de prueba registra entregas sin contactar destinatarios. CI construye las imágenes antes de la suite para que ese test nunca dependa de imágenes preexistentes del runner.

## Rollout

| Variable | Uso |
| --- | --- |
| `WEB_IMAGE`, `API_IMAGE`, `WORKER_IMAGE` | Digests inmutables de una misma release |
| `MIGRATION_DATABASE_URL` | Rol de migración separado, con DDL; nunca credenciales runtime |
| `RUNTIME_ENV_FILE` | Archivo protegido con secretos runtime; fuera de Git y contexto Docker |
| `SMOKE_FILE_URL` | URL temporal protegida de un PDF generado en el entorno candidato |

El env runtime incluye `DATABASE_URL` (LOGIN miembro de `uco_app`, sin ownership/BYPASSRLS), `WORKER_DISPATCH_DATABASE_URL` (LOGIN miembro de `uco_worker`), `WORKER_USER_ID` (membresía activa autorizada), `EMAIL_GATEWAY_URL/TOKEN`, `S3_ENDPOINT/BUCKET/REGION/ACCESS_KEY_ID/SECRET_ACCESS_KEY`, custodia `OFFLINE_*`/`DEVICE_CERTIFICATE_KEY`, peppers y orígenes públicos. Configurar `UCONEXT_TRUSTED_PROXY_IPS` con la IP real del reverse proxy **y `127.0.0.1`** para el healthcheck local. El healthcheck local afirma `x-forwarded-proto: https` desde loopback; los requests externos continúan sujetos a la validación de proxy/origen. El probe web consulta un asset público sin seguir redirecciones; el smoke público comprueba las rutas de aplicación.

### Gateway de email

`EMAIL_GATEWAY_URL` recibe POST JSON con `template` (`PASSWORD_RESET` o `INVITATION`), `email`, `token` y `jobKey`; las invitaciones incluyen `role` y `branchIds`. La autenticación usa `Authorization: Bearer` con `EMAIL_GATEWAY_TOKEN`. El endpoint exige HTTPS; HTTP solo se admite en loopback para pruebas locales. No sigue redirects y cada envío tiene timeout de 15 segundos.

El gateway debe persistir y deduplicar `Idempotency-Key`, igual a `jobKey`, incluso si pierde la respuesta después de aceptar el mensaje. Un 2xx confirma aceptación durable. El proveedor debe convertir el token en el enlace correspondiente y enviar el mensaje; su elección y provisión siguen diferidas. Un adaptador local hacia Mailpit debe cumplir el mismo contrato. No iniciar el worker sin configurar este puerto.

El worker reclama ambos outboxes con lease y `SKIP LOCKED`. Recuperación usa funciones con privilegios mínimos sobre el outbox global; invitaciones y expiraciones usan la transacción tenant y autorización vigentes. Los fallos reintentan con backoff hasta cinco intentos y luego quedan en dead-letter. Un ACK con lease vencido no completa el job. Las entregas completadas eliminan el token del payload; los errores persistidos usan códigos estables. No enviar cuerpos, tokens ni credenciales a logs. El monitor suma dead-letters globales de recuperación una sola vez por ciclo, además de los tenant.

La migración `0106` crea `uco_identity_dispatcher` como rol sin LOGIN ni BYPASSRLS, propietario de las dos funciones de dispatch global. La restauración provisiona ese rol antes de `pg_restore --no-owner` y repone explícitamente su ownership después de migrar. Esto también admite backups anteriores a `0106`; no iniciar el worker entre restore y verificación.

La migración `0107` habilita el lock de ventas mediante `UPDATE(id)` sin permitir reescribirlas: el trigger de inmutabilidad continúa rechazando cualquier UPDATE. La reversión del stock pasa por `inventory_api.reverse_sale_stock`, que valida contexto tenant, actor, autorización y vínculo con la anulación, bloquea la proyección en orden canónico y registra movimientos compensatorios en la misma transacción.

```powershell
pwsh -File infra/deploy/rollout.ps1 -PublicOrigin 'https://gestion.example.com'
```

El procedimiento hace pull, ejecuta **un job de migración** y solo ante éxito inicia API/worker/web con `--wait`. La migración versionada se serializa además mediante advisory lock PostgreSQL, incluyendo dos releases concurrentes. Un fallo de migración impide el rollout. El proxy HTTPS del proveedor publica un mismo origen, enruta `/api/v1` al puerto API y todo lo demás a web; los puertos Compose están ligados a loopback. El worker no publica un puerto externo.

Readiness worker requiere un ciclo reciente de dispatch; no basta que Node siga vivo. El smoke público verifica rutas/assets, API/readiness, worker y lectura de un PDF generado. Si falla, mantener mantenimiento, inspeccionar y seguir [el runbook](../restore/restore-runbook.md). No ejecutar downgrade automático de schema.

## Alertas

Montar `observability/prometheus.yaml`, reglas `operations-alerts.yaml` e `inventory-ledger-alerts.yaml` en `/etc/prometheus`; conectar a los servicios `api`, `alertmanager` y `blackbox-exporter` de la misma red de monitoreo. Blackbox usa `observability/blackbox.yaml`. En producción, configurar el target/origen HTTPS y routing del proveedor si no se scrapea internamente. Montar `observability/alertmanager.yaml` y el webhook de guardia como archivo secreto `/run/secrets/operations-alert-webhook`; ese endpoint se provisiona en el proveedor.

`OPERATIONS_MONITOR_CONTEXTS` es un JSON de `{organizationId,userId}` por organización, con OWNER activo, sin incluir identidades en labels Prometheus. Mantener la lista al provisionar/revocar organizaciones y usuarios. Un contexto incompleto/fallido no publica cero: conserva el snapshot anterior y dispara alerta de obsolescencia. `INVENTORY_VERIFIER_CONTEXTS` conserva la configuración del verificador de inventario existente.

Las reglas usan evaluación/scrape de 1 minuto: readiness y DB 3 minutos; errores >5% por 5 minutos con ≥20 requests; sync recuperable >5% por 10 minutos con ≥20 operaciones; dead-letter después de agotar los reintentos; conflictos pendientes por 30 minutos; operaciones server-side pendientes por >1 hora. El backlog de dispositivos desconectados no es observable por el servidor hasta recibirlo. Retener logs operativos 30 días en el sink del proveedor; la auditoría sigue en PostgreSQL.
