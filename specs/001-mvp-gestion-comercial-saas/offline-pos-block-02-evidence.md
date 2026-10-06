# Offline POS — T195–T199

## Entrega y trazabilidad

| Tarea | RF | Implementación | Prueba |
|---|---|---|---|
| T195 | 123, 256 | offline-sale.ts y OfflinePos.prepareSale; confirmación recalcula desde bootstrap verificado | Ítem ausente/desactivado conocido, precio sin versión, overrides, unidades/precisión, property-based y nueva configuración firmada |
| T196 | 49, 281 | Descuento global FIXED/PERCENTAGE y evidencia de actor/rol/grant/configuración/permiso | OWNER/ADMIN autorizado, CASHIER y permiso falso rechazados, límites, 100 %, evidencia cifrada |
| T197 | 117, 267, 268 | OfflineSales.confirm, estado cifrado, pagos y sobre en la misma transacción | UUID global estable, referencia OFF-device-UUID conservada en replay, fallo de envelope, cambio de payload, efectivo/vuelto, cero, aislamiento, stock y cash projections |
| T198 | 130, 272 | occurredAt declarado y receivedAt null local; recordOfflineReceipt y migración 0090 | Persistencia/reload, reloj de dispositivo futuro no confundido con recepción, retry conserva tiempos, RLS, inmutabilidad y upgrade desde operaciones ACKED anteriores |
| T199 | 118 | Guard ApiClient, descargas CSV/recibos y OnlineOnlyBoundary en workspace | Rechazo sin invocar transporte, formulario/reporte ya cargado desaparecen al perder red, foco y accesibilidad |

El carrito persistido de T194 es preparación local, no un documento de venta ni
un nuevo estado de la máquina de ventas servidor. T197 crea directamente
CONFIRMED y guarda snapshots de ítems/precios, descuento, pagos, vuelto, actor,
scope, moneda, referencia y tiempo declarado. No permite editar una venta
confirmada. El resultado original se recupera tras respuesta incierta o reload;
el mismo UUID con otros pagos produce conflicto sin efectos.

## Garantías críticas

El UUID de preparación es también ID de venta y de operación sellada. La referencia
local completa incluye dispositivo y UUID; se persiste independiente de la
referencia definitiva, inicialmente null. No se genera otra identidad para retry.
En una sola transacción IndexedDB se añaden venta, operación cifrada, envelope,
secuencias y proyecciones de stock/efectivo. El efectivo esperado empieza en la
apertura y solo suma efectivo aplicado, no efectivo recibido antes del vuelto.

El lease/fence y la comparación de los bytes de sesión, cash y stock previos
rechazan preparación obsoleta antes del commit. Se revalida el grant y la identidad
antes/después de las escrituras. Un fallo no consume secuencia ni deja pagos o
proyecciones parciales; el retry conserva ID y referencia. El stock conocido no
puede quedar negativo localmente. El caso excepcional servidor por cambios
concurrentes pertenece a la ingestión histórica posterior.

El catálogo firmado solo contiene ítems activos. Un ítem eliminado del conocimiento
firmado posterior no se vende. La confirmación no confía en el precio o total del
carrito: recalcula desde la versión verificable y revalida descuento desde el grant
vigente. Las entradas estrictas no admiten objetos de cliente, precios ni recibos
proporcionados por el operador. Descuento/auditoría mínima viajan en el payload
firmado para validación posterior; no se registran secretos en logs.

La política administrativa es online-only: el workspace no monta contenido
administrativo cuando está offline y el cliente API rechaza antes de fetch. Las
descargas que usan fetch directamente comparten el guard. No se crea una cola de
mutaciones administrativas. Las operaciones POS ya selladas permanecen intactas.

## Tiempo y migración 0090

El cliente firma occurredAt y deja receivedAt null: no puede inventar una recepción
servidor. El primitivo interno recordOfflineReceipt recibe únicamente PoolClient
contextualizado y payload de recepción estricto; el trigger genera received_at
desde clock_timestamp() y protege ambos tiempos/created_at de modificación.
Reintentos idénticos recuperan el par original; timestamps distintos generan
conflicto. Los datos antiguos mantienen occurred_at null porque su declaración no
existía; received_at se conserva desde su created_at histórico.

La regresión de upgrade detectó el trigger de inmutabilidad de estado. La migración
suspende solo ese guard durante el backfill y lo habilita de nuevo dentro de la
transacción del migrador. PostgreSQL real verifica upgrade y estado ACKED intacto.
No se amplían privilegios UPDATE sobre timestamps ni se cambia RLS.

Este primitivo no concede autorización histórica por fecha. T200A/T200B validarán
firma, grant, configuración, cadena y revocación; T201/T209 conectarán recepción y
efectos comerciales. No se declara implementada todavía la sincronización HTTP
completa. El POS visible sigue pendiente de T220; hoy el workspace online se bloquea
sin red, mientras los casos de uso locales se verifican en el harness.

## Regresión de cálculo y dependencia

fast-check halló una pérdida de un centavo por doble redondeo con Decimal a 20
dígitos significativos: quantity 0.410 × precio 58043747049713873.89 daba
23797936290382688.30 en lugar de 23797936290382688.29. El test reproduce ese caso
exacto y una propiedad compara líneas/descuentos grandes con aritmética bigint.
Los cálculos compartidos usan ahora un clon privado Decimal con precisión 160 y
HALF_UP, suficiente para productos numeric(20) y descuentos acotados a 128
caracteres antes del redondeo persistido. No se cambia la configuración global.

Web declara fast-check 4.5.3 como devDependency, ya usado por shared, para invariantes
de cálculos offline. No entra en producción ni añade proveedor o peso al bundle.
Lockfile actualizado e instalación frozen-lockfile verificada.

## Comandos y resultados

```text
pnpm typecheck --filter=@uconext/api --filter=@uconext/web --filter=@uconext/shared
pnpm lint --filter=@uconext/api --filter=@uconext/web --filter=@uconext/shared
pnpm --filter @uconext/shared test
pnpm build --filter=@uconext/api --filter=@uconext/web
```

Gate web: 19 archivos / 55 tests verdes, más la prueba axe nueva (3 tests del
boundary verdes, total actual 56). Incluye offline-sale, offline-sale-confirmation,
offline-authorization, offline-pos, offline-sealer/lease/database/migration,
capability/envelope/keys/record-cipher, service-worker/update, api-client,
online-only-boundary, pos-payment-rules, reports-workspace y receipt-actions.
Después del ajuste Decimal se repitieron quote/confirmación (13 tests verdes).
Shared completo: 9 archivos / 19 tests verdes.

Gate API PostgreSQL real: offline-receipt-times.integration,
offline-bootstrap.integration, device-authorization-http.e2e,
configuration-exposure.integration, configuration-barrier.integration,
migrations.integration y sync-envelope-keys: 7 archivos / 24 tests verdes.
Tras el ajuste compartido se ejecutaron sales-quote.integration,
sales-price-acceptance y sales-http.e2e para verificar el consumo online del cálculo:
3 archivos / 15 tests verdes. Total de pruebas distintas del bloque y regresiones:
114. Lint, typecheck y build terminaron con exit code 0.

Chrome/Playwright:

```text
pnpm --filter @uconext/web exec vite --host 127.0.0.1 --port 4179 --strictPort --config test/browser/offline-update.vite.mjs ../..
npx --yes --package @playwright/cli playwright-cli -s=offline-block02 run-code --filename apps/web/test/browser/offline-pos.mjs
npx --yes --package @playwright/cli playwright-cli -s=offline-block02 run-code --filename apps/web/test/browser/offline-restrictions.mjs
```

Ambos harnesses pasaron: worker real, apertura/venta sin red, precios verificables,
fallo real de escritura IndexedDB con rollback y retry, pagos/vuelto, replay/reload
con bytes idénticos, logout, retorno de red y competencia de pestañas. Restricciones
probadas a 1280 y 390 px, foco en aviso, sin overflow y cero requests API/CSV.
Capturas en output/playwright/offline-restrictions-{1280,390}.png inspeccionadas.
El harness usa fixtures de firma/bootstrap y no reproduce la tipografía next/font
de producción; verifica lógica del componente y distribución responsive. No se
afirma cobertura completa de Safari/Firefox, UI POS ni ingestión final. El detector
impeccable de los archivos UI afectados devolvió []. Axe verifica semántica; JSDOM
no calcula contraste renderizado. No hay tests skip/todo ni repositorios mockeados
para acreditar transacciones o aislamiento.

## Revisión y rollback

Unidades revisables con sus tests: (1) precisión decimal y stock puro compartidos;
(2) cotización/permiso offline; (3) venta estable y persistencia dual; (4) proyecciones
con guard de concurrencia; (5) tiempos/0090 con upgrade PG; (6) restricciones
online-only y harness. Estas unidades separan el cambio grande para revisión sin
suprimir pruebas o comprimir código. No se crearon commits ni PRs.

Rollback de UI puede retirar boundary/guards y sus imports sin tocar registros.
Rollback de confirmación no debe eliminar ventas, sobres, secuencias o claves;
debe conservar capacidad de entregar pendientes. 0090 no se revierte borrando
SQL aplicado ni alterando timestamps históricos. Se preservaron cambios previos.

El siguiente bloque físico es T200, T200A, T200B, T201A y T201B. El objetivo general
permanece activo; sdd-check global queda para el cierre del plan.
