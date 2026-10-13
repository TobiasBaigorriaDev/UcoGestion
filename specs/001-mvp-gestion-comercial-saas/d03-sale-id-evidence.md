# D03 — ID de venta recuperable

Aprobación explícita del usuario: 2026-10-11, «apruebo», después de actualizar el spec cerrado y el plan aprobado. Alcance: RF-317–RF-323 y plan §22. La aprobación incluye conectar la superficie mínima del POS offline existente y entregar un comprobante local HTML imprimible/descargable; el PDF se obtiene online después de sincronizar.

## Resultado y decisiones

- Confirmación compartida online/offline: UUID completo seleccionable, copia por teclado, anuncio de resultado, alternativa manual y foco al confirmar. Cada nueva venta sustituye el ID anterior.
- El JSON de comprobante agrega `saleId` a partir de la fila autorizada, y el renderer lo incluye en HTML y PDF. Los snapshots históricos, respuestas idempotentes y sobres firmados permanecen intactos. No hay migraciones, nuevas dependencias ni numeración adicional.
- La UI offline usa el motor real, conectado mediante un puerto ligado a la identidad desbloqueada de `OfflineSetup`. Conserva apertura, borrador, cobro, resultado persistido, ID y comprobante local. La confirmación aparece después del commit dual; recuperar un comprobante no confirma una venta nueva.
- Los pendientes sobreviven a reload/reapertura. Un ACK definitivo elimina el payload local; la confirmación conserva su ID y ofrece las acciones online. El retiro de identidad elimina las vistas, URLs temporales y ventanas de impresión abiertas por la UI. Las descargas explícitas ya guardadas por la persona quedan bajo su control.
- La consulta explica el ID del comprobante no fiscal con `aria-describedby`, distingue la disponibilidad después de sincronizar y valida UUID antes de pedir datos al backend.
- La regresión HTTP detectó que CASHIER podía leer una venta con actor propio y propietario de sesión ajeno. Se exige actor y propietario de sesión propios en detalle y comprobante, además de las condiciones existentes de membresía, tenant y sucursal. Ningún ID enviado por el cliente prueba autorización.
- El comprobante local es HTML pasivo con texto escapado. El color literal `#111` detectado como advisory por Impeccable es intencional para el documento independiente imprimible; no modifica la paleta de la aplicación.

## TDD y verificación focalizada

Los logs están en `output/playwright/d03/` al cerrar el bloque. No se agregan tests saltados ni mocks de repositorios para acreditar garantías transaccionales.

| Unidad | RED | GREEN y evidencia |
| --- | --- | --- |
| T01 | ID ausente en confirmación y componente inexistente. | Confirmación, copia exacta por teclado, axe, portapapeles ausente/denegado, venta cero/consecutiva y respuesta incierta con el mismo ID/clave. 4 archivos, 8 tests en la ejecución conjunta previa al caso adicional de ID inválido. |
| T02 | HTML/PDF sin ID; prueba negativa de sesión ajena devuelve 200. | Renderer, HTTP y contratos: 3 archivos, 8 tests; PostgreSQL con rol runtime miembro de `uco_app`, Supertest, texto real de PDF descomprimido y snapshots anteriores inmutables. |
| T03 | Superficie offline ausente. | Motor/Dexie reales en nivel unitario; apertura, preparación, cobro, comprobante, remount, fallo de sellado y revocación. 4 archivos, 19 tests. |
| T04 | Ayuda no asociada al campo; falta notificación a vistas tras sync manual. | Consulta y notificación pasan; ingestión histórica: 15 tests con PostgreSQL real. Recorrido de navegador inicial completo acreditado con API runtime real, ID en impresión/descarga, recuperación y consulta. |
| T05 | Foco no transferido; ventana local no retirada; texto de ayuda distinto del literal aprobado. | Presentación: 12 tests; migración/revocación/replays: 6 tests; regresiones finales de consulta y fast-check: 4 tests. Se amplía el presupuesto de la propiedad criptográfica a 30 s manteniendo cinco secuencias de hasta seis replays y todas sus aserciones. |

La matriz de HTTP cubre detalle, JSON, HTML y PDF: OWNER/ADMIN/CASHIER permitidos, EMPLOYEE, ADMIN sin sucursal, otro tenant, sesión ajena de CASHIER, membresía revocada y ausencia de autenticación. Las negativas no entregan datos del comprobante.

La ingestión comprueba el mismo UUID en detalle/recibo después de conflictos de stock y configuración; conserva snapshots, referencia local, pagos, movimientos, auditoría y resultado de replay. Las pruebas existentes de rollback real y entrega concurrente se ejecutan junto a esas aserciones.

El fixture de navegador usa los componentes de producto y motores de almacenamiento/cifrado, y los conecta a NestJS/PostgreSQL reales. Los fixtures Vite ignoran descargas y artefactos para evitar recargas ajenas al flujo. La variante de pérdida de ACK entrega primero al servidor, descarta su respuesta y reintenta; debe comprobar dos ventas totales y dos eventos de confirmación, incluyendo la venta online inicial.

## Checks y límites

Los scripts raíz `pnpm lint`, `pnpm typecheck`, `pnpm test` y `pnpm build` se intentaron. Windows bloquea `turbo.exe` mediante Control de aplicaciones (`spawn UNKNOWN` y diagnóstico nativo explícito). No se modifica ni evade esa política. Se ejecutan los scripts existentes de cada paquete con `pnpm -r run ...` como verificación adicional; no se presenta esa ejecución como un éxito del launcher raíz.

| Comando | Resultado |
| --- | --- |
| `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` | Launcher raíz bloqueado por Windows Application Control; no se acredita éxito de Turbo. |
| `pnpm -r run lint` | Todos los paquetes pasan en la revisión final. |
| `pnpm -r run typecheck` | Todos los paquetes pasan en la revisión final. |
| `pnpm -r run build` | Todos los paquetes pasan; Next.js genera las rutas de producción. Advertencia existente de middleware. |
| `pnpm -r run test` | API: 122 archivos / 606 pruebas; shared: 9 / 21; UI: 3 / 8; Web: 79 / 230, recopilado antes de las últimas pruebas de T05. Todos pasan. |
| `pnpm --filter @uconext/web test` | Revisión final Web: 81 archivos / 237 pruebas, todas pasan, incluida la propiedad con su presupuesto de 30 s. |
| `node --test test/*.test.mjs` | 3 pruebas raíz pasan. |
| `pnpm test:e2e:critical` (Chromium) | 6 escenarios pasan. |
| `pnpm test:e2e:catalog` | Revisión final: 2 archivos / 3 pruebas pasan con NestJS/PostgreSQL reales; incluye el recorrido D03 completo y dos ventas / dos eventos de confirmación. |
| `pnpm test:e2e:nightly` (`BROWSER=chromium`) | 12 de 17 escenarios pasan; se detiene en `offline-settings`, esperando «Desbloquear mi identidad» sobre una página en blanco. El escenario aislado pasa dos veces; la corrida completa permanece fallida después de tres intentos. Los cuatro escenarios posteriores no se ejecutan en esa corrida. |
| `pnpm test:e2e:nightly` (`BROWSER=firefox`) | Dos intentos no logran iniciar el navegador; último diagnóstico `spawn UNKNOWN`. No se acredita cobertura Firefox. |
| `pnpm test:e2e:nightly` (`BROWSER=webkit`) | No logra iniciar: Windows Code Integrity rechaza `harfbuzz-icu.dll` por política Enterprise. No se altera la política. |
| `git diff --check` | Pasa. |

D03-T05 permanece pendiente por los launchers y motores impedidos. WebKit no acredita Safari real ni cierra T236 o los pendientes anteriores del MVP. El reporte `d03-sdd-check.md` distingue la cobertura funcional comprobada y estas puertas pendientes.

La causa del fallo Chromium aún no está demostrada: el módulo de fixture espera un iframe, inicialización IndexedDB y Service Worker antes de montar React. El diagnóstico no registra un error de página y el cuerpo queda vacío. No se presenta como fallo del flujo D03 ni como prueba aprobada. Se deja el bloqueo visible conforme a `sdd-build`: «If a task fails after three reasonable correction attempts: leave it pending; stop the block; report the failing test/error and likely cause».

## Archivos

- SDD: `spec.md`, `plan.md`, `tasks.md`, este documento.
- API: `sales-operations.service.ts`, `receipt-renderer.ts`; pruebas HTTP, ingestión histórica, PDF y archivos pasivos; `vitest.browser.config.mts` y nuevo `sale-id-browser.e2e.ts`.
- Web: confirmación compartida, comprobante local, POS offline, conexión de settings/workspace, estilos POS, consulta y validación de respuesta; puerto de acciones offline, lecturas autorizadas y controlador de setup.
- Pruebas Web: confirmación, ventas consecutivas, retry de checkout, consulta, POS/comprobante local, setup y propiedad de identidad. Browser: fixture/recorrido D03 y aserciones de recibo/ID en POS, expiración, migración y seguridad de impresión; ajustes de observación/diagnóstico de fixtures.

No se modifican las reglas de generación de ID, idempotencia, importación, ledgers, outbox ni auditoría comercial. La ampliación de superficie utiliza esos mecanismos existentes.

### Inventario exacto del cambio

- `apps/api/src/modules/sales/receipt-renderer.ts`
- `apps/api/src/modules/sales/sales-operations.service.ts`
- `apps/api/test/generated-files.test.ts`
- `apps/api/test/historical-ingestion.integration.test.ts`
- `apps/api/test/receipt-pdf-text.ts`
- `apps/api/test/receipt-renderer.test.ts`
- `apps/api/test/sale-id-browser.e2e.ts`
- `apps/api/test/sales-http.e2e.test.ts`
- `apps/api/vitest.browser.config.mts`
- `apps/web/src/features/offline/offline-pos-workspace.tsx`
- `apps/web/src/features/offline/offline-settings.tsx`
- `apps/web/src/features/offline/offline-workspace.tsx`
- `apps/web/src/features/sales/offline-receipt-actions.tsx`
- `apps/web/src/features/sales/pos-online.tsx`
- `apps/web/src/features/sales/pos.module.css`
- `apps/web/src/features/sales/sale-confirmation.tsx`
- `apps/web/src/features/sales/sale-lookup.tsx`
- `apps/web/src/features/sales/sales-api.ts`
- `apps/web/src/offline/offline-pos-actions.ts`
- `apps/web/src/offline/offline-pos.ts`
- `apps/web/src/offline/offline-setup.ts`
- `apps/web/test/browser/catalog-category.vite.mjs`
- `apps/web/test/browser/offline-expiry.mjs`
- `apps/web/test/browser/offline-pos.html`
- `apps/web/test/browser/offline-pos.mjs`
- `apps/web/test/browser/offline-settings.mjs`
- `apps/web/test/browser/offline-settings.tsx`
- `apps/web/test/browser/offline-update.html`
- `apps/web/test/browser/offline-update.vite.mjs`
- `apps/web/test/browser/receipt-safety.mjs`
- `apps/web/test/browser/sale-id.html`
- `apps/web/test/browser/sale-id.mjs`
- `apps/web/test/browser/sale-id.tsx`
- `apps/web/test/browser/sale-id.vite.mjs`
- `apps/web/test/offline-pos-workspace.test.tsx`
- `apps/web/test/offline-pos.fixture.ts`
- `apps/web/test/offline-receipt-actions.test.tsx`
- `apps/web/test/offline-sale-id.test.ts`
- `apps/web/test/offline-setup.test.ts`
- `apps/web/test/pos-checkout.test.tsx`
- `apps/web/test/pos-consecutive-sales.test.tsx`
- `apps/web/test/sale-confirmation.test.tsx`
- `apps/web/test/sale-lookup.test.tsx`
- `specs/001-mvp-gestion-comercial-saas/d03-sale-id-evidence.md`
- `specs/001-mvp-gestion-comercial-saas/plan.md`
- `specs/001-mvp-gestion-comercial-saas/spec.md`
- `specs/001-mvp-gestion-comercial-saas/tasks.md`
