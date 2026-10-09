# Offline POS — primer grupo: T214A–T214E

La congelación durable por sesión en IndexedDB se serializa con el lease de sellado. Impide confirmar operaciones nuevas entre pestañas y reloads, conserva replays sellados y bytes pendientes ante fallos de drenaje. La cola del dispositivo debe estar vacía antes de avanzar.

El API expone `begin-close`, `final-sync`, `close` y `abort-close` en `/api/v1/cash-sessions`. El checkpoint firmado versión 1 liga organización, actor, dispositivo, sesión, secuencia/hash del dispositivo, secuencia de sesión, congelación y ausencia de pendientes. PostgreSQL comprueba continuidad y ACK definitivo persistido para cada operación. Locks: idempotencia → organización → caja → sesión. Intentos y transiciones son append-only; la última transición identifica el intento vigente.

`final-sync` recalcula el esperado desde apertura y ledger bajo lock. `close` exige intento y esperado vigentes, contado no negativo y motivo para diferencias; confirma transición, snapshot, revisión inicial, auditoría e idempotencia juntos. `abort-close` invalida el intento con una transición auditada a OPEN. Las sesiones finales no se reabren. HTTP utiliza los guards y observabilidad centrales, trace/request ID y errores problem+json.

## TDD y verificación

- RED T214A: barrera ausente; GREEN: IndexedDB/Web Crypto, preservación de bytes y replay.
- RED T214B: servicio ausente; GREEN: PostgreSQL real, firma falsa, EMPLOYEE, tenant ajeno y replay único.
- RED T214C/D/E: métodos ausentes antes de implementación; GREEN: final-sync, diferencia, cierre, aborto, intento antiguo y diferencia cero.
- RED HTTP: ruta ausente (404); GREEN: conflicto problem+json y 401 sin sesión.
- `pnpm --filter @uconext/api test test/cash-foundation.integration.test.ts test/historical-ingestion.integration.test.ts test/cash-http.e2e.test.ts`: **27 tests / 3 archivos verdes**, migraciones desde cero con Testcontainers/PostgreSQL 16 y rol runtime bajo RLS.
- `pnpm --filter @uconext/web test test/offline-close.test.ts test/offline-sealer.test.ts test/offline-sale-confirmation.test.ts test/offline-configuration-barrier.test.ts test/offline-migration.test.ts`: **19 tests / 5 archivos verdes**.
- `pnpm lint --filter=@uconext/api --filter=@uconext/web` y `pnpm typecheck --filter=@uconext/api --filter=@uconext/web`: **2 paquetes verdes en ambos gates**.
- Harness Chromium, Vite `127.0.0.1:4179`, `playwright-cli --session=offline-close run-code --filename apps/web/test/browser/offline-close.mjs`: **passed=true**, cola pendiente, dos pestañas, replay sin red, reload y conservación byte por byte.
- Trigger temporal de rechazo de auditoría: rollback del cierre/snapshot; reintento con la misma clave confirma una sola operación.
- Cadena real importada: rechaza hash/secuencias discordantes, acepta checkpoint aplicado y replay de un sobre previo en CLOSING.

## Límites y rollback

La UI/coordinación corresponde a T218B; revisión posterior, conciliación y cierre excepcional a los grupos siguientes. No se ejecutó sdd-check global ni se afirma cobertura Firefox/WebKit.

Unidad local: retirar `offline-close.ts`, prueba/harness, `closingSessions` y su chequeo de sellado. Unidad servidor: retirar `cash-close.service.ts`, rutas/proveedor, pruebas añadidas y migraciones 0098–0100 antes de aplicarlas. Si ya se aplicaron, preservar historia y usar una migración forward-only. Estos límites no incluyen código previo de ventas, delivery o D01.
