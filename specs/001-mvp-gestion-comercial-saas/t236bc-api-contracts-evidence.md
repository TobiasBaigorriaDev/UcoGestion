# T236B–T236C — cierre de los dos fallos de API

Fecha: 2026-10-09, America/Buenos_Aires. Bloque autorizado tras T236A, ejecutado secuencialmente mediante `sdd-build`. Se conservaron los cambios previos de RF-246. El spec cerrado y el plan aprobado no cambian.

## T236B: privilegios de catálogo

El test de creación conservaba una expectativa anterior al lifecycle y a la edición no estructural: esperaba SQLSTATE `42501` al actualizar `sku`. Las migraciones 0044 y 0048 habilitan, respectivamente, cambios estructurales controlados y edición de nombre/SKU/barcode. RF-159 protege específicamente `type`, `trackInventory` y `baseUnit` cuando existe historial; SKU no pertenece a esa lista. No se revocaron privilegios necesarios ni se cambió código runtime para satisfacer una expectativa obsoleta.

La regresión de `catalog-item-creation.integration.test.ts` ahora comprueba, con rol runtime y PostgreSQL real:

- La edición de SKU en el tenant propio está habilitada, incluso con referencia histórica.
- Un UPDATE sobre un ítem de otro tenant afecta cero filas (RLS).
- UPDATE de `id` o `organization_id` falla con `42501`.
- Cada cambio de `type`, `track_inventory` o `base_unit` con historial falla con `55000`, por el trigger defensivo.
- El rollback conserva el ítem propio y no modifica el ajeno.

La suite de lifecycle conserva las pruebas de autorización, barrera offline, historial, concurrencia, auditoría, idempotencia y rollback. El permiso SQL de SKU no sustituye el comando de aplicación auditado: el test examina privilegios y constraints, no afirma que una escritura SQL directa genere auditoría de negocio.

Trazabilidad: RF-36 → reserva/unicidad de códigos y edición existente; RF-159 → trigger de protección histórica; RF-151/RF-285 → rol runtime, identidad tenant y negativos RLS. Implementación examinada: migraciones 0037, 0038, 0044 y 0048; servicio de lifecycle existente. No hay migraciones nuevas.

## T236C: snapshot OpenAPI

El snapshot esperaba 54 rutas, mientras que la aplicación actual expone 108. Se generó un candidato y se revisó su diferencia estructural antes de incorporarlo: **54 rutas añadidas, 56 operaciones, cero rutas eliminadas, cero modificaciones a rutas preexistentes y cero cambios en metadata/components/info**. Las operaciones añadidas corresponden a 13 controladores existentes y capacidades del plan §8.2: auditoría, desactivación de sucursales, caja, dispositivos, dashboard, gastos, inventario, bootstrap/barrera/entrega offline, compras, reportes y ventas/comprobantes.

Se cotejaron método, ruta, operationId, parámetros y status con los decorators actuales. Los POST ordinarios conservan 201; challenge/push de entrega mantienen sus `@HttpCode(200)` explícitos. Se preservan los contratos existentes y la base `/api/v1`. El [detalle estructurado](t236bc-contract-review.json) lista cada adición y su controlador, junto con SHA-256 de las fuentes examinadas.

Trazabilidad: T026, RF-133/RF-151 → `createOpenApiDocument` → `request-contracts.test.ts` y snapshot versionado. Constitution §10 y plan §8.1 requieren comparar OpenAPI en CI; el test sigue incluido en la suite de CI. Se actualizó únicamente el snapshot esperado, sin alterar rutas, permisos, DTOs ni comportamiento del servidor. Este check no reemplaza las pruebas funcionales ni afirma cobertura completa de schemas request/response.

## RED y GREEN

Baseline reproducible:

`pnpm --filter @uconext/api exec vitest run --config vitest.config.mts test/catalog-item-creation.integration.test.ts test/request-contracts.test.ts`

Resultado: 14 tests pasaron / 2 fallaron, por UPDATE SKU permitido y snapshot OpenAPI desactualizado. Se usó el fallo existente; no se fabricó un estado RED sobre código que ya cumple el contrato aprobado.

Después de corregir la regresión de catálogo:

`pnpm --filter @uconext/api exec vitest run --config vitest.config.mts test/catalog-item-creation.integration.test.ts test/catalog-item-lifecycle.integration.test.ts`

Resultado: 2 archivos / 34 tests pasaron. Solo entonces se trabajó sobre OpenAPI. La generación de su candidato mediante `--update` no se tomó como verificación definitiva.

Gate final del bloque, **sin `--update`**:

`pnpm --filter @uconext/api exec vitest run --config vitest.config.mts test/request-contracts.test.ts test/catalog-item-creation.integration.test.ts test/catalog-lifecycle.e2e.test.ts test/audit-dashboard-http.e2e.test.ts test/user-branch-management.e2e.test.ts test/sales-http.e2e.test.ts`

Resultado: 6 archivos / 21 tests pasaron, incluido el snapshot. En las dos corridas verdes hay **43 tests API distintos**, descontando la repetición de los 12 tests de creación. Las integraciones y HTTP usan PostgreSQL 16 real por Testcontainers, sin mocks de repositorios. Se ejecutaron en contenedor Linux local; los archivos modificados se copiaron desde el workspace. Las pruebas HTTP preservan autorización, CSRF, aislamiento, replay, recibos históricos y sus formatos HTML/PDF.

`pnpm --filter @uconext/api lint` y `pnpm --filter @uconext/api typecheck`: pasaron en el workspace Windows. `git diff --check`: pasó. No se agregaron dependencias ni se omitieron/deshabilitaron tests.

Archivos del bloque: `apps/api/test/catalog-item-creation.integration.test.ts`, `apps/api/test/__snapshots__/request-contracts.test.ts.snap`, `tasks.md` y estos dos artefactos de evidencia. Los logs crudos quedan en `output/playwright/t236/t236bc-red.log`, `t236b-green.log`, `t236c-candidate.log` y `t236bc-final.log`, ignorados por Git.

## Estado

T236B y T236C completadas. Los dos fallos reproducibles del gate original están cerrados en las suites afectadas. No se ejecutó de nuevo toda la suite API ni la puerta raíz: la validación completa corresponde a T236 al terminar los demás hallazgos. El informe original de sdd-check conserva su carácter histórico; jobs, CI, rate limit ejecutable, compatibilidad y cobertura RF pendiente siguen abiertos.
