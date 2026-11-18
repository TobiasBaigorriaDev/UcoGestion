# T236Y — Edición de productos en cuestionario

Solicitud explícita del usuario, 2026-10-12. Refinamiento de presentación T236S sobre RF-40–RF-43, RF-145, RF-152–RF-154, RF-221–RF-222.

## Cambios

- `apps/web/src/features/catalog/catalog-item-management.tsx`: retira navegación de modos y botonera precio/estructura/desactivar/eliminar. Campos de datos, precio y estructura visibles simultáneamente; disponibilidad como select Activo/Inactivo con guardado. Disclosure de eliminación dentro del editor conserva confirmación y errores de historial/offline. No hay formularios HTML anidados.
- `catalog-item-management.module.css`: distribución vertical, apartados y foco en eliminación.
- `test/catalog-item-management.test.tsx`, `test/browser/catalog-search.mjs`, `test/browser/ui-critical.mjs`: expectativas y flujos adaptados, conservando cobertura de payloads, errores, confirmación y controles solo dentro del editor.
- DESIGN, plan y tasks documentan presentación. API, DB y contratos no cambian. Se guarda cada apartado mediante su operación versionada; no se afirma atomicidad conjunta ni se ejecutan escrituras comerciales encadenadas. Stock separado.

## Evidencia

- RED: nuevo test de campos simultáneos falla inicialmente porque «Cambiar precio» sigue como botón.
- GREEN: `pnpm --filter @uconext/web exec vitest run test/catalog-item-management.test.tsx test/catalog-read.test.tsx test/catalog-stock.test.tsx`, 28/28. Datos, precio, estado/estructura, borrado con confirmación, rechazo por historial e incertidumbre offline, búsqueda, selector de categoría, campos simultáneos y cierre del editor.
- `pnpm lint` y `pnpm typecheck`: 4/4 tareas cada uno.
- Playwright CLI con Next/API local real: lectura de producto existente y apertura del editor sin mutaciones. Campos de nombre/precio/tipo/unidad/estado simultáneos; ausencia de los cuatro botones; disclosure de eliminación por Enter, confirmación presente. 1440px/390px sin overflow y axe sin violaciones. Capturas inspeccionadas juntas en una ronda. `output/playwright/product-questionnaire-browser.log`: fieldsTogether/noActionNavigation/deletionKeyboard/axe=true.
- Capturas `output/playwright/product-questionnaire-{1440,390}.png`. No se guardó ni eliminó el producto real. Sesión temporal cerrada.

Versiones, idempotencia, autorización, auditoría, logs/trazas, transacciones y errores del backend conservados; no cambia reintentos ni aislamiento. Sin nuevas dependencias/migraciones. No se declara verde suite global ni gates ajenos.
