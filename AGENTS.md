# Guía de agentes — UcoNext

## Alcance

Este archivo aplica a todo el repositorio. Es la guía operativa para agentes que analicen, implementen, prueben o documenten el proyecto. No reemplaza la especificación funcional, la constitución técnica ni el plan aprobado.

## Fuentes de verdad y precedencia

Antes de realizar cambios, leer los documentos pertinentes en este orden:

1. `specs/001-mvp-gestion-comercial-saas/spec.md`: comportamiento funcional y alcance del MVP. Está cerrado.
2. `constitution.md`: reglas técnicas transversales y no negociables.
3. `specs/001-mvp-gestion-comercial-saas/plan.md`: diseño técnico aprobado y trazabilidad RF → implementación.
4. Tareas generadas por `sdd-build`: unidad de trabajo actual.
5. Código y tests existentes: evidencia del estado implementado, nunca autorización para contradecir los documentos anteriores.

Este `AGENTS.md` traduce esas fuentes en hábitos de trabajo. Ante un conflicto, prevalece el orden anterior. No reinterpretar un requisito para adaptarlo al código.

## Estado y flujo SDD

- El `spec.md` está `CERRADO` y el `plan.md` revisado está `APROBADO`; D01 y D02 quedaron incorporadas con trazabilidad.
- La siguiente fase es `sdd-build`; ejecutar una tarea atómica por vez con TDD estricto.
- Después de completar el plan, ejecutar `sdd-check` para verificar cada requisito contra implementación y tests.
- No reabrir decisiones funcionales salvo contradicción técnica que haga imposible el requisito.
- Una modificación funcional requiere volver a la etapa SDD correspondiente, actualizar la trazabilidad y obtener aprobación explícita.
- Una excepción a `constitution.md` debe documentarse y aprobarse antes de implementarse.
- No incorporar funcionalidades fuera del MVP como facturación fiscal/ARCA, contabilidad, pagos online, aplicaciones nativas, multimoneda o suscripciones automatizadas.

## Forma de trabajo

1. Identificar la tarea activa y los RF vinculados en la matriz de trazabilidad del plan.
2. Leer el módulo, migraciones, contratos y tests que puedan verse afectados.
3. Preservar cambios existentes del usuario y evitar modificaciones no relacionadas.
4. Escribir primero una prueba que falle por la conducta requerida.
5. Implementar el cambio mínimo que haga pasar la prueba respetando arquitectura e invariantes.
6. Refactorizar solo con las pruebas verdes.
7. Ejecutar checks proporcionales y luego los checks obligatorios de la tarea.
8. Documentar decisiones nuevas, migraciones, riesgos y evidencia de verificación.

No dar una tarea por terminada con tests omitidos, deshabilitados, marcados como `skip` o sustituidos por mocks que eviten probar la garantía real.

## Repositorio y herramientas

La estructura objetivo es:

```text
apps/
  web/       # Next.js, administración, POS y PWA
  api/       # NestJS, API y worker del monolito modular
packages/
  shared/    # contratos estables y utilidades puras
  config/    # configuración compartida
  ui/        # design system y componentes reutilizables
```

Reglas:

- Usar `pnpm`, workspaces y Turborepo. No introducir otro package manager.
- Mantener el lockfile versionado y usar instalaciones reproducibles en CI.
- Usar los scripts raíz definidos en `package.json` para `lint`, `typecheck`, `test`, `build` y E2E.
- Buscar archivos y texto con `rg`/`rg --files`.
- Editar archivos de forma localizada; no ejecutar formateos masivos ajenos a la tarea.
- No agregar dependencias sin justificar responsabilidad, mantenimiento, seguridad, peso y compatibilidad.
- No extraer paquetes o servicios por anticipación. Los dominios backend permanecen en `apps/api`.
- No introducir microservicios, Redis, GraphQL, CQRS distribuido, event sourcing completo o Kubernetes en el MVP.

## Convenciones de código

- TypeScript estricto de extremo a extremo; evitar `any`, casts inseguros y estados imposibles.
- Código, identificadores, tablas, columnas, endpoints y nombres técnicos en inglés.
- Textos de producto y documentación funcional en español claro, con localización preparada para evolucionar.
- Exponer APIs públicas explícitas en paquetes y módulos. Se prohíben imports a rutas internas de otro módulo.
- Evitar dependencias circulares y mantener la dirección `presentation → application → domain`.
- El dominio no importa NestJS, Drizzle, HTTP ni componentes React.
- Los controladores solo adaptan HTTP; las reglas y transacciones pertenecen a casos de uso.
- Representar errores HTTP mediante `application/problem+json` con códigos estables y `traceId`.
- No exportar entidades Drizzle ni campos internos desde contratos públicos.

## Arquitectura backend

El backend es un monolito modular NestJS. Los módulos previstos son `auth`, `platform-admin`, `organizations`, `users`, `branches`, `catalog`, `inventory`, `cash`, `sales`, `customers`, `suppliers`, `purchases`, `expenses`, `offline-sync`, `audit`, `dashboard` y `reports`.

- Los módulos colaboran mediante servicios de aplicación o puertos públicos.
- Un controlador no accede directamente a tablas de otro módulo.
- `reports` puede realizar lecturas transversales bajo RLS y autorización; no obtiene permiso de escritura cruzada.
- API y worker comparten código y base de datos. Son procesos del mismo monolito, no microservicios.
- Las mutaciones comerciales pasan exclusivamente por la API NestJS bajo `/api/v1`.
- No usar Next.js Server Actions como canal alternativo para mutaciones de negocio.

## PostgreSQL y persistencia

- PostgreSQL es la fuente de verdad.
- Usar `node-postgres` como driver, Drizzle ORM para esquema/CRUD y Drizzle Kit para migraciones.
- Usar SQL explícito cuando se necesiten locks, RLS, constraints avanzados, índices parciales, idempotencia o consultas especializadas.
- Las migraciones deben ser versionadas, deterministas y revisables. Nunca ejecutar schema push automático en producción.
- Usar UUID como PK y `timestamptz` en UTC.
- Persistir estados como `text` con `CHECK`; no usar enums PostgreSQL sin una excepción aprobada.
- Aplicar FKs históricas con `RESTRICT`; no usar cascade delete sobre documentos, movimientos o auditoría.
- Las eliminaciones físicas solo son válidas cuando un caso de uso demuestra que no existe historial ni referencias.
- Probar migraciones, RLS, locks, constraints y transacciones contra PostgreSQL real; SQLite no es sustituto válido.

## Multi-tenancy y autorización

El aislamiento tenant es una propiedad de seguridad crítica:

- Toda tabla tenant incluye `organization_id`.
- Toda relación tenant usa una FK compuesta que demuestre pertenencia a la misma organización.
- RLS es obligatorio y opera con default deny.
- El rol runtime no posee `BYPASSRLS` ni es propietario de las tablas protegidas.
- Cada unidad de trabajo obtiene un `PoolClient`, abre transacción y aplica con `SET LOCAL` el contexto de organización, usuario y request.
- Validar membresía, rol y sucursales dentro de esa misma transacción.
- Los repositorios tenant reciben únicamente el cliente transaccional contextualizado; nunca consultan mediante el pool global.
- RLS limita organización; RBAC y branch scope limitan funciones y sucursales.
- IDs, filtros o contexto enviados por el frontend nunca prueban autorización.
- El acceso de plataforma usa credenciales y procedimientos separados del acceso operativo tenant.

Toda modificación relacionada con tenancy debe incluir una prueba negativa cross-tenant y, cuando aplique, una prueba de alcance entre sucursales.

## Transacciones, concurrencia e idempotencia

- Toda operación con efectos relacionados se confirma o revierte completa en una transacción PostgreSQL.
- Auditoría, idempotencia, movimientos y outbox requeridos forman parte de la misma transacción.
- Usar `READ COMMITTED` con locks explícitos salvo decisión aprobada distinta.
- Bloquear stock en orden canónico `(branch_id, item_id)` mediante `SELECT ... FOR UPDATE`.
- Bloquear `cash_session` antes de validar estado, dispositivo o efectivo esperado.
- Repetir validaciones de stock, permisos, estado y dinero después de adquirir locks.
- Una operación con varios ítems es indivisible; nunca dejar efectos parciales.
- Reintentar deadlocks o fallos de serialización de forma acotada y con la misma clave idempotente.
- Las mutaciones de negocio requieren `Idempotency-Key` y hash SHA-256 del payload canónico.
- Un reintento idéntico devuelve el resultado persistido; la misma clave con otro payload produce conflicto.

Las operaciones online normales y los ajustes negativos nunca pueden producir stock negativo. La única excepción es el conflicto explícito originado al sincronizar una venta offline legítima.

## Dinero, cantidades y tiempo

- Se prohíben `float`, `double` y JavaScript `number` en cálculos de negocio.
- Dinero: `numeric(20,2)` y value object `Money` basado en `decimal.js`.
- Cantidades: `numeric(20,3)` y value object `Quantity`.
- API e IndexedDB transportan decimales como strings canónicos.
- Redondear importes persistidos con `HALF_UP` a dos decimales según el spec.
- `UNIT` solo admite cantidades enteras; las unidades fraccionables admiten hasta tres decimales.
- Guardar el código ISO 4217 en documentos monetarios históricos.
- Almacenar timestamps en UTC y calcular períodos según la zona horaria vigente de la organización sin reescribir el pasado.

Centralizar estas reglas en value objects compartidos y cubrirlas con pruebas unitarias y property-based.

## Historial, ledgers y auditoría

- `inventory_movements` y `cash_movements` son ledgers append-only.
- `branch_stocks` y el efectivo esperado son proyecciones transaccionales; movimiento y proyección cambian juntos.
- Operaciones confirmadas, movimientos, anulaciones, reintegros, reversas, comprobantes y eventos de auditoría son inmutables.
- Corregir mediante nuevas operaciones compensatorias enlazadas; nunca reescribir el historial.
- Guardar snapshots suficientes para reproducir ventas, compras y comprobantes aunque cambien maestros o configuración.
- Proteger ledgers y auditoría con privilegios mínimos, constraints únicos por fuente y triggers defensivos.
- No registrar contraseñas, tokens, cookies, claves, secretos ni payloads sensibles innecesarios en auditoría o logs.

## Seguridad online

- Autenticación mediante sesiones opacas persistidas; guardar solo el hash del token.
- Cookies `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`, path `/` y sin `Domain`.
- Hashear contraseñas con Argon2id y parámetros versionados.
- Invitaciones y resets usan tokens hasheados, únicos, de un solo uso y con vencimiento.
- Revalidar membresía y alcance en cada request protegido.
- Proteger mutaciones con CSRF ligado a sesión, validación de origen y content type JSON.
- Aplicar límites persistentes a login, reset e invitaciones sin permitir enumeración de cuentas.
- Mantener CSP estricta, cabeceras defensivas, validación real de uploads y HTTPS obligatorio.
- Validar todos los DTO/schemas en backend aunque el frontend ya los haya validado.

## PWA y operación offline

- Dexie/IndexedDB almacena datos offline; Cache Storage solo contiene app shell y assets públicos versionados.
- Nunca cachear respuestas privadas del API en el Service Worker.
- Exigir dispositivo autorizado, autenticación online previa y grant vigente de hasta 72 horas.
- Proteger datos mediante Web Crypto, AES-256-GCM por registro, claves no exportables y PIN offline derivado con Argon2id.
- Aislar datos por organización, dispositivo y usuario.
- La cola offline es append-only, firmada y encadenada por secuencia y hash.
- Cada operación confirmada localmente guarda en la misma transacción un sobre opaco cifrado para el servidor; si falla cualquiera de ambas escrituras, no se confirma.
- Conservar operaciones pendientes hasta recibir un ACK idempotente definitivo del servidor.
- Una revocación conocida impide nuevas operaciones, pero no elimina operaciones legítimas pendientes.
- Tras logout, cambio de usuario o revocación, el canal de dispositivo solo puede entregar sobres ya sellados y recibir ACKs mínimos; no concede lectura ni nuevas operaciones.
- La corrección no puede depender de Background Sync; también sincronizar al recuperar red, volver al foreground y por acción manual.
- Una actualización del Service Worker o migración de IndexedDB nunca puede perder o invalidar silenciosamente la cola pendiente.
- El cierre definitivo de caja es online-only y exige estado servidor consolidado.

Todo cambio offline debe probar pérdida y retorno de red, reload, cierre de pestaña, reintentos, revocación, expiración, actualización PWA y conflictos relevantes.

## Frontend, UX y accesibilidad

- Next.js App Router + React, con Server Components para shell/lectura inicial y Client Components donde se requieran interacción, IndexedDB o Web Crypto.
- TanStack Query gestiona estado remoto; Zustand se limita a contexto activo, POS y sync efímero.
- React Hook Form + Zod gestiona formularios.
- `packages/ui` materializa `DESIGN.md` mediante tokens, CSS variables, Tailwind y primitivas accesibles.
- Diseñar mobile-first para PC, notebook, tablet y teléfono.
- Garantizar teclado, foco visible, labels, semántica, estados ARIA, contraste mínimo 4.5:1 y mensajes que no dependan solo del color.
- Respetar `prefers-reduced-motion` y degradar blur/efectos costosos.
- Usar la skill `impeccable` cuando una tarea implique diseñar o pulir interfaz.
- Usar la skill `playwright` para verificar flujos reales de navegador y PWA.

## Testing obligatorio

- Vitest: lógica unitaria y value objects.
- fast-check: invariantes de dinero, cantidades, estados e idempotencia.
- Testcontainers + PostgreSQL: integración, RLS, migraciones, constraints, locks y concurrencia.
- Supertest: contratos y autorización de la API NestJS.
- Playwright: E2E, navegadores, responsive, PWA y offline.
- Testing Library + axe-core: accesibilidad.
- `fake-indexeddb`: solo pruebas unitarias del almacenamiento offline.

Los mocks se limitan a reloj, entropía y puertos externos. No mockear repositorios para afirmar atomicidad, concurrencia o aislamiento.

Cada corrección de seguridad, aislamiento, concurrencia, cálculo o sincronización debe comenzar con una prueba de regresión reproducible.

## Observabilidad, jobs y recuperación

- Logs JSON estructurados con Pino y redacción centralizada.
- Trazas y métricas mediante OpenTelemetry/OTLP; métricas operativas compatibles con Prometheus.
- Correlacionar por `trace_id`, `request_id`, operation ID y job ID sin crear labels de alta cardinalidad por tenant.
- Jobs mediante outbox PostgreSQL y worker con `FOR UPDATE SKIP LOCKED`, lease, backoff y dead-letter.
- Handlers idempotentes por `job_key`.
- Separar liveness de readiness.
- Mantener backup diario, retención mínima de 30 días, restauración mensual y evidencia de RPO/RTO.
- Los proveedores concretos de hosting, PostgreSQL, S3, email, observabilidad, CDN y edge rate limiting permanecen diferidos. Depender de puertos, OTLP y contratos reemplazables.

## Definición de terminado

Una tarea solo está terminada cuando:

- implementa exclusivamente el alcance y los RF asignados;
- conserva aislamiento tenant, autorización e invariantes del dominio;
- incluye migraciones y contratos cuando correspondan;
- tiene pruebas significativas en el nivel adecuado;
- pasa `lint`, `typecheck` y las suites afectadas;
- no deja tests saltados, secretos, errores de compilación ni deuda oculta;
- actualiza documentación y trazabilidad si cambió una decisión aprobada;
- informa los archivos modificados, comandos ejecutados y resultados relevantes.

Antes de declarar terminado un bloque crítico, verificar explícitamente atomicidad, idempotencia, auditoría, observabilidad, errores y comportamiento de reintentos.

## Decisiones y bloqueos

Resolver detalles locales con el mejor criterio compatible con `spec.md`, `constitution.md` y `plan.md`. Registrar decisiones técnicas que afecten contratos, modelo de datos, seguridad, consistencia o arquitectura.

Detenerse y pedir decisión únicamente cuando:

- dos requisitos obligatorios sean incompatibles;
- la solución requiera cambiar el alcance funcional;
- sea necesario alterar una regla constitucional;
- falte autorización para una acción externa, irreversible o destructiva.

No usar una pregunta como sustituto de revisar los documentos existentes o ejecutar una comprobación segura.
