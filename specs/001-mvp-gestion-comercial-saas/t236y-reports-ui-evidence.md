# T236Y — Reportes: períodos y gráficos

Solicitud explícita del usuario, 2026-10-12. RF-146–RF-150, RF-152–RF-154, RF-286–RF-287; refinamiento de T184C.

Implementación: `reports-workspace.tsx`, CSS local, `report-trends.ts` y encabezado configurable de `TrendChart`. Se conserva identidad DESIGN.md, datasets por rol, sucursales autorizadas, listado paginado y exportaciones. Hoy inicia seleccionado; semana comienza el lunes. Fechas locales inclusivas se traducen al contrato exclusivo existente; presets aplican filtros de inmediato y Personalizado usa Aplicar filtros.

Gráficos por hora/día, importes exactos mediante sumMoney, exclusión de anulaciones y separación de monedas históricas. Caja grafica cantidad de sesiones según apertura; movimientos grafica cantidad de movimientos. Inventario actual no ofrece una falsa serie histórica. Gráficos de hasta 31 días y 200 páginas: no se presentan datos parciales ante error o exceso; se conserva listado/exportación. Repeticiones de ID se deduplican. No cambia autorización ni persistencia. Sin nuevas transacciones comerciales, idempotencia, auditoría o reintentos de escrituras; HTTP, observabilidad y errores conservan infraestructura existente.

TDD: pruebas de UI fallaron por ausencia de presets, fechas inclusivas y gráficos; implementación pasó las regresiones. Axe detectó salto h2→h4, corregido con headingLevel=3 para Reportes conservando h4 en Ventas/Compras.

Verificación:

- Vitest UI y helper: fechas locales, límites de 31 días, horas/días futuros, páginas completas, anulaciones, deduplicación, monedas, gastos/caja/movimientos, fast-check de importes y recuperación de error.
- Playwright CLI con componente real y datos de presentación: 390/768/1280 px, axe con contraste activo, teclado, presets, rango de un día e inventario actual. Fixture `test/browser/reports.html`; servidor Vite con `purchase-history.vite.mjs` existente. Capturas en `output/playwright/reports-{390,768,1280}.png`. Esta fixture no acredita aislamiento ni persistencia.
- Detector Impeccable: sin hallazgos.

Comandos y resultados:

- `pnpm lint`: PASS.
- `pnpm typecheck`: PASS.
- `pnpm build`: PASS, API/shared y Next.js con ruta `/workspace/reports` compilada.
- `pnpm --filter @uconext/web exec vitest run test/reports-workspace.test.tsx test/report-trends.test.ts`: 11 pruebas PASS.
- Regresión focalizada con `test/purchase-history.test.tsx` y `test/sale-lookup.test.tsx`: 4 archivos / 21 pruebas PASS antes de agregar la prueba adicional de recuperación de gráficos.
- `pnpm --filter @uconext/api exec vitest run --config vitest.config.mts test/reports.integration.test.ts test/reports-http.e2e.test.ts`: 18 pruebas PASS contra PostgreSQL real; autorización tenant/rol/sucursal, filtros, netos y exportaciones.
- `pnpm exec playwright-cli run-code --filename apps/web/test/browser/reports.mjs`: PASS en 390/768/1280 px; axe con contraste y controles por teclado.
- `impeccable.cmd detect --json apps/web/src/features/insights/reports-workspace.tsx apps/web/src/features/insights/reports-workspace.module.css`: `[]`.

Suite ampliada `pnpm --filter @uconext/web test`: interrumpida tras reproducir un fallo ajeno al cambio, sin resultado global aprobado. Confirmado aisladamente con `pnpm --filter @uconext/web exec vitest run test/offline-pos-workspace.test.tsx`: 1 PASS / 1 FAIL. La aserción de línea 67 busca el UUID `draft.id` mientras la confirmación existente muestra el código de venta de 12 caracteres de D05. Ningún archivo offline fue modificado por T236Y; no se oculta ni se salta esta prueba. La suite completa permanece pendiente de esa corrección y nueva ejecución. No se ejecutaron todos los E2E ni un sdd-check global.
