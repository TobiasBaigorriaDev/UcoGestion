# Evidencia operativa — T230–T233 y T235

Fecha de verificación: 2026-10-09. Alcance: RF-135, RF-136, RF-137, RF-138, RF-139 y RF-315. Se conservaron los cambios anteriores del usuario; no se agregaron requisitos funcionales ni proveedores definitivos.

## Implementación y trazabilidad

| Tarea | Resultado | Evidencia principal |
| --- | --- | --- |
| T230 · RF-135/136/137 | Alertas de readiness, DB, error HTTP, dead-letter, sync, conflictos y monitor obsoleto; routing mediante webhook secreto. Agregación bajo RLS, con membresía OWNER vigente, sin labels por tenant. | `observability/operations-alerts.yaml`, `prometheus.yaml`, `alertmanager.yaml`, `blackbox.yaml`; `OperationalMonitor`, `MetricsService`; pruebas de reglas y prueba negativa cross-tenant. |
| T231 · RF-138 | Snapshot consistente PostgreSQL, dump custom cifrado AES-256-GCM, SHA-256, publicación del manifiesto al final, credenciales/cuenta separadas y lifecycle de 35 días. Custodia histórica de ingestión/ACK cifrada y vinculada al mismo backup. | `apps/api/src/operations/backup*.ts`, `postgres-tools.ts`, `infra/backup/backup.ps1`, workflow diario; pruebas de corrupción y publicación incompleta. |
| T232 · RF-139/315 | Restore mensual en cluster vacío aislado, migraciones versionadas, verificación criptográfica de claves referenciadas, constraints, RLS default deny, proyecciones de inventario/caja, API y outbox con PDF real. | `restore*.ts`, `recovery-smoke.ts`, `infra/restore/monthly-restore.ps1`, workflow mensual; `backup-restore.integration.test.ts`. |
| T233 · RF-139/315 | Runbook con responsabilidades, mantenimiento, custodia, restauración, rollout, validación y rollback compatible. RPO máximo 24 h y RTO máximo 8 h medidos desde el incidente, incluyendo demora de respuesta. | `infra/restore/restore-runbook.md`, `recovery-targets.ts`; pruebas de límites y simulacro PostgreSQL. |
| T235 · RF-135/138/139 | Imágenes web/API/worker con runtime fijado, lockfile congelado, usuario sin privilegios, migraciones incluidas, advisory lock y migración previa única. Smoke de rutas, assets, readiness, worker y PDF generado. | `infra/deploy/`, `database/migrate.ts`, `worker-health.ts`, CI y pruebas de migraciones simultáneas/runtime de imágenes. |

Los detalles de provisión están en [entrega](../../infra/deploy/README.md) y [recuperación](../../infra/restore/restore-runbook.md). Las implementaciones comerciales existentes y sus migraciones se usan sin alterar su comportamiento.

## Verificaciones realizadas

| Comando o suite | Resultado |
| --- | --- |
| `pnpm run test:operations` | 10 archivos, 13 pruebas aprobadas; 143,56 s. PostgreSQL real en Testcontainers; dump/restore real entre dos clusters. |
| Vitest: `operational-observability`, `database-readiness`, `historical-ingestion`, `outbox`, `s3-object-storage`, `recovery-targets` | 6 archivos, 23 pruebas aprobadas; 100,09 s. |
| Vitest: claves de sobres y ACK offline | 4 pruebas aprobadas. |
| `promtool check rules` y `promtool test rules observability/operations-alerts.test.yaml` | Reglas válidas; tests aprobados, incluyendo fallas transitorias, duración de alertas y tráfico mínimo. Ejecutado con `prom/prometheus:v3.2.1`. |
| `pnpm run lint --filter=@uconext/api --filter=@uconext/web` | Ambos paquetes aprobados, ejecutando el script raíz en el builder Linux. |
| `pnpm run typecheck --filter=@uconext/api --filter=@uconext/web` | Ambos paquetes aprobados en el builder Linux. También lint/typecheck directo de API y web en Windows. |
| `node --test test/workspace.smoke.test.mjs` | 1 prueba aprobada. |
| Parser PowerShell de backup, restore, rollout y smoke; `node --check` del builder | Sin errores de sintaxis. |
| `node --test infra/deploy/normalize-next-build.test.mjs` | Igualdad de metadatos de Next con distintos valores aleatorios originales y rechazo de Server Actions, aprobado. |
| `pnpm run build:images --verify` | API, worker y web recompilados independientemente; igualdad de digest aprobada para las tres imágenes. |
| Vitest: `delivery-runtime.integration.test.ts` después del build final | 1 prueba aprobada; 34,27 s. Verifica rutas/assets, API/readiness, worker y archivo PDF en las imágenes finales. |

Digests locales verificados, con el mismo checkout, origen localhost, clave de build local y `SOURCE_DATE_EPOCH=1791332783`:

| Imagen | Digest |
| --- | --- |
| API | `sha256:59f57add88ea703f28588168716ad9cf8ee5901330e73970ed06d92e32e3cb38` |
| Worker | `sha256:395d193bd5160bfb2b60e8971db563ada035d1e41dd5eeb6e4016fe937fb7251` |
| Web | `sha256:ebe51f22a84a92aa1fbeccb4cdc20cfe3cc3b015c9e16a863a83ffcd6de32893` |

Next copia los manifiestos a standalone durante el build: la normalización se aplica tanto al output principal como a esa copia antes de construir el runtime. La clave maestra entra como BuildKit secret; el argumento de invalidación de caché contiene únicamente su fingerprint SHA-256. El warning de Docker sobre el nombre de ese argumento no implica inclusión de la clave maestra. El warning existente de Next sobre `middleware` permanece fuera de esta tarea.

No se saltaron ni deshabilitaron pruebas requeridas. El script raíz Turbo en Windows devuelve `spawn UNKNOWN`; los mismos scripts raíz de lint/typecheck se ejecutaron correctamente en Linux. Una ejecución amplia interrumpida por concurrencia excesiva de PostgreSQL no se cuenta como evidencia; Vitest usa ahora un worker y se repitieron las suites pertinentes.

El restore verifica datos no vacíos: stock 7,125 y caja esperada 15,00. La prueba introduce por separado divergencia de inventario, divergencia de caja, clave ausente y RLS deshabilitada; todas se rechazan. La prueba de migración concurrente obtiene un journal sin duplicados y una repetición segura. Los tests de runtime ejecutan contenedores construidos del proyecto y un puerto externo S3 de prueba; no mockean repositorios, aislamiento ni transacciones.

## Garantías y límites de despliegue

La publicación incompleta no crea un backup comprometido: el manifiesto es el último objeto. Los checksums detectan corrupción y GCM autentica dump/custodia; una falla elimina plaintext temporal. La custodia contiene las claves necesarias para sobres pendientes y ACK históricos, y se comprueba contra los registros del snapshot. El backup falla si falta una referencia necesaria.

El simulacro no ejecuta jobs restaurados de producción: usa un tenant canario y reclama exclusivamente su job. Comprueba idempotencia/atomicidad de outbox en las suites afectadas, auditoría del archivo y errores sin secretos. Los logs de backup/restore contienen identificador, checksum, tiempos y estados de verificación; los fallos retornan código distinto de cero. El rollout se detiene antes de iniciar servicios si falla la migración y ante smoke fallido exige intervención según el runbook.

La configuración de cuenta independiente exige IDs diferentes y credenciales separadas; la separación efectiva de IAM, bucket, custodia, runners, receptor de guardia, HTTPS y proveedor debe provisionarse y verificarse en el entorno elegido. No se ejecutaron backups o restauraciones contra producción, ni se publicaron imágenes o secretos externos. Los workflows están implementados, pero necesitan esos recursos para operar.

GitHub schedule puede demorarse: el proveedor debe vigilar edad del último backup y fallas del scheduler para garantizar RPO de 24 h. La prueba demuestra el mecanismo y límites temporales con datos representativos de la suite; el RTO de 8 h para el volumen productivo requiere un simulacro con volumen y ancho de banda reales, conservando su evidencia mensual. La cola de dispositivos desconectados solo es observable al llegar al servidor; el runbook exige recuperar claves antiguas y reenviar los mismos sobres hasta ACK definitivo.

T236 y la fase global `sdd-check` permanecen fuera del alcance de este pedido.
