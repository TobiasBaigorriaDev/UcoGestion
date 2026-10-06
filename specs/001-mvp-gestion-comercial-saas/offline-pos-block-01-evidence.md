# Offline POS — bloque T186, T187, T192, T193 y T194

## Alcance y trazabilidad

| Tarea y RF | Implementación | Evidencia |
|---|---|---|
| T186 · RF-116, 123, 167, 168, 302, 303, 310, 315 | Bootstrap firmado, custodia, contratos shared y POST /api/v1/offline/bootstrap | Exposición previa, replay exacto, rotación, rollback, barrera, concurrencia, tenant/sucursal y HTTP/CSRF |
| T187 · RF-114, 119, 169, 172 | Grant firmado, POST /api/v1/offline/authorize y verificador web | Posesión de clave, sync completo, firma y scope, 72 h sin renovación por login/retry, falsificaciones |
| T192 · RF-114, 115, 116, 119 | OfflinePos.open, sealer y lease | Estado cifrado y envelope indivisibles, rollback, expiración durante commit, capabilities y competencia entre pestañas |
| T193 · RF-117, 118 | OfflinePos.catalog | Solo catálogo/configuración firmados conocidos; aislamiento y bloqueo tras logout |
| T194 · RF-117, 280 | OfflinePos.prepareSale | Borrador persistido cifrado exclusivamente consumidor final; rechazo de cliente sin escrituras |

T194 entrega el borrador local. Ítems/precios pertenecen a T195, descuentos a
T196 y confirmación, cobros, recibo y envelope de venta a T197. El borrador no
confirma la venta ni cambia stock/efectivo. T220 integrará la UI. La ingestión
de apertura y el cierre definitivo siguen en las tareas posteriores.

## Garantías y custodia

Bootstrap/grant usan TenantTransaction, RLS, autorización vigente, locks,
idempotencia persistente y auditoría en la misma transacción. Respuestas perdidas
recuperan bytes idénticos. D01 bloquea nuevas exposiciones; la reserva no habilita
crear operaciones. Grant exige prueba de posesión y sync consolidado. HTTP usa
Problem Details con códigos estables, traceId y respuestas no-store.

Apertura conserva estado, envelope y head en una transacción IndexedDB con
lease/fence, revalidación de autorización y expiración. Fallos no consumen
secuencia; la sesión abierta impide duplicados tras reload. El borrador se cifra
antes de la transacción y revalida identidad/grant antes y después de escribir;
no constituye una operación confirmada de la cola.

Producción requiere OFFLINE_SIGNING_PRIVATE_KEY (PEM EC P-256),
OFFLINE_SIGNING_KEY_ID y OFFLINE_INGESTION_KEYS (JSON con activeKeyId y keys,
mapa ID → privada PEM RSA). No hay claves efímeras como fallback. La publicación
ACK usa el signer ES256 y el navegador exige una clave de confianza provisionada
independientemente del documento recibido.

- 0087 concede UPDATE únicamente de branches.status para SHARE locks bajo RLS.
- 0088 incorpora inventario global inmutable de IDs/PEM públicos de ingestión,
  sin datos comerciales. Rechaza retirar o reemplazar claves históricas; la
  custodia conserva sus privadas. No aplica eliminación por TTL.
- 0089 incorpora autorizaciones tenant con RLS/triggers inmutables y protege
  el vencimiento posterior, fijado a 72 horas.

Shared declara Zod para contratos públicos runtime usando la versión existente
del repo. Web declara shared como workspace; se actualizó lockfile y ejecutó
pnpm install --frozen-lockfile. No se agregó proveedor ni package manager.

## TDD y gate

Los tests precedieron a bootstrap, grant/verificador, apertura y políticas. La
regresión final del borrador falló por ausencia de ID/registro y pasó con escritura
cifrada. Build detectó imports .js no resueltos por Turbopack: se ajustaron imports
locales TS offline a la convención sin extensión.

Comandos ejecutados:

```text
pnpm typecheck --filter=@uconext/api --filter=@uconext/web --filter=@uconext/shared
pnpm lint --filter=@uconext/api --filter=@uconext/web --filter=@uconext/shared
pnpm --filter @uconext/api test -- test/offline-bootstrap.integration.test.ts test/device-authorization-http.e2e.test.ts test/configuration-exposure.integration.test.ts test/configuration-barrier.integration.test.ts test/migrations.integration.test.ts test/sync-envelope-keys.test.ts
pnpm --filter @uconext/web test -- test/offline-authorization.test.ts test/offline-pos.test.ts test/offline-sealer.test.ts test/offline-lease.test.ts test/offline-database.test.ts test/offline-migration.test.ts test/offline-capability.test.ts test/offline-envelope.test.ts test/service-worker.test.ts test/service-worker-update.test.ts test/offline-keys.test.ts test/offline-record-cipher.test.ts
pnpm --filter @uconext/shared test
pnpm build --filter=@uconext/api --filter=@uconext/web
```

Verdes: API 6 archivos / 21 tests, web 12 / 28, shared 7 / 16. Tras persistir
el borrador se repitieron los 6 tests POS, typecheck, lint y build afectados.
PostgreSQL real/Testcontainers verifica migraciones, locks y RLS con rol runtime
no propietario. No hay skips ni mocks de repositorios para afirmar atomicidad.

Chrome/Playwright ejecutó test/browser/offline-pos.mjs con módulos de producción
y Service Worker real: apertura sin red, consumidor final, logout, retorno de red,
reload conservando bytes pendientes, duplicados y dos pestañas (una apertura).
Las claves/bootstrap del harness son fixtures; HTTP real se prueba por separado.
Esto no acredita aún Safari/Firefox, UI completa ni todos los escenarios de
ingestión, revocación remota y actualización PWA.

## Revisión y reversión

Unidades revisables: (1) contratos/bootstrap/custodia y 0087–0088 con PG/HTTP;
(2) grant, 0089 y verificador con tests; (3) apertura/catálogo/borrador y
sealer/lease con tests unitarios/browser. No se crearon commits ni PRs. Se
preservaron cambios previos. Migraciones persistidas requieren rollback que
conserve exposiciones/grants/claves; no borrar SQL o IndexedDB con cola pendiente.

Siguiente bloque físico: T195, T196, T197, T198 y T199. El objetivo general
permanece activo; sdd-check global se ejecutará al completar el plan.
