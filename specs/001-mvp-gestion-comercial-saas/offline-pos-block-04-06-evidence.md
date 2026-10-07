# Offline POS: tres grupos de cinco tareas pendientes

Se implementaron las primeras quince tareas pendientes de la sección 8, respetando su orden. Los cierres, conciliación, late data y las interfaces de tareas posteriores continúan pendientes.

| Grupo | Tareas | Implementación y evidencia |
| --- | --- | --- |
| 1 | T201B, T201, T202, T202A, T203 | Delivery restringido, certificado/header coherentes, ingestión histórica por sobre bajo TenantTransaction/RLS, resultados terminales persistidos, ACK mínimo ES256 y reintento de bytes exactos. Entrega automática al volver la red/foreground, evento manual y Service Worker sin sesión. Tests HTTP, históricos, ACK y navegador. |
| 2 | T204, T205, T206, T207, T208 | Checkpoints firmados e inmutables de revocación, bloqueo durable de lectura/creación y conservación de sobres previos; limpieza después del drenaje. Validación de precios, unidad, tipo, inventario, moneda, permisos y recursos usando la configuración histórica original. Tests de revocación, snapshots y PostgreSQL con catálogo actual modificado/desactivado. |
| 3 | T208A, T209, T210, T211, T212 | Barrera D01 durable entre pestañas/identidades, drenaje y renovación firmada; endpoints ordinarios con CSRF e idempotencia. Importación de ventas/pagos/recibos/caja/stock/auditoría indivisible. Incidencias OPEN, reapertura, faltante máximo, fuentes/correcciones, PENDING_REVIEW y resolución por OWNER/ADMIN con scope, nota e idempotencia. Tests PostgreSQL concurrentes, dos dispositivos, HTTP y navegador. |

## Archivos y decisiones

- `apps/api/src/modules/offline-sync/historical-delivery-ingestion.ts` compone validación histórica, orden/dependencias, importadores públicos de caja/ventas, auditoría y ACK en una misma transacción. Una firma ACK indisponible o inválida revierte también los efectos comerciales. El replay exige el hash del sobre original.
- `apps/api/src/modules/offline-sync/offline-ack.ts` y `packages/shared/src/offline-contracts.ts` definen el ACK mínimo: versión, operación, hash del sobre, estado y key ID. El navegador verifica la firma con claves fijadas por bootstrap, además del ID/hash esperado.
- `apps/web/src/offline/opaque-delivery.ts` realiza entrega sin cookies ni desbloqueo de identidad. `apps/web/public/offline-delivery-worker-v1.js` accede únicamente a sobres y capacidad pública de entrega; conserva el ACK junto al sobre. Foreground verifica de nuevo el ACK y elimina payload/sobre en una transacción IndexedDB.
- `offline-revocation.ts` conserva evidencia firmada del último sequence/head legítimo. El bloqueo durable impide desbloqueo/lectura/creación y sobrevive recargas; el dispositivo revocado conserva un tombstone después de limpiar sus claves. La revocación de membresía limpia solo esa identidad.
- `offline-configuration-barrier.ts` congela bajo lease/fencing, no libera la barrera con pendientes, firma checkpoints incluyendo exposiciones conocidas por servidor y solo reanuda tras instalar configuración nueva verificada. El servidor conserva referencias históricas comerciales: drenar sobres no libera historia.
- Ventas e inventario colaboran mediante `sales/index.ts` e `inventory/index.ts`. Los locks se adquieren en orden; stock negativo se limita al carril de ingestión offline validada. Las correcciones positivas enlazan movimientos de la misma transacción, sin resolver automáticamente la incidencia.
- Las ventas online nuevas también guardan el snapshot `track_inventory`; el valor histórico desconocido permanece `NULL` para filas anteriores.

## Migraciones y claves

Migraciones versionadas 0093–0097: resultados de entrega/ACK, checkpoints de revocación, snapshots de venta e incidencias, vinculación de correcciones y resolución autorizada. Incluyen RLS, relaciones compuestas por organización, restricciones históricas y funciones especializadas de stock. Se probaron con PostgreSQL 16 real y rol runtime no propietario, sin BYPASSRLS.

La custodia existente requiere `OFFLINE_SIGNING_KEY_ID`, `OFFLINE_SIGNING_PRIVATE_KEY` y `OFFLINE_INGESTION_KEYS`. Se agrega `OFFLINE_ACK_SIGNING_KEYS`, JSON `{ "key-id-anterior": "PEM privado ES256" }`, para retener claves históricas de ACK mientras existan exposiciones. No retirar claves referenciadas. Una clave faltante produce error recuperable y preserva sobres; no se generan claves efímeras de producción.

Aplicar las migraciones mediante el mecanismo versionado del repositorio antes de desplegar API nueva. No se realizó despliegue.

## Verificación ejecutada

Desde la raíz, con pnpm/Turborepo:

```sh
pnpm exec turbo run lint typecheck --filter=@uconext/api --filter=@uconext/web --filter=@uconext/shared
pnpm exec turbo run build --filter=@uconext/api --filter=@uconext/shared
pnpm exec turbo run test --filter=@uconext/shared
pnpm exec turbo run test --filter=@uconext/web
pnpm exec turbo run test --filter=@uconext/api -- migrations.integration.test.ts inventory-foundation.integration.test.ts sales-quote.integration.test.ts purchases.integration.test.ts cash-foundation.integration.test.ts historical-ingestion.integration.test.ts offline-ack.test.ts offline-envelope-order.test.ts historical-sale-snapshot.test.ts
pnpm exec turbo run test --filter=@uconext/api -- device-authorization-http.e2e.test.ts
pnpm exec turbo run test --filter=@uconext/api -- historical-envelope.test.ts offline-envelope-order.test.ts configuration-barrier.integration.test.ts
```

Resultados: lint/typecheck de los tres paquetes y build API/shared verdes; shared 9 archivos/19 tests; web completa 57 archivos/152 tests, seguida de regresión enfocada de 5 archivos/9 tests después de los últimos cambios; regresiones API de migraciones/inventario/ventas/compras/caja e ingestión 9 archivos/83 tests; HTTP real Nest 7 tests. Validación histórica/orden/barrera final: 3 archivos/12 tests. Bootstrap y barrera también pasaron en las comprobaciones de integración.

Se ejecutaron los callbacks de `apps/web/test/browser/{offline-pos,offline-expiry,offline-update,opaque-delivery,offline-barrier}.mjs` con Playwright y Chromium real, contexts independientes y el servidor Vite de `offline-update.vite.mjs`: 43 escenarios comprobados. Incluyen pérdida de red/respuesta, logout sin sesión, recarga, bytes exactos, ACK falsificado, ACK válido, Service Worker nativo, limpieza atómica, dos pestañas, freeze y revocación. Las claves y ACK del servidor de prueba son efímeros y exclusivos del harness.

Los callbacks usan IndexedDB y Web Crypto reales; el servidor de prueba controla fallos de transporte y firmas, no sustituye la garantía PostgreSQL, que se verifica en las integraciones API. Navegador probado: Chromium; no se afirma cobertura Safari/Firefox.

## Límites explícitos

Un sobre inválido que no permite reconstruir contexto histórico autenticado falla de manera recuperable; no recibe un ACK terminal inventado. Un rechazo histórico autenticado conserva resultado SECURITY_REJECTED estable, sin efectos comerciales. Dependencias aún ausentes permanecen pendientes sin ACK. El worker conserva sobres hasta que foreground verifica y limpia; Background Sync es opcional, no un requisito de corrección.

La UI detallada, logout completo, los cierres y los demás RF asignados a tareas posteriores no se dan por terminados por compartir primitivas con esta implementación.
