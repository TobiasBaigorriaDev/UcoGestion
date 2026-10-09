# Offline POS — grupo 3 de 5 tareas

Grupo completo: T217, T218, T218A, T218B y T218C verificadas. Con los grupos documentados en `offline-pos-block-07-evidence.md` y `offline-pos-block-08-evidence.md` se completan las 15 tareas solicitadas. T219 y siguientes quedan fuera de este bloque.

## T217 — cierre excepcional

RED: import inexistente de `ExceptionalCashCloseService`; ruta HTTP inicialmente 404. GREEN: cierre/replay real, rechazo a CASHIER/cross-tenant, snapshot inmutable con `UNKNOWN`, caja liberada para un dispositivo reemplazante. Migración 0102 agrega el snapshot excepcional y constraints/trigger que impiden una transición final sin snapshot. `ExceptionalCashCloseService` integra preparación, locks, idempotencia y auditoría en la misma transacción; D01 y exposiciones/versiones se conservan.

## T218 — late data y revisión

RED: venta histórica válida rechazada con `OFFLINE_SALE_SESSION_INVALID` en una sesión excepcional; import inexistente del servicio de revisión. GREEN: importación de sobres sellados antes de la declaración, ACK duplicado/concurrencia, fallo del firmador de ACK con rollback completo y reintento exacto. El esperado conocido cambia de 10.00 a 30.00 y luego 50.00, mientras snapshot/status/completeness no cambian. Nuevas recuperaciones exigen otra revisión; un corte anterior no puede cubrir nuevas operaciones. Se rechaza CASHIER, cross-tenant y movimiento manual sobre la sesión final. Moneda bloqueada y versiones/exposiciones retenidas después de la reaparición.

Migraciones 0103/0104: fuentes y revisiones append-only, FKs compuestas y RLS default deny. `offline-sale-importer` utiliza el puerto público de cash para marcar/auditar `LATE_RECOVERED_OPERATIONS`; la proyección se recalcula dentro de la transacción de ingestión. Se conserva `UNKNOWN` aun después de revisión administrativa.

## T218A — apertura y movimientos

RED: lectura HTTP nueva devuelve 404; componente UI no existe. GREEN: ruta `/workspace/cash-sessions`, formularios React Hook Form/Zod, lectura TanStack Query y mutaciones por ApiClient/NestJS. `CashWorkspaceService` valida membresía y branch scope en la transacción RLS; CASHIER ve solo sus sesiones y EMPLOYEE no opera. Prueba con rol runtime PostgreSQL rechaza tenant ajeno y sucursal fuera de alcance.

El navegador solo opera con una clave privada local cuya prueba ECDSA coincide con la clave pública del dispositivo autorizado del servidor. No se aceptan IDs arbitrarios como vínculo del equipo. La reautorización y el PIN offline del futuro T220A no se implementan en esta tarea: sin dispositivo ya provisionado aparece un aviso y no hay mutaciones.

El reintento guarda exclusivamente clave aleatoria y hash SHA-256 por organización/usuario/dispositivo/acción; no guarda importe ni motivo. Rechaza cambiar el payload de una respuesta pendiente. Reload recupera el estado confirmado del servidor y reutiliza la clave de un intento desconocido. Errores 5xx/red/respuesta inválida retienen la clave; solo un rechazo definitivo permite un nuevo intento. Sesiones abiertas muestran caja, estado, dispositivo implícito del equipo, fecha, moneda e importes strings; otro dispositivo y sesiones no abiertas no permiten movimientos. Sin red la administración usa el boundary existente.

## T218B — cierre normal y revisión de diferencia

RED: faltaba el checkpoint local firmado, la consolidación local de un cierre final, los componentes y la paginación/vistas. También se reprodujo pérdida de respuesta de aborto seguida de reload: el intento anterior quedaba cacheado. GREEN: barrera durable bajo lease, drain de toda la cola, comparación de secuencia/hash aplicados en servidor, firma ECDSA real y clave por intento estable tras reload. Nuevo intento tras un aborto confirmado obtiene otra clave; la proyección autenticada enlaza el aborto al intento anterior sin reactivarlo. La liberación local ocurre antes de firmar el nuevo intento.

La UI retoma CLOSING desde servidor y presenta contado solo después de final-sync; usa Money/strings, exige motivo de diferencia y permite aborto idempotente. Cierre final puede consolidarse localmente tras respuesta perdida; se rechaza desbloquear otra sesión local. El historial tiene cursores estables, vistas activas/finalizadas/pendientes y revisión independiente o SELF_REVIEW con justificación. La revisión conserva montos y movimientos. RLS, scope y ownership aplican también al GET de checkpoint.

Pruebas: 25 verdes web/9 archivos (formularios, retries, matching de clave privada, checkpoint, lease, POS y sealer), seguidas de 9 verdes closing/offline-close incluyendo regresión de aborto tras reload. API 16 verdes/2 archivos PostgreSQL+Supertest antes de la última regresión y 15 foundation verdes después de ella, con nueva lectura de checkpoint, permisos y paginación. Lint/typecheck raíz de API/web verdes tras la última corrección. Chromium `cash-closing.mjs` verde: firma real, begin perdido/reload, aborto perdido/retry y reload, nueva clave, sync, contado, motivo, revisión, teclado, red/retorno, axe completo y sin overflow desktop1440/mobile390. `offline-close.mjs` vuelve verde: pendientes, dos pestañas, replay offline, reload y bytes preservados.

Detector manual closing/workspace exit0 sin findings. Revisión independiente completa disposition fix por dirección desactualizada; la única corrección fue Resolved y disposition ship al alcance documental señalado. Documenter preservó el sistema en `.impeccable/review/cash-close-system-preservation.md`, registró drift heredado y sidecar ausente sin modificarlos. No se atribuye a un fixture HTTP evidencia de atomicidad PostgreSQL ni se afirma whole-surface pass de un verdict puntual.

## T218C — conciliación, cierre excepcional y datos tardíos

RED: componente ausente; proyección pública no incluía dispositivo/UNKNOWN, snapshot excepcional ni corte de revisión tardía. GREEN: OWNER/ADMIN prepara la barrera/checkpoint desde el equipo asociado para CONFLICTED, obtiene el esperado actualizado antes del contado, registra motivo y confirma explícitamente sesiones separadas. Se confirma directamente CLOSED_CONFLICT_RESOLVED. No se fusionan sesiones, reasignan ventas ni crean compensaciones automáticas.

Dispositivo UNRECOVERABLE bloquea cierre normal. OWNER/ADMIN dentro de scope confirma cierre excepcional con motivo, contado opcional y reconocimiento explícito de incertidumbre permanente. Campo vacío se omite del comando y mantiene null; jamás se interpreta como cero. Una respuesta perdida conserva clave/payload y el replay recupera el mismo cierre.

La lectura RLS expone campos públicos explícitos del snapshot original, separado del esperado conocido actualizado. Presenta dispositivo/contacto, operaciones recibidas, motivo, contado/diferencia opcionales, UNKNOWN permanente, restricciones históricas y bloqueo de moneda. El marcador tardío muestra última secuencia, cantidad/fecha y revisión pendiente/revisada. Cada revisión se vincula al throughOperationId vigente; nuevos datos remueven la aceptación anterior y exigen otra revisión. Listado con filtro de sesión y vistas no concede acceso adicional: mantiene scope, ownership y organización dentro de la transacción.

Regresión adicional RED: declarar el dispositivo irrecuperable después de un cierre normal ocultaba el snapshot en la selección de interfaz. La interfaz excepcional se reserva a estados activos irrecuperables, CONFLICTED y el final excepcional; un CLOSED/CLOSED_CONFLICT_RESOLVED anterior conserva su snapshot y revisión normal.

GREEN posterior: nueve tests exceptional/closing/workspace, y rerun raíz de lint/typecheck/build web verdes. La corrección preserva los tres estados excepcionales capturados y no cambia tokens, markup ni textos de esas capturas. El documenter cotejó el dispatch final; el `ship` visual anterior conserva su alcance original sin derivar un nuevo whole-surface pass.

Chromium `cash-exceptional.mjs`: verde, tres estados a1440/390 con axe completo sin violaciones/desborde, confirmación explícita, teclado, counted opcional, pérdida/replay, reload, snapshot original versus actualizado, nuevo corte y pérdida/retorno de red. Detector único Ctarget `[]`, exit0. Revisión completa independiente `ship` sin material fixes a alcance T218C. Documenter verificó seis PNG y preservación del sistema en `.impeccable/review/cash-exceptional-system-preservation.md`; PRODUCT/DESIGN intactos y drift heredado documentado.

## Gate integrado final del tercer grupo

- `pnpm --filter @uconext/api test -- test/cash-foundation.integration.test.ts test/historical-ingestion.integration.test.ts test/cash-http.e2e.test.ts test/migrations.integration.test.ts --maxWorkers=1`: **31 verdes / 4 archivos**. PostgreSQL real; migrations desde vacío y replay, runtime RLS, permisos/scope, firmas, locks, concurrencia, rollback y respuestas HTTP reales. Se limita concurrencia de workers para evitar el cierre inesperado de un worker HTTP observado al correr dos suites PG en paralelo; una repetición aislada y el gate secuencial pasan.
- `pnpm --filter @uconext/web test -- test/cash-exceptional.test.tsx test/cash-closing.test.tsx test/cash-workspace.test.tsx test/cash-operations.test.tsx test/cash-command-retry.test.ts test/cash-device-binding.test.ts test/offline-close.test.ts test/offline-lease.test.ts test/offline-pos.test.ts test/offline-sealer.test.ts test/opaque-delivery.test.ts --maxWorkers=2`: **31 verdes / 11 archivos**. Lease, firma, sello/cola, dinero, grant que vence durante escritura, reintentos, estados y formularios.
- `pnpm --filter @uconext/web test -- test/offline-revocation.test.ts test/service-worker-update.test.ts --maxWorkers=2`: **4 verdes / 2 archivos**. Revocación, preservación de pendientes y migración/update.
- Chromium `cash-closing.mjs`, `cash-exceptional.mjs` y `offline-close.mjs`: verdes con los escenarios y límites indicados arriba. `offline-update.mjs` en perfil Chromium limpio: verde, bloquea activación hasta migrar, conserva bytes exactos tras reload y revierte formato desconocido. El fixture requiere worker en instalación: el primer intento sobre el perfil con SW ya instalado devolvió «No installing worker»; se ejecutó correctamente en perfil nuevo sin cambiar el test ni limpiar datos del usuario.
- `pnpm lint --filter=@uconext/web --filter=@uconext/api`, `pnpm typecheck --filter=@uconext/web --filter=@uconext/api`, `pnpm build --filter=@uconext/web --filter=@uconext/api`: **verdes**. Build incluye shared y ruta `/workspace/cash-sessions`; warning heredado Next middleware→proxy, sin modificarlo fuera de scope.
- `git diff --check`: verde. Sin nuevas dependencias, tests skip/todo ni excepciones constitucionales.
- Chromium `offline-sealing.mjs`: verde, offline, rollback, lock de memoria/logout, reload, identidad, dos pestañas, cierre de pestaña/crash y fencing; conserva secuencia y sobres exactos. Es regresión del sellador existente, no declara implementada la entrega automática tras logout de T219.

Garantías críticas verificadas: atomicidad (fallo de auditoría o firma ACK revierte ledger/sale/snapshot/estado/idempotencia); idempotencia durable y respuesta perdida; auditoría append-only en el mismo PoolClient/COMMIT; observabilidad Pino/trace/request ID y errores problem+json por infraestructura común; reintentos acotados de transacción y barrera/lease sin pérdida de cola. Cierre obsoleto tras aborto y carrera cierre versus venta/movimiento se rechazan o consolidan con resultado consistente. UNKNOWN, D01, versiones históricas y snapshot excepcional no se liberan por revisión ni recuperación.

## Comandos y resultados previos

- `pnpm --filter @uconext/api test test/cash-foundation.integration.test.ts test/historical-ingestion.integration.test.ts test/cash-http.e2e.test.ts`: 29 pruebas verdes antes de T218A.
- `pnpm --filter @uconext/api test test/cash-foundation.integration.test.ts`: 15 verdes después de agregar el caso de lectura RLS/branch/CASHIER.
- `pnpm --filter @uconext/api test test/cash-http.e2e.test.ts test/migrations.integration.test.ts`: 2 verdes, migración desde vacío y replay seguros.
- `pnpm --filter @uconext/web test test/cash-command-retry.test.ts test/cash-operations.test.tsx`: 4 verdes; formularios, pérdida de respuesta/reload, clave estable, cambio de payload, permisos, motivo, importes y axe en JSDOM (contraste se mide en Chromium). La revisión visual detectó un mensaje de Zod en inglés al exceder 2000 caracteres; regresión RED reproducida, mensaje español explícito y GREEN sin enviar al servidor.
- `pnpm --filter @uconext/web test test/cash-device-binding.test.ts`: 1 verde; firma real no exportable, clave pública ajena y revocación local/servidor.
- Playwright CLI `cash-operations.mjs`: verde; respuesta perdida y replay sin duplicar apertura, estado tras reload, vínculo del dispositivo, teclado/Enter, foco en error, axe completo desktop 1440/móvil 390 sin violaciones, sin desborde, pérdida/retorno de red.
- Capturas reales con CSS/reset y Plus Jakarta Sans provenientes del build Next existente; el fixture HTTP de navegador no prueba atomicidad. PostgreSQL real/Supertest verifican esa garantía separadamente.
- Detector `impeccable detect --json` de tres targets: `[]`. Revisión completa independiente: `fix` por mensaje de motivo excesivo; verdict pass: única corrección `resolved`, disposición `ship` a ese alcance. Cinco capturas (apertura/movimientos desktop/mobile y error móvil) verificadas. Documenter independiente creó `.impeccable/review/cash-system-preservation.md`, con límites y drift heredado sin canonizarlo. PRODUCT.md/DESIGN.md no se modifican.
- `pnpm lint --filter=@uconext/api --filter=@uconext/web` y `pnpm typecheck --filter=@uconext/api --filter=@uconext/web`: verdes. `git diff --check`: verde.

Cambios principales: migraciones 0102–0104; servicios de cierre excepcional/late recovery/review/lectura; controlador/módulo cash y puerto público; importer de ventas offline; frontend `cash-api`, `cash-operations`, `cash-workspace`, ruta y navegación; pruebas API/UI/navegador y fixture visual que usa el tema real de Next. Sin dependencias nuevas, excepciones constitucionales ni cambios funcionales aprobados.
