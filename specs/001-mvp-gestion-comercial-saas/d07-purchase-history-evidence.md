# D07 — Historial y tendencias de compras

Solicitud del usuario: incorporar en Compras un historial con productos, día, hora e importe, junto con gráficos como en Ventas. Alcance RF-336–RF-340.

## Implementación

- `GET /api/v1/purchases`: lectura tenant contextualizada con rol OWNER/ADMIN, alcance efectivo por sucursal, snapshots históricos de proveedor/productos, estado derivado de pagos/anulaciones, fechas locales inclusivas y cursor acotado.
- `GET /api/v1/purchases/trends`: gasto neto y cantidad por hora o día, hasta 31 días; excluye compras anuladas y completa intervalos vacíos. Importes en strings decimales.
- Compras presenta historial, filtros de período/estado/sucursal, gráficos con tabla textual, selección del detalle y estados de carga/error/vacío. Confirmar, pagar o anular invalida historial y tendencias. EMPLOYEE conserva la recepción/consulta propia sin acceso al historial financiero.
- Sin migración ni cambio de mutaciones, ledgers, auditoría o idempotencia. Las lecturas siguen el manejo existente de Problem Details y trazas HTTP.

## RED → GREEN

1. `purchases-http.e2e.test.ts -t 'D07 lists'`: RED 404 al faltar `GET /purchases`; GREEN con PostgreSQL/Supertest. Verifica productos, importes, cursor, período local, anuladas excluidas, tenant, branch scope y rol.
2. `purchase-history.test.tsx`: RED por módulo ausente; GREEN con historial, gráficos, selección, preset semanal y axe.

## Verificación

| Comando | Resultado |
| --- | --- |
| `pnpm --filter @uconext/api test -- purchases-http.e2e.test.ts` | 7/7 pasan, PostgreSQL real |
| `pnpm --filter @uconext/api test -- request-contracts.test.ts` | 4/4 pasan; snapshot OpenAPI actualizado |
| `pnpm --filter @uconext/web test -- purchase-history.test.tsx purchase-lookup.test.tsx purchase-creation.test.tsx` | 7/7 pasan |
| `pnpm --filter @uconext/web test -- workspace-errors.test.tsx` | 2/2 pasan; Compras espera la zona horaria antes de montar filtros |
| `pnpm --filter @uconext/api exec vitest run --config vitest.browser.config.mts purchase-history-browser.e2e.ts` | Pasa con NestJS/PostgreSQL, Chromium, teclado, axe y anchos 390/768/1280 px |
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | Pasan |
| `impeccable detect --json` sobre UI modificada | Dos avisos preexistentes de tamaños literales en `pos.module.css`; ninguno en los componentes nuevos de Compras/gráfico compartido |

La prueba de navegador detectó un contenedor de gráfico desplazable sin foco en móvil. Se corrigió en el gráfico compartido con Ventas; la segunda pasada de navegador pasó. Capturas: `output/playwright/purchase-history-{390,768,1280}.png`.

## Invariantes

- **Aislamiento/autorización:** los endpoints usan `TenantTransaction.read`, RLS y predicados de membresía/rol/sucursal en cada lectura. Test negativo de segundo tenant, ADMIN fuera de scope y CASHIER.
- **Dinero/tiempo:** PostgreSQL suma `numeric` y API entrega strings; filtros y agrupación usan `organizations.timezone` sin modificar timestamps. Test del borde UTC → día local previo.
- **Historial:** proveedor, productos, costos y moneda se leen de snapshots persistidos. Las anuladas permanecen visibles y se excluyen de los netos.
- **Atomicidad/idempotencia/auditoría/reintentos:** D07 no agrega mutaciones ni modifica las rutas existentes. La invalidación de Query sucede tras éxito; las operaciones siguen sus transacciones y reintentos previos.

## Revisión del escenario local (12 de octubre de 2026)

El proceso API del escenario `output/mvp-demo` había arrancado a las 01:03, antes de compilar los endpoints de D07 a las 01:17. La ruta `GET /api/v1/purchases` devolvía 404 en ese proceso antiguo, aunque el código y las pruebas ya la incluían. Se recompiló la API y se reinició únicamente su proceso con la configuración local existente, sin recrear la base de datos. Con sesión válida, la misma URL de la incidencia y `/api/v1/purchases/trends` respondieron 200 en la aplicación real.

La inspección en escritorio encontró el botón de detalle extendido a 631 px y los formularios apilados a ancho completo. Una prueba de geometría en Chromium falló con esas medidas; después de ajustar la grilla, el botón mide 111 px y la creación/consulta quedan lado a lado a 1280 px. Otra regresión midió el formulario: costo unitario debajo de cantidad y motivo de anulación de 162 × 48 px. Se corrigieron la disposición de campos y el área de texto; la prueba de navegador volvió a pasar en 390/768/1280 px con axe. `pnpm --filter @uconext/web lint`, `typecheck` y `pnpm --filter @uconext/api build` pasaron. Captura del escenario real: `output/playwright/purchase-live-1440-fixed.png`.
