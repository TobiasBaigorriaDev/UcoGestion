# T236S — Acciones dentro de Editar y ajuste vertical

Solicitud explícita del 2026-10-12. Refinamiento de T236R [RF-46, RF-54–RF-63, RF-145, RF-152–RF-154, RF-160, RF-221].

## Resultado

El detalle ofrece Editar y Cambiar stock. Precio, estructura, estado y eliminación se muestran dentro de Editar; las operaciones conservan confirmación de eliminación, restricciones históricas y versiones. Cerrar Editar retira sus controles y errores. Cambiar stock es un botón con aria-expanded que abre el formulario existente de ajuste, siempre en una columna; mínimo de stock permanece debajo. Se elimina el alta duplicada de la ruta de ajustes, que pasa a ser Historial de ajustes y conserva compensaciones de RF-63.

## Archivos

- `apps/web/src/features/catalog/catalog-item-management.tsx`, `catalog-product-stock-actions.tsx`, `catalog-inventory-navigation.tsx`, `catalog-item-management.module.css`.
- `apps/web/src/features/inventory/inventory-adjustments.tsx`, `inventory-adjustments.module.css`; `apps/web/src/features/identity/workspace.tsx`.
- `apps/web/test/catalog-item-management.test.tsx`, `catalog-inventory-navigation.test.tsx`, `inventory-adjustments.test.tsx`; escenarios `catalog-search.mjs` y `ui-critical.mjs`.
- DESIGN.md, plan.md, tasks.md y esta evidencia.

## Verificación

- RED: `pnpm --filter @uconext/web test -- catalog-item-management.test.tsx`: regresión falla porque Cambiar precio aparece fuera de Editar.
- GREEN: `pnpm --filter @uconext/web test -- catalog-item-management.test.tsx catalog-inventory-navigation.test.tsx inventory-adjustments.test.tsx catalog-read.test.tsx inventory-stock.test.tsx`: 29/29 pruebas pasan. Incluye acciones ocultas/visibles, cierre del editor, historial sin alta y compensación.
- `pnpm lint`, `pnpm typecheck`, `pnpm build`: pasan. Build mantiene el aviso previo sobre middleware/proxy.
- Detector Impeccable sobre componentes/CSS cambiados: sin hallazgos.
- Playwright CLI con Chromium 154.0.8037.98 y Next en producción: búsqueda, Enter, acciones dentro de Editar, cambio de stock, payload del ajuste y mínimo, recarga, disposición vertical de todos los campos a 1440/390 px, sin desbordes ni violaciones axe en 1440/768/390 px. `output/playwright/product-actions-result.json` y capturas `product-adjustment-vertical-*`.
- Escenario ui-critical focalizado en catálogo e historial: 12 comprobaciones pasan entre 1440, 1024, 768 y 390 px, editor abierto y estados de formulario/error. `output/playwright/product-actions-critical-result.json`.

Los escenarios de presentación interceptan HTTP; no prueban persistencia/atomicidad PostgreSQL. Mutaciones, CSRF, idempotencia, auditoría, locks, observabilidad y reintentos siguen en las implementaciones existentes, sin cambios de API o datos. No se repite la suite web completa: los fallos ajenos en POS offline y comprobantes detectados en T236R siguen documentados allí; no se declara ese gate verde.
