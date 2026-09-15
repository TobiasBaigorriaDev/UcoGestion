# Constitución técnica de UcoNext

**Versión:** 1.1.0  
**Estado:** VIGENTE  
**Ratificación inicial:** 2026-09-15  
**Origen:** decisiones consolidadas durante `sdd-quick-spec`, `sdd-spec-clarifier` y `sdd-plan` del MVP. Versión 1.1.0: entrega opaca de operaciones offline tras logout/revocación.

## 1. Propósito y autoridad

Esta constitución define las reglas técnicas y arquitectónicas obligatorias del proyecto. Su objetivo es preservar aislamiento multi-tenant, integridad comercial, trazabilidad, seguridad y mantenibilidad mientras el producto evoluciona.

La precedencia documental es:

1. El `spec.md` cerrado define el comportamiento funcional y el alcance del producto.
2. Esta constitución define las restricciones técnicas transversales.
3. Un `plan.md` aprobado define cómo aplicar ambos documentos a una entrega concreta.
4. Las tareas y el código implementan el plan sin reinterpretar requisitos.

Un plan no puede cambiar el comportamiento del spec. Esta constitución no puede utilizarse para omitir requisitos funcionales. Si aparece una incompatibilidad real, el trabajo debe detenerse y el documento correspondiente debe modificarse explícitamente mediante su etapa SDD, conservando trazabilidad.

## 2. Principios no negociables

1. **Servidor autoritativo.** El backend y PostgreSQL son la autoridad sobre permisos, precios, stock, caja, dinero, estados e integridad. El frontend nunca constituye una frontera de seguridad.
2. **Aislamiento tenant por capas.** Toda protección multi-tenant debe existir en autorización, modelo relacional y Row-Level Security.
3. **Consistencia antes que disponibilidad silenciosa.** Una operación online inválida o parcialmente aplicable debe rechazarse completa. Las excepciones offline deben estar explícitamente modeladas, identificadas y auditadas.
4. **Historial inmutable.** Las operaciones confirmadas no se reescriben para corregir el pasado. Se anulan o compensan mediante nuevas operaciones trazables.
5. **Simplicidad evolutiva.** El MVP utiliza un monolito modular. No se incorporan microservicios, CQRS distribuido, event sourcing completo, Kubernetes ni infraestructura enterprise sin evidencia concreta que lo justifique.
6. **Contratos explícitos.** Los límites entre navegador, API, módulos y base de datos deben estar tipados, validados y versionados.
7. **Operabilidad incorporada.** Auditoría, observabilidad, migraciones, backup y restauración son parte de la solución, no trabajo posterior.

## 3. Stack y repositorio

El proyecto debe utilizar TypeScript end-to-end y la siguiente base tecnológica:

- `pnpm` como package manager.
- `pnpm workspaces` para el monorepo.
- Turborepo para pipelines, caché y ejecución coordinada.
- Next.js App Router + React para `apps/web`.
- NestJS sobre Node.js para `apps/api`.
- PostgreSQL como fuente de verdad.
- `node-postgres` como driver.
- Drizzle ORM para esquema tipado, consultas comunes y relaciones.
- Drizzle Kit para migraciones versionadas.
- SQL explícito como mecanismo admitido y esperado en operaciones PostgreSQL sensibles.

La estructura base es:

```text
apps/
  web/
  api/
packages/
  shared/
  config/
  ui/
```

Solo se crearán paquetes adicionales cuando exista una responsabilidad estable y realmente compartida. Los dominios backend permanecerán dentro de `apps/api` hasta que una necesidad comprobada justifique extraerlos.

`packages/shared` solo puede contener contratos estables, enums independientes de infraestructura, esquemas reutilizables y utilidades puras. No puede convertirse en un contenedor genérico ni depender de NestJS, Drizzle o detalles de despliegue.

`packages/ui` contiene tokens, primitivas y patrones visuales reutilizables del frontend. `packages/config` contiene configuración compartida de TypeScript, ESLint, testing y tooling.

Los paquetes deben publicar exports explícitos. Se prohíben imports hacia rutas internas no públicas de otro paquete o módulo. ESLint y TypeScript deben controlar aliases, dependencias circulares y límites de imports.

Las versiones de runtime y dependencias deben fijarse mediante lockfile. Las actualizaciones relevantes requieren CI verde y revisión de migraciones, contratos y compatibilidad offline.

## 4. Arquitectura del backend

El backend es un monolito modular NestJS. Sus módulos iniciales son:

- `auth`
- `platform-admin`
- `organizations`
- `users`
- `branches`
- `catalog`
- `inventory`
- `cash`
- `sales`
- `customers`
- `suppliers`
- `purchases`
- `expenses`
- `offline-sync`
- `audit`
- `dashboard`
- `reports`

Los controladores adaptan HTTP y no contienen reglas de negocio. Los casos de uso coordinan autorización, transacciones y efectos. Las políticas, value objects y máquinas de estado del dominio no dependen de NestJS, Drizzle ni HTTP. La infraestructura implementa puertos de persistencia, email, archivos y observabilidad.

La dirección de dependencias es `presentation → application → domain`; infraestructura depende de puertos definidos hacia adentro. Un módulo no debe acceder a detalles internos de otro módulo. La colaboración se realiza mediante APIs de aplicación explícitas.

El módulo `reports` puede ejecutar consultas read-only entre dominios porque es un read model deliberado, pero debe respetar RLS, autorización, sucursales y contratos públicos. Esta excepción no habilita escritura cruzada.

Los procesos `api` y `worker` pueden desplegarse por separado, pero utilizan el mismo código, módulos, base de datos y versión. No constituyen microservicios.

## 5. Persistencia y modelo relacional

Drizzle es una capa tipada sobre PostgreSQL y no debe ocultar capacidades de la base. CRUD simple debe preferir Drizzle. Se debe usar SQL explícito cuando aporte semántica necesaria para:

- `SELECT ... FOR UPDATE`;
- locks ordenados;
- actualizaciones condicionales;
- RLS y contexto tenant;
- constraints y FKs compuestas;
- índices parciales o funcionales;
- idempotencia;
- sincronización offline;
- consultas especializadas de reportes;
- triggers defensivos de inmutabilidad.

Todas las tablas pertenecientes a una organización deben incluir `organization_id`. Toda relación entre entidades tenant debe usar una FK compuesta que pruebe que padre e hijo pertenecen a la misma organización.

Las PK deben ser UUID. Una operación offline debe poder generar su UUID antes de conectarse. Los timestamps se almacenan como `timestamptz` en UTC y se presentan o agrupan según la zona horaria de la organización.

Los estados de dominio deben persistirse como `text` con constraints `CHECK` y representarse como uniones/enums TypeScript. No se utilizarán enums PostgreSQL salvo justificación aprobada, para evitar migraciones rígidas.

Los recursos mutables deben incluir `version bigint` cuando puedan sufrir edición concurrente. Los endpoints de actualización deben aplicar optimistic concurrency.

La eliminación física solo se permite mediante un caso de uso que compruebe ausencia de referencias. Las FKs históricas deben utilizar `RESTRICT`; no se permite cascade delete sobre documentos, movimientos, auditoría o relaciones históricas.

## 6. Aislamiento multi-tenant y RLS

El MVP utiliza una base y esquema compartidos. RLS es obligatorio en toda tabla tenant y opera con default deny.

El rol de aplicación PostgreSQL:

- no puede tener `BYPASSRLS`;
- no debe ser propietario de tablas protegidas;
- recibe únicamente privilegios mínimos;
- no puede desactivar RLS ni mutar ledgers inmutables.

Cada unidad de trabajo tenant debe:

1. obtener un `PoolClient`;
2. iniciar una transacción;
3. ejecutar `SET LOCAL`/`set_config(..., true)` para `app.organization_id`, `app.user_id` y `app.request_id`;
4. validar membresía, rol y sucursales dentro de la misma transacción;
5. entregar a los repositorios únicamente un cliente transaccional contextualizado;
6. confirmar o revertir y liberar la conexión.

Se prohíbe que un repositorio tenant consulte directamente con el pool global. No se deben usar variables de sesión persistentes que requieran limpieza manual al devolver la conexión.

RLS garantiza la frontera de organización. El backend aplica además RBAC y alcance de sucursales. Las consultas, exports, jobs y sincronización deben reconstruir y validar su contexto; nunca deben confiar en IDs recibidos ni en filtros del frontend.

El acceso de plataforma usa un pool y rol DB separados, limitado a procedimientos de provisioning o recuperación explícitos. Un administrador de plataforma no recibe acceso operativo ordinario a los tenants.

## 7. Transacciones, concurrencia e idempotencia

Toda operación que modifique varios datos relacionados debe ejecutarse en una transacción PostgreSQL controlada por el caso de uso. Auditoría, idempotencia y outbox requeridas deben confirmarse en la misma unidad atómica.

El nivel predeterminado es `READ COMMITTED` con locks explícitos. Las existencias se bloquean mediante `SELECT ... FOR UPDATE` en orden canónico `(branch_id, item_id)`. Una operación multi-sucursal debe construir primero el conjunto completo de filas y adquirir todos los locks en el mismo orden global.

Las operaciones de caja deben bloquear la fila `cash_session` antes de validar estado, dispositivo y saldo esperado. Ningún efecto puede ocurrir entre la verificación final de cierre y su commit.

Las validaciones de stock y dinero deben repetirse después de adquirir los locks. La primera transacción válida que confirma prevalece; las demás se reevalúan contra el nuevo estado. No existe prioridad por rol o tipo de operación.

Deadlocks y fallos de serialización pueden reintentarse internamente un máximo acotado, conservando la misma clave idempotente. Si no se resuelven, la operación debe fallar completa con un error reintentable y accionable.

Las mutaciones de documentos, movimientos y sincronización exigen `Idempotency-Key`. La persistencia debe usar una clave única por tenant/scope/key y un hash SHA-256 del payload canónico. Un reintento idéntico devuelve el resultado original; reutilizar la clave con otro payload devuelve conflicto. El registro idempotente debe conservarse mientras exista el documento de negocio.

## 8. Dinero, cantidades y tiempo

Se prohíbe `float`, `double` y JavaScript `number` para cálculos de negocio.

- Dinero: PostgreSQL `numeric(20,2)`.
- Cantidades: PostgreSQL `numeric(20,3)`.
- Porcentajes: decimal con precisión suficiente para no redondear prematuramente.
- Dominio TypeScript: `decimal.js` encapsulado en value objects `Money`, `Quantity` y `Percentage`.
- API/IndexedDB: representación decimal mediante strings canónicos.
- Redondeo monetario persistido: `HALF_UP` a dos decimales.

La entrada expresa magnitud y el tipo de operación expresa dirección. Los signos negativos solo pueden ser resultados calculados o deltas internos generados por el dominio.

Los documentos monetarios deben guardar el código ISO 4217 usado. Ningún cálculo histórico puede depender del símbolo visual de moneda ni de una configuración actual mutable.

Los filtros de período deben interpretarse en la zona horaria de la organización y convertirse a intervalos UTC. Las operaciones offline conservan separadamente la hora declarada por el dispositivo y la hora de recepción del servidor.

## 9. Ledgers, snapshots e inmutabilidad

`inventory_movements` y `cash_movements` son ledgers append-only. `branch_stocks` y `cash_sessions.expected_cash` son proyecciones transaccionales para lectura y validación rápida. Cada transacción debe insertar el movimiento y actualizar la proyección de forma conjunta.

Constraints únicos por fuente deben impedir que una venta, compra, ajuste, transferencia, anulación o sincronización duplique movimientos. Un verificador periódico debe comparar proyección y suma del ledger, emitir métricas/alertas y nunca autocorregir silenciosamente.

Ventas, compras y comprobantes deben guardar snapshots suficientes de ítems, unidad, categoría aplicable, precio/costo, moneda y datos comerciales requeridos para reproducir el documento. Cambios posteriores de catálogo, cliente, proveedor u organización no deben reescribir dichos snapshots.

Los ledgers, auditoría, documentos confirmados, cancelaciones, refunds, reversals y snapshots no admiten edición ni eliminación por el rol runtime. Triggers defensivos deben impedir mutaciones accidentales. Las correcciones se modelan como operaciones compensatorias enlazadas.

## 10. API y contratos

La API es REST JSON y se publica bajo `/api/v1`. No se utilizará GraphQL en el MVP. Las mutaciones de negocio deben pasar por el API NestJS; Next.js Server Actions no pueden crear una vía de escritura alternativa.

Zod 4 es la fuente de verdad de schemas request/response compartibles. NestJS debe aplicar validación global strict y esquemas específicos por endpoint. Los schemas públicos no pueden exportar entidades Drizzle ni campos internos.

Convenciones obligatorias:

- IDs UUID.
- Dinero/cantidades decimales como strings.
- `X-Organization-Id` para contexto tenant.
- `Idempotency-Key` para comandos transaccionales.
- `If-Match`/versión para edición optimista de maestros.
- paginación por cursor para listados.
- filtros mediante allowlists.
- OpenAPI generado y verificado en CI.

Los errores usan `application/problem+json` con `type`, `title`, `status`, `code`, `detail`, `instance`, `traceId` y `fieldErrors` cuando corresponda. Nunca exponen stack traces, SQL, secretos ni existencia de cuentas en endpoints públicos.

## 11. Autenticación y seguridad web

La autenticación online usa sesiones opacas en PostgreSQL:

- token aleatorio de alta entropía;
- persistencia exclusiva de su hash;
- cookie `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`, path `/` y sin `Domain`;
- expiración idle y absoluta;
- revocación inmediata ante logout, reset, desactivación o evento aplicable;
- revalidación de membresía y alcance en cada request protegido.

Las contraseñas se almacenan con Argon2id y parámetros versionados. Reset e invitaciones utilizan tokens únicos, hasheados, de un solo uso y con vencimiento. Los flujos públicos no deben permitir enumeración de emails.

Las mutaciones requieren token CSRF ligado a sesión, validación de `Origin`/`Sec-Fetch-Site` y content type JSON. Login, reset e invitaciones deben tener límites persistentes por IP e identidad normalizada; la API debe contar además con rate limiting general en el borde.

HTTPS es obligatorio. Deben configurarse CSP estricta con nonce, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, `nosniff`, Referrer Policy, Permissions Policy mínima y Trusted Types donde esté disponible.

Los archivos cargados deben validarse por contenido real, extensión, tamaño y dimensiones. Deben recibir nombres generados y servirse desde almacenamiento sin ejecución activa.

## 12. PWA, criptografía y operación offline

La PWA usa manifest App Router, service worker propio y Dexie sobre IndexedDB. Cache Storage solo puede contener app shell y assets públicos versionados; está prohibido cachear respuestas privadas del API.

El modo offline requiere Service Worker, IndexedDB y Web Crypto. Si faltan capacidades, la aplicación online sigue disponible pero no puede autorizar el dispositivo para POS offline.

Cada dispositivo autorizado genera una clave ECDSA P-256 no exportable. El servidor almacena la pública y emite grants JWS vinculados a usuario, organización, dispositivo, rol/scope, sucursal, cajas, versión de configuración y expiración máxima de 72 horas.

El usuario desbloquea offline mediante un PIN específico de usuario/dispositivo. Una DEK AES-256-GCM protege los datos y se envuelve mediante una clave no exportable del dispositivo y una KEK derivada con Argon2id. Los parámetros deben estar versionados. Los intentos fallidos deben aplicar backoff y, tras el límite definido, exigir reautenticación online sin borrar ciphertext ni operaciones pendientes.

Cada registro sensible se cifra con IV único y AAD que incluya schema version, organización, dispositivo, tipo e ID. Los datos se aíslan lógicamente por organización, dispositivo y usuario. Nunca se guardan contraseñas ni tokens online reutilizables.

La cola offline es append-only. Cada operación contiene UUID, secuencia de dispositivo y sesión, `prev_hash`, payload canónico, hash, actor, grant/config version, timestamps y firma ECDSA. Una operación confirmada localmente no puede editarse.

Toda operación confirmada localmente debe incluir, en la misma confirmación IndexedDB, un sobre opaco inmutable cifrado para el servidor. La lectura y creación permanecen ligadas a la identidad; una capacidad de dispositivo separada puede entregar sobres ya sellados después de logout o revocación y recibir solo ACKs mínimos. Este canal exige prueba fresca de posesión, no contiene credenciales bearer y no concede lectura tenant ni creación de operaciones. Las claves servidor se rotan sin retirar las necesarias para pendientes o incertidumbre histórica.

El sync debe:

1. procesar dependencias antes que dependientes;
2. validar firma, grant, versiones, secuencia, hash chain, idempotencia y contrato;
3. confirmar cada operación de negocio en una transacción independiente;
4. devolver un ACK estable por operación;
5. limpiar localmente solo después del ACK definitivo;
6. preservar y mostrar conflictos o errores recuperables;
7. aplicar revocaciones después de recibir operaciones legítimas selladas con el conocimiento anterior.

La sincronización debe ejecutarse al recuperar conectividad, volver al foreground, por acción manual y mediante Background Sync cuando exista. La corrección funcional no puede depender de Background Sync.

El cierre normal de caja exige dispositivo operativo único, cola vacía, hash chain completa y checkpoint final verificable. Una actualización de PWA o migración IndexedDB no puede descartar ni volver incompatible una cola pendiente.

Las garantías criptográficas de una PWA no equivalen a un dispositivo nativo con hardware confiable. El threat model y esta limitación deben permanecer documentados; CSP, revisión de dependencias y reducción de XSS son controles críticos.

## 13. Frontend y diseño

Next.js debe usar Server Components para shell y contenido inicial cuando aporte valor, y Client Components para POS, formularios interactivos, IndexedDB y Web Crypto. Toda escritura comercial utiliza el cliente REST compartido.

El estado remoto se gestiona con TanStack Query. Zustand solo se usa para contexto activo, estado efímero POS y sincronización; no replica indiscriminadamente la base servidor. React Hook Form + Zod gestiona formularios.

`DESIGN.md` es obligatorio para tokens y lenguaje visual. `packages/ui` debe materializarlo con CSS variables, Tailwind CSS y primitivas accesibles basadas en Radix UI. Plus Jakarta Sans se carga mediante `next/font`.

La interfaz es mobile-first. Debe mantener navegación por teclado, foco visible, labels, semántica, estados ARIA, contraste mínimo 4.5:1 y alternativas textuales para gráficos. No puede usar solo color para comunicar estados.

El glassmorphism debe ser moderado. Blur y motion deben reducirse mediante preferencias del usuario y fallbacks de rendimiento. La acción verde vibrante se reserva para avance o interacción activa, conforme a `DESIGN.md`.

## 14. Jobs, reportes y archivos

Los jobs usan una outbox PostgreSQL confirmada junto con el negocio. El worker reclama filas mediante `FOR UPDATE SKIP LOCKED`, lease, número de intentos, backoff exponencial y dead-letter. Todo handler debe ser idempotente por `job_key`.

No se introduce Redis en el MVP. Email y object storage se abstraen mediante puertos sustituibles.

Los CSV se generan en streaming y neutralizan formula injection. Los PDF de reportes se generan de forma asíncrona; los comprobantes individuales pueden generarse síncronamente desde snapshots. Los archivos resultantes se almacenan en un servicio S3-compatible y se descargan mediante URLs firmadas de corta duración.

El worker debe reconstruir el tenant y volver a validar el alcance del actor antes de generar un reporte. Un job no puede reutilizar ciegamente filtros ni permisos históricos.

## 15. Auditoría y observabilidad

Toda operación relevante debe escribir auditoría en la misma transacción. Los eventos incluyen tenant, actor, sucursal, dispositivo, request/operation ID, entidad, acción, timestamp y `before/after` limitado mediante allowlist.

La auditoría es append-only. El rol runtime no puede actualizarla ni borrarla y un trigger defensivo debe rechazar esos intentos. Contraseñas, tokens, cookies, credenciales y secretos nunca se auditan.

La observabilidad base utiliza:

- Pino para logs JSON estructurados y redacción central;
- OpenTelemetry para trazas y métricas exportadas por OTLP;
- métricas Prometheus;
- health checks separados de liveness y readiness;
- correlación por `trace_id`, `request_id`, operation ID y job ID.

Tenant/user/device solo se agregan a logs cuando sean necesarios y seguros. Las métricas no deben usar identificadores tenant como labels de alta cardinalidad.

Se deben alertar indisponibilidad persistente, fallos de base, error rate anormal, dead letters, fallos persistentes de sync y conflictos que excedan el umbral operativo. Un fallo aislado recuperable debe reintentarse antes de alertar.

## 16. Migraciones, despliegue y recuperación

Todas las migraciones son versionadas, deterministas, revisables y almacenadas en el repositorio. Drizzle Kit puede generarlas, pero RLS, roles, triggers, funciones, índices y constraints avanzados se expresan mediante SQL manual cuando corresponda.

Está prohibido ejecutar schema push automático en producción. CI debe verificar migración desde base vacía y desde la versión anterior. El despliegue ejecuta un único job de migración antes de iniciar la nueva versión.

El entorno local debe proveer PostgreSQL, object storage compatible, email de desarrollo y collector de observabilidad mediante Compose.

Producción despliega contenedores `web`, `api` y `worker` detrás del mismo origen HTTPS. `/api/v1` se enruta al API. Los secretos provienen del secret manager del proveedor; ningún contenedor conserva archivos operativos como almacenamiento persistente.

La base debe respaldarse automáticamente al menos cada 24 horas en almacenamiento cifrado e independiente del primario, con retención mínima de 30 días. La estrategia inicial conserva 35 días.

Debe ejecutarse una restauración mensual en un entorno aislado, seguida por migraciones, checks de integridad/ledger y smoke tests. El runbook debe permitir medir y sostener RPO ≤24 h y RTO objetivo ≤8 h.

## 17. Política de pruebas

Las herramientas base son:

- Vitest para unitarios;
- fast-check para invariantes/property-based;
- Testcontainers con PostgreSQL real para integración;
- Supertest para API NestJS;
- Playwright para E2E y navegadores;
- axe-core y Testing Library para accesibilidad;
- fake-indexeddb únicamente para pruebas unitarias offline.

SQLite está prohibido como sustituto de PostgreSQL en integración. RLS, locks, constraints, migraciones, transacciones e idempotencia deben probarse contra PostgreSQL real.

Los mocks se limitan a puertos externos, reloj y entropía. No deben mockearse repositorios en pruebas cuyo objetivo sea demostrar atomicidad, concurrencia o aislamiento.

Los flujos críticos deben cubrir al menos:

- separación cross-tenant y branch scope;
- permisos por rol;
- dinero/redondeo;
- stock concurrente;
- caja y cierres;
- venta/compra/gasto y anulaciones;
- reintentos idempotentes;
- pérdida y retorno de conectividad;
- revocación y expiración offline;
- actualización PWA con cola pendiente;
- conflictos y late data;
- exportaciones autorizadas;
- restauración de backup.

CI debe ejecutar `lint`, `typecheck`, unitarios, integración/migraciones, build y E2E crítico. Cada defecto de concurrencia, aislamiento o sincronización requiere primero una prueba de regresión reproducible.

## 18. Reglas de cambio y excepciones

Una decisión puede diferirse únicamente si no afecta modelo de datos, contratos, seguridad, consistencia ni arquitectura central. Las decisiones diferidas deben registrarse en el `plan.md` aplicable.

Agregar una dependencia requiere justificar responsabilidad, mantenimiento, seguridad, peso y compatibilidad con el stack. Una dependencia no puede reemplazar la comprensión de las invariantes del dominio.

Una excepción a esta constitución debe:

1. identificar la regla afectada;
2. explicar por qué el cumplimiento impide el objetivo;
3. documentar alternativas y riesgos;
4. recibir aprobación explícita;
5. quedar registrada en la constitución o plan aprobado antes de implementar.

Los cambios constitucionales usan versionado semántico:

- `PATCH`: aclaración sin cambio de obligación.
- `MINOR`: nueva regla compatible o ampliación de guía.
- `MAJOR`: eliminación, inversión o cambio incompatible de una regla existente.

Cada modificación debe actualizar versión, fecha y motivo, y revisar los planes pendientes o aprobados que puedan quedar en conflicto.

## 19. Decisiones deliberadamente diferidas

Pueden elegirse más adelante sin alterar esta arquitectura:

- proveedor concreto de hosting;
- proveedor PostgreSQL administrado;
- proveedor S3-compatible;
- proveedor de email;
- backend de observabilidad compatible con OTLP;
- CDN y edge rate limiting concretos;
- particionado de tablas de auditoría/ledgers cuando el volumen lo justifique;
- incorporación futura de read replicas o Redis basada en métricas.

No están diferidos y no pueden reinterpretarse durante implementación: shared-schema multi-tenant con RLS, unidad de trabajo transaccional, Drizzle + `node-postgres`, sesiones opacas, aritmética decimal, ledgers inmutables, dispositivo exclusivo de caja, cifrado/firmas offline, idempotencia persistente y pruebas PostgreSQL reales.
