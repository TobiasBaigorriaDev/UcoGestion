# D06 — Tendencias y filtros en Ventas

Solicitud del usuario: gráficos de dinero y cantidad de ventas en el tiempo, con filtros Hoy, Esta semana, Este mes y por sucursal. RF-332–RF-335.

## Implementación

- `SalesOperationsService.trends` agrega ventas confirmadas por hora para un día y por fecha para rangos de varios días, bajo transacción tenant y RLS. Excluye anuladas y completa intervalos sin ventas con cero. Los filtros de sucursal y los predicados de rol/scope/actor/titular de sesión se aplican en PostgreSQL.
- `GET /api/v1/sales/trends` valida rango local inclusivo de hasta 31 días y sucursal opcional. `GET /api/v1/sales` admite sucursal opcional y expone `branchId` en cada fila autorizada.
- Ventas comparte período y sucursal entre historial y gráficos. Los dos gráficos usan líneas y ofrecen una tabla de valores por hora o por día. Si el rango personalizado supera 31 días, el historial sigue disponible y la UI explica el límite.
- La web admite filas de historial de la versión anterior de la API sin `branchId` cuando la consulta lleva una sucursal concreta; un test reproduce el error `INVALID_RESPONSE` informado por el usuario.
- El proceso local de demostración seguía ejecutando `apps/api/dist/main.js` anterior. Se recompiló la API, se reinició solo ese proceso con la configuración local existente y se verificaron `GET /sales` y `GET /sales/trends` a través de Next con una sesión de demostración. No se ejecutaron migraciones.
- No hay migración ni nuevas mutaciones. Auditoría, idempotencia, ledgers y reintentos de comandos no cambian. El endpoint es lectura autorizada y usa el manejo de errores y observabilidad HTTP existentes.

## Verificación

- `pnpm --filter @uconext/api exec vitest run --config vitest.config.mts test/sales-http.e2e.test.ts`: 4 tests; PostgreSQL real, tenant, branch, fecha local, anulaciones, días vacíos y contratos existentes.
- `pnpm --filter @uconext/api exec vitest run --config vitest.config.mts test/request-contracts.test.ts -u`: 4 tests y snapshot OpenAPI actualizado.
- `pnpm --filter @uconext/web exec vitest run test/sale-lookup.test.tsx`: 6 tests; filtros de período/sucursal, gráficos e historial.
- `pnpm --filter @uconext/web exec vitest run test/sales-api-history.test.ts test/sale-lookup.test.tsx`: 7 tests; compatibilidad con filas anteriores y renderizado de líneas.
- `pnpm --filter @uconext/api exec vitest run --config vitest.browser.config.mts test/sale-id-browser.e2e.ts`: 2 escenarios con navegador real, NestJS/PostgreSQL, responsive 390/768/1280 y axe sin violaciones.
- `pnpm lint`, `pnpm typecheck`: scripts raíz.

La prueba aislada del escenario de historial de navegador necesita la venta que prepara el escenario anterior; se ejecutó y aprobó la suite completa.
