# T236A — validación de entradas monetarias RF-246

Fecha: 2026-10-09, America/Buenos_Aires. Corrección autorizada al retornar desde el gate T236 a `sdd-build`, una tarea por vez. No cambia el spec cerrado ni el plan aprobado.

RF-246 exige permitir cero y rechazar valores negativos o con más de dos decimales al configurar precios de venta y costos unitarios de compra. RF-44 conserva HALF_UP para resultados calculados; no permite redondear entradas inválidas para aceptarlas.

## Cambio y trazabilidad

| RF | Implementación | Prueba y garantía |
| --- | --- | --- |
| RF-246, escala de entrada | `packages/shared/src/index.ts`: parseMoneyInput cuenta decimales del string original, incluidos ceros finales. | `money-validation.test.ts`: propiedad fast-check rechaza `.000`, `.010` y `.001`, acepta `.00`; conserva pruebas de signo y cero. |
| RF-246, precio de venta | `CatalogPriceService`: ambos métodos validan rawPrice antes de Money y conservan el límite numeric(20,2). | `catalog-price.integration.test.ts`: PostgreSQL real; `10.005`, `10.000`, negativos pequeños, subcentavos y overflow se rechazan sin cambiar ítem/versiones, auditoría ni idempotencia. Cero acepta, replay es estable y payload diferente produce conflicto. |
| RF-246, contrato HTTP | Endpoint existente PATCH `/api/v1/catalog/items/:id/price`, con el mismo código de error público. | `catalog-and-invitation-http.e2e.test.ts`: errores 400 problem+json con CATALOG_PRICE_INVALID y traceId; cero posterior con la misma clave confirma una única versión y auditoría. |
| RF-246, costo de compra | `PurchasePersistence` ya valida el costo original antes de cálculo/persistencia; no se modificó su lógica. | `purchases-http.e2e.test.ts`: rutas PENDING_PAYMENT y PAID rechazan costos negativos y de tres decimales; no quedan compra ni movimiento. La misma clave admite cero y replay posterior. |

El test histórico de precios ahora usa una entrada válida `10.01`; conserva las verificaciones de versiones, moneda y auditoría. `Money` mantiene su redondeo HALF_UP sin cambios. No hay migraciones ni dependencias nuevas. El ajuste compartido aplica también a otras entradas monetarias que usan esos validadores; se ejecutaron pruebas de sus consumidores.

## TDD y verificaciones

RED:

- `pnpm --filter @uconext/shared exec vitest run --config vitest.config.mts src/money-validation.test.ts`: 3 pasaron / 1 falló; contraejemplo `0.000` aceptado (seed -2048292851).
- `pnpm --filter @uconext/api exec vitest run --config vitest.config.mts test/catalog-price.integration.test.ts`: 3 pasaron / 1 falló; `10.005` devolvió `10.01` en vez de rechazar.

GREEN y regresión:

- `pnpm --filter @uconext/shared test`: 9 archivos / 20 tests pasaron.
- Catálogo HTTP y compras HTTP: 2 archivos / 11 tests pasaron. En la primera corrida posterior al cambio, el nuevo test de persistencia tenía una expectativa incorrecta del precio inicial (`0.00` en vez de `null`); se corrigió esa expectativa y se repitió el archivo junto con la regresión siguiente.
- `pnpm --filter @uconext/api exec vitest run --config vitest.config.mts test/catalog-price.integration.test.ts test/purchases.integration.test.ts test/sales-quote.integration.test.ts test/expenses.integration.test.ts test/historical-sale-snapshot.test.ts`: 5 archivos / 43 tests pasaron.
- `pnpm --filter @uconext/api exec vitest run --config vitest.config.mts test/cash-foundation.integration.test.ts test/sales-http.e2e.test.ts test/expenses-http.e2e.test.ts`: 3 archivos / 19 tests pasaron. En total, 73 tests API distintos pasaron en las suites afectadas, sin contar repeticiones.
- `pnpm --filter @uconext/web exec vitest run --config vitest.config.mts --maxWorkers=1 test/cash-operations.test.tsx test/cash-exceptional.test.tsx test/cash-closing.test.tsx test/offline-sale.test.ts test/offline-sale-confirmation.test.ts test/offline-pos.test.ts`: 6 archivos / 30 tests pasaron.
- Lint y typecheck de `@uconext/api` y `@uconext/shared`: pasaron. Build de shared: pasó.

Archivos modificados: `packages/shared/src/index.ts`, `packages/shared/src/money-validation.test.ts`, `apps/api/src/modules/catalog/catalog-price.service.ts`, `apps/api/test/catalog-price.integration.test.ts`, `apps/api/test/catalog-and-invitation-http.e2e.test.ts`, `apps/api/test/purchases-http.e2e.test.ts` y `tasks.md`; este documento es nuevo. Los logs Linux RED/GREEN/regresión se conservan en `output/playwright/t236/t236a-*.log`, ignorado por Git.

Las integraciones se ejecutaron sobre PostgreSQL 16 real mediante Testcontainers en un contenedor Linux local con los archivos modificados copiados desde el workspace. No se mockearon repositorios, locks, RLS ni transacciones; las suites existentes conservan negativos cross-tenant, concurrencia y rollback. La validación del precio ocurre antes de iniciar efectos; las operaciones válidas conservan auditoría y replay transaccional. HTTP demuestra los errores públicos y la correlación traceId; el rechazo de compras demuestra rollback y reutilización posterior de la clave.

## Estado de la puerta final

Esta evidencia cierra únicamente T236A. El informe original de T236 queda como evidencia histórica del snapshot anterior; no se reescriben sus resultados para aparentar una nueva puerta verde. T236 sigue pendiente por los demás hallazgos y requiere volver a ejecutarse al completar las tareas correctivas.
