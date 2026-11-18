# Evidencia de cuentas corrientes — 2026-10-13

## Entrega

Clientes muestra deuda y tope, con cuenta compartida entre sucursales y detalle limitado a la sucursal autorizada. OWNER/ADMIN modifica el tope con versión; personal autorizado cobra importes totales o parciales desde caja abierta y medios habilitados. Los cobros en efectivo generan movimientos de caja; los demás no. Reversas con motivo y anulaciones conservan historial compensatorio. POS admite fiado completo y pago parcial con diferencia a cuenta; el backend aplica el tope bajo lock incluso entre cajas de sucursales distintas.

La ampliación autorizada está en spec.md y plan.md. Se modificó RF-78 del MVP y su exclusión de crédito online, conservando offline fuera del alcance. Sin dependencias nuevas ni excepciones constitucionales.

## Archivos de esta entrega

- Migración 0113, journal y esquema Drizzle: accounts, entries, FKs tenant, RLS, proyección y triggers append-only.
- Customers: customer-account.service.ts, customer-accounts.controller.ts, index.ts, módulo y lecturas de customer-management.service.ts.
- Cash: customer-collection-movement.ts y export público.
- Sales: persistence, operations, controller, receipt renderer y settlement compartido.
- Web: panel/API/CSS de cuenta, listado Clientes y contexto workspace; checkout/reglas/API/confirmación/detalle de ventas.
- Tests propios de cuenta, migración desde 0112, cálculo/property-based, panel, checkout y escenario navegador; extensión de pruebas de comprobantes y snapshot OpenAPI con las cuatro rutas nuevas.
- ops/development/migrate-local-demo.mjs aplica migraciones versionadas exclusivamente a la base local nombrada, sin recrear datos.

Cambios anteriores del usuario en catálogo, reportes, cantidades y documentación permanecen preservados. No se crearon commits ni PRs que los mezclen. Se corrigieron dos fixtures previos de regresión: UUID válido al descargar PDF e ID corto esperado en confirmación offline.

## Evidencia automática

Logs locales bajo output/playwright/customer-accounts-*.log.

| Comando | Resultado |
|---|---|
| pnpm --filter @uconext/api test [11 archivos afectados: cuenta, ventas, cash, clientes y comprobantes] | 58 pruebas PASS |
| pnpm --filter @uconext/api test test/customer-account-migration.integration.test.ts test/customer-accounts.integration.test.ts test/receipt-renderer.test.ts --reporter=verbose | 17 pruebas PASS; PostgreSQL real y PDF decodificado |
| pnpm --filter @uconext/api test test/customer-accounts.integration.test.ts --reporter=dot | 12 pruebas PASS, incluidos guards cross-tenant/EMPLOYEE |
| pnpm --filter @uconext/web test --reporter=verbose | 90 archivos, 293 pruebas PASS |
| pnpm --filter @uconext/web test test/customer-account-panel.test.tsx test/account-checkout.test.tsx test/pos-checkout.test.tsx --reporter=dot | 3 archivos, 8 pruebas PASS después de los últimos ajustes de recuperación |
| pnpm --filter @uconext/api test --maxWorkers=2 --reporter=json --outputFile=../../output/playwright/customer-accounts-api-final.json | Suite completa: 126 archivos, 632 pruebas PASS; success=true, cero fallos y pendientes |
| pnpm --filter @uconext/api exec vitest run --config vitest.browser.config.mts test/sale-id-browser.e2e.ts --reporter=verbose | 3 pruebas PASS, sin filtros: ventas online/offline, consulta/anulación y cuenta corriente |
| pnpm build | 3 tareas PASS |
| pnpm lint / pnpm typecheck | PASS; ejecución final registrada en logs |

Regresiones adicionales RED/GREEN: pérdida de respuesta tras venta que consume crédito, luego refresco de saldo/cotización; el POS conserva payload completo y clave originales. Pérdida de respuesta de cobro total y refresco con deuda cero: permite recuperar el cobro original sin sobrecobrar. El reintento de un cambio de tope conserva también la versión original aunque la lectura se haya actualizado. Playwright reproduce el cargo confirmado con respuesta abortada, refresca crédito y recupera una sola venta.

Primera ejecución ampliada API (`pnpm --filter @uconext/api test --reporter=verbose`): 123 archivos y 624 casos PASS, snapshot OpenAPI desactualizado y dos cierres inesperados de workers. El snapshot se revisó y actualizó exclusivamente con cuatro rutas nuevas. Se identificaron los casos incompletos: sales-http.e2e.test.ts y los últimos tres de device-authorization-http.e2e.test.ts. Repeticiones aisladas sin filtros: sales-http + request-contracts 8 PASS; device-authorization-http 8 PASS. Finalmente se ejecutó toda la suite con el comando registrado en la tabla: 126 archivos/632 casos PASS, salida cero y sin errores de workers. Se conservan ambos logs; no se atribuye una causa a los cierres anteriores sin evidencia. El ajuste de concurrencia se pasó por CLI y no modifica la configuración del proyecto.

TDD: RED inicial por puerto de cuenta inexistente y por regla anterior de pago completo; GREEN con integración PostgreSQL y cálculo exacto. Pruebas nuevas de reversa sin efectivo y anulación parcial primero fallaron por preparación incorrecta del fixture: se corrigió para usar movimientos append-only y sesión explícita de reintegro. No se deshabilitaron tests. El escenario completo corrigió su aserción para medir efectivo en todas las cajas abiertas, ya que las pruebas previas crean otra caja válida. El reintento de respuesta perdida usa la misma clave y produce un único cobro.

La primera comprobación final de navegador detectó una carrera del escenario: el mensaje de recuperación ya estaba visible después del intento offline, antes de que terminara la siguiente solicitud interceptada. Se conservó el log customer-accounts-browser-full-final.log y se corrigió la sincronización esperando requestfailed de esa solicitud concreta; la ejecución posterior se registra en customer-accounts-browser-verified.log.

## Verificación visual

Skill impeccable: mundo existente de DESIGN.md conservado, detector sin hallazgos. Revisor independiente detectó superposición de Confirmar en móvil y código CASH visible: corregidos, recapturados y disposición final ship. Documenter: sin cambios al sistema visual; no hay assets nuevos.

Playwright contra NestJS/PostgreSQL con rol runtime real, 1280 y 390 px: sin overflow ni violaciones axe. Capturas .impeccable/review/account-pos-desktop.png, account-pos-mobile.png, customer-account-desktop.png y customer-account-mobile.png. Son evidencia, no assets de producto.

## Integridad y operación

- Atomicidad: fallo de auditoría revierte saldo, ledger, caja e idempotencia; stock insuficiente y reversa sin efectivo no dejan efectos parciales.
- Concurrencia: dos sesiones distintas serializan cargos/cobros sobre la misma cuenta y respetan saldo/tope global.
- Idempotencia: replay idéntico no duplica; payload distinto rechaza; se revalida autorización y se conservan claves ante respuestas inciertas.
- Auditoría: límites, cargos, cobros y compensaciones integran la transacción. Historial y documentos confirmados permanecen inmutables.
- Errores: problem+json y códigos estables con middleware de trazabilidad existente; errores accionables en UI.
- Observabilidad: middleware JSON existente registra request/trace/status; no se agregan payloads financieros ni secretos a logs.
- Migración: base vacía y anterior 0112 verificadas en PostgreSQL real. Demo local migrada y API reiniciada; clientes anteriores parten de deuda/tope cero, sin carga retroactiva ni cambios comerciales.

Online-only para crédito/cobros. No se alteran cola, sobres o grants offline. No hay intereses, anticipos ni deudas iniciales manuales. Para anular una compra cuyo cargo dejaría saldo negativo, se revierten primero los cobros necesarios. Cobros posteriores no aumentan ventas del dashboard.
