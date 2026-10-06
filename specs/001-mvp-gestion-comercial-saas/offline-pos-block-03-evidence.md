# Offline POS — bloque 03

Fecha: 2026-10-06. Bloque físico: T200, T200A, T200B, T213 y T201A. Se conserva T213 antes de T201A, como figura en `tasks.md`. El objetivo Offline POS sigue activo; T201B y las tareas siguientes permanecen pendientes.

## Implementación y trazabilidad

| Tarea | RF | Resultado verificado |
| --- | --- | --- |
| T200 | 119, 175 | El grant vencido impide apertura y confirmación nuevas; una marca cifrada durable evita reactivarlo después de reload/retroceso del reloj. Catálogo histórico y sobres pendientes se conservan. |
| T200A | 128, 129, 169, 172, 278 | Validación interna de routing duplicado, AES-GCM/AAD, RSA-OAEP, firma exterior e interior P1363, hash canónico, formato, JWT histórico, identidad/scope/configuración y corte de conocimiento por secuencia. La lectura histórica usa el cliente contextual bajo RLS. No reactiva dispositivo/actor ni aplica negocios. |
| T200B | 131, 175, 273–277 | Cadena global de dispositivo y cadena de sesión contiguas; apertura aplicada antes de ventas. Dependencia PENDING/SECURITY_REJECTED conserva el dependiente pendiente. Replay ligado a ID, payload y bytes exactos; discrepancia produce conflicto. Lock de dispositivo retenido por la transacción. |
| T213 | 124, 131, 132, 158, 292 | Puerto público de aplicación de caja importa el snapshot autorizado bajo lock del registro: OPEN compatible, CONFLICTED incompatible. Conserva la sesión previa. Resultado inicial idempotente, auditoría y recibo ACKED se confirman juntos, incluso con conflicto comercial. |
| T201A | 151, 312–314 | Dos handlers de entrega con excepción de sesión/CSRF limitada a esos métodos; origen, fetch-site y JSON siguen obligatorios. Certificado servidor, nonce JWS 120 s persistido y de un uso, prueba ECDSA sobre challenge/hash de bytes exactos del lote, límites persistentes y rechazo genérico sin detalles privados. |

## Decisiones locales y límites de etapa

- `0091_offline_envelope_order.sql` conserva filas anteriores sin inventar metadatos firmados. Una fila legada sin evidencia de sesión/envelope no prueba dependencias nuevas: espera, sin fabricar ACK. `offline_sync_sessions` representa la identidad del protocolo, con FK compuesta a dispositivo y referencias tenant en los recibos. Es distinta de `cash_sessions`: una apertura rechazada puede conservar evidencia sin crear una sesión comercial. Su identidad y los metadatos de envelope son inmutables.
- `0092_offline_delivery_challenges.sql` aplica RLS default deny y FK tenant a dispositivo; solo permite consumir `used_at` una vez. Los contadores de seguridad guardan HMAC de identidad/IP, no certificados o IP en claro.
- `readHistoricalEnvelopeContext` recibe evidencia de conocimiento del resolvedor servidor, nunca un DTO. T204 implementa su recolección/persistencia monotónica; una revocación actual no sustituye ese corte. Los validadores de este bloque son internos, sin ruta de aplicación comercial.
- Los contratos de venta offline pasan a `packages/shared/src/offline-operation-contracts.ts`; web y API usan el mismo formato. Quantity mantiene la representación canónica existente sin ceros decimales innecesarios; UNIT exige entero. La aritmética y aplicación histórica completas permanecen en sus tareas correspondientes.
- `OfflineCashOpeningImporter.apply` es un puerto interno al pipeline, expuesto por `cash/index.ts`, y exige una apertura históricamente validada en la misma transacción. No publica una ruta HTTP que permita saltarse el validador. El ACK del transporte se emite después del commit en T201/T202A.
- T201 compone `HistoricalDeliveryIngestionPort` con los validadores y efectos; T202A firma sus ACKs. Hasta entonces la implementación explícita `UnconfiguredHistoricalDeliveryIngestion` devuelve HTTP 503 recuperable después de consumir una prueba válida. No entrega datos ni inventa ACKs, y el cliente debe conservar los mismos sobres y obtener otro challenge para reintentar. Esto es el límite del incremento T201A, no una ingestión terminada.
- Límite: 50 envelopes, 2 MiB por envelope y 4 MiB de bytes del lote; parser JSON 5 MiB para el overhead de transporte. Se probó entrega mayor al límite antiguo de 100 KiB. Los límites persistentes aplican antes de validar/cifrar: 60 solicitudes/IP/min y 20 por certificado/IP/min; todos los rechazos de validación/límite usan la misma respuesta genérica.
- La limitación de reloj en una PWA comprometida de §19 sigue vigente. Firma/cadena no se presentan como prueba de hora absoluta. La marca local de expiración protege el flujo normal y su recuperación.

## TDD y verificación

RED constatado: expiración no durable tras retroceso del reloj; módulos de validación/orden/lector/entrega inexistentes; puerto de importación inexistente; cantidades malformadas aceptadas; payload modificado entre autenticación y autorización aceptado. GREEN después de cada incremento, sin tests skip/todo ni repositorios simulados para aislamiento/locks/atomicidad.

Gate de 115 tests distintos, todos verdes:

- API: 33 tests en 7 archivos del módulo/configuración; además 8 tests de cabeceras/HTTPS. PostgreSQL 16 real, migraciones, runtime `uco_app` no propietario, negativos cross-tenant, locks observados con `pg_blocking_pids`, dependencia fallida, metadatos inmutables, concurrencia de apertura y nonce, replay, timestamps y rollback. El test de apertura confirma recibos ACKED para OPEN y CONFLICTED en la misma transacción; el rechazo de seguridad conserva recibo sin crear caja comercial.
- Web: 55 tests en 18 archivos de offline/PWA/guards; cambios posteriores de formato revalidados con 20 tests de POS/venta/expiración. `fake-indexeddb` se usa solo para almacenamiento unitario.
- Shared: 19 tests en 9 archivos, con propiedades de dinero/cantidades/arithmetic.
- Chrome real mediante Playwright CLI: 8 escenarios de expiración, denegación de venta/apertura, bytes exactos, secuencia, reload, retroceso de reloj y catálogo histórico. Regresión adicional de 12 escenarios POS: Service Worker real, pérdida/retorno de red, pagos, rollback, logout, replay, reload y dos pestañas.
- `pnpm lint`, `pnpm typecheck`, `pnpm build` y `git diff --check`: verdes. Build conserva el aviso preexistente de Next sobre migración futura de middleware a proxy; sin errores de compilación.

Comandos principales:

```powershell
pnpm --filter @uconext/api test -- test/offline-bootstrap.integration.test.ts test/offline-receipt-times.integration.test.ts test/historical-envelope.test.ts test/offline-envelope-order.test.ts test/device-authorization-http.e2e.test.ts test/configuration-barrier.integration.test.ts test/sync-envelope-keys.test.ts
pnpm --filter @uconext/api test -- test/security-headers.test.ts
pnpm --filter @uconext/shared test
pnpm --filter @uconext/web test -- test/offline-authorization.test.ts test/offline-capability.test.ts test/offline-database.test.ts test/offline-envelope.test.ts test/offline-expiry.test.ts test/offline-keys.test.ts test/offline-lease.test.ts test/offline-migration.test.ts test/offline-pos.test.ts test/offline-record-cipher.test.ts test/offline-sale-confirmation.test.ts test/offline-sale.test.ts test/offline-sealer.test.ts test/service-worker-update.test.ts test/service-worker.test.ts test/online-only-boundary.test.tsx test/api-client.test.ts test/middleware-security-headers.test.ts
npx --yes @playwright/cli -s=offline-block03 run-code --filename apps/web/test/browser/offline-expiry.mjs
npx --yes @playwright/cli -s=offline-block03 run-code --filename apps/web/test/browser/offline-pos.mjs
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

El harness sirve los módulos de producción y el Service Worker real mediante Vite; no sustituye una prueba E2E del producto POS completo todavía pendiente en las tareas de integración. Chrome y Vite de esta verificación quedaron cerrados.

## Archivos y unidades de revisión

1. Expiración: `apps/web/src/offline/offline-authorization.ts`, `offline-pos.ts`, `offline-sales.ts`; test unitario `offline-expiry.test.ts` y harness/scripts `test/browser/offline-pos.html`, `offline-expiry.mjs`.
2. Contratos y autenticación: `packages/shared/src/offline-operation-contracts.ts`, `index.ts`, web `offline-sale.ts`; API `historical-envelope-validator.ts`, `historical-envelope-context.ts`, `sync-envelope-decryptor.ts`, `historical-envelope.test.ts` y casos de bootstrap real.
3. Orden/recibo: `offline-envelope-order.ts`, `sync-operation-receipt.ts`, migración 0091, esquema/journal y `offline-envelope-order.test.ts`, `offline-receipt-times.integration.test.ts`.
4. Apertura importada: `cash/offline-cash-opening-importer.ts`, `cash/index.ts` y casos T213 de `offline-bootstrap.integration.test.ts`.
5. Entrega: `offline-delivery.service.ts`, `offline-delivery.controller.ts`, `offline-sync.module.ts`, `auth/index.ts`, `configure-api.ts`, migración 0092/esquema/journal; tests HTTP y nonce runtime en los fixtures existentes.

Cada unidad conserva pruebas y evidencia con su código. Sin commits, PRs ni aplicación de migraciones a una base externa. La verificación global RF→implementación→test corresponde a `sdd-check` al completar el plan.
