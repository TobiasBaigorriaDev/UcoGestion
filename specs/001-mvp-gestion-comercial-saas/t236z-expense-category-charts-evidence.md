# T236Z — Comparar gastos por categoría

Solicitud explícita del usuario, 2026-10-12; refinamiento de T236Y y RF-146–RF-150, RF-152–RF-154, RF-286–RF-287.

En Reportes/Gastos las categorías con operaciones no anuladas del período comparten ejes y escala, con color, patrón y leyenda de nombres. Se mantiene un gráfico separado por moneda histórica para no sumar monedas distintas. La tabla accesible muestra valores por hora/día en columnas de categoría. Importes exactos con sumMoney, deduplicación y todas las páginas del reporte, ceros en intervalos transcurridos y corte al presente. Sin categorías con actividad se conserva el estado vacío vigente.

Archivos:

- API: `apps/api/src/modules/reports/reports.service.ts` agrega categoryName con JOIN compuesto tenant a expense_categories, incluyendo inactivas bajo transacción read-only y RLS.
- Web: `report-trends.ts` agrupa por ID de categoría y moneda; `trend-chart.tsx`/CSS soportan múltiples líneas, leyenda y columnas de valores; `reports-workspace.tsx` conecta exclusivamente Gastos a esa presentación.
- Pruebas: `reports.integration.test.ts`, `report-trends.test.ts`, `reports-workspace.test.tsx` y fixture/recorrido `test/browser/reports-expense-categories.mjs`.

TDD RED: regresiones fallaron por categorías ausentes en la agregación, gráfico de categorías ausente en UI y categoryName ausente en API. GREEN:

- `pnpm --filter @uconext/web exec vitest run test/report-trends.test.ts test/reports-workspace.test.tsx test/purchase-history.test.tsx test/sale-lookup.test.tsx`: 24 PASS, incluyendo sumas decimales, exclusión de anulados, monedas y categorías, leyenda, valores y axe; regresiones de gráficos Ventas/Compras.
- `pnpm --filter @uconext/api exec vitest run --config vitest.config.mts test/reports.integration.test.ts test/reports-http.e2e.test.ts test/report-csv.test.ts`: 27 PASS. PostgreSQL real, nombre de categoría inactiva, negativa cross-tenant y checks de rol/sucursal y exportaciones existentes.
- `pnpm exec playwright-cli run-code --filename apps/web/test/browser/reports-expense-categories.mjs`: PASS. Tres categorías en un solo plot con colores computados distintos; tabla con teclado, cambios de período y 390/768/1280 px, axe con contraste activo sin hallazgos ni overflow. Fixture usa el componente real con datos de presentación, no acredita persistencia ni autorización.
- `impeccable.cmd detect --json` sobre chart/estilos/reports: `[]`.
- `pnpm lint`, `pnpm typecheck`, `pnpm build`: PASS. API y web compiladas; sin dependencias añadidas.

Capturas: `output/playwright/reports-expense-categories-{390,768,1280}.png`.

No modifica historial, operaciones, permisos ni roles; no requiere migración ni paquetes. Atomicidad/idempotencia/auditoría y reintentos comerciales no se alteran porque es una lectura. Conserva observabilidad HTTP vigente y manejo de error/reintento de gráficos. CSV/PDF conservan columnas y filtros. Se conserva la limitación de suite global documentada en T236Y; no se repitió la suite web completa ni el sdd-check global.
