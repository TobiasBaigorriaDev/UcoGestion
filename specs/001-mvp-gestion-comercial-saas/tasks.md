## Tareas de construcción — MVP Gestión Comercial SaaS — ESTADO: LISTO PARA BUILD

Derivadas de spec.md cerrado y plan.md aprobado. Se ejecutan respetando el orden físico del listado y las dependencias explícitas. Pueden ejecutarse individualmente o agrupadas en bloques pequeños y coherentes cuando el usuario lo indique. Los IDs son estables y no determinan por sí solos el orden de ejecución.

Cada tarea mantiene TDD estricto: escribir primero la prueba automatizada, comprobar el estado rojo esperado, implementar el mínimo necesario y ejecutar la prueba nueva junto con las pruebas directamente afectadas. Una tarea se marca únicamente cuando su comportamiento requerido está implementado y sus pruebas relevantes están verdes.

No es obligatorio ejecutar toda la regresión, lint global ni typecheck global después de cada tarea. Al finalizar un bloque se ejecuta una única verificación integrada proporcional al alcance: tests de los módulos o paquetes modificados, lint y typecheck de los paquetes afectados, y las pruebas de integración, migraciones o E2E que correspondan. La suite completa del repositorio se reserva para CI, hitos explícitos y la puerta final previa a sdd-check.

Una tarea que prepara schema, política o componente interno no expone un endpoint incompleto. La exposición integra permisos, RLS, auditoría, atomicidad e idempotencia. Los rangos de IDs se expanden según la convención establecida para números y sufijos; la ejecución resultante respeta siempre el orden físico y las dependencias explícitas.

La definición de terminado de cada slice tenant incluye una prueba negativa cross-tenant y, si usa sucursal, una prueba entre sucursales. Cada comando crítico demuestra, cuando corresponda, rollback de auditoría/idempotencia/ledger/proyección junto con el negocio, replay idéntico, conflicto por payload distinto y comportamiento después de perder la respuesta. Ninguna tarea puede cerrarse con tests relevantes omitidos mediante skip, todo o equivalentes, ni con mocks de repositorios utilizados para afirmar aislamiento, atomicidad o concurrencia.

D01 y D02 resueltas: RF-302–RF-316 se implementan mediante exposiciones/barreras/versiones y entrega opaca cifrada. La presencia de un RF expresa trazabilidad prevista, no evidencia de implementación ni cobertura de pruebas.
## 1. Fundación

- [x] T001: Inicializar pnpm workspaces, Turborepo y scripts raíz con una prueba smoke del workspace [RF-151]
- [x] T002: Crear configuración TypeScript estricta, ESLint y Vitest compartida y verificarla sobre un paquete mínimo [RF-151]
- [x] T003: Crear el esqueleto NestJS con `/api/v1` y una prueba Supertest de arranque [RF-135, RF-151]
- [x] T004: Crear el esqueleto Next.js App Router con una prueba de render responsive del shell mínimo [RF-152]
- [x] T005: Configurar Testcontainers PostgreSQL y demostrar rollback real en una prueba de integración [RF-132]
- [x] T006: Configurar Compose de desarrollo para PostgreSQL y verificar readiness desde el API [RF-135]
- [x] T007: Agregar MinIO, Mailpit y OTel Collector al Compose con checks de configuración reproducibles [RF-134, RF-135]
- [x] T008: Definir contratos compartidos de UUID, timestamp UTC y decimal string con pruebas de validación [RF-43, RF-151, RF-271]
- [x] T009: Implementar Money canónico con decimal.js y redondeo HALF_UP mediante property tests [RF-43, RF-44]
- [x] T010: Implementar validadores monetarios de magnitud, escala y rangos mediante property tests [RF-246, RF-247, RF-248, RF-252, RF-253]
- [x] T011: Implementar Quantity para UNIT y unidades fraccionables mediante property tests [RF-41, RF-42, RF-244, RF-245]
- [x] T012: Implementar reglas puras de pagos, total cero y reversiones con signos positivos [RF-249, RF-250, RF-251]
- [x] T013: Definir el contrato application/problem+json y verificar serialización, fieldErrors y traceId [RF-133, RF-151]
- [x] T014: Configurar Drizzle, migraciones versionadas y prueba desde base vacía y versión anterior [RF-132, RF-151]
- [x] T015: Crear las tablas tenant base con organization_id, UUID, timestamptz y FKs compuestas [RF-02, RF-04, RF-285]
- [x] T016: Crear los roles DB separados uco_app/plataforma y probar ausencia de BYPASSRLS y ownership tenant [RF-02, RF-284]
- [x] T017: Implementar TenantTransaction con BEGIN, SET LOCAL y liberación segura del PoolClient [RF-04, RF-132]
- [x] T018: Aplicar RLS default-deny a las tablas base y probar acceso sin contexto y cross-tenant [RF-02, RF-04, RF-285]
- [x] T019: Implementar hash canónico e idempotency record ligado a actor, branch y clase de autorización; autorizar replay antes de devolver respuesta y detectar conflicto de payload [RF-02, RF-04, RF-131, RF-275, RF-276]
- [x] T020: Probar idempotencia concurrente con dos conexiones y una única confirmación, más negativos de replay por otro actor, branch, tenant o permiso revocado [RF-02, RF-04, RF-131, RF-132, RF-276, RF-285]
- [x] T021: Crear audit_events append-only con allowlist y trigger defensivo de UPDATE/DELETE [RF-140, RF-141]
- [x] T022: Hacer obligatoria la auditoría dentro de TenantTransaction y probar rollback conjunto [RF-140, RF-283]
- [x] T023: Implementar dispatcher global de outbox con función segura de privilegio mínimo y ejecutar cada job tenant en una TenantTransaction reautorizada; probar SKIP LOCKED, lease, backoff, dead-letter y job_key [RF-132, RF-140, RF-151]
- [x] T024: Configurar Pino JSON con request/trace IDs y pruebas de redacción de secretos [RF-134, RF-141]
- [x] T025: Exponer health live/ready, métricas base y trazas OTLP con pruebas de disponibilidad [RF-135, RF-136]
- [x] T026: Agregar pipe Zod, paginación por cursor, límites, filtros allowlist y snapshot OpenAPI [RF-133, RF-151]
- [x] T027: Implementar If-Match/version para CRUD y respuesta Problem Details de conflicto [RF-133, RF-151]
- [x] T028: Configurar CSP con nonce, cabeceras defensivas y HTTPS obligatorio en web/API [RF-151, RF-154]
- [x] T234: Configurar CI desde fundación: lint/typecheck/tests/migraciones/build y E2E existentes; incorporar cada suite al crearse, sin skips ni placeholders verdes. Programar ejecución ampliada offline al disponer del flujo [RF-132, RF-135, RF-151, RF-289] (Depende de T001–T028)

## 2. Identidad y tenancy

- [x] T029: Crear users globales con email normalizado único y password hash versionado Argon2id [RF-10, RF-12]
- [x] T030: Implementar login no enumerable con sesión opaca y hash SHA-256 del token [RF-10, RF-12]
- [x] T031: Emitir cookie __Host-uco_session con atributos seguros y probar que nunca expone el token persistido [RF-12, RF-151]
- [x] T032: Aplicar expiración idle/absoluta y rehash transparente en autenticación [RF-10, RF-12]
- [x] T033: Revalidar usuario y membresía en cada request protegido e invalidar acceso revocado [RF-04, RF-19]
- [x] T034: Implementar logout y revocación de sesiones sin eliminar historial [RF-19]
- [x] T035: Implementar CSRF synchronizer, Origin, Sec-Fetch-Site y JSON estricto para mutaciones [RF-151]
- [x] T036: Implementar rate limit PostgreSQL no enumerable para login, reset e invitaciones y configurar el límite general de API en el borde [RF-11, RF-13, RF-151]
- [x] T037: Crear solicitud de reset con token hasheado, vencimiento y outbox email [RF-11, RF-12]
- [x] T038: Consumir reset una sola vez, cambiar password e invalidar sesiones aplicables [RF-11, RF-12, RF-19]
- [x] T039: Preparar el pool/rol restringido y el contrato interno de provisioning sin exponer todavía la mutación [RF-284]
- [x] T040: Exponer provisioning asistido que cree atómicamente organización argentina en ARS, primera sucursal, primer OWNER y auditoría; probar rollback total [RF-01, RF-05, RF-178, RF-284] (Depende de T039)
- [x] T041: Implementar recuperación OWNER excepcional explícita, mínima y auditada [RF-183, RF-284]
- [x] T042: Descubrir con acceso global mínimo las membresías del usuario autenticado y seleccionar organización activa solo entre las vigentes, sin permitir enumeración tenant [RF-03, RF-04]
- [x] T043: Implementar perfil organizacional editable por OWNER/ADMIN sin campos estructurales [RF-08]
- [x] T044: Cambiar timezone por OWNER conservando timestamps históricos absolutos [RF-09, RF-271]
- [x] T045: Preparar política interna de cambio de moneda solo para OWNER sin historial, sin exponer aún la mutación [RF-07, RF-205]
- [x] T046: Definir y probar el predicado de historial servidor que bloquea moneda desde la primera referencia, incluso anulada o revertida [RF-06, RF-206]
- [x] T047: Preparar la política interna de membresía no propietaria con rol fijo y branch scope validado, sin endpoint de alta directa; T051/T052 serán las únicas vías ordinarias de activación [RF-21, RF-23, RF-184]
- [x] T048: Proyectar permisos OWNER sobre todas las sucursales sin asignaciones redundantes [RF-21, RF-22]
- [x] T049: Aplicar políticas CASHIER y EMPLOYEE con pruebas negativas de campos y capacidades [RF-24, RF-25]
- [x] T050: Crear invitación hasheada con rol, sucursales, vencimiento y outbox email [RF-13, RF-16]
- [x] T051: Aceptar invitación de cuenta existente sin duplicar usuario ni membresía [RF-14]
- [x] T052: Aceptar invitación de cuenta nueva exigiendo contraseña segura [RF-15]
- [x] T053: Revocar invitación pendiente e impedir su consumo posterior [RF-17]
- [x] T054: Expirar invitación a los siete días e impedir el uso del token [RF-293]
- [x] T055: Reenviar invitación invalidando token previo sin duplicar membresía [RF-294]
- [x] T056: Impedir a no-OWNER crear, promover, degradar o revocar un OWNER [RF-18, RF-180]
- [x] T057: Activar un OWNER invitado únicamente después de aceptar [RF-179]
- [x] T058: Rechazar concurrentemente toda mutación que deje una organización activa sin OWNER [RF-178, RF-181]
- [x] T059: Permitir modificar otro OWNER solo si queda al menos uno activo [RF-182]
- [x] T060: Limitar la gestión ADMIN a miembros no propietarios y branches dentro de su alcance [RF-18, RF-184]
- [x] T061: Revocar membresía guardando momento efectivo y conocimiento por dispositivo [RF-19, RF-20]
- [x] T062: Crear sucursal con nombre normalizado único dentro del tenant [RF-27, RF-266]
- [x] T063: Implementar modelo de estado de sucursal e impedir nuevas operaciones sobre una sucursal inactiva, sin exponer aún el comando de desactivación [RF-29]

## 3. Maestros y shell

- [x] T064: Crear y renombrar cajas con nombre normalizado único por sucursal [RF-30, RF-266]
- [x] T065: Desactivar caja conservando historial e impedir nuevas aperturas [RF-31]
- [x] T066: Activar/desactivar los cinco medios de pago por OWNER/ADMIN [RF-113]
- [x] T067: Crear categorías de catálogo tenant opcionales para los ítems [RF-50, RF-51]
- [x] T068: Crear categorías de gasto tenant separadas y exigir estado activo al seleccionarlas [RF-50, RF-52]
- [x] T069: Preparar lifecycle de categorías y predicado de referencias servidor y exposición offline; no exponer borrado físico hasta integrar la barrera D01 [RF-53, RF-54, RF-55, RF-302, RF-306]
- [x] T070: Crear ítem PRODUCT con identificador interno y nombre obligatorio [RF-32, RF-35]
- [x] T071: Crear ítem SERVICE rechazando trackInventory [RF-32, RF-34]
- [x] T072: Configurar trackInventory opcional en PRODUCT respetando la unidad [RF-33, RF-41, RF-42]
- [x] T073: Normalizar y reservar SKU opcional único entre registros activos e inactivos [RF-36, RF-265]
- [x] T074: Normalizar y reservar barcode opcional único entre registros activos e inactivos [RF-36, RF-265]
- [x] T075: Crear y probar el componente de captura de barcode como entrada de teclado, sin depender todavía del flujo de confirmación POS [RF-38, RF-153]
- [x] T076: Mostrar advertencia de nombres similares sin bloquear el alta [RF-37]
- [x] T077: Cambiar precio vigente conservando versiones y precios históricos [RF-46]
- [x] T077A: Crear versiones firmadas, exposiciones por dispositivo/grant/época y recursos con FKs tenant; impedir purga de versiones con historia o incertidumbre [RF-167, RF-169, RF-170, RF-302, RF-304, RF-307]
- [x] T077C: Implementar predicados internos de historial/incertidumbre por recurso y bloqueo permanente de moneda al declarar irrecuperable con posible historial desconocido; probar que reaparición/revocación/expiración no lo levantan [RF-302, RF-304, RF-305, RF-306] (Depende de T077A)
- [x] T077D: Implementar contrato servidor de barrera por época y checkpoint: verificar ACKs/continuidad, cerrar autorizaciones antiguas y coordinar locks con lifecycle/grants; probar múltiples dispositivos, checkpoint obsoleto y carreras en PostgreSQL [RF-131, RF-132, RF-302, RF-303] (Depende de T077A y T077C)
- [x] T077B: Exponer cambio de moneda por OWNER solo sin historia ni incertidumbre offline y sin bloqueo permanente, coordinado con primera operación y emisión de grants; auditoría/idempotencia atómicas [RF-06, RF-07, RF-131, RF-132, RF-205, RF-206, RF-302, RF-303, RF-305] (Depende de T045–T046, T077A, T077C y T077D)
- [x] T078: Desactivar ítem con historia e impedir uso nuevo sin alterar snapshots [RF-55, RF-56]
- [x] T079: Preparar borrado físico de ítems/maestros solo sin referencias ni exposiciones offline relevantes; probar autorización y rechazo ante incertidumbre [RF-54, RF-55, RF-302, RF-304, RF-306] (Depende de T077C y T077D)
- [x] T080: Preparar cambio de type, trackInventory y baseUnit solo sin historia ni incertidumbre y con combinación válida; revalidar barrera/versiones bajo lock [RF-159, RF-160, RF-302, RF-303, RF-306] (Depende de T077C y T077D)
- [x] T081: Permitir desactivación conservando referencias/versiones; para cambiar semántica bloqueada, usar otro ítem sin reasignar historia ni liberar incertidumbre del anterior [RF-159, RF-161, RF-304, RF-306]
- [x] T081A: Exponer lifecycle de categorías/ítems con permisos, barrera D01, locks, auditoría e idempotencia; probar rollback y carrera con primera referencia [RF-53, RF-54, RF-55, RF-56, RF-131, RF-132, RF-159, RF-160, RF-161, RF-302, RF-303, RF-306] (Depende de T069 y T077A–T081)
- [x] T082: Crear cliente con solo nombre y tax ID normalizado opcional único [RF-68, RF-69, RF-265]
- [x] T083: Permitir CRUD/estado de clientes a OWNER/ADMIN y borrado solo sin historia [RF-211, RF-214, RF-219, RF-220]
- [x] T084: Limitar edición de clientes de CASHIER a campos permitidos y denegar EMPLOYEE [RF-212, RF-213]
- [x] T085: Crear proveedor con solo nombre y tax ID normalizado opcional único [RF-70, RF-71, RF-265]
- [x] T086: Permitir CRUD/estado de proveedores a OWNER/ADMIN y borrado solo sin historia [RF-215, RF-218, RF-219, RF-220]
- [x] T087: Dar lectura de proveedores a EMPLOYEE en recepción y denegar CASHIER [RF-216, RF-217]
- [ ] T088: Materializar tokens, tipografía y regla cromática UcoNext en packages/ui [RF-152, RF-154]
- [ ] T089: Crear primitivas accesibles con foco, teclado, labels y contraste sobre glass [RF-153, RF-154]
- [ ] T090: Implementar fallback de blur y preferencias de movimiento/transparencia reducidos [RF-152, RF-154]
- [ ] T091: Crear shell mobile-first y navegación contextual organización/sucursal [RF-03, RF-152, RF-153]
- [ ] T092: Implementar cliente REST común con Problem Details y resumen accesible de errores [RF-133, RF-154]
- [ ] T092A: Implementar UI de login y selector/cambio de organización con estados accesibles [RF-03, RF-10, RF-133, RF-152, RF-153, RF-154] (Depende de T038, T042 y T088–T092)
- [ ] T092F: Implementar UI de recuperación y aceptación/reenvío de invitación con estados accesibles y respuestas no enumerables [RF-11, RF-13, RF-14, RF-15, RF-16, RF-17, RF-133, RF-152, RF-153, RF-154, RF-293, RF-294] (Depende de T041, T043–T053 y T088–T092)
- [ ] T092B: Implementar UI de perfil comercial y timezone con permisos y concurrencia optimista [RF-08, RF-09, RF-133, RF-152, RF-153, RF-154] (Depende de T060 y T088–T092)
- [ ] T092D: Implementar UI de usuarios, invitaciones y roles con restricciones OWNER/ADMIN y concurrencia optimista [RF-13, RF-17, RF-18, RF-21, RF-22, RF-23, RF-24, RF-25, RF-133, RF-152, RF-153, RF-154, RF-178, RF-184] (Depende de T043–T060 y T088–T092)
- [ ] T092E: Implementar UI de sucursales con alta, alcance y navegación contextual; posponer desactivación completa hasta T221A [RF-27, RF-133, RF-152, RF-153, RF-154, RF-184] (Depende de T061–T063 y T088–T092)
- [ ] T092C: Implementar onboarding asistido de plataforma para organización, primera sucursal y OWNER, con confirmación de resultado o rollback sin exponer acceso tenant ordinario [RF-01, RF-05, RF-133, RF-152, RF-153, RF-154, RF-284] (Depende de T040 y T088–T092)
- [ ] T093: Implementar catálogo de solo lectura para CASHIER/EMPLOYEE sin costos ni márgenes [RF-222, RF-224, RF-226]
- [ ] T094: Permitir a EMPLOYEE ver ítems inactivos solo en contexto histórico autorizado [RF-223]
- [ ] T095: Implementar UI de categorías de catálogo para OWNER/ADMIN con alta, estados, activación y borrado; explicar bloqueos D01 [RF-50, RF-51, RF-53, RF-54, RF-55, RF-152, RF-153, RF-154, RF-221, RF-306, RF-308] (Depende de T069, T081A y T088–T092)
- [ ] T095E: Implementar UI separada de categorías de gasto con selección activa y estados accesibles [RF-50, RF-52, RF-53, RF-54, RF-55, RF-152, RF-153, RF-154] (Depende de T069 y T088–T092)
- [ ] T095A: Implementar UI de listado, alta y edición no estructural de ítems, incluidos tipo inicial, inventario, unidad, códigos, duplicados y precio [RF-32, RF-33, RF-34, RF-35, RF-36, RF-37, RF-41, RF-42, RF-46, RF-152, RF-153, RF-154, RF-221] (Depende de T067–T078 y T088–T092)
- [ ] T095F: Implementar UI de activación, desactivación, borrado y cambio estructural de ítems con motivos D01 diferenciados [RF-54, RF-55, RF-56, RF-133, RF-152, RF-153, RF-154, RF-159, RF-160, RF-161, RF-221, RF-306, RF-308] (Depende de T079–T081A y T095A)
- [ ] T095B: Implementar UI de clientes por rol con campos permitidos, alta, consulta, edición y estados [RF-68, RF-69, RF-211, RF-212, RF-213, RF-214, RF-220] (Depende de T082, T084–T092)
- [ ] T095G: Implementar UI de proveedores por rol con campos permitidos, alta, consulta, edición, estados y borrado sin historia [RF-70, RF-71, RF-215, RF-216, RF-217, RF-218, RF-219, RF-220] (Depende de T083–T092)
- [ ] T095C: Implementar UI de cajas con alcance, alta, renombre, desactivación y confirmaciones accesibles [RF-30, RF-31, RF-93, RF-152, RF-153, RF-154] (Depende de T064–T065 y T088–T092)
- [ ] T095H: Implementar UI de medios de pago con alcance, activación/desactivación y confirmaciones accesibles [RF-93, RF-113, RF-152, RF-153, RF-154] (Depende de T066 y T088–T092)
- [ ] T095D: Implementar UI de moneda OWNER con concurrencia optimista y motivos distintos de historial, incertidumbre y bloqueo permanente por dispositivo irrecuperable [RF-06, RF-07, RF-133, RF-152, RF-153, RF-154, RF-205, RF-206, RF-305, RF-308] (Depende de T077B y T088–T092)

## 4. Inventario

- [ ] T096: Crear branch_stocks tenant con cantidad decimal y prohibir edición fuera del servicio de inventario [RF-39, RF-163]
- [ ] T097: Crear inventory_movements append-only con unicidad `(source_type, source_id, source_line_id, effect_kind)` y trigger defensivo; probar efectos TRANSFER_OUT/TRANSFER_IN válidos y duplicados rechazados [RF-62, RF-63, RF-66, RF-163]
- [ ] T098: Inicializar en cero un producto inventariable en todas las sucursales sin movimiento [RF-39]
- [ ] T099: Inicializar en cero los productos inventariables al crear una sucursal [RF-162]
- [ ] T100: Implementar internamente el ajuste INCREASE con metadatos, observación y movimiento atómico, sin exponer aún el comando [RF-40, RF-60, RF-62, RF-245]
- [ ] T101: Implementar internamente el ajuste DECREASE con lock y rechazo íntegro de stock negativo, sin exponer aún el comando [RF-60, RF-61, RF-62, RF-245]
- [ ] T102: Autorizar motivos de ajuste de OWNER/ADMIN dentro de branch scope [RF-190]
- [ ] T103: Autorizar motivos EMPLOYEE y rechazar INVENTARIO_INICIAL [RF-191, RF-192]
- [ ] T104: Rechazar cualquier ajuste iniciado por CASHIER [RF-193]
- [ ] T105: Corregir ajuste confirmado solo mediante ajuste compensatorio enlazado [RF-63]
- [ ] T105A: Exponer ajustes positivos, negativos y compensatorios con permisos por rol/motivo, RLS, branch scope, auditoría e idempotencia en la misma unidad transaccional [RF-40, RF-60, RF-61, RF-62, RF-63, RF-131, RF-132, RF-140, RF-190, RF-191, RF-192, RF-193] (Depende de T100–T105)
- [ ] T106: Crear umbral opcional por producto/sucursal y calcular stock bajo [RF-57, RF-58, RF-59]
- [ ] T107: Aplicar permisos de edición y consulta de umbral/stock por rol y branch scope [RF-227, RF-228, RF-229]
- [ ] T108: Preparar contrato y política de transferencia entre sucursales activas distintas del mismo tenant y scope, sin exponer aún el comando [RF-64, RF-285]
- [ ] T109: Reunir origen/destino y bloquear todo el conjunto por `(branch_id, item_id)` sin agrupar por dirección; rechazar falta en cualquier línea [RF-65, RF-164, RF-165]
- [ ] T110: Exponer transferencia confirmando cabecera, líneas, efectos TRANSFER_OUT/TRANSFER_IN, proyección, auditoría e idempotencia en una transacción indivisible [RF-64, RF-65, RF-66, RF-131, RF-132, RF-140, RF-166, RF-285] (Depende de T097 y T108–T109)
- [ ] T111: Corregir transferencia únicamente con una transferencia compensatoria [RF-67]
- [ ] T112: Reintentar deadlocks de inventario de forma acotada conservando idempotency key [RF-131, RF-164]
- [ ] T113: Probar dos operaciones concurrentes sobre el mismo stock y transferencias A→B/B→A sin saldo negativo, parciales ni deadlock por orden inverso [RF-164, RF-165, RF-166]
- [ ] T114: Implementar verificador ledger/proyección que solo alerta divergencias [RF-62, RF-134]
- [ ] T114A: Implementar UI de consulta de stock, mínimos y alertas por sucursal y rol [RF-57, RF-58, RF-59, RF-152, RF-153, RF-154, RF-227, RF-228, RF-229] (Depende de T106–T107 y T088–T092)
- [ ] T114B: Implementar UI de ajustes y compensaciones con motivos/permisos, validación decimal y errores de stock [RF-40, RF-60, RF-61, RF-63, RF-133, RF-152, RF-153, RF-154, RF-190, RF-191, RF-192, RF-193] (Depende de T100–T107 y T088–T092)
- [ ] T114C: Implementar UI de transferencias con origen/destino, líneas, scope y compensación posterior [RF-64, RF-65, RF-67, RF-133, RF-152, RF-153, RF-154] (Depende de T108–T111 y T088–T092)

## 5. Caja y ventas online

- [ ] T115: Crear devices y autorización mínima para dispositivo operativo online [RF-127, RF-230]
- [ ] T116: Crear cash_sessions con origin, transiciones append-only e índice parcial para una sesión normal OPEN/CLOSING; toda apertura bloquea cash_register y también rechaza CONFLICTED, sin impedir conservar aperturas offline separadas conflictivas [RF-92, RF-124, RF-290, RF-291, RF-292]
- [ ] T117: Crear cash_movements append-only y expected_cash transaccional [RF-97, RF-99]
- [ ] T118: Preparar apertura online con monto no negativo, actor, caja, branch y dispositivo, sin exponer aún el comando [RF-91, RF-230, RF-253]
- [ ] T119: Aplicar scope y permisos de apertura de OWNER/ADMIN/CASHIER y rechazo EMPLOYEE [RF-93, RF-94, RF-95]
- [ ] T120: Rechazar operaciones desde un dispositivo distinto al asociado a la sesión [RF-231, RF-232]
- [ ] T121: Conservar dispositivo y registrar actor real cuando cambia el usuario autorizado [RF-233]
- [ ] T121A: Exponer apertura online integrando lock de caja, unicidad, scope, rol, dispositivo, auditoría e idempotencia; probar aperturas concurrentes [RF-91, RF-92, RF-93, RF-94, RF-95, RF-131, RF-132, RF-140, RF-230, RF-232, RF-253] (Depende de T116 y T118–T121)
- [ ] T122: Exponer ingreso manual positivo con motivo, sesión/dispositivo bajo lock, permisos, auditoría e idempotencia atómicas [RF-93, RF-94, RF-95, RF-96, RF-131, RF-132, RF-140, RF-231, RF-252]
- [ ] T123: Exponer retiro manual con sesión/dispositivo bajo lock, permisos, auditoría e idempotencia y rechazo íntegro por efectivo insuficiente [RF-93, RF-94, RF-95, RF-96, RF-131, RF-132, RF-140, RF-231, RF-242, RF-243, RF-252]
- [ ] T124: Calcular efectivo esperado desde movimientos consolidados del servidor [RF-97]
- [ ] T132: Calcular quote backend con líneas HALF_UP y cantidades válidas [RF-43, RF-44, RF-45, RF-244, RF-254]
- [ ] T133: Validar descuento global porcentual o fijo y permisos OWNER/ADMIN [RF-47, RF-48, RF-49, RF-247, RF-248]
- [ ] T134: Definir contrato PRICE_CHANGED que rechace la confirmación, devuelva cotización segura y exija aceptación explícita con una nueva clave antes de reintentar [RF-254, RF-255]
- [ ] T135: Preparar persistencia interna de venta confirmada sin borrador con ID global y snapshots de ítems, moneda, organización, sucursal y cliente, sin exponer aún el comando [RF-72, RF-205, RF-267, RF-269, RF-270]
- [ ] T136: Asociar cliente activo opcional o consumidor final sin cliente ficticio [RF-77, RF-214]
- [ ] T137: Validar sesión abierta, branch y dispositivo al confirmar venta [RF-73, RF-230, RF-231]
- [ ] T138: Aplicar permisos OWNER/ADMIN/CASHIER y rechazar EMPLOYEE en venta [RF-74, RF-194, RF-195, RF-196, RF-197]
- [ ] T139: Conservar actor y titular distintos sin transferir la sesión [RF-198]
- [ ] T140: Bloquear stock canónicamente y rechazar venta online sin disponibilidad [RF-75, RF-164, RF-165, RF-166]
- [ ] T141: Omitir validación y movimientos para ítems sin control de inventario [RF-76]
- [ ] T142: Validar pagos positivos habilitados cuya suma exacta cubra una venta mayor a cero [RF-78, RF-113, RF-249]
- [ ] T143: Calcular recibido y vuelto efectivo sin alterar total ni efecto neto de caja [RF-79]
- [ ] T144: Confirmar venta total cero sin línea de pago pero con sesión, stock y permisos [RF-250, RF-295]
- [ ] T145: Exponer confirmación de venta integrando precio aceptado, sesión/dispositivo, permisos, cliente, pagos, stock, caja, recibo, auditoría e idempotencia en una transacción [RF-72, RF-73, RF-74, RF-75, RF-76, RF-77, RF-78, RF-79, RF-80, RF-81, RF-131, RF-132, RF-194, RF-195, RF-196, RF-197, RF-198, RF-249, RF-250, RF-254, RF-255, RF-267, RF-269, RF-270, RF-283, RF-295] (Depende de T132–T144)
- [ ] T146: Probar que el receipt snapshot y la etiqueta no fiscal permanecen reproducibles tras cambiar maestros o anular la venta [RF-80, RF-81, RF-84, RF-270]
- [ ] T147: Renderizar vista imprimible y PDF regenerable sin afectar la venta ante fallos [RF-82, RF-83]
- [ ] T148: Preparar política interna de anulación solo para OWNER/ADMIN y motivo inmutable [RF-26, RF-84, RF-85]
- [ ] T149: Preparar reversión interna de inventario mediante movimientos compensatorios trazables [RF-86, RF-251]
- [ ] T150: Preparar reintegros por medios históricos originales aunque estén inactivos [RF-87, RF-89, RF-251, RF-260]
- [ ] T151: Preparar validación bajo lock de sesión, dispositivo y efectivo disponible para reintegro efectivo [RF-88, RF-90, RF-242, RF-243]
- [ ] T152: Exponer anulación confirmando estado append-only, reintegros, stock, caja, auditoría e idempotencia atómicamente [RF-26, RF-84, RF-85, RF-86, RF-87, RF-88, RF-89, RF-90, RF-131, RF-132, RF-140, RF-251, RF-260] (Depende de T148–T151)
- [ ] T152A: Implementar carrito POS online con búsqueda/barcode, cantidades, precios vigentes y estados accesibles [RF-38, RF-72, RF-133, RF-152, RF-153, RF-154, RF-244, RF-254] (Depende de T075, T093 y T132–T136)
- [ ] T152C: Implementar checkout POS con descuento autorizado, pagos mixtos, vuelto, total cero y aceptación explícita de PRICE_CHANGED [RF-47, RF-48, RF-49, RF-72, RF-78, RF-79, RF-133, RF-152, RF-153, RF-154, RF-249, RF-250, RF-254, RF-255, RF-295] (Depende de T137–T145 y T152A)
- [ ] T152B: Implementar UI de consulta y anulación de venta con motivo, permisos y errores accionables [RF-26, RF-84, RF-85, RF-133, RF-152, RF-153, RF-154] (Depende de T148–T152 y T088–T092)
- [ ] T152D: Implementar recibo imprimible/PDF y recuperación de fallos de impresión sin acoplarlo a confirmación [RF-80, RF-81, RF-82, RF-83, RF-133, RF-152, RF-153, RF-154] (Depende de T146–T147 y T152B)

## 6. Compras y gastos

- [ ] T153: Preparar persistencia interna de compra PENDING_PAYMENT con proveedor activo, branch, líneas y snapshots, sin exponer aún el comando [RF-100, RF-102, RF-218, RF-269]
- [ ] T154: Autorizar compra PENDING_PAYMENT a OWNER/ADMIN según scope [RF-185, RF-186]
- [ ] T155: Permitir recepción EMPLOYEE como PENDING_PAYMENT sin efectos financieros [RF-187, RF-225]
- [ ] T156: Rechazar toda operación de compras iniciada por CASHIER [RF-188]
- [ ] T157: Exponer confirmación PENDING_PAYMENT integrando permisos, snapshots, stock/ledger, auditoría e idempotencia en una transacción [RF-100, RF-101, RF-102, RF-131, RF-132, RF-140, RF-185, RF-186, RF-187, RF-188, RF-225, RF-269] (Depende de T153–T156)
- [ ] T158: Preparar confirmación PAID para OWNER/ADMIN con pago y stock atómicos, sin exponer aún el comando [RF-185, RF-186, RF-189]
- [ ] T159: Preparar caso de total cero PAID sin crear un pago de importe cero [RF-246, RF-257]
- [ ] T160: Preparar pago de PENDING_PAYMENT con un único pago positivo exactamente igual al saldo y transición append-only [RF-103, RF-258]
- [ ] T161: Exigir sesión/dispositivo bajo lock y registrar salida atómica al pagar compra en efectivo [RF-104, RF-230, RF-231, RF-242, RF-243]
- [ ] T162: Pagar compra por medio no efectivo sin requerir ni modificar caja [RF-105]
- [ ] T162A: Exponer confirmación de compra PAID integrando permisos, pago, stock, caja si es efectivo, auditoría e idempotencia [RF-100, RF-101, RF-104, RF-105, RF-131, RF-132, RF-140, RF-185, RF-186, RF-189, RF-230, RF-231, RF-242, RF-243, RF-257, RF-269] (Depende de T158–T162)
- [ ] T162B: Exponer pago posterior de PENDING_PAYMENT con total exacto, sesión/medio válido, estado append-only, auditoría e idempotencia [RF-103, RF-104, RF-105, RF-131, RF-132, RF-140, RF-230, RF-231, RF-242, RF-243, RF-258] (Depende de T160–T162)
- [ ] T163: Preparar anulación única con motivo y transición append-only sin modificar datos originales [RF-106, RF-259]
- [ ] T164: Preparar locks y rechazo total si falta stock para cualquier reversión [RF-107, RF-166]
- [ ] T165: Exponer anulación revirtiendo inventario y medio histórico, con sesión/dispositivo y efecto de caja cuando corresponda, auditoría e idempotencia atómicas [RF-106, RF-107, RF-108, RF-109, RF-131, RF-132, RF-140, RF-166, RF-230, RF-231, RF-251, RF-259, RF-260] (Depende de T163–T164)
- [ ] T166: Preparar persistencia interna de gasto con categoría activa, concepto, importe, branch, actor y timestamp, sin exponer aún el comando [RF-52, RF-110, RF-252]
- [ ] T167: Autorizar gasto OWNER/ADMIN dentro de scope y, si es efectivo, exigir sesión válida y dispositivo operativo [RF-207, RF-208, RF-230, RF-231]
- [ ] T168: Autorizar gasto CASHIER solo en efectivo, sesión propia y dispositivo asociado [RF-209]
- [ ] T169: Rechazar cualquier gasto iniciado por EMPLOYEE [RF-210]
- [ ] T170: Exponer creación de gasto integrando permisos, categoría, medio, sesión/dispositivo, caja cuando corresponda, auditoría e idempotencia en una transacción [RF-52, RF-110, RF-111, RF-112, RF-131, RF-132, RF-140, RF-207, RF-208, RF-209, RF-210, RF-230, RF-231, RF-242, RF-243, RF-252] (Depende de T166–T169)
- [ ] T171: Preparar anulación única con motivo y transición append-only sin alterar el gasto original [RF-261, RF-264]
- [ ] T172: Preparar compensación efectiva con ingreso atómico en sesión/dispositivo válidos [RF-262]
- [ ] T173: Exponer anulación de gasto con reversión administrativa no efectiva o ingreso efectivo bajo lock, auditoría e idempotencia atómicas [RF-131, RF-132, RF-140, RF-230, RF-231, RF-261, RF-262, RF-263, RF-264] (Depende de T171–T172)
- [ ] T173A: Implementar UI de alta de compra OWNER/ADMIN y recepción EMPLOYEE PENDING_PAYMENT con costos contextuales y total cero [RF-100, RF-102, RF-133, RF-152, RF-153, RF-154, RF-185, RF-186, RF-187, RF-188, RF-225, RF-257] (Depende de T153–T159 y T088–T092)
- [ ] T173C: Implementar UI de pago y anulación total de compras con medio/sesión válida, total exacto y estados históricos [RF-103, RF-104, RF-105, RF-106, RF-107, RF-108, RF-109, RF-133, RF-152, RF-153, RF-154, RF-188, RF-258, RF-259] (Depende de T160–T165, T173A y T088–T092)
- [ ] T173B: Implementar UI de gastos por rol con selección válida de categoría/medio/sesión, anulación y errores accionables [RF-52, RF-110, RF-111, RF-112, RF-133, RF-152, RF-153, RF-154, RF-207, RF-208, RF-209, RF-210, RF-261, RF-264] (Depende de T166–T173 y T088–T092)

## 7. Auditoría, dashboard y reportes

- [ ] T174: Consultar auditoría completa como OWNER y denegar el módulo a CASHIER/EMPLOYEE [RF-282]
- [ ] T175: Limitar auditoría ADMIN a recursos globales administrables y branches asignadas [RF-282]
- [ ] T176: Construir dashboard OWNER/ADMIN con filtros y métricas comerciales autorizadas [RF-142]
- [ ] T177: Calcular resultado operativo como ventas netas menos gastos netos, sin margen [RF-143, RF-226, RF-286]
- [ ] T178: Limitar dashboard CASHIER a sus ventas/sesiones y EMPLOYEE a catálogo/inventario [RF-144, RF-145]
- [ ] T179: Crear dataset read-only de ventas con estado histórico y filtros autorizados [RF-146, RF-286, RF-287]
- [ ] T179A: Crear dataset read-only de inventario actual y stock bajo [RF-58, RF-59, RF-146]
- [ ] T179B: Crear dataset read-only de movimientos de inventario [RF-146]
- [ ] T179C: Crear dataset read-only de caja y diferencias [RF-146]
- [ ] T179D: Crear dataset read-only de compras con estado histórico [RF-146, RF-286]
- [ ] T179E: Crear dataset read-only de gastos con estado histórico [RF-146, RF-286]
- [ ] T180: Aplicar y probar scope OWNER/ADMIN/CASHIER/EMPLOYEE a todos los datasets, incluyendo negativos cross-tenant y entre sucursales [RF-02, RF-144, RF-145, RF-148, RF-149, RF-150, RF-285] (Depende de T179–T179E)
- [ ] T181: Interpretar períodos en timezone tenant y excluir anulados de netos sin ocultarlos [RF-286, RF-287]
- [ ] T182: Exportar CSV filtrado neutralizando celdas ejecutables [RF-147, RF-288]
- [ ] T183: Implementar ObjectStoragePort, archivos temporales y URL firmada con expiración [RF-147]
- [ ] T184: Generar PDF filtrado mediante outbox y revalidar scope en el worker [RF-147, RF-151]
- [ ] T184A: Implementar UI de dashboard por rol con filtros, estados y equivalente textual de gráficos [RF-142, RF-143, RF-144, RF-145, RF-152, RF-153, RF-154, RF-226, RF-286] (Depende de T176–T178 y T088–T092)
- [ ] T184B: Implementar UI de auditoría con filtros, scope y estados accesibles [RF-133, RF-152, RF-153, RF-154, RF-282] (Depende de T174–T175 y T088–T092)
- [ ] T184C: Implementar UI de reportes con datasets/filtros autorizados, CSV/PDF y seguimiento accesible de exportaciones [RF-133, RF-146, RF-147, RF-148, RF-149, RF-150, RF-152, RF-153, RF-154, RF-286, RF-287, RF-288] (Depende de T179–T184 y T088–T092)

## 8. Offline POS

- [ ] T185: Autorizar dispositivo POS registrando tenant, branch, autorizador, estado, contacto y clave pública; emitir certificado opaco autenticado/cifrado, no bearer y ligado al thumbprint [RF-127, RF-309, RF-312, RF-313]
- [ ] T185A: Implementar service worker con `no-cache`, precache exclusivo de shell/assets y prueba negativa de API privada [RF-118, RF-171, RF-279]
- [ ] T185B: Crear manifest y capability gate que impida autorizar offline sin Service Worker, IndexedDB y Web Crypto requeridos [RF-116, RF-152, RF-289] (Depende de T185A)
- [ ] T188: Crear una base Dexie por organización/dispositivo con stores cifrados particionados por identidad y delivery_queue opaca común; probar migración y aislamiento [RF-173, RF-279, RF-309, RF-312]
- [ ] T189: Crear clave ECDSA no exportable y DEK/KEK por PIN, con backoff persistente y bloqueo; separar desbloqueo/creación de la capacidad limitada de entrega [RF-171, RF-172, RF-173, RF-311] (Depende de T188)
- [ ] T189A: Implementar SyncEnvelopeDecryptorPort con RSA-OAEP-3072/SHA-256, publicación firmada, rotación y restauración; impedir retirar claves referenciadas por exposiciones o sobres posibles [RF-310, RF-315] (Depende de T185)
- [ ] T190: Cifrar registros legibles por identidad con AES-256-GCM, AAD/IV únicos y detectar alteración sin permitir acceso cruzado [RF-171, RF-173, RF-312, RF-277]
- [ ] T190A: Construir sobre híbrido versionado: CEK AES-256-GCM, wrap RSA-OAEP, routing mínimo, duplicación interna y firma; excluir credenciales reutilizables [RF-309, RF-310, RF-315] (Depende de T189A–T190)
- [ ] T190B: Implementar lease local con fencing token y recuperación tras crash para serializar secuencia entre pestañas/identidades sin consumirla al fallar [RF-175, RF-277, RF-309] (Depende de T188)
- [ ] T191: Sellar operación bajo lease local con fencing: firma/hash, registro cifrado y sobre opaco en una transacción IndexedDB, sin bifurcar ni consumir secuencia ante fallo [RF-115, RF-175, RF-267, RF-277, RF-309, RF-310] (Depende de T189–T190B)
- [ ] T191A: Migrar forward-only preservando byte por byte registros y sobres; bloquear actualización incompatible y conservar key IDs/formatos verificables [RF-175, RF-279, RF-310, RF-315] (Depende de T188–T191)
- [ ] T186: Emitir bootstrap firmado con clave pública de ingestión/ACK vigentes y registrar exposición antes de entregar configuración utilizable; probar respuesta perdida, reintento y rotación [RF-116, RF-123, RF-167, RF-168, RF-302, RF-303, RF-310, RF-315] (Depende de T077A, T077C, T077D, T185, T185B y T189A)
- [ ] T187: Emitir grant ligado a clave registrada, actor/tenant/dispositivo/scope/cajas/versión con 72 h desde validación y sync completos; probar que login y sync fallido no renuevan plazo [RF-114, RF-119, RF-169, RF-172] (Depende de T186 y T189)
- [ ] T192: Abrir sesión offline con permisos, dispositivo y bootstrap/grant vigentes, persistiéndola con envelope atómicamente [RF-114, RF-115, RF-116, RF-119] (Depende de T185, T185A, T185B, T186, T187 y T188–T191A)
- [ ] T193: Consultar offline únicamente catálogo permitido y configuración conocida [RF-117, RF-118]
- [ ] T194: Crear venta offline de consumidor final sin cachear ni editar clientes [RF-117, RF-280]
- [ ] T195: Validar ítems activos según conocimiento local y precios de versión verificable [RF-123, RF-256]
- [ ] T196: Aplicar descuento offline solo con permiso vigente conocido y dejar evidencia [RF-49, RF-281]
- [ ] T197: Persistir venta/pagos offline con referencia local estable e ID global [RF-117, RF-267, RF-268]
- [ ] T198: Conservar occurred_at local separado de received_at servidor [RF-130, RF-272]
- [ ] T199: Bloquear configuración, compras, gastos, ajustes, anulaciones, cierre y reportes offline [RF-118]
- [ ] T200: Invalidar nuevas operaciones al expirar grant sin borrar pendientes [RF-119, RF-175]
- [ ] T200A: Validar internamente formato, firma, grant histórico, versión y conocimiento de revocación sin producir efectos de negocio [RF-128, RF-129, RF-169, RF-172, RF-278] (Depende de T187 y T191)
- [ ] T200B: Validar cadena, secuencias, dependencias e idempotencia por sobre, conservando dependientes pendientes ante fallo [RF-131, RF-175, RF-273, RF-274, RF-275, RF-276, RF-277] (Depende de T191 y T200A)
- [ ] T213: Implementar apertura offline importada con lock de caja: OPEN si compatible, CONFLICTED si incompatible, conservando sesión previa; ACKED confirma la apertura persistida aun con conflicto comercial [RF-124, RF-131, RF-132, RF-158, RF-292] (Depende de T116, T187 y T191)
- [ ] T201A: Implementar delivery/challenge y delivery/push con certificado opaco servidor, nonce JWS de un uso, prueba ECDSA sobre hash exacto, origin/content-type, límites y respuestas indistinguibles [RF-151, RF-312, RF-313, RF-314] (Depende de T013, T018, T185 y T190A)
- [ ] T201B: Probar que el guard de entrega solo alcanza ingestión/ACK mínimo: negar catálogo, recibos, status detallado y toda mutación ordinaria; incluir negativos cross-tenant y certificado/header discordante [RF-02, RF-04, RF-151, RF-312, RF-313, RF-314] (Depende de T201A)
- [ ] T201: Integrar validadores e ingestión histórica en una TenantTransaction por sobre con RLS; aceptar actor revocado solo conforme al contexto original y devolver resultado estable [RF-128, RF-129, RF-131, RF-132, RF-169, RF-175, RF-273, RF-274, RF-278, RF-283, RF-313] (Depende de T200A–T200B, T201A–T201B y T213)
- [ ] T202: Reintentar resultado incierto con la misma clave, payload y bytes de sobre; rechazar cambio de hash y no recrear la operación [RF-120, RF-275, RF-276, RF-315] (Depende de T201)
- [ ] T202A: Emitir y verificar ACK JWS mínimo por operación; probar ACK falsificado/repetido, conflicto aplicado, rechazo de seguridad y pérdida de respuesta [RF-131, RF-274, RF-276, RF-314, RF-315, RF-316] (Depende de T201)
- [ ] T203: Activar entrega/sync al recuperar red, foreground y acción manual, incluso sin sesión de usuario; el service worker enumera solo sobres opacos [RF-120, RF-274, RF-311, RF-312] (Depende de T201B y T202A)
- [ ] T204: Persistir checkpoints monotónicos de conocimiento de revocación; rechazar operación manipulada o creada después del checkpoint y auditar evidencia [RF-20, RF-128, RF-129, RF-169, RF-278] (Depende de T201)
- [ ] T205: Revocar dispositivo bloqueando creación y lectura pero permitiendo únicamente entrega de sobres previos legítimos; limpiar al concluir [RF-128, RF-177, RF-311, RF-313, RF-314, RF-316] (Depende de T204)
- [ ] T206: Revocar membresía bloqueando sesión/desbloqueo/creación y conservar la entrega opaca de sobres previos legítimos [RF-129, RF-174, RF-175, RF-311, RF-313] (Depende de T204)
- [ ] T207: Aceptar configuración obsoleta legítima usando versión y conocimiento, sin reasignar recursos [RF-167, RF-169, RF-170] (Depende de T201 y T204–T206)
- [ ] T208: Aceptar catálogo desactivado/cambiado conservando referencias originales y semántica de versión histórica; probar precio, unidad, tipo, control de inventario, moneda y discrepancia sin reinterpretación actual [RF-122, RF-167, RF-169, RF-170, RF-206, RF-269, RF-307] (Depende de T207)
- [ ] T208A: Integrar barrera D01 en PWA con congelación durable entre identidades/pestañas, drenaje y renovación de configuración; probar reload, pérdida de red, dos dispositivos y liberación solo sin historia ni pendientes [RF-120, RF-175, RF-279, RF-302, RF-303, RF-306] (Depende de T077D, T186–T208)
- [ ] T209: Exponer ingestión de venta offline legítima integrando sesión/dispositivo históricos, venta/pagos/recibo, stock/caja, snapshots, auditoría e idempotencia; si deja stock negativo, crear/reabrir en esa misma transacción la incidencia OPEN con fuentes, saldos y faltante máximo [RF-80, RF-81, RF-117, RF-121, RF-122, RF-130, RF-131, RF-132, RF-167, RF-169, RF-170, RF-205, RF-256, RF-267, RF-268, RF-269, RF-270, RF-272, RF-276, RF-283, RF-296, RF-298] (Depende de T186–T208 y T208A)
- [ ] T210: Probar el ciclo de incidencia bajo reintentos y ventas concurrentes, sin duplicar fuentes ni perder el faltante máximo [RF-121, RF-164, RF-296, RF-298] (Depende de T209)
- [ ] T211: Pasar incidencia a PENDING_REVIEW al corregirse el saldo y vincular movimientos [RF-297] (Depende de T105A, T157, T210)
- [ ] T212: Resolver incidencia no negativa por OWNER/ADMIN dentro de scope con nota, auditoría e idempotencia; rechazar EMPLOYEE o saldo aún negativo [RF-131, RF-132, RF-140, RF-299, RF-300, RF-301] (Depende de T211)
- [ ] T214A: Congelar localmente nuevas operaciones y drenar la cola antes de solicitar cierre, conservando reintentos idempotentes ya sellados [RF-155, RF-156, RF-234]
- [ ] T214B: Implementar begin-close: validar firma/checkpoint completo ya aplicado, versión y actor/dispositivo, persistir OPEN→CLOSING y close_attempt_id bajo lock [RF-157, RF-275, RF-276] (Depende de T214A)
- [ ] T214C: Implementar final-sync que verifique cadena, secuencia, ACKs y ausencia de pending/failed/retry antes de recalcular expected_cash y aceptar contado [RF-155, RF-156, RF-234]
- [ ] T214D: Confirmar close con permisos, locks y close_attempt_id vigente; revalidar esperado, insertar snapshot/transición y revisión si diferencia no cero atómicamente. Probar cierre obsoleto tras aborto [RF-93, RF-94, RF-95, RF-98, RF-131, RF-132, RF-140, RF-199, RF-230, RF-231, RF-253, RF-283] (Depende de T214B–T214C)
- [ ] T214E: Abortar idempotentemente CLOSING→OPEN desde dispositivo asociado con permisos de sesión; invalidar close_attempt_id y auditar, sin desbloquear finales [RF-131, RF-133, RF-157] (Depende de T214B–T214D)
- [ ] T214F: Revisar diferencia idempotente y auditadamente sin alterar importes/cierre/movimientos; impedir autorrevisión con otro revisor, permitir SELF_REVIEW justificado solo sin alternativa y dirigir toda corrección real a T122/T123 [RF-131, RF-140, RF-200, RF-201, RF-202, RF-203, RF-204]
- [ ] T214: Conciliar CONFLICTED con OWNER/ADMIN y scope, congelación/checkpoint/versiones bajo lock, contado/diferencia/motivo y transición atómica a CLOSED_CONFLICT_RESOLVED, sin fusionar ni compensar [RF-124, RF-125, RF-126, RF-131, RF-132, RF-140, RF-158, RF-290] (Depende de T213 y T214A–T214F)
- [ ] T215: Probar cierre contra venta/sync concurrentes, caída después de begin-close, respuesta perdida, aborto, conflicto y rechazo de envelopes posteriores al checkpoint [RF-131, RF-155, RF-156, RF-157, RF-158, RF-234, RF-275]
- [ ] T216: Preparar política de cierre excepcional desde OPEN/CLOSING/CONFLICTED solo para OWNER/ADMIN dentro de scope, con confirmación explícita y motivo [RF-235, RF-236]
- [ ] T216A: Preparar snapshot inmutable de cierre excepcional, completeness UNKNOWN, late-data marker y bloqueo D01 de moneda sin liberar exposiciones [RF-235, RF-237, RF-238, RF-304, RF-305] (Depende de T216)
- [ ] T217: Exponer cierre excepcional integrando política/snapshot, locks, auditoría e idempotencia; liberar la caja como final sin inventar operaciones ni liberar D01 [RF-131, RF-132, RF-140, RF-235, RF-236, RF-237, RF-238, RF-239, RF-304, RF-305] (Depende de T216–T216A)
- [ ] T218: Incorporar late data legítima en una transacción idempotente y auditada preservando snapshot/estado final excepcional, recalcular derivados conocidos, marcar LATE_RECOVERED_OPERATIONS y exigir revisión OWNER/ADMIN; verificar bloqueo permanente de moneda y versiones retenidas tras reaparición [RF-304, RF-305, RF-307, RF-131, RF-132, RF-140, RF-240, RF-241, RF-291] (Depende de T209 y T217)
- [ ] T218A: Implementar UI de apertura y movimientos manuales de caja con permisos, dispositivo y estados persistentes [RF-91, RF-93, RF-94, RF-95, RF-96, RF-133, RF-152, RF-153, RF-154, RF-230, RF-231] (Depende de T116–T123 y T088–T092)
- [ ] T218B: Implementar UI de cierre normal, congelación, sync final, contado, aborto y revisión de diferencia [RF-98, RF-133, RF-152, RF-153, RF-154, RF-155, RF-156, RF-157, RF-199, RF-200, RF-201, RF-202, RF-203, RF-204, RF-234] (Depende de T214A–T215 y T218A)
- [ ] T218C: Implementar UI de conciliación CONFLICTED, cierre excepcional y late data con confirmaciones y estados accesibles [RF-125, RF-133, RF-152, RF-153, RF-154, RF-158, RF-235, RF-236, RF-240, RF-241, RF-290, RF-291] (Depende de T214, T216–T218 y T218A)
- [ ] T219: Implementar logout/cambio de usuario: destruir material de desbloqueo en memoria, impedir lectura/creación y continuar entrega opaca automática sin revelar identidad, tenant ni contenido [RF-128, RF-173, RF-174, RF-175, RF-177, RF-311, RF-312, RF-314]
- [ ] T220: Al ACK definitivo firmado, eliminar/inutilizar payload y sobre atómicamente; ante SECURITY_REJECTED conservar solo evidencia mínima y ante fallo recuperable preservar bytes [RF-176, RF-177, RF-314, RF-315, RF-316] (Depende de T202A y T219)
- [ ] T220A: Implementar UI de autorización/PIN, vigencia, última sync y cola detallada solo para la identidad activa [RF-114, RF-117, RF-119, RF-120, RF-123, RF-133, RF-152, RF-153, RF-154, RF-168, RF-173, RF-174, RF-175, RF-274] (Depende de T185–T220 y T088–T092)
- [ ] T220B: Implementar progreso genérico de entrega opaca entre identidades y conflictos/rechazos sin exponer actor, tenant, recursos ni contenido ajenos [RF-128, RF-129, RF-133, RF-152, RF-153, RF-154, RF-173, RF-174, RF-312, RF-314, RF-316] (Depende de T201A–T220A)
- [ ] T221: Exponer desactivación por OWNER con chequeo atómico de sesiones y pendientes/conflictos, incluida incertidumbre relevante; conservar historia y exposiciones sin usar desactivación para liberar D01 [RF-28, RF-29, RF-131, RF-132, RF-304, RF-306] (Depende de T063, T116 y T185–T220)
- [ ] T221A: Completar UI de administración de sucursal con bloqueo y explicación accionable de sesiones, pendientes o conflictos que impiden desactivarla [RF-28, RF-29, RF-133, RF-152, RF-153, RF-154] (Depende de T092B y T221)

## 9. Hardening y entrega operativa

- [ ] T224: Verificar instalación standalone, iconos 192/512 y degradación online segura del capability gate en la matriz soportada [RF-116, RF-152, RF-289] (Depende de T185A–T185B)
- [ ] T225: Verificar por Playwright/axe los flujos UI críticos mobile/desktop por teclado, foco, labels, contraste y errores [RF-152, RF-153, RF-154] (Depende de T092A–T095H, T114A–T114C, T152A–T152D, T173A–T173C, T184A–T184C, T218A–T220B y T221A)
- [ ] T226: Verificar tablas como cards móviles y equivalentes textuales accesibles de gráficos [RF-142, RF-152, RF-154] (Depende de T114A, T184A y T184C)
- [ ] T227: Ejecutar Playwright en Chromium/WebKit/Firefox y verificar además Chrome/Edge branded, Firefox y Safari reales en versiones objetivo, registrando navegador, OS y resultado [RF-152, RF-289] (Depende de T224–T226)
- [ ] T228: Probar pérdida/retorno de red, logout, cambio de identidad, revocación, reload, cierre de pestaña, sync parcial y pérdida de ACK sin perder ni exponer sobres [RF-120, RF-175, RF-274, RF-279, RF-311, RF-312, RF-314, RF-315]
- [ ] T229: Validar nombre, content type/disposition, tamaño y aislamiento sin ejecución activa de recibos y exportaciones generados; no agregar uploads al MVP [RF-83, RF-147, RF-151]
- [ ] T230: Configurar alertas por readiness, error rate, DB, dead-letter, sync y conflictos [RF-135, RF-136, RF-137]
- [ ] T231: Implementar backup diario cifrado, independiente del primario, con checksum y retención de 35 días como fija el plan [RF-138]
- [ ] T232: Automatizar restore mensual aislado con migraciones, claves de ingestión/ACK referenciadas, ledger checks y smoke tests [RF-139, RF-315]
- [ ] T233: Documentar y probar runbook de recuperación con RPO 24 h, RTO 8 h y recuperación de claves necesarias para sobres pendientes [RF-139, RF-315]
- [ ] T235: Construir imágenes reproducibles web/api/worker, ejecutar migración única previa al rollout y smoke de rutas, readiness, worker y archivos [RF-135, RF-138, RF-139]
- [ ] T236: Ejecutar puerta final y sdd-check con evidencia individual RF → implementación → prueba. Este gate verifica calidad, seguridad y compatibilidad, pero no sustituye tareas de implementación [RF-132, RF-151, RF-289] (Depende de todas las tareas anteriores)
