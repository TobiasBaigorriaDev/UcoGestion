# T236J — Captura y conservación de categoría histórica

Fecha: 2026-10-10. Resultado: GREEN. Alcance exclusivo: T236J / RF-269.

## Decisión y compatibilidad

La revisión inicial detectó una incompatibilidad real: configuración v1 y líneas offline no expresaban la categoría asignada. El usuario autorizó el cambio versionado al responder «hazlo» tras la explicación del bloqueo. La decisión está en plan §11.2; el [diagnóstico inicial](t236j-contract-incompatibility.md) conserva el punto de detención anterior a esa aprobación.

Nuevas preparaciones online emiten bootstrap `version=2`, configuración `schemaVersion=2` y cotización `schemaVersion=2`. Cada ítem/línea expresa `category: { id, name } | null`. Categorías asignadas desactivadas también se capturan. La publicación `configurationVersion`, el grant y el sobre criptográfico mantienen sus versiones y responsabilidades anteriores.

Lectores, cotizadores y validadores conservan exactamente las formas v1. Un grant vigente con configuración v1 conserva su semántica hasta una nueva preparación online: no puede aportar una categoría que nunca fue incluida en su configuración firmada. Sus operaciones se registran como `UNKNOWN`, incluso si hoy el catálogo tiene una categoría. Esta convivencia no inventa cumplimiento retrospectivo de RF-269. Configuración v2 exige cotización v2; no se acepta una degradación que omita la categoría.

No se migran sobres pendientes, no se recalculan firmas/hashes, no se vuelven a sellar operaciones y no se modifica un ACK persistido. Tampoco se reconstruyen documentos por fecha o catálogo vigente. Datos `UNKNOWN` significan categoría histórica desconocida; `NONE` acredita ausencia explícita; `ASSIGNED` contiene identidad y nombre originales.

## Implementación

- Migración `0109_document_category_snapshots.sql`: asignación opcional `catalog_items.category_id`, FKs tenant `RESTRICT`, estados/checks en líneas de venta/compra y referencias históricas append-only mediante triggers. No completa asignaciones, categorías o comprobantes anteriores. El default `UNKNOWN` es metadato sobre evidencia faltante.
- Alta de ítem: `categoryId` opcional, categoría activa de la organización, autorización y auditoría existentes. Cuando se omite el campo, el hash del comando previo no cambia. No se agregó una interfaz ni un comando de reasignación.
- Ventas online y compras `PENDING_PAYMENT`/`PAID`: asignación e identidad capturadas bajo locks del ítem y categoría dentro de la transacción contextual. Ventas guardan también objeto y estado en el comprobante. Un puerto público de catálogo evita importar rutas internas entre módulos.
- Configuración offline retenida y firmada: incluye relación categoría/ítem; la cotización local copia ese valor. La ingestión compara con la configuración original y persiste el snapshot recibido, sin consultar categoría actual.
- Reintento: devuelve documento/ACK persistido. Categoría y referencia histórica se confirman o revierten junto con documento, movimientos, auditoría e idempotencia. Los negativos tenant se verifican por servicio, HTTP y FK real.

## TDD y cobertura

Las pruebas se agregaron primero. RED mostró rechazo del contrato v2, ausencia de categoría en cotizaciones y ausencia de `catalog_items.category_id` en persistencia online. GREEN incorporó el modelo y contratos mínimos; luego se extrajo el puerto público y se repitieron las suites afectadas. Se compiló `@uconext/shared` antes del gate porque los consumidores usan su `dist`.

| Garantía | Evidencia ejecutada |
| --- | --- |
| Venta conserva categoría después de rename/reasignación; replay devuelve el original; nueva venta sin categoría; rollback completo | `sales-quote.integration.test.ts`, PostgreSQL real |
| Compras pendientes y pagadas conservan el original; ausencia explícita; replay; rollback de documento/líneas/referencias | `purchases.integration.test.ts`, PostgreSQL real |
| Migración desde esquema anterior deja históricos desconocidos, conserva recibos e inmutabilidad; constraints/FKs tenant | `document-category-migration.integration.test.ts`, migraciones reales PostgreSQL |
| Alta con categoría propia; inactiva, ausente o ajena rechazada; payload distinto conflicto; HTTP estricto | `catalog-item-creation.integration.test.ts`, `catalog-and-invitation-http.e2e.test.ts` |
| Configuración v2, categoría nula/asignada, falsificación de nombre/ID y degradación de versión rechazadas | shared contracts, `historical-sale-snapshot.test.ts`, `offline-sale.test.ts` |
| Sobre v1 histórico válido mantiene bytes/hash y categoría desconocida aun con categoría actual; ACK fallido revierte todo; replay exacto | caso T236J de `historical-ingestion.integration.test.ts` |
| Sobre v2 anterior a rename/desactivación/reasignación conserva categoría; ingestión tardía, dos entregas concurrentes, cierre excepcional inmutable, ACK fallido atómico | caso T218 ampliado de `historical-ingestion.integration.test.ts` |
| Confirmación local y sobre indivisibles en ambas versiones; fallo de escritura, reload, replay estable | `offline-sale-confirmation.test.ts`, Dexie/fake-indexeddb |
| Red perdida/restaurada, logout, reload, dos pestañas, worker real, versiones 1/2, actualización PWA y entrega opaca | escenarios Chromium `offline-pos`, `offline-update`, `opaque-delivery` |

Se conserva la auditoría transaccional y observabilidad HTTP existente (JSON con `request_id`, `trace_id`, estado y duración); no se incorporan payloads sellados a logs. Los errores de categoría usan código estable `CATALOG_ITEM_CATEGORY_NOT_AVAILABLE` y HTTP 409 conforme al manejador existente; UUID inválido usa HTTP 400.

## Comandos y resultados finales

Todos los resultados finales indicados a continuación terminaron con código 0. No hay pruebas omitidas, deshabilitadas ni mocks de repositorios para afirmar atomicidad.

| Comando | Resultado |
| --- | --- |
| `pnpm --filter @uconext/shared build` | Build correcto de contratos consumidos por API/web |
| `pnpm --filter @uconext/shared test` | 9 archivos, 21 tests |
| `pnpm --filter @uconext/web exec vitest run offline opaque-delivery --reporter=default --reporter=json --outputFile=../../output/t236j/web-results.json` | 21 archivos, 69 tests |
| Gate API detallado abajo, seguido de repetición de `catalog-and-invitation-http.e2e.test.ts` | 17 archivos, 152 tests verificados: 140 verdes en los otros 16 archivos y 12 verdes en la suite HTTP repetida |
| `$env:SCENARIO='offline-pos'; pnpm test:e2e:nightly` | Chromium: GREEN, versiones 1/2 |
| `$env:SCENARIO='offline-update'; pnpm test:e2e:critical` | Chromium: GREEN |
| `$env:SCENARIO='opaque-delivery'; pnpm test:e2e:nightly` | Chromium: GREEN |
| `pnpm lint` | 4 tareas correctas, 3 desde caché Turbo |
| `pnpm typecheck` | 4 tareas correctas, 3 desde caché Turbo |
| `git diff --check` | Sin errores |

```powershell
pnpm --filter @uconext/api exec vitest run --config vitest.config.mts --maxWorkers=1 historical-sale-snapshot.test.ts historical-envelope.test.ts historical-ingestion.integration.test.ts offline-bootstrap.integration.test.ts sales-quote.integration.test.ts purchases.integration.test.ts catalog-item-creation.integration.test.ts catalog-category-management.integration.test.ts catalog-and-invitation-http.e2e.test.ts sales-http.e2e.test.ts purchases-http.e2e.test.ts request-contracts.test.ts configuration-exposure.integration.test.ts configuration-barrier.integration.test.ts catalog-item-lifecycle.integration.test.ts document-category-migration.integration.test.ts delivery-migration.integration.test.ts --reporter=default --reporter=json --outputFile=../../output/t236j/api-results.json
pnpm --filter @uconext/api exec vitest run --config vitest.config.mts --maxWorkers=1 catalog-and-invitation-http.e2e.test.ts --reporter=default --reporter=json --outputFile=../../output/t236j/api-http-results.json
```

El gate API inicial detectó una expectativa nueva de HTTP 400 para categoría ajena; el código estable existente responde 409. Se corrigió la expectativa y se repitió el archivo completo: 12/12 GREEN. No se omitió el fallo. Una aserción temporal previa de auditoría de categorías comparaba relojes host/PostgreSQL y era sensible a milisegundos; ahora usa límites del mismo reloj PostgreSQL y el archivo completo pasó. Lint/typecheck finales se ejecutaron después de estas correcciones.

Reportes locales conservados en `output/playwright/t236j/`: resultados Chromium y subdirectorio `gates` con los JSON/logs de Vitest. No se versionan outputs generados. La migración está versionada y probada; no se ejecutó un despliegue ni una migración en producción. Solo se marca T236J; T236 y la conciliación global de requisitos siguen a cargo de `sdd-check`.
