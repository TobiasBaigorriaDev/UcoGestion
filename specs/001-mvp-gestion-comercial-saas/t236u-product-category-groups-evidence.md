# T236U — Agrupar Productos y ubicación del alta

Solicitud explícita del usuario del 2026-10-12. Refinamiento de presentación con trazabilidad en plan y tasks.

## Cambios

- `components/catalog-product-list.tsx` y CSS: agrupación optativa con checkbox, secciones accesibles y encabezados de categoría; Sin categoría al final. Solo grupos con resultados; orden elegido conservado dentro de cada grupo. Asociaciones no resueltas se muestran como Categoría no disponible.
- `catalog-item-management.tsx`: formulario de alta movido debajo de su botón, antes del listado; listado usa agrupación compartida. `catalog-read.tsx`: agrupación en consulta y schema que conserva categoryId.
- `catalog-read.service.ts`: proyección aditiva de categoryId nullable en lectura tenant, sin cambios a RLS, autorización o persistencia. No se exponen costo/margen ni se agregan mutaciones.

## RED / GREEN

- RED UI: `pnpm --filter @uconext/web exec vitest run test/catalog-item-management.test.tsx -t 'optionally groups|keeps the product list'`: falla por checkbox ausente y formulario después del listado.
- RED PostgreSQL: `pnpm --filter @uconext/api exec vitest run test/catalog-read.integration.test.ts`: falla por categoryId ausente en ítems activos e históricos.
- GREEN web: `pnpm --filter @uconext/web exec vitest run test/catalog-item-management.test.tsx test/catalog-read.test.tsx test/catalog-sort.test.ts test/catalog-stock.test.tsx`: 30/30. Categorías activas/inactivas disponibles, Sin categoría, categoría no disponible, búsqueda, orden dentro del grupo, desactivar agrupación y posición del alta.
- GREEN API: misma suite PostgreSQL, 2/2. CASHIER/EMPLOYEE reciben asociaciones, item sin categoría devuelve null; se conservan negativas de organización, sucursal y rol histórico. PostgreSQL 16 real mediante Testcontainers, migraciones y runtime RLS; sin mocks de persistencia.
- `pnpm lint`, `pnpm typecheck`: pasan en el monorepo. `git diff --check` sin errores; detector impeccable sin hallazgos en el componente/CSS nuevos.
- Playwright CLI, escenario `test/browser/catalog-search.mjs`: agrupación, Sin categoría, órdenes y búsqueda, teclado, ajuste/mínimo existente, controles y ausencia de overflow en 1440/768/390. Axe sin violaciones en listado agrupado. Comprobación geométrica del alta entre botón y listado a 1440/390. Capturas `output/playwright/catalog-{1440,768,390}.png`, `product-creation-top-{1440,390}.png`; resultado `catalog-groups-result.log`.

Los escenarios UI interceptan HTTP; garantías de consulta/autorización se acreditan por la suite PostgreSQL separada. No cambia atomicidad, idempotencia, auditoría, reintentos ni operaciones offline. Avisos CSP previos de herramientas Next dev conservados, sin ampliar CSP. Suite global web y gates SDD ajenos permanecen pendientes según T236R; no se declaran verdes por esta verificación focalizada.
