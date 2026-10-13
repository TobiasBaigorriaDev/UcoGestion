# T236T — Ordenar Productos

## Ampliación: Stock bajo primero

Solicitud posterior del mismo día: se agrega `stock-low` al selector compartido. Prioriza `lowStock` con mínimo no nulo, calculado por la API como saldo menor o igual al mínimo configurado en la sucursal. Productos sin alerta siguen por nombre; saldos no aplicables al final. Cambiar mínimos/saldos y recargar recalcula los grupos. Prueba RED de `catalog-sort.test.ts` devuelve incorrectamente Arroz/Café antes de Bolsa, que tiene una cantidad mayor pero alerta configurada; GREEN: 28/28 en las cuatro suites afectadas. `pnpm lint` y `pnpm typecheck` pasan. El escenario Playwright existente incluye selección `stock-low` y mantiene comprobaciones de búsqueda, ajustes y responsive.

Solicitud explícita del usuario del 2026-10-12. Refinamiento local de la presentación del catálogo.

## Implementación

- `catalog-item-management.tsx` y `catalog-read.tsx` incorporan el selector compartido `components/catalog-sort.tsx` y su CSS. Nombre A–Z inicial; nombre Z–A, precio y stock en ambos sentidos.
- Se ordenan copias de los resultados de búsqueda. BigInt compara decimales sin pérdida de precisión, incluso cantidades negativas de conflictos offline. Sin precio/stock queda al final; empates por nombre e ID. Solo saldos disponibles de productos activos con inventario en la sucursal seleccionada.
- No se cambian contratos, transacciones, permisos, auditoría, idempotencia ni persistencia; esta tarea no modifica operaciones comerciales u offline.

## Evidencia

- RED: `pnpm --filter @uconext/web exec vitest run test/catalog-item-management.test.tsx -t 'orders filtered'` falla por selector ausente.
- GREEN: `pnpm --filter @uconext/web exec vitest run test/catalog-item-management.test.tsx test/catalog-read.test.tsx test/catalog-stock.test.tsx test/catalog-sort.test.ts`: 27/27. Incluye todos los sentidos, búsqueda/limpieza, ausencia de stock tras error, precios por encima del entero seguro, cantidades fraccionarias negativas y exclusión de saldos no aplicables. Sin tests omitidos en esta ejecución completa de las suites afectadas.
- `pnpm lint` y `pnpm typecheck`: pasan en el monorepo.
- Playwright CLI Chromium sobre Next dev en localhost:3000: escenario `test/browser/catalog-search.mjs`, orden por nombre/precio/stock, búsqueda, acciones y ajustes existentes; 1440/768/390 px sin desbordes, selector de al menos 44 px y cero violaciones axe. Capturas `output/playwright/catalog-{1440,768,390}.png`. HTTP interceptado para presentación, sin afirmar garantías PostgreSQL. El servidor dev conserva avisos CSP previos de las herramientas de desarrollo; no se amplía CSP.
- No se repite la suite global web: fallos previos ajenos en POS offline y comprobantes permanecen documentados en T236R. Esta tarea no cierra otros gates SDD pendientes.
