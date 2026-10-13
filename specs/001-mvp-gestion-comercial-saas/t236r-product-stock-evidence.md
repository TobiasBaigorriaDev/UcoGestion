# T236R — Stock y detalles dentro de Productos

Solicitud explícita del usuario del 2026-10-12. Alcance de presentación sobre RF-40–RF-43, RF-57–RF-62, RF-145, RF-152–RF-154 y RF-221; no modifica el spec funcional ni contratos de negocio.

## Cambio

- Lista inicial con nombre, precio y stock. Detalles y acciones se montan al abrir el producto con clic, Enter o Space.
- Stock deja de ser una pestaña. `/workspace/inventory` redirige a `/workspace/catalog`; los enlaces de retorno de ajustes/transferencias apuntan a Productos.
- `CatalogProductStockActions` reutiliza los formularios existentes de ajuste y mínimo en modo compacto. El ajuste conserva ingreso/egreso, cantidad y motivo; no reemplaza el saldo ni reescribe movimientos.
- OWNER/ADMIN conservan gestión de catálogo; EMPLOYEE conserva cambios de inventario autorizados; CASHIER solo consulta. Servicios, inactivos y stock ausente/error no ofrecen mutaciones.
- Formularios se desmontan al cerrar el detalle y cambiar organización/sucursal; IDs de campos de ajuste incluyen producto para permitir varios detalles abiertos.

## Archivos

`apps/web/src/features/catalog/{catalog-item-management.tsx,catalog-read.tsx,catalog-inventory-navigation.tsx,catalog-product-stock-actions.tsx,catalog-item-management.module.css}`, `apps/web/src/features/inventory/{inventory-adjustments.tsx,inventory-stock.tsx,inventory-transfers.tsx}`, `apps/web/src/features/identity/workspace.tsx`, `apps/web/app/workspace/inventory/page.tsx`; tests de catálogo, navegación y escenarios de navegador; DESIGN.md, plan.md y tasks.md.

## Verificación

- RED: `pnpm --filter @uconext/web test -- catalog-item-management.test.tsx catalog-inventory-navigation.test.tsx`: dos regresiones fallan (acciones visibles inicialmente y pestaña Stock presente).
- GREEN: `pnpm --filter @uconext/web test -- catalog-item-management.test.tsx catalog-inventory-navigation.test.tsx catalog-read.test.tsx inventory-stock.test.tsx inventory-adjustments.test.tsx`: 27/27 pruebas pasan.
- `pnpm lint`, `pnpm typecheck`, `pnpm build`: pasan. Build conserva el aviso previo de migración de middleware a proxy.
- Detector Impeccable sobre catálogo y CSS: sin hallazgos.
- Playwright CLI/Chromium sobre Next en producción: búsqueda por nombre/SKU/código, apertura por Enter, ausencia de Stock en navegación, ajustes y mínimos dentro del producto, edición, cero violaciones axe y cero desbordes a 1440, 768 y 390 px. API interceptada exclusivamente para esta comprobación de presentación; no acredita transacciones PostgreSQL. Resultado en `output/playwright/product-details-result.json`; capturas `catalog-*` y `managed-catalog-*`.
- Suite web completa iniciada como comprobación adicional y detenida tras fallos en `offline-pos-workspace.test.tsx` y `receipt-actions.test.tsx`; no se acredita como verde. La prueba aislada `offline-pos-workspace.test.tsx` reproduce una expectativa de UUID completo mientras la confirmación D05 existente muestra un código corto de 12 caracteres. Ningún archivo del motor/confirmación offline se modifica en T236R.

## Garantías y límites

Se reutilizan `confirmAdjustment` y `saveStockThreshold`, incluidos CSRF, Idempotency-Key y errores HTTP existentes. API, locks, atomicidad, auditoría y observabilidad permanecen en los casos de uso existentes. Los ajustes y mínimos usan decimales como strings y autorización backend por organización/sucursal; las pruebas existentes de los formularios conservan validación y rechazo por permisos. No hay migraciones ni cambios de datos. El escenario de navegador comprueba el payload del ajuste y la recarga del stock y mínimo, sin atribuir garantías de persistencia a fixtures.
