# T236K — autorización con membresías reales

Este seguimiento comprende únicamente RF-03, RF-21, RF-23, RF-29, RF-93, RF-116, RF-220 y RF-285. Conserva los cambios previos de T236J y no declara terminado T236 ni la revisión completa del MVP.

## Evidencia por requisito

La [suite PostgreSQL](../../apps/api/test/t236k-authorization.integration.test.ts) ejecuta casos de uso de producción con membresías OWNER/ADMIN/CASHIER/EMPLOYEE persistidas. Usa un login runtime miembro de `uco_app`, sin propiedad de tablas ni BYPASSRLS. Las denegaciones comparan documentos, proyecciones, ledgers, idempotencia, auditoría y outbox antes/después. Los recursos existen y los errores identifican la validación concreta; una respuesta 404 no se cuenta como autorización.

| RF | Resultado | Pruebas y límite de la conclusión |
|---|---|---|
| RF-03 | CUBIERTO | [Chromium con API y PostgreSQL reales](../../apps/api/test/organization-switch-browser.e2e.ts): selección OWNER → EMPLOYEE en otra organización; contexto/sucursal anterior retirados, clave anterior bloqueada, registro privado cifrado ilegible y segunda pestaña cerrada. Intentos con organización ajena, organización inactiva y membresía inactiva devuelven 403 y conservan la identidad válida. La cola opaca conserva sus bytes; este caso no demuestra entrega/ACK del sobre. Se conserva además la suite de descubrimiento de organizaciones. |
| RF-21 | PENDIENTE | 4 roles × 8 familias: alta de catálogo, cliente, proveedor, ajuste, mínimo, compra, gasto y apertura; además cotización POS y aumento de inventario. Roles del backend, scope retirado, tenant sin membresía y actor inactivo, con efecto cero al rechazar. No se cerró el inventario completo acción × rol: faltan filas explícitas para todos los comandos restantes, lecturas restringidas y rutas HTTP. |
| RF-23 | PENDIENTE | ADMIN: cambio de rol, estado/revocación, invitación/reenviar/revocar y alta/edición/desactivación de caja. Targets OWNER y scopes mixtos rechazados cuando la modificación es global; asignaciones locales con el mismo rol conservan sucursales ajenas. Invitaciones revalidan autorización en replay. Falta consolidar todas las operaciones administrativas/comerciales, incluyendo dispositivos y ajustes de organización, con la misma matriz. |
| RF-29 | PENDIENTE | Diez operaciones antes y después de una desactivación real: aumentos/disminuciones, transferencias en ambos sentidos, mínimo, compra, gasto, caja, dispositivo y apertura. Venta confirmada también rechaza sucursal inactiva con sesión preexistente. La desactivación conserva historial y las denegaciones no escriben efectos. Falta una enumeración exhaustiva que distinga cada operación nueva de compensaciones/historial y cubra todos sus contratos HTTP. |
| RF-93 | CUBIERTO | OWNER y ADMIN abren, depositan, retiran y cierran con checkpoint firmado, final-sync y caja real. ADMIN fuera de scope y tenant/actor ajeno se rechazan; OWNER accede a ambas sucursales de su organización. Retirar alcance o inactivar la membresía bloquea movimientos/cierre; EMPLOYEE se rechaza. Cierre permitido termina CLOSED con diferencia 0.00. |
| RF-116 | CUBIERTO | [Chromium integrado](../../apps/api/test/organization-switch-browser.e2e.ts): sin login previo, login sin dispositivo, dispositivo autorizado sin bootstrap, bootstrap sin sync y checkpoint incompleto no habilitan apertura local ni escriben registros/sobres. Bootstrap anónimo 401 y dispositivo desconocido 403; autorización incompleta 409. Login real + dispositivo + bootstrap + autorización firmada tras sync inicial válido habilitan una apertura offline y un sobre cifrado, sin sesión comercial creada en servidor. La suite PostgreSQL agrega los cuatro roles, actor/tenant ajeno, scope retirado, dispositivo revocado, sucursal y membresía inactivos. |
| RF-220 | CUBIERTO | ADMIN crea/edita cliente y proveedor globales; compra en sucursal asignada permitida. Con esos maestros, compra y venta sobre sucursal existente ajena a su alcance se rechazan sin efectos. EMPLOYEE, actor de otro tenant y ADMIN inactivo no editan los maestros. No se infiere autorización comercial de una autorización de maestro. |
| RF-285 | PENDIENTE | Ítem, proveedor, cliente y sucursal destino de tenant ajeno se rechazan en ajustes, compras, ventas y transferencias; contrapartes locales válidas pasan. Continúan las suites de RLS/FK. No se extrapolan esos casos a todas las relaciones: faltan asociaciones explícitas de categorías, membresías/invitaciones, cajas/dispositivos, grants/sync y documentos compensatorios en todos los endpoints. |

## Regresiones y correcciones

Cada cambio de producción responde a una prueba roja reproducible:

- RF-03: la clave y el estado de sucursal anterior permanecían habilitados. `auth-flow`, `identity-context` y `workspace` retiran identidades tras selección exitosa, borran la sucursal recordada y cancelan/limpian queries. La selección rechazada no retira el contexto vigente. El retiro entre pestañas sigue usando el mecanismo existente y conserva ciphertext/cola.
- RF-21: EMPLOYEE podía cotizar por el caso de uso público POS. Se valida OWNER/ADMIN/CASHIER en la misma transacción y se responde `SALE_QUOTE_FORBIDDEN` como 403 HTTP.
- RF-23: con un solo scope coincidente ADMIN podía cambiar globalmente rol/estado o revocar un usuario con otras sucursales; revocar/reenviar invitaciones tampoco exigía el alcance completo. Se exige contención completa para efectos globales. La suite existente detectó que editar solamente asignaciones locales sin cambiar rol debe seguir preservando el alcance ajeno; ese caso se conserva y los replays revalidan las asignaciones solicitadas.
- RF-29: una sucursal inactiva admitía mutaciones de caja. La validación de mutación exige ACTIVE y adquiere `FOR SHARE`; la lectura histórica sigue disponible.

No se agregaron dependencias ni migraciones en T236K. No se modificaron spec ni decisiones aprobadas del plan.

Los escenarios de navegador dejan [estado antes/después del cambio](../../output/playwright/t236k-switch-browser-result.json) y [cada prerrequisito offline](../../output/playwright/t236k-offline-prerequisites-result.json) como artefactos verificables.

## Verificación

Entorno Windows, pnpm, PostgreSQL 16 Testcontainers y Chromium real mediante Playwright CLI. Docker se selecciona solo para el comando con `DOCKER_HOST=npipe:////./pipe/docker_engine`.

- `pnpm lint`: cuatro tareas correctas sobre el estado final, [log](../../output/t236k-lint-closure.log).
- `pnpm typecheck`: cuatro tareas correctas sobre el estado final, [log](../../output/t236k-typecheck-closure.log).
- `pnpm --filter @uconext/web test -- auth-flow identity-branch-context workspace offline-identity offline-authorization offline-keys offline-pos offline-capability`: 14 archivos, 35 pruebas correctas, [log](../../output/t236k-web-related.log).
- `pnpm --filter @uconext/api exec vitest run --config vitest.authorization-browser.config.mts`: dos pruebas correctas, [log](../../output/t236k-browser-final.log).
- `pnpm --filter @uconext/api test -- t236k-authorization.integration.test.ts`: 71 pruebas correctas sobre el estado final (40 RF-21, 11 RF-23, 11 RF-29, 2 RF-93, 4 RF-116, 1 RF-220, 2 RF-285), [log](../../output/t236k-authorization-complete.log).
- Gate de veinte suites PostgreSQL/HTTP: primer intento terminó con 19 suites y 207 pruebas correctas, pero un worker salió inesperadamente; exit 1, [log](../../output/t236k-api-final-gate.log). No se cuenta como gate verde.
- `pnpm --filter @uconext/api test -- cash-foundation.integration.test.ts`: 15 pruebas de caja correctas en ejecución aislada, [log](../../output/t236k-cash-foundation-retry.log). Este resultado por sí solo no resuelve el error del worker del gate amplio.
- La repetición de veinte archivos también terminó con salida inesperada de un worker: 19 suites/201 pruebas aprobadas, exit 1, [log](../../output/t236k-api-verified.log). Estos intentos no se declaran verdes; la verificación final usa la misma selección en dos bloques consecutivos.
- Primer bloque detallado: 134 pruebas correctas y una fallida en el test existente T214B, [log](../../output/t236k-api-block1.log). El límite temporal mezclaba reloj de Windows y reloj de PostgreSQL y falló por 30 ms. El test mide ahora inicio/evento/fin mediante PostgreSQL y compara además el timestamp persistido con el resultado del servicio; conserva ambas cotas y no cambia producción.
- Bloque 1 repetido tras corregir el test: diez archivos, 135 pruebas correctas, exit 0, [log](../../output/t236k-api-block1-verified.log). Incluye las 71 nuevas y las suites de descubrimiento, membresías, invitaciones, sucursales, cajas, efectivo y cotización. Los comandos exactos constan al inicio de cada log.
- Bloque 2: diez archivos, 73 pruebas correctas, exit 0, [log](../../output/t236k-api-block2-verified.log). Incluye contratos HTTP de ventas/dispositivos, bootstrap, inventario, clientes, proveedores, base tenant y RLS. Resultado combinado: **20 suites y 208 pruebas correctas**, sin omitir archivos de la selección original. La causa de salida inesperada del worker en los intentos de veinte archivos juntos no se atribuye a un fallo de negocio ni se declara corregida.

Los logs de RED permanecen en `output/t236k-switch-red.log`, `output/t236k-browser-prerequisites-first.log`, `output/t236k-authorization-second.log`, `output/t236k-authorization-third.log` y `output/t236k-quote-red.log`. Los filtros usados para diagnosticar casos producen tests no seleccionados; no hay `.skip` incorporados. El gate amplio inicial y su repetición se cancelaron al quedar sin completar y no cuentan como verificación verde.

Atomicidad: snapshots completos iguales en rechazos. Idempotencia: aumento y reenvío/revocación validan replay y pérdida posterior de permisos. Auditoría/outbox: incluidos en snapshots para comprobar rollback. Observabilidad HTTP: errores de producción recorren el filtro problem+json y logging de AppModule en navegador/HTTP; no se añadió otro canal de error. Los reintentos de sobre y las compensaciones fuera de estos escenarios no se declaran cubiertos por T236K.

## Archivos de T236K

| Grupo | Archivos modificados o agregados |
|---|---|
| Autorización de usuarios | `apps/api/src/modules/users/{membership-administration,invitation-resend,invitation-revocation}.service.ts` |
| Sucursal inactiva | `apps/api/src/modules/branches/cash-register-management.service.ts` |
| Cotización POS | `apps/api/src/modules/sales/{sales-operations.service,sales-quote.service,sales.controller}.ts` |
| Retiro de organización | `apps/web/src/features/identity/{auth-flow.tsx,identity-context.ts,workspace.tsx}` y `apps/web/test/identity-branch-context.test.ts` |
| Pruebas reales | `apps/api/test/{t236k-authorization.integration.test.ts,organization-switch-browser.e2e.ts,cash-foundation.integration.test.ts}`, `apps/api/vitest.authorization-browser.config.mts` |
| Fixtures de navegador | `apps/web/test/browser/organization-switch.{html,tsx,mjs}`, `apps/web/test/browser/offline-prerequisites.{html,ts,mjs}` |
| Seguimiento | Este archivo, `t236-followup-matrix.md` (solo ocho RF y nota de delta), `tasks.md` (subtareas K1–K8) y logs T236K en `output/` |

Los cambios anteriores de catálogo, snapshots históricos, contratos compartidos, migración 0109 y documentación T236J no pertenecen a este delta y se preservaron.
