# T236V — Categorías como carpetas

Solicitud explícita del usuario del 2026-10-12: resaltar categorías y abrir productos tocando su carpeta.

## Implementación

`catalog-product-list.tsx` incorpora `CategoryFolder`, cerrada al montarse: botón con icono de carpeta, nombre, cantidad de ítems y flecha, aria-expanded/aria-controls. Apertura independiente, productos montados al abrirse y ocultos al cerrar. Desactivar/reactivar agrupación reinicia las carpetas. CSS compartido para gestión/consulta usa fondo verde suave, borde verde, texto e iconos verdes de los tokens existentes y sangría de productos. Sin categoría conserva su carpeta al final. Sin cambios de API, permisos, datos ni operaciones comerciales.

## Evidencia

- RED: `pnpm --filter @uconext/web exec vitest run test/catalog-item-management.test.tsx test/catalog-read.test.tsx -t groups`: dos regresiones fallan por productos inicialmente visibles.
- GREEN: `pnpm --filter @uconext/web exec vitest run test/catalog-item-management.test.tsx test/catalog-read.test.tsx test/catalog-sort.test.ts test/catalog-stock.test.tsx`: 30/30, sin omisiones. Apertura, cierre, reinicio de carpetas, búsqueda, orden y categorías existentes.
- `pnpm lint`, `pnpm typecheck`: pasan en el monorepo. Detector impecable: sin hallazgos tras retirar borde lateral grueso; se conserva borde uniforme verde.
- Playwright CLI Chromium en Next dev, escenario `catalog-search.mjs`: carpetas inicialmente cerradas, apertura mediante Enter, Sin categoría y recorridos existentes de búsqueda/ajuste/mínimo. Controles de al menos 44 px y sin desbordes a 1440/390; cero violaciones axe en vista abierta a 1440/768/390 después de corregir el hover para mantener contraste durante la transición de fondo. Resultado `output/playwright/category-folders-result.log`; capturas `category-folders-closed-{1440,390}.png` y `catalog-{1440,768,390}.png`.

El escenario intercepta HTTP para presentación; no afirma garantías de persistencia. CSP de desarrollo conserva sus avisos previos sin modificaciones. No cierra suites globales ni gates SDD ajenos pendientes.
