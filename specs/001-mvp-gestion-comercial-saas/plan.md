# Plan técnico — MVP Sistema de Gestión Comercial SaaS — ESTADO: APROBADO

> D01 (§6.4) y D02 (§11.1.1) están resueltas e incorporadas al spec. Plan aprobado por la autorización explícita de completar todo lo necesario para dejar el proyecto listo para build.

## 1. Objetivo y restricciones

Implementar el spec cerrado como un SaaS web/PWA multi-tenant, con PostgreSQL como fuente de verdad, POS online y continuidad offline limitada. El diseño será un monolito modular TypeScript desplegado como aplicaciones web, API y worker del mismo repositorio y artefacto backend. No se introducen microservicios, event sourcing, CQRS distribuido, Redis ni Kubernetes.

`constitution.md` es la norma técnica transversal del proyecto y este plan se ajusta a ella. `DESIGN.md` es la convención visual aplicable: UcoNext, mobile-first, Plus Jakarta Sans, paleta verde, superficies glass moderadas, contraste mínimo 4.5:1 y degradación de blur en dispositivos modestos. `AGENTS.md` funciona como guía operativa derivada de estos documentos y no altera su precedencia.

## 2. Base técnica y decisiones propuestas

| Área | Decisión | Justificación |
| --- | --- | --- |
| Repositorio | `pnpm` workspaces + Turborepo | Mantiene tres paquetes compartidos y dos aplicaciones con bajo costo cognitivo. |
| Frontend | Next.js App Router + React + TypeScript | Soporta PWA, layouts responsive y composición server/client sin duplicar aplicaciones. |
| Backend | NestJS modular | DI, guards, pipes, módulos y testing encajan con el número de dominios y reglas de autorización. |
| API | REST JSON versionada en `/api/v1` | Contrato simple para web, PWA, sincronización y futuras integraciones. No se usarán Server Actions para mutaciones de negocio. |
| Persistencia | PostgreSQL + `node-postgres` + Drizzle ORM/Kit | Drizzle cubre esquema y CRUD; SQL explícito cubre locks, RLS, constraints y consultas especializadas. |
| Tenancy | Esquema compartido con `organization_id`, FKs compuestas y RLS | Menor costo operativo con aislamiento en aplicación, constraints y base de datos. |
| Contexto RLS | Transacción obligatoria por unidad de trabajo + `SET LOCAL` | Evita fuga de contexto entre conexiones del pool. |
| Concurrencia | `READ COMMITTED`, locks pesimistas ordenados y constraints | Resuelve stock/caja sin elevar todo el sistema a `SERIALIZABLE`. Los errores transitorios se reintentan de forma acotada. |
| Cantidades/dinero | PostgreSQL `numeric(20,3)`/`numeric(20,2)` + `decimal.js`; JSON decimal como string | Evita `float`/`number` y conserva reglas `HALF_UP` end-to-end. |
| Auth online | Sesiones opacas persistidas en PostgreSQL y cookie segura | Permite revocación inmediata sin listas de bloqueo JWT. |
| Validación | Zod 4 en contratos compartidos y pipes Nest propios | Un esquema valida API, cliente y payload offline sin compartir entidades de infraestructura. |
| Estado frontend | TanStack Query para servidor; Zustand solo para sesión/contexto POS; React Hook Form + Zod | Separa caché remota, estado efímero y validación de formularios. |
| Persistencia offline | Dexie sobre IndexedDB, cifrado por registro y cola append-only | IndexedDB es la persistencia PWA adecuada; Dexie simplifica transacciones y migraciones locales. |
| Desbloqueo offline | PIN por usuario/dispositivo, Argon2id y claves Web Crypto no exportables | Equilibra compatibilidad del navegador, cifrado en reposo y dispositivo autorizado. |
| Integridad offline | JWS de grant + ECDSA P-256 por dispositivo + secuencia/hash chain por sesión | Vincula configuración, identidad, dispositivo y orden de operaciones; no depende solo del reloj local. |
| Idempotencia | Registro permanente por operación + hash canónico del request | Los reintentos concurrentes devuelven el resultado original y detectan reutilización con otro payload. |
| Jobs | Outbox y worker PostgreSQL con `FOR UPDATE SKIP LOCKED` | Emails y exportaciones asíncronas sin agregar Redis. |
| Archivos | Almacenamiento S3-compatible mediante puerto | Archivos de las capacidades aprobadas; el proveedor queda reemplazable. |
| PDFs | `@react-pdf/renderer`; CSV en streaming | Comprobantes pequeños síncronos y reportes asíncronos paginados. |
| Observabilidad | Pino JSON + OpenTelemetry OTLP + métricas Prometheus + health checks Nest | Señales portables y correlacionadas sin fijar proveedor. |
| Tests | Vitest, Supertest, Testcontainers PostgreSQL, Playwright, axe-core y fast-check | Las garantías RLS, transaccionales y offline se prueban con infraestructura real; mocks solo en lógica pura. |
| Despliegue | Contenedores `web`, `api` y `worker`, PostgreSQL administrado y object storage | Un único monolito modular con procesos escalables independientemente, sin microservicios. |

## 3. Arquitectura lógica

```text
Browser / PWA
  ├─ Next.js shell + módulos UI
  ├─ IndexedDB cifrado + cola offline
  └─ Service Worker (app shell y coordinación de sync)
           │ HTTPS, REST, cookie + CSRF / device proof
           ▼
NestJS modular monolith
  ├─ HTTP controllers + validation + guards
  ├─ application use cases + policy checks
  ├─ domain policies/value objects/state machines
  ├─ Drizzle repositories + SQL crítico
  ├─ audit + idempotency + transactional outbox
  └─ worker entrypoint (email, reports, cleanup)
           │ transaction + SET LOCAL + RLS
           ▼
PostgreSQL ─────────────── S3-compatible object storage
```

Los controladores solo adaptan HTTP. Los casos de uso poseen el límite transaccional. Las entidades/políticas de dominio no importan NestJS, Drizzle ni componentes web. Los módulos se comunican mediante servicios de aplicación o puertos públicos; no acceden a tablas ajenas desde controladores. `reports` es la excepción controlada: posee consultas read-only que cruzan módulos bajo RLS y autorización.

## 4. Estructura de archivos prevista

```text
/
├─ apps/
│  ├─ web/
│  │  ├─ app/
│  │  │  ├─ (auth)/login/ reset-password/ accept-invitation/
│  │  │  ├─ (app)/[organizationId]/[branchId]/
│  │  │  │  ├─ dashboard/ pos/ catalog/ inventory/ cash/
│  │  │  │  ├─ customers/ suppliers/ purchases/ expenses/
│  │  │  │  ├─ reports/ audit/ users/ settings/
│  │  │  ├─ manifest.ts
│  │  │  ├─ global-error.tsx
│  │  │  └─ layout.tsx
│  │  ├─ src/
│  │  │  ├─ features/<domain>/{api,components,hooks,schemas}/
│  │  │  ├─ lib/api/{client,problem-details,query-client}.ts
│  │  │  ├─ lib/auth/ lib/tenant-context/ lib/format/
│  │  │  ├─ offline/
│  │  │  │  ├─ db/{schema,migrations,encrypted-store}.ts
│  │  │  │  ├─ crypto/{argon2,keys,envelope,canonicalize}.ts
│  │  │  │  ├─ grants/ queue/ sync/ session-chain/
│  │  │  │  └─ service-worker/
│  │  │  └─ test/{fixtures,fake-indexeddb}/
│  │  ├─ public/icons/
│  │  ├─ next.config.ts
│  │  └─ playwright.config.ts
│  └─ api/
│     ├─ src/
│     │  ├─ main.ts
│     │  ├─ worker.ts
│     │  ├─ app.module.ts
│     │  ├─ core/
│     │  │  ├─ auth/ tenancy/ authorization/ database/
│     │  │  ├─ idempotency/ audit/ outbox/ objects/
│     │  │  ├─ errors/ validation/ observability/ security/
│     │  │  └─ decimal/ time/
│     │  ├─ database/
│     │  │  ├─ schema/{identity,organization,catalog,inventory}.ts
│     │  │  ├─ schema/{cash,sales,purchases,expenses,offline}.ts
│     │  │  ├─ schema/{audit,jobs,reports}.ts
│     │  │  ├─ migrations/
│     │  │  └─ seeds/
│     │  └─ modules/
│     │     ├─ auth/ platform-admin/ organizations/ users/ branches/
│     │     ├─ catalog/ inventory/ cash/ sales/ customers/
│     │     ├─ suppliers/ purchases/ expenses/ offline-sync/
│     │     └─ audit/ dashboard/ reports/
│     ├─ test/{integration,e2e,concurrency,security}/
│     └─ drizzle.config.ts
├─ packages/
│  ├─ shared/src/{contracts,enums,value-schemas,problem-details}/
│  ├─ ui/src/{tokens,primitives,patterns,forms,feedback}/
│  └─ config/{typescript,eslint,vitest}/
├─ ops/
│  ├─ docker/ compose.yaml
│  ├─ migrations/ run-migrations.ps1
│  ├─ backup/ backup.ps1
│  ├─ restore/ restore-runbook.md
│  └─ observability/{otel-collector,prometheus-alerts}/
├─ package.json
├─ pnpm-workspace.yaml
├─ turbo.json
└─ .env.example
```

Cada módulo backend usa `domain/`, `application/`, `infrastructure/` y `presentation/http/` solo cuando tenga contenido real. Módulos CRUD simples pueden agrupar archivos, pero conservan la dirección de dependencias `presentation → application → domain`, con infraestructura implementando puertos.

## 5. Módulos y responsabilidades

| Módulo | Responsabilidad y API interna |
| --- | --- |
| `auth` | Usuarios globales, password Argon2id, sesiones opacas, reset, CSRF y rate limits. |
| `platform-admin` | Provisioning excepcional con pool/rol DB restringido y auditoría global. |
| `organizations` | Perfil, moneda, timezone, medios de pago y bloqueo estructural. |
| `users` | Membresías, OWNER invariant, sucursales asignadas e invitaciones. |
| `branches` | Sucursales, cajas y su activación/inactivación. |
| `catalog` | Ítems, tipos/unidades, categorías, precios y snapshots de catálogo. |
| `inventory` | Balance por sucursal, ledger, ajustes, transferencias, mínimos e incidencias offline. |
| `cash` | Sesiones, dispositivo exclusivo, movimientos, cierres, diferencias y conciliaciones. |
| `sales` | Cotización no persistida, confirmación, pagos mixtos, recibo y anulación. |
| `customers` | Ficha global tenant y permisos diferenciados de CASHIER. |
| `suppliers` | Ficha global tenant y lectura contextual de EMPLOYEE. |
| `purchases` | Compra `PENDING_PAYMENT`/`PAID`, pago total, inventario y anulación. |
| `expenses` | Gastos pagados, efecto de caja y anulación total. |
| `offline-sync` | Grants, bootstrap, envelopes firmados, hash chains, push/pull, conflictos y late data. |
| `audit` | Eventos append-only, consultas autorizadas y redacción. |
| `dashboard` | Agregados operativos sin costo/margen. |
| `reports` | Read models, filtros, exports CSV/PDF y jobs. |

## 6. Modelo de datos y constraints

### 6.1 Convenciones

- PK UUID v4 generada con `crypto.randomUUID()`; las operaciones offline generan el UUID en el cliente.
- Todas las tablas tenant incluyen `organization_id`; toda relación tenant usa FK compuesta `(organization_id, foreign_id)` hacia una clave única equivalente.
- Fechas en `timestamptz` UTC; la zona de organización solo interpreta entrada, presentación y límites de reportes.
- Dinero `numeric(20,2)`, cantidad `numeric(20,3)`, porcentaje `numeric(7,4)`. El API intercambia estos valores como strings canónicos.
- Estados como `text` con `CHECK`; evita la rigidez de enums PostgreSQL en migraciones futuras.
- Filas mutables llevan `version bigint` para optimistic concurrency y `updated_at`.
- Recursos con historia se desactivan mediante `status`; la eliminación física usa FK `RESTRICT` y un caso de uso que comprueba ausencia de referencias.
- SKU, barcode, identificadores fiscales, nombres de sucursal/caja y email usan columnas normalizadas e índices únicos según el spec. Los inactivos conservan la reserva del valor.

### 6.2 Tablas principales

| Área | Tablas y campos esenciales |
| --- | --- |
| Identidad | `users`, `auth_sessions(token_hash, idle_expires_at, absolute_expires_at, revoked_at)`, `password_reset_tokens`, `platform_admins`, `security_audit_events`. |
| Tenant | `organizations(base_currency, timezone, profile, operational_history_started_at)`, `memberships(role,status,revoked_at)`, `membership_branches`, `invitations(status,token_hash,expires_at)`. |
| Sucursales | `branches(status,name_norm)`, `cash_registers(status,name_norm)`, `payment_method_settings(method,enabled)`. |
| Catálogo | `catalog_categories`, `expense_categories`, `catalog_items(type,track_inventory,base_unit,price,price_version,status,sku_norm,barcode_norm,structural_locked_at)`. |
| Inventario | `branch_stocks(quantity,version)`, `stock_thresholds`, `inventory_movements(delta,source_type,source_id,source_line_id,effect_kind)`, `inventory_adjustments`, `stock_transfers`, `stock_transfer_lines`, `inventory_incidents`, `inventory_incident_sources`, `inventory_incident_corrections`. |
| Caja | `cash_sessions(status,owner_user_id,device_id,opening_cash,expected_cash,server_sync_seq,completeness)`, `cash_session_state_transitions`, `cash_movements(type,amount,source)`, `cash_closures`, `cash_difference_reviews`, `cash_session_conflicts`, `late_recovered_operations`. La exclusión única se aplica solo a la sesión normal bloqueante de una caja; una apertura offline incompatible se conserva como otra fila `CONFLICTED`. |
| Ventas | `sales(customer_id,currency,subtotal,discount,total,client_operation_id,receipt_snapshot)`, `sale_items` con snapshots, `sale_payments`, `sale_cancellations`, `sale_refunds`; estado actual derivado de confirmación/cancelación. |
| Partes | `customers(status,tax_id_norm,...)`, `suppliers(status,tax_id_norm,...)`. |
| Compras | `purchases(supplier_id,currency,total,client_operation_id)`, `purchase_items` con snapshots, `purchase_payments`, `purchase_cancellations`, `purchase_payment_reversals`; estado actual derivado de confirmación/pago/cancelación. |
| Gastos | `expenses(expense_category_id,amount,method,concept)`, `expense_cancellations`; estado actual derivado de creación/cancelación. |
| Offline | `devices(status,public_key,last_seen_at,last_config_version)`, `device_delivery_certificates(cert_id,context_hash,public_key_thumbprint,version)`, `offline_grants(jti,payload_hash,expires_at,revoked_at)`, `sync_operations(device_seq,session_seq,payload_hash,prev_hash,status)`, `sync_delivery_challenges(jti_hash,expires_at,used_at)`, `sync_checkpoints`, `configuration_versions`, `sync_conflicts`. Localmente, una base física por organización/dispositivo contiene stores particionados por identidad y una `delivery_queue` común con sobres opacos. |
| Transversal | `idempotency_records(scope,key,request_hash,status,response_code,response_body,resource_id,actor_user_id,branch_id,authorization_class)`, `audit_events`, `outbox_jobs`, `report_exports`, `object_files`. |

### 6.3 Ledger y proyecciones

`inventory_movements` y `cash_movements` son ledgers append-only; `branch_stocks.quantity` y `cash_sessions.expected_cash` son proyecciones transaccionales. Inventario usa unique `(organization_id, source_type, source_id, source_line_id, effect_kind)`, con todas esas columnas NOT NULL; TRANSFER_OUT/TRANSFER_IN distinguen los dos efectos. Caja usa unique `(organization_id, source_type, source_id, effect_kind)` consolidando líneas del mismo efecto. Movimiento y proyección se confirman juntos. El verificador alerta divergencias sin autocorregir.

`audit_events`, `inventory_movements`, `cash_movements`, el contenido económico confirmado y sus snapshots no admiten `UPDATE`/`DELETE` por el rol runtime. Los cambios de estado aprobados se representan mediante registros append-only de pago, cancelación o transición; una proyección mutable separada puede exponer el estado actual mediante funciones o repositorios acotados. El rol runtime no puede modificar líneas, importes ni snapshots. Triggers defensivos rechazan esas mutaciones aun ante errores de repositorio. Las reversiones insertan documentos/movimientos compensatorios.

### 6.4 D01 — Preservación histórica offline aprobada

RF-302–RF-308 complementan RF-06/07, RF-54/55 y RF-159/160. Se distinguen historial confirmado e incertidumbre offline: ambos bloquean cambios destructivos o estructurales, pero solo la ausencia demostrada de ambos permite esos cambios. Desactivar no libera referencias ni versiones; se mantienen los permisos y precondiciones de cada recurso.

Persistencia: `offline_configuration_exposures` registra organización, dispositivo, grant/época y versión que pudo usarse; `offline_exposure_resources` identifica los maestros alcanzados. Las relaciones usan FKs tenant compuestas. La moneda utiliza además `organizations.currency_permanently_locked_at` y una referencia a la declaración auditada de dispositivo irrecuperable. Este bloqueo es irreversible en el MVP aunque reaparezca el dispositivo. La incertidumbre de productos solo puede liberarse mediante prueba posterior; si se descubre historia real, pasa a aplicar el bloqueo histórico.

Implementación de lifecycle de catálogo: las exposiciones append-only referencian identidades tenant persistentes de ítems/categorías. Así conservan la evidencia aun cuando el maestro sin historia se borre tras liberar la exposición. Cada versión firmada registra `config_epoch`; las mutaciones de estado, estructura y borrado del catálogo avanzan la época bajo el lock de organización, y un grant nuevo solo acepta una versión de la época actual. Las rutas NestJS `/api/v1/catalog/items/:id/status`, `/structure`, `DELETE /api/v1/catalog/items/:id`, `/api/v1/catalog/categories/:id/status` y `DELETE /api/v1/catalog/categories/:id` exigen sesión tenant, CSRF, `If-Match` e `Idempotency-Key`.

La exposición se registra transaccionalmente ANTES de entregar configuración/grant utilizable. Una respuesta perdida conserva la exposición; un reintento es idempotente. Expiración, logout, revocación, ausencia de operaciones en servidor y declaración de pérdida nunca la liberan por sí solos. Las versiones necesarias para historia o exposición no se purgan.

La barrera para cambios estructurales congela de forma durable la creación local bajo la época anterior en todas las identidades/pestañas relevantes, drena operaciones y obtiene un checkpoint firmado con secuencia/hash y ACKs definitivos. El servidor confirma continuidad y cierre de todas las autorizaciones relevantes. Un checkpoint ordinario de sync no basta si aún permite crear operaciones con esa configuración. Un dispositivo inaccesible conserva incertidumbre.

Bajo el lock de lifecycle de organización y después los de catálogo en orden canónico, se revalidan historial, exposiciones, versiones y bloqueo permanente antes de confirmar la mutación con auditoría e idempotencia. Bootstrap/emisión de grants, liberación de exposiciones, primera operación y declaración de irrecuperable usan la misma coordinación: no puede aparecer una autorización antigua entre la prueba y el commit. Un cambio de versión no reactiva grants anteriores. Tras el commit, un dispositivo solo reanuda con configuración y autorización nuevas verificadas.

El ámbito se limita a moneda, semántica estructural y eliminación de recursos efectivamente referenciables offline; no impide cambios de precio ni convierte una descarga pública en historia. La desactivación de sucursal conserva las restricciones específicas de RF-28; D01 no autoriza omitirlas.

Las operaciones tardías usan la versión histórica para moneda, unidad, tipo y control de inventario y conservan sus IDs originales. No se altera el snapshot del cierre excepcional. La UI distingue bloqueo histórico, incertidumbre pendiente y bloqueo permanente de moneda sin revelar dispositivos u operaciones fuera de scope.

Pruebas obligatorias: configuración entregada con respuesta perdida; checkpoint obsoleto; grants múltiples; dos dispositivos donde solo uno sincronizó; nueva operación frente a barrera; cambio frente a emisión de grant; pérdida/reaparición del dispositivo; moneda permanentemente bloqueada; liberación sin historia; pendientes que revelan historia; desactivación y late data íntegra.

## 7. Tenancy, seguridad y autorización

### 7.1 RLS y unidad de trabajo

El pool usa un rol `uco_app` sin `BYPASSRLS`. Toda unidad de trabajo tenant:

1. obtiene un `PoolClient`;
2. ejecuta `BEGIN`;
3. ejecuta `SELECT set_config('app.organization_id', $1, true)`, `app.user_id` y `app.request_id`;
4. verifica membresía/rol/scope vigentes para comandos online; la ingestión histórica usa exclusivamente §11.3.1 dentro de la misma transacción, sin omitir identidad ni RLS;
5. ejecuta repositorios únicamente con `TenantTransaction`;
6. inserta auditoría/outbox/idempotencia;
7. confirma o revierte y libera la conexión.

La política RLS base usa `organization_id = nullif(current_setting('app.organization_id', true),'')::uuid`; sin contexto resulta en cero filas/default deny. RLS delimita tenant. `AuthorizationService` y guards aplican permisos y sucursales; los constraints compuestos impiden asociaciones cruzadas aunque falle una validación de aplicación.

`platform-admin` usa un pool separado y un rol DB limitado a funciones de provisioning explícitas; no reutiliza el pool tenant ni obtiene acceso operativo general.

Los flujos que todavía no poseen organización activa se separan explícitamente de las unidades de trabajo tenant:

- login, reset y descubrimiento de membresías usan repositorios globales con grants mínimos sobre tablas de identidad y una vista segura de membresías del usuario autenticado;
- el dispatcher de outbox usa una función `SECURITY DEFINER` con `search_path` fijo; su propietario es un rol NOLOGIN sin BYPASSRLS, con privilegios y política RLS exclusivos para reclamar metadatos de outbox entre organizaciones mediante lease. No tiene acceso a tablas comerciales. Solo el worker tiene EXECUTE; PUBLIC y el rol web no lo tienen. La función no acepta SQL ni tenant arbitrario y devuelve únicamente job ID, organization ID, tipo y lease; el payload se lee después bajo RLS tenant;
- cada handler abre después una `TenantTransaction`, reconstruye `organization_id`/actor/scope y vuelve a autorizar antes de leer datos o producir archivos;
- provisioning y recuperación OWNER siguen usando el pool de plataforma separado.

Ninguno de estos mecanismos concede `BYPASSRLS` a `uco_app` ni permite enumerar datos tenant.

### 7.2 Sesiones online

- Cookie `__Host-uco_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, sin `Domain`, path `/`.
- Token aleatorio de 256 bits; solo su SHA-256 se persiste. Expiración idle de 12 h y absoluta de 7 días; sin “recordarme” en MVP.
- Password Argon2id server-side con parámetros almacenados y rehash transparente al iniciar sesión.
- CSRF synchronizer token ligado a sesión, header `X-CSRF-Token`, validación `Origin`/`Sec-Fetch-Site` y JSON estricto en mutaciones.
- Cambio de contraseña, reset, desactivación de usuario y revocación invalidan sesiones aplicables. Cada request vuelve a validar membresía y scope.
- Reset/invitación usan tokens aleatorios de un solo uso almacenados hasheados; las respuestas públicas no revelan si existe el email.
- Rate limit persistente en PostgreSQL para login/reset/invitaciones por IP y email normalizado; rate limit general adicional en reverse proxy.

### 7.3 Políticas de autorización

`packages/shared` define `Role` y `Permission` fijos. Nest registra globalmente `SessionGuard`, `TenantGuard`, `PermissionGuard` y `BranchScopeGuard`; `DeviceSessionPolicy` valida las operaciones de caja. Los guards rechazan temprano, pero el caso de uso repite las comprobaciones sensibles dentro de la transacción para evitar TOCTOU.

Login/reset y provisioning tienen políticas explícitas separadas. `sync/push` con sesión vigente y el canal `delivery/push` sin sesión del actor convergen en la misma ingestión histórica de §11.3.1. El segundo exige certificado firmado, challenge de un solo uso y prueba de posesión del dispositivo; su guard solo admite entrega y ACK mínimo. Ninguna ruta omite RLS. Las pruebas comprueban que la excepción no alcanza lectura ni mutaciones ordinarias.

Los maestros globales tenant —catálogo, clientes, proveedores— no se filtran por sucursal para OWNER/ADMIN. Sus operaciones asociadas sí. CASHIER/EMPLOYEE reciben DTOs proyectados sin campos prohibidos; no se confía en ocultar columnas desde React.

### 7.4 Seguridad web

HTTPS obligatorio; CSP con nonce, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, Trusted Types donde esté disponible, `nosniff`, Referrer Policy y Permissions Policy mínima. El service worker se sirve con `no-cache` y CSP propia. Los artefactos aprobados generados por el sistema usan nombre generado, content type/disposition seguro, tamaño acotado y almacenamiento sin ejecución activa. El MVP no incorpora una función genérica de uploads.

## 8. Contratos HTTP

### 8.1 Convenciones

- Base `/api/v1`; JSON UTF-8; decimal y cantidad como string; IDs UUID.
- Contexto: `X-Organization-Id`; las rutas con sucursal llevan `branchId` y se valida el scope. El “contexto activo” del cliente nunca sustituye estas verificaciones.
- Mutaciones de documentos/movimientos exigen `Idempotency-Key`; modificaciones CRUD usan `If-Match` con `version`.
- Errores `application/problem+json`: `type`, `title`, `status`, `code`, `detail`, `instance`, `traceId`, `fieldErrors`; conflictos incluyen versión/total vigente seguro.
- Listados usan cursor opaco y `limit` acotado. Filtros se validan con allowlists.
- Zod 4 es fuente de contrato request/response. Nest usa pipes/decorators internos que reciben el schema; OpenAPI se genera en CI y se compara por snapshot.

### 8.2 Endpoints por capacidad

| Prefijo | Endpoints principales |
| --- | --- |
| `/auth` | `login`, `logout`, `me`, `csrf`, `forgot-password`, `reset-password`, `accept-invitation`. |
| `/platform/organizations` | `POST` provisioning; recuperación OWNER explícita. |
| `/organizations` | listar membresías, contexto, perfil, moneda/timezone, medios de pago. |
| `/memberships`, `/invitations` | alta, cambios de rol/scope, revocación, reenvío. |
| `/branches`, `/cash-registers`, `/devices` | CRUD/estado y autorización/revocación de dispositivo. |
| `/catalog/items`, `/catalog/categories`, `/expense-categories` | CRUD, estado, precios, umbrales y búsqueda/barcode. |
| `/inventory` | stocks, movements, `adjustments`, `transfers`, `incidents/:id/resolve`. |
| `/cash-sessions` | `open`, movements, `begin-close`, `final-sync`, `close`, conflict reconciliation, unrecovered-device close, difference review. |
| `/sales` | `quote`, `POST` confirmación, `:id/cancel`, `:id/receipt`, `:id/receipt.pdf`. |
| `/customers`, `/suppliers` | CRUD/estado con proyecciones por rol. |
| `/purchases` | `POST`, `:id/pay`, `:id/cancel`. |
| `/expenses` | `POST`, `:id/cancel`. |
| `/offline` | `authorize`, `bootstrap`, `sync/push`, `sync/pull`, `delivery/challenge`, `delivery/push`, `session-finalize`, `status`. `delivery/*` no confía en cookies ni `X-Organization-Id`: deriva el tenant de un certificado servidor y limita la respuesta a challenge/ACK. |
| `/dashboard`, `/reports` | agregados, datasets filtrados, `exports`, descarga firmada. |
| `/audit` | búsqueda autorizada append-only. |
| `/health/live`, `/health/ready`, `/metrics` | operación; métricas protegidas por red/credencial técnica. |

`POST /sales/quote` es stateless: no crea una venta. Devuelve precios/versiones y total. `POST /sales` vuelve a calcular; ante cambio de precio retorna `409 PRICE_CHANGED` con cotización actual para aceptación y reintento con la misma intención pero nueva clave.

## 9. Transacciones, locking e idempotencia

### 9.1 Patrón común

Cada comando crítico ejecuta: autenticar y validar autorización mínima para el comando → adquirir idempotencia → cargar y bloquear agregados en orden canónico → revalidar tenant/rol/scope/estado/versiones → calcular con Decimal → persistir documento y snapshots → insertar ledgers/proyecciones → auditoría/outbox → guardar respuesta idempotente → commit.

La tabla `idempotency_records` tiene unique `(organization_id, scope, key)`. El INSERT concurrente espera al competidor. SHA-256 del payload canónico RFC 8785 distingue replay de reutilización. Antes de devolver una respuesta persistida se revalidan los permisos actuales sobre recurso y sucursal; ser el actor original NO exime de autorización. Otro actor o uno revocado no lee la respuesta por conocer la clave. La ingestión histórica usa una clase separada, verifica dispositivo/actor/envelope originales y devuelve solo ACK mínimo. Un hash diferente produce `409 IDEMPOTENCY_KEY_REUSED`; el registro vive mientras exista el negocio.

### 9.1.1 Jerarquía global de locks

Jerarquía global: idempotencia → organización/sucursal cuando se coordina lifecycle → caja (`cash_registers`) al coordinar apertura/conflicto/cierre → sesiones por ID → documento cabecera → catálogo/versiones por ID → conjunto completo de stock por `(branch_id, item_id)` → incidencias/proyecciones. Solo se toman locks necesarios y nunca en orden inverso. Para anulación/pago, los IDs se leen inicialmente sin lock y se revalidan después de bloquear primero la sesión. Los reintentos repiten autorizaciones y validaciones.

Deadlocks/`40001`/`40P01` admiten hasta tres reintentos internos con jitter solo si el caso de uso conserva exactamente la misma clave. Después se devuelve `409 CONCURRENT_MODIFICATION` o `503 RETRYABLE_TRANSACTION` sin efectos parciales.

### 9.2 Inventario

Toda operación reúne todos los pares afectados `(branch_id, item_id)`, los ordena globalmente y bloquea `branch_stocks` con `FOR UPDATE` exactamente en ese orden. Tras adquirirlos valida estado y cantidades. Venta online, decremento, transferencia y anulación de compra exigen saldo suficiente. Compra/ajuste positivo incrementan. Venta offline sincronizada puede cruzar cero: inserta movimiento, actualiza saldo y crea/actualiza `inventory_incident` en la misma transacción.

Transferencia construye la unión de filas origen y destino y la bloquea por `(branch_id, item_id)` sin agrupar por dirección. Inserta header/líneas y dos movimientos por línea. Cada efecto usa una identidad única `(source_type, source_id, source_line_id, effect_kind)`, con `effect_kind=TRANSFER_OUT|TRANSFER_IN`; un constraint permite ambos efectos legítimos y rechaza repetir cualquiera. No existe estado intermedio.

### 9.3 Caja

Toda operación online ordinaria de efectivo bloquea sesión, valida OPEN, dispositivo, permisos y saldo, e inserta movimiento/proyección atómicamente. Se usa efectivo aplicado, no recibido. La ingestión histórica dispone de vías explícitas para OPEN, CONFLICTED y late data de CLOSED_WITH_UNRECOVERED_DEVICE; no reutiliza la política online OPEN-only ni permite nuevas operaciones en estados finales.

Toda apertura online o importación offline bloquea `cash_registers`. Online rechaza si existe cualquier sesión OPEN/CLOSING/CONFLICTED. El índice parcial unique `(organization_id, cash_register_id) WHERE status IN ('OPEN','CLOSING')` incluye sesiones de ambos orígenes: una apertura offline compatible pasa a OPEN. Una incompatible se conserva como otra fila CONFLICTED, fuera del índice, sin cambiar el estado de la preexistente.

El cierre normal usa un protocolo idempotente en dos barreras:

1. El dispositivo propietario congela localmente nuevas operaciones de la sesión y drena su cola. Operaciones selladas antes de la congelación todavía pueden ingresar al servidor.
2. `begin-close` recibe checkpoint firmado y versión, toma locks caja/sesión y comprueba que todas las operaciones hasta ese checkpoint estén aplicadas con ACK definitivo. Solo entonces confirma OPEN→CLOSING con `close_attempt_id`. Rechaza nuevos envelopes; acepta replay de los ya aplicados. La congelación local persiste entre pestañas y reloads.
3. `final-sync` verifica cadena, secuencia, ACKs y ausencia de pendientes/fallos/reintentos. Recalcula `expected_cash` dentro de la transacción bloqueada y recién entonces habilita ingresar el contado.
4. `close` vuelve a bloquear sesión, valida close_attempt_id, versión y estado, verifica/recalcula esperado y confirma snapshot, revisión y transición final juntos. Una respuesta perdida usa la misma clave idempotente.
5. `abort-close` exige usuario autorizado y dispositivo operativo: CASHIER solo su sesión; OWNER/ADMIN dentro de scope. Invalida close_attempt_id, audita y confirma CLOSING→OPEN. Un formulario antiguo no puede cerrar tras aborto/reapertura. Una caída deja CLOSING recuperable; un dispositivo irrecuperable usa cierre excepcional.

La conciliación conserva CONFLICTED durante su preparación y exige congelación local, checkpoint, versión y locks antes de confirmar CLOSED_CONFLICT_RESOLVED. No introduce CONFLICTED→CLOSING. OWNER/ADMIN registra contado, diferencia, motivo y auditoría. Si falta el dispositivo, usa cierre excepcional. Un conflicto comercial aceptado recibe ACKED con referencia a la incidencia; no es una operación pendiente de transporte.

### 9.4 Ventas

La confirmación online bloquea sesión, catálogo/precio y stock; valida pagos activos, calcula líneas `quantity × unit_price`, redondea cada línea `HALF_UP`, suma subtotal, calcula descuento y valida pagos/vuelto. Persiste snapshots, movimientos de stock/caja, recibo y auditoría en una transacción. Una venta cero conserva sesión, stock y recibo, pero no crea pago cero.

La anulación bloquea primero sesión de reintegro si existe, después venta, catálogo y stocks según §9.1.1. Verifica CONFIRMED y crea cancelación, refunds históricos y movimientos compensatorios sin modificar líneas originales.

### 9.5 Compras y gastos

Compra PAID confirma documento, stock, pago y caja atómicamente. EMPLOYEE siempre crea PENDING_PAYMENT. El pago posterior bloquea sesión si es efectivo y después compra; unique `(organization_id, purchase_id)` impide segundo pago. La anulación sigue la misma jerarquía y rechaza una reversión sin stock.

Gasto confirmado es inmutable. Su anulación total crea un registro separado; si fue efectivo, registra ingreso compensatorio en una sesión válida. Reportes excluyen anulados del neto sin ocultarlos.

## 10. Máquinas de estado

| Agregado | Estados y transiciones permitidas |
| --- | --- |
| Invitation | `PENDING → ACCEPTED | EXPIRED | REVOKED`; reenvío revoca token anterior. |
| Membership | `ACTIVE ↔ INACTIVE`, `ACTIVE → REVOKED`; invariant de al menos un OWNER activo. |
| Catalog/Customer/Supplier/Branch/Register | `ACTIVE ↔ INACTIVE`; delete solo sin historia. |
| Device | `ACTIVE → REVOKED`; revocado solo sincroniza operaciones anteriores legítimas. |
| Sale | creación directa `CONFIRMED → CANCELLED`; sin borrador ni segunda cancelación. |
| Purchase | creación `PENDING_PAYMENT | PAID`; `PENDING_PAYMENT → PAID`; ambos → `CANCELLED`. |
| Expense | creación `CONFIRMED → CANCELLED`. |
| CashSession servidor | Normal: `OPEN → CLOSING → CLOSED`, con `CLOSING → OPEN` por aborto auditado. Una apertura offline incompatible se conserva como una fila separada `CONFLICTED → CLOSED_CONFLICT_RESOLVED`; la sesión preexistente conserva su estado. Excepcional: `OPEN | CLOSING | CONFLICTED → CLOSED_WITH_UNRECOVERED_DEVICE` según autorización y evidencia disponible. |
| Cash difference | `PENDING_REVIEW → REVIEWED`; `SELF_REVIEW` es atributo de la transición. |
| Inventory incident | `OPEN → PENDING_REVIEW → RESOLVED`; nueva venta conflictiva devuelve a `OPEN`. |
| Local sync operation | PENDING → SYNCING → ACKED o SECURITY_REJECTED; los fallos recuperables/dependencias pendientes vuelven a PENDING. Un conflicto comercial ya aplicado recibe ACKED. |
| Report export | `QUEUED → RUNNING → READY | FAILED → EXPIRED`. |

Las transiciones viven en políticas de dominio y también se protegen con `CHECK`, FKs, índices únicos y `WHERE status = ...` en actualizaciones condicionales.

## 11. Diseño offline y sincronización

### 11.1 Bootstrap y claves

El dispositivo genera primero la privada ECDSA P-256 no exportable y entrega la pública exportable al servidor autenticado. Después se emiten bootstrap y grant con actor/tenant/dispositivo/rol/scope/cajas/versión. exp se calcula desde validación y sincronización online completas, con máximo 72 h; login o sync fallido no renuevan ese plazo.

El cliente genera una DEK AES-256-GCM protegida por clave de dispositivo y KEK derivada del PIN con Argon2id (`m=64 MiB`, `t=3`, `p=1`, versionados). Reautenticarse levanta el bloqueo de intentos, pero no deriva por sí solo la KEK: abrir o reenvolver la DEK requiere el PIN original y la clave de dispositivo. No se promete recuperación de PIN olvidado.

Cada registro IndexedDB usa IV aleatorio, AAD con versión/schema/organización/dispositivo/tipo/id y AES-GCM. Bases lógicas y claves separan organización/dispositivo/usuario. Solo se guarda el catálogo activo, precios/versiones, stock conocido, permisos, cajas, medios, grants, sesión local y cola mínima; no se cachean clientes.

Logout/cambio de usuario destruye material de desbloqueo en memoria, impide nuevas operaciones y conserva ciphertext por identidad. Otro usuario no hereda datos ni permisos. La entrega de pendientes funciona mediante los sobres opacos y el canal limitado definido en §11.1.1, sin exigir login al actor revocado.

Después de cinco PIN fallidos se aplica backoff exponencial persistente; después de diez se bloquea el desbloqueo hasta reautenticación online. Estos límites, su versión y los intentos no pueden resetearse cerrando o recargando la pestaña.

### 11.1.1 D02 — Entrega opaca después de logout o revocación

RF-309–RF-316 separan tres capacidades: leer datos locales, crear operaciones y entregar bytes ya sellados. El PIN/DEK controla lectura; el grant y políticas vigentes controlan creación; un certificado de entrega ligado a la clave no exportable del dispositivo solo permite transportar sobres existentes. Logout, cambio de usuario o revocación eliminan material de desbloqueo en memoria y deshabilitan creación, pero conservan mientras haya pendientes la clave de dispositivo, el certificado público y la cola opaca. La limitación de una PWA frente a código comprometido sigue declarada en §19.

Al autorizar el dispositivo, el servidor emite un certificado opaco autenticado y cifrado para el propio servidor. Su interior contiene `device_id`, `organization_id`, thumbprint de la clave pública y versión; otra identidad local no puede inspeccionarlo. No es bearer: exige la clave privada del dispositivo. Para cada operación se genera una CEK aleatoria AES-256-GCM; el payload canónico ya firmado, grant y contexto histórico se cifran con ella, y la CEK se envuelve con la clave pública RSA-OAEP-3072/SHA-256 vigente del servidor publicada en el bootstrap. El sobre exterior versionado contiene solo certificado opaco, operation ID aleatorio, key ID, hashes, ciphertext y firma del dispositivo. Los campos exteriores se duplican dentro y se comparan tras descifrar. No contiene sesión, contraseña ni token bearer.

`SyncEnvelopeDecryptorPort` abstrae la custodia de claves privadas. Una clave de ingestión no se retira mientras cualquier exposición D01 pueda haber generado sobres con ella, incluidos dispositivos irrecuperables; backup/restore prueba también disponibilidad de esas claves. La rotación publica una clave nueva para creación y conserva las anteriores solo para descifrado.

Una sola base IndexedDB por organización/dispositivo permite que una transacción incluya stores cifrados particionados por identidad y la `delivery_queue` opaca compartida. La creación toma un lease local con fencing token para la secuencia del dispositivo; prepara firma/cifrado, y una transacción verifica el fence/head y escribe registro de negocio, sobre y nuevo head. Si falla o pierde el lease, no confirma ni consume secuencia. Así se evita una falsa atomicidad entre bases separadas.

Tras logout o con otra identidad activa, el service worker o el coordinador en foreground solo enumera la cola común y transmite bytes opacos. La UI ajena no recibe metadatos del actor, tenant, documento o contenido; muestra a lo sumo progreso genérico del dispositivo. No puede editar, cancelar ni descifrar sobres.

`POST /offline/delivery/challenge` autentica y descifra el certificado opaco y emite un nonce JWS corto ligado a su hash/origin. `delivery/push` exige prueba ECDSA sobre challenge y hash exacto del lote; consume el JTI una sola vez, aplica rate limit y valida formato/tamaño antes de descifrar el sobre. El certificado no revive al usuario ni autoriza lecturas. Tras derivar el tenant del contexto autenticado, abre `TenantTransaction` y ejecuta la misma validación histórica que el push autenticado.

El servidor devuelve por operación un ACK JWS mínimo con operation ID, envelope hash, resultado estable y ack key ID. ACKED incluye conflictos comerciales ya persistidos; SECURITY_REJECTED no produce efectos. Un fallo de transporte, clave temporalmente indisponible, dependencia pendiente o respuesta incierta conserva exactamente el sobre y reintenta. Al verificar ACK definitivo, una transacción IndexedDB elimina/inutiliza el payload y actualiza evidencia mínima; para sobres ajenos no expone el resultado comercial.

Pruebas obligatorias: logout antes/durante push; usuario B activa sync sin observar datos de A; actor/membresía/dispositivo revocados; sobre nuevo o alterado; certificado/challenge falsificado, vencido o repetido; tenant/header interno discordante; pérdida de ACK; rotación/restauración de clave; múltiples pestañas; crash entre cifrado y commit; limpieza solo tras ACK firmado; negativas contra todos los endpoints ordinarios.

### 11.2 Operación local

Dexie contiene `meta`, `catalog`, `stock_snapshot`, `cash_sessions`, `operations`, `sync_attempts` y `key_envelopes`. Una transacción local confirma sesión/venta y agrega un envelope append-only con UUID, secuencia de dispositivo, secuencia de sesión, `prev_hash`, payload canónico, hash, actor, grant/config versions y timestamps. ECDSA firma el hash. La operación confirmada no se edita; una corrección espera conexión y usa el flujo de anulación online.

El POS valida localmente unidad, precisión, precios sincronizados, rol, caja/dispositivo y stock conocido. Aun así, el servidor es la autoridad. Se usa `navigator.storage.persist()` cuando está disponible y la UI muestra última sincronización, vigencia del grant, operaciones pendientes y riesgo de operar con stock desactualizado.

### 11.3 Protocolo

1. `bootstrap`: descarga snapshot completo tenant/sucursal autorizado y manifiesto firmado con versiones. Para el volumen PyME del MVP se evita un motor genérico de replicación.
2. `push`: envía lotes acotados, preservando orden/dependencias. Apertura se procesa antes de sus ventas. Cada envelope se confirma en una transacción independiente para no perder operaciones válidas por otro conflicto.
3. El servidor valida firma, grant, configuración conocida, secuencia/hash chain, idempotencia y payload; no confía solo en `occurred_at`.
4. `ack`: ACKED confirma persistencia de la operación incluso con incidencia de inventario o sesión CONFLICTED; permite limpiar payload. Un fallo recuperable conserva PENDING y SECURITY_REJECTED conserva evidencia sin efectos.
5. `pull`: devuelve nueva configuración/snapshot y revocaciones. Primero se intenta recibir operaciones legítimas selladas con el grant anterior; después se aplica la revocación conocida y se bloquean nuevas operaciones.
6. La app sincroniza al recuperar `online`, al abrir/volver al foreground, manualmente y mediante Background Sync si el navegador lo soporta. No se depende de Background Sync para corrección funcional en iOS.

### 11.3.1 Autorización histórica de ingestión

`sync/push` tiene una frontera distinta de una mutación online. Un challenge de corta duración demuestra posesión de la clave privada del dispositivo y habilita únicamente entregar envelopes existentes; no habilita catálogo, reportes ni nuevas operaciones. El servidor valida la firma, el grant histórico, actor/tenant/dispositivo originales, la versión de configuración, la secuencia y el punto de conocimiento de revocación registrado mediante checkpoints monotónicos.

Un grant vencido al recibirse puede acreditar una operación creada durante su vigencia; no legitima crear después de exp. Se combinan grant, versiones, cadena, checkpoints de conocimiento y evidencia temporal, conservando occurred_at/received_at. Una firma y secuencia demuestran integridad/orden, no una hora absoluta confiable en un dispositivo comprometido; se conserva la limitación PWA de §19. La autorización histórica no reactiva el actor.

El ACK JWS contiene solo ID, hash, resultado estable y key ID; no incluye recibos ni datos privados. Solo un ACK definitivo verificado permite eliminar payload. El canal de entrega opaca de §11.1.1 funciona sin reactivar al actor.

El worker/service worker no activa una nueva versión de esquema local mientras existan datos sin migrar. Las migraciones Dexie son forward-only, transaccionales y se prueban con bases de versiones previas.

### 11.4 Cierre, conflicto y datos tardíos

El checkpoint final incluye la última secuencia y hash de la cadena de la sesión. El servidor compara continuidad y operaciones procesadas antes del cierre. Aperturas incompatibles crean una sesión offline `CONFLICTED` separada; la sesión que ya existía conserva su estado y ambas quedan vinculadas mediante `cash_session_conflicts`. OWNER/ADMIN concilia sin fusionar y después de aplicar una barrera final equivalente a la del cierre normal.

Dispositivo irrecuperable produce `CLOSED_WITH_UNRECOVERED_DEVICE`, snapshot del conocimiento disponible y `completeness=UNKNOWN`. Si llegan después operaciones legítimas, se aplican a ventas/inventario/caja como late data, se conserva el snapshot original, se recalculan derivados actuales y se exige revisión; el estado nunca se promociona a `CLOSED` normal.

## 12. Frontend, UX y design system

Next.js App Router renderiza shell, navegación y páginas iniciales; POS, formularios y módulos dependientes de IndexedDB son Client Components. Las mutaciones usan exclusivamente el cliente REST compartido para que online/offline tengan contratos equivalentes.

`packages/ui` materializa tokens de `DESIGN.md` con CSS variables y Tailwind CSS. Las primitivas interactivas se construyen sobre Radix UI, con foco visible, teclado y atributos ARIA; Plus Jakarta Sans se sirve con `next/font`. Glass blur se limita a contenedores importantes y se desactiva con `prefers-reduced-transparency`, `prefers-reduced-motion` o fallback de rendimiento.

TanStack Query maneja datos remotos y su invalidación. Zustand contiene organización/sucursal activas, terminal POS y estado de sync, sin duplicar entidades servidor. React Hook Form + Zod valida temprano; los errores del backend se mapean a campos y a un resumen accesible. Tablas poseen alternativa móvil en cards; gráficos incluyen tabla/texto equivalente.

El manifest usa modo `standalone`, iconos 192/512 y theme UcoNext. El service worker precachea únicamente app shell y assets versionados; las respuestas privadas de API no entran en Cache Storage. La PWA soporta las dos últimas versiones estables declaradas en el spec; las capacidades offline se detectan y se bloquea autorización si faltan IndexedDB, Web Crypto o Service Worker requeridos.

### 12.1 Flujos UI obligatorios

Cada capacidad visible se entrega como slice vertical con ruta, contrato API, autorización, estados `loading/empty/error/success/forbidden`, responsive y prueba de teclado. Las superficies mínimas son:

| Superficie | Flujos y estados que debe cubrir |
| --- | --- |
| Auth/onboarding | Login, solicitud/consumo de reset, aceptación/revocación/expiración de invitación, provisioning asistido y selección de organización. |
| Administración | Perfil, timezone, moneda bloqueada, usuarios/roles/sucursales, branches, cajas, dispositivos, medios de pago y maestros con confirmaciones de desactivación/borrado. |
| Catálogo/inventario | Alta/edición, advertencia de duplicados, barcode por teclado, stocks/mínimos, ajustes/compensaciones, transferencias e incidencias con permisos por rol. |
| POS/caja | Apertura, carrito por teclado/táctil, pagos mixtos, vuelto, total cero, aceptación explícita de `PRICE_CHANGED`, recibo/impresión, cierre/aborto, diferencias, autorrevisión excepcional, conflicto y cierre por dispositivo irrecuperable. |
| Compras/gastos | Recepción EMPLOYEE, compra pendiente/pagada, pago/anulación, gasto/anulación y elección válida de sesión/medio. |
| Consulta | Clientes, proveedores, dashboard, auditoría, reportes, exportación y estados asincrónicos del PDF. |
| Offline | Capability gate, autorización/PIN, vigencia del grant, última sincronización, cola propia, entrega opaca genérica de sobres ajenos sin metadatos, dependencias, estados recuperables/definitivos, conflictos, revocación y actualización bloqueada por migración. |

Los formularios no confían en ocultamiento visual para permisos. Los conflictos muestran la acción siguiente; `PRICE_CHANGED` presenta cotización anterior/nueva y exige confirmación explícita antes de un reintento con clave nueva. Los importes, stock, sesiones y operaciones offline muestran su estado textual además de color. `DESIGN.md` define los pares cromáticos permitidos, targets táctiles y feedback accesible.

## 13. Reportes, recibos y archivos

Dashboard y listados usan SQL agregado con índices por `(organization_id, branch_id, occurred_at/status)`. Ventas/compras/gastos anulados se muestran con estado pero se excluyen de netos. Resultado operativo es ventas netas menos gastos netos, sin costos ni margen.

CSV se genera en streaming y neutraliza celdas que empiecen con `=`, `+`, `-`, `@`, tab o CR mediante prefijo seguro. PDF de reporte se crea como job para evitar timeouts; `report_exports` guarda filtros normalizados, actor/scope, formato y estado. El worker vuelve a validar alcance al ejecutar, genera el archivo, lo sube a storage y entrega URL firmada de corta duración. Los objetos de exportación expiran a las 24 h; el usuario puede regenerarlos.

El recibo no fiscal se deriva del snapshot inmutable de la venta. HTML imprimible y PDF muestran referencia, estado, organización/sucursal/cliente snapshot, ítems, descuento, pagos y vuelto, siempre con “Comprobante no fiscal”. La falla de render/impresión no participa de la transacción de venta: si falla la generación posterior, se regenera desde el snapshot.

## 14. Auditoría, jobs y observabilidad

### 14.1 Auditoría

`audit_events` se inserta en la misma transacción del negocio. Almacena actor, tenant, sucursal, dispositivo, request/operation ID, entidad/acción, timestamp y `before/after` construidos con allowlist. No guarda tokens, hashes de password ni payloads sensibles completos. El rol runtime solo posee `INSERT/SELECT` autorizado; trigger rechaza update/delete.

Autenticaciones fallidas y eventos sin tenant van a `security_audit_events`. OWNER consulta todo el tenant; ADMIN consulta recursos globales que administra y eventos de sus sucursales; CASHIER/EMPLOYEE no acceden al módulo.

### 14.2 Outbox y worker

Email de invitación/reset y exportaciones insertan `outbox_jobs` en la transacción que crea la intención. `worker.ts` reclama filas con `FOR UPDATE SKIP LOCKED`, lease, intentos, exponential backoff y dead-letter. Los handlers son idempotentes por `job_key`. El proveedor de email implementa `EmailPort`; desarrollo usa Mailpit.

### 14.3 Señales

- Pino emite JSON con `trace_id`, `request_id`, componente, nivel, tenant/user/device cuando sea seguro; redacción central elimina cookies, headers auth y PII no necesaria.
- OpenTelemetry instrumenta HTTP, Nest, `pg`, jobs y sync; exporta OTLP. Métricas Prometheus: latencia/tasa de error, pool, transacciones reintentadas, jobs, sync por resultado, edad de operaciones server-side y conflictos.
- `/health/live` solo proceso; `/health/ready` comprueba PostgreSQL y object storage cuando sea necesario para la operación solicitada.
- Alertas iniciales: readiness falla 3 veces, error rate >5% durante 5 min con mínimo de tráfico, DB inaccesible 3 intentos, jobs dead-letter, sync failures >5% durante 10 min o conflicto sin revisar sobre umbral operativo.
- Logs operativos se retienen 30 días; auditoría sigue la vida de los registros históricos.

## 15. Migraciones, despliegue y recuperación

Drizzle Kit genera migraciones revisables en `apps/api/src/database/migrations`. RLS, roles, triggers, funciones, índices parciales y constraints avanzados se escriben en SQL manual dentro de la misma secuencia. CI crea una base vacía y otra desde la versión anterior, ejecuta migraciones y pruebas RLS. Producción ejecuta un job único de migración antes de iniciar la versión nueva; nunca `push` automático.

Desarrollo usa Compose con PostgreSQL, MinIO, Mailpit y OTel Collector. Producción usa tres procesos del mismo monorepo: Next.js, Nest API y worker Nest; un reverse proxy publica un mismo origen y enruta `/api/v1` al API. Secretos se inyectan desde el secret manager del proveedor. No se usa almacenamiento local persistente de contenedor.

Backup mínimo: `pg_dump --format=custom` nocturno cifrado hacia un bucket/cuenta independiente, 35 días de retención, checksums y registro de ejecución. Se conserva además el backup administrado del proveedor cuando exista. Una restauración automatizada mensual en entorno aislado ejecuta migraciones, checks de integridad/ledger y smoke tests; el resultado se registra. `restore-runbook.md` define responsables, DNS/secrets, restauración de DB/objetos, validación y retorno, apuntando a RPO ≤24 h y RTO ≤8 h.

## 16. Estrategia de testing

| Nivel | Herramienta | Alcance |
| --- | --- | --- |
| Unitario | Vitest | Money/Quantity, `HALF_UP`, permisos, estados, hash canonical, políticas sin I/O. |
| Property-based | fast-check | Invariantes de pagos, vuelto, stock, transferencias, redondeo e idempotencia. |
| Integración DB | Testcontainers PostgreSQL | RLS default-deny, FKs tenant, constraints, locks, ledgers, triggers y migraciones. No SQLite. |
| API | Nest + Supertest | Contratos Zod, Problem Details, CSRF, auth, permisos y transacciones completas. |
| Concurrencia | conexiones `pg` reales | Ventas simultáneas, lock order, deadlocks/retries, doble idempotency key, cierre vs movimiento. |
| Offline unit | Vitest + fake-indexeddb | cifrado dual, Dexie migrations, lease/fencing, cola opaca, grants, secuencia/hash chain, ACK firmado y limpieza segura. |
| Offline browser | Playwright Chromium/WebKit/Firefox | pérdida/retorno de red, logout/cambio de identidad, entrega opaca, reload, cierre de pestaña, sync parcial, revocación, rotación de clave y service-worker update. |
| E2E | Playwright | onboarding, roles, catálogo, inventario, caja, venta, compras, gastos, anulaciones y reportes. |
| Accesibilidad | Testing Library + axe-core + Playwright | teclado, foco, labels, estados, contraste y flujos críticos responsive. |
| Artefactos | tests de PDF/CSV | texto obligatorio, filtros/scope, snapshots y neutralización CSV. |
| Operación | smoke + restore drill | health, migración, backup restaurable y métricas/alertas. |

Los mocks se limitan a email, object storage, reloj y generación de entropía. Persistencia, RLS, transacciones, locks e idempotencia se prueban contra PostgreSQL real. Cada bug de concurrencia o sync agrega primero una prueba de regresión reproducible.

CI ejecuta `lint → typecheck → unit → integration/migrations → build → e2e crítico` sobre cada cambio. Un job nocturno amplía escenarios offline y motores Playwright. La compatibilidad de las dos últimas versiones estables se verifica en una matriz separada: Chrome y Edge mediante canales branded instalados; Firefox mediante las versiones estables objetivo en runners controlados; Safari mediante ejecución real en macOS para las versiones disponibles. WebKit Playwright aporta cobertura temprana, pero no se presenta como evidencia suficiente de Safari. La matriz registra versión, sistema operativo y resultado; una versión que no pueda automatizarse recibe smoke manual documentado antes de release. Cobertura se usa como señal: se exige cobertura de ramas elevada en políticas de dinero, permisos, estados, stock, caja y sync, no un porcentaje global artificial.

La entrega produce imágenes reproducibles de `web`, `api` y `worker`, ejecuta una sola migración versionada antes del rollout y corre smoke de rutas, readiness, worker y archivos. El plan está `APROBADO` y habilita `sdd-build`; la puerta final exige todos los scripts raíz verdes y luego `sdd-check` produce evidencia individual RF → implementación → prueba antes de cualquier veredicto de producción.

## 17. Secuencia de construcción para `sdd-build`

1. **Fundación:** workspace, config, Compose, Next/Nest, contratos, Problem Details, DB/migraciones, UoW/RLS, observabilidad base.
2. **Identidad y tenancy:** auth, sesiones, plataforma, organizaciones, membresías, invitations, branches y RBAC.
3. **Maestros:** catálogo/categorías, clientes/proveedores, cajas, payment methods, design system y shell responsive.
4. **Inventario:** balances/ledger, ajustes, mínimos, transferencias y pruebas de concurrencia.
5. **Caja y ventas online:** dispositivo/sesión, movimientos, quote/confirmación, pagos, recibo y anulaciones; las primitivas de cierre se preparan pero el cierre se expone después del protocolo de checkpoint/sync.
6. **Compras y gastos:** estados, pagos, efectos de stock/caja, anulaciones y permisos.
7. **Auditoría, dashboard y reportes:** read models, exports, PDFs, jobs y controles de alcance.
8. **Offline POS y cierre definitivo:** criptografía, Dexie, bootstrap, grant, cola, push/pull, barreras de cierre/aborto, conflictos, incidentes, cierre excepcional y late data.
9. **Hardening:** accesibilidad, navegadores, performance, alertas, backup/restore, seguridad y E2E completos.

Cada etapa se divide luego en tareas verticales TDD; ninguna etapa autoriza relajar RLS, auditoría o atomicidad para “integrarlo después”.

## 18. Decisiones deliberadamente diferidas

- Proveedor concreto de hosting/containers, PostgreSQL administrado, object storage, email y backend OTLP.
- CDN y edge rate-limit concretos; los contratos HTTP no dependen del proveedor.
- Particionado físico de `audit_events`/ledgers; se activará por métricas de volumen sin cambiar contratos.
- Read replica, caché Redis o réplicas del worker; no son necesarias para el MVP.
- Estrategia de multi-región, alta disponibilidad avanzada y PITR menor a 24 h, fuera de alcance.
- Notificaciones push de stock bajo; el MVP usa dashboard/reportes.

## 19. Riesgos técnicos y mitigaciones

| Riesgo | Impacto | Mitigación aceptada |
| --- | --- | --- |
| Seguridad PWA limitada frente a dispositivo completamente comprometido/XSS | Exposición de claves/datos locales | CSP estricta, dependencia mínima, Web Crypto no exportable, PIN+Argon2id, cifrado por registro, grants cortos y threat-model documentado. No se promete equivalencia a hardware nativo. |
| Reloj offline manipulable | Elusión de ventana temporal | Grant firmado, versión conocida, secuencias/hash chain, conocimiento de revocación y servidor como árbitro; timestamps locales no son prueba única. |
| Borrado de almacenamiento por usuario/SO | Pérdida de ventas no sincronizadas | Persistent Storage, estado visible, sync frecuente, advertencias y cierre bloqueado; un navegador no puede garantizar persistencia absoluta. |
| Complejidad de cierre y late data | Conciliaciones incorrectas | Dispositivo exclusivo, checkpoint final, estados explícitos, snapshots inmutables y E2E de fallos. |
| Deadlocks de stock multi-ítem | Latencia/fallos transitorios | Lock order canónico, transacciones cortas, retry acotado y pruebas concurrentes reales. |
| RLS mal configurada | Fuga cross-tenant | Default deny, rol sin bypass, `SET LOCAL`, repositorios con cliente transaccional, FKs compuestas y suite negativa RLS. |
| Proyección/ledger divergentes | Stock o caja incorrectos | Escritura atómica, constraints por source y verificador que alerta sin autocorregir. |
| PDFs/reportes grandes | Memoria/timeout | Jobs PostgreSQL, streaming CSV, archivos temporales en object storage y filtros/indexes. |
| Drizzle no cubre SQL avanzado | Fricción de ORM | SQL explícito es decisión de primera clase, revisado y probado con PostgreSQL real. |
| Dependencia de capacidades PWA por navegador | Offline desigual | Capability check, foreground sync obligatorio, Background Sync solo como mejora y matriz Playwright WebKit/Firefox/Chromium. |
| Backups existentes pero no restaurables | Pérdida prolongada | Restore mensual automatizado con checks de ledger y runbook medido. |
| Canal de entrega opaca comprometido o demasiado amplio | Forja de operaciones o acceso tras revocación | Certificado no bearer, challenge de un uso, prueba de posesión, sobre previo inmutable, validación histórica/RLS y ACK mínimo; pruebas negativas de endpoints. |
| Referencias offline desconocidas | Cambios administrativos pueden quedar bloqueados indefinidamente | D01 aprobada (§6.4): barreras verificables, versiones retenidas y bloqueo permanente de moneda cuando corresponde; UI explica el motivo. |
| Confusión WebKit/Safari | Declarar compatibilidad sin probar el navegador real | Matriz de motores en CI y verificación separada de navegadores branded/versiones con evidencia por release. |

## 20. Referencias técnicas verificadas

- [Next.js — Progressive Web Apps](https://nextjs.org/docs/app/guides/progressive-web-apps)
- [W3C — Web Cryptography Level 2](https://www.w3.org/TR/WebCryptoAPI/)
- [W3C — Indexed Database API 3.0](https://www.w3.org/TR/IndexedDB/)
- [Next.js — App Router](https://nextjs.org/docs/app)
- [Drizzle — PostgreSQL con node-postgres](https://orm.drizzle.team/docs/get-started-postgresql)
- [Drizzle — Transactions](https://orm.drizzle.team/docs/transactions)
- [Drizzle — Row-Level Security](https://orm.drizzle.team/docs/rls)
- [NestJS — OpenAPI](https://docs.nestjs.com/openapi)
- [Zod 4](https://zod.dev/)
- [Dexie — Transactions](https://dexie.org/docs/Dexie/Dexie.transaction%28%29)

## 21. Trazabilidad RF → plan

| RF | Capacidad | Componentes y verificación |
| --- | --- | --- |
| RF-01 | Organización y plataforma | §5–§8; `modules/platform-admin`, `modules/organizations`; integración RLS/provisioning |
| RF-02 | Organización y plataforma | §5–§8; `modules/platform-admin`, `modules/organizations`; integración RLS/provisioning |
| RF-03 | Organización y plataforma | §5–§8; `modules/platform-admin`, `modules/organizations`; integración RLS/provisioning |
| RF-04 | Organización y plataforma | §5–§8; `modules/platform-admin`, `modules/organizations`; integración RLS/provisioning |
| RF-05 | Organización y plataforma | §5–§8; `modules/platform-admin`, `modules/organizations`; integración RLS/provisioning |
| RF-06 | Organización y plataforma | §5–§8; `modules/platform-admin`, `modules/organizations`; integración RLS/provisioning |
| RF-07 | Organización y plataforma | §5–§8; `modules/platform-admin`, `modules/organizations`; integración RLS/provisioning |
| RF-08 | Organización y plataforma | §5–§8; `modules/platform-admin`, `modules/organizations`; integración RLS/provisioning |
| RF-09 | Organización y plataforma | §5–§8; `modules/platform-admin`, `modules/organizations`; integración RLS/provisioning |
| RF-10 | Autenticación y membresías | §7.2–§8; `modules/auth`, `modules/users`; tests de sesión, invitación y revocación |
| RF-11 | Autenticación y membresías | §7.2–§8; `modules/auth`, `modules/users`; tests de sesión, invitación y revocación |
| RF-12 | Autenticación y membresías | §7.2–§8; `modules/auth`, `modules/users`; tests de sesión, invitación y revocación |
| RF-13 | Autenticación y membresías | §7.2–§8; `modules/auth`, `modules/users`; tests de sesión, invitación y revocación |
| RF-14 | Autenticación y membresías | §7.2–§8; `modules/auth`, `modules/users`; tests de sesión, invitación y revocación |
| RF-15 | Autenticación y membresías | §7.2–§8; `modules/auth`, `modules/users`; tests de sesión, invitación y revocación |
| RF-16 | Autenticación y membresías | §7.2–§8; `modules/auth`, `modules/users`; tests de sesión, invitación y revocación |
| RF-17 | Autenticación y membresías | §7.2–§8; `modules/auth`, `modules/users`; tests de sesión, invitación y revocación |
| RF-18 | Autenticación y membresías | §7.2–§8; `modules/auth`, `modules/users`; tests de sesión, invitación y revocación |
| RF-19 | Autenticación y membresías | §7.2–§8; `modules/auth`, `modules/users`; tests de sesión, invitación y revocación |
| RF-20 | Autenticación y membresías | §7.2–§8; `modules/auth`, `modules/users`; tests de sesión, invitación y revocación |
| RF-21 | RBAC, sucursales y cajas | §5, §7.3, §10; `modules/users`, `modules/branches`; tests de matriz/scope |
| RF-22 | RBAC, sucursales y cajas | §5, §7.3, §10; `modules/users`, `modules/branches`; tests de matriz/scope |
| RF-23 | RBAC, sucursales y cajas | §5, §7.3, §10; `modules/users`, `modules/branches`; tests de matriz/scope |
| RF-24 | RBAC, sucursales y cajas | §5, §7.3, §10; `modules/users`, `modules/branches`; tests de matriz/scope |
| RF-25 | RBAC, sucursales y cajas | §5, §7.3, §10; `modules/users`, `modules/branches`; tests de matriz/scope |
| RF-26 | RBAC, sucursales y cajas | §5, §7.3, §10; `modules/users`, `modules/branches`; tests de matriz/scope |
| RF-27 | RBAC, sucursales y cajas | §5, §7.3, §10; `modules/users`, `modules/branches`; tests de matriz/scope |
| RF-28 | RBAC, sucursales y cajas | §5, §7.3, §10; `modules/users`, `modules/branches`; tests de matriz/scope |
| RF-29 | RBAC, sucursales y cajas | §5, §7.3, §10; `modules/users`, `modules/branches`; tests de matriz/scope |
| RF-30 | RBAC, sucursales y cajas | §5, §7.3, §10; `modules/users`, `modules/branches`; tests de matriz/scope |
| RF-31 | RBAC, sucursales y cajas | §5, §7.3, §10; `modules/users`, `modules/branches`; tests de matriz/scope |
| RF-32 | Catálogo y mínimos | §5–§6, §8, §12; `modules/catalog`; tests de constraints, precio y estado |
| RF-33 | Catálogo y mínimos | §5–§6, §8, §12; `modules/catalog`; tests de constraints, precio y estado |
| RF-34 | Catálogo y mínimos | §5–§6, §8, §12; `modules/catalog`; tests de constraints, precio y estado |
| RF-35 | Catálogo y mínimos | §5–§6, §8, §12; `modules/catalog`; tests de constraints, precio y estado |
| RF-36 | Catálogo y mínimos | §5–§6, §8, §12; `modules/catalog`; tests de constraints, precio y estado |
| RF-37 | Catálogo y mínimos | §5–§6, §8, §12; `modules/catalog`; tests de constraints, precio y estado |
| RF-38 | Barcode/POS | §8, §9.4, §12; catálogo + POS; prueba de entrada por teclado |
| RF-39 | Inicialización de stock | §6.2–§6.3, §9.2; `catalog` + `inventory`; integración sin movimiento |
| RF-40 | Ajuste inicial | §6.3, §9.2; `modules/inventory`; integración de ajuste/ledger |
| RF-41 | Cantidades | §6.1, §9; `Quantity`; property tests UNIT |
| RF-42 | Cantidades | §6.1, §9; `Quantity`; property tests de escala fraccionable |
| RF-43 | Aritmética decimal | §6.1, §9; value objects compartidos; property tests |
| RF-44 | Dinero y redondeo | §6.1, §9.4–§9.5; `Money`; property tests HALF_UP |
| RF-45 | Líneas comerciales | §9.4–§9.5; sales/purchases; property e integración de línea |
| RF-46 | Catálogo y mínimos | §5–§6, §8, §12; `modules/catalog`; tests de constraints, precio y estado |
| RF-47 | Descuentos de venta | §8, §9.4, §12; `modules/sales`; tests por tipo y rol |
| RF-48 | Descuentos de venta | §8, §9.4, §12; `modules/sales`; tests de límites/subtotal |
| RF-49 | Descuentos de venta | §7.3, §9.4, §11–§12; sales/offline; tests negativos por rol |
| RF-50 | Categorías separadas | §5–§6, §8, §12; catalog/expenses; constraints tenant |
| RF-51 | Catálogo y mínimos | §5–§6, §8, §12; `modules/catalog`; tests de constraints, precio y estado |
| RF-52 | Categoría de gasto | §5–§6, §8, §9.5; `modules/expenses`; tests de referencia activa |
| RF-53 | Catálogo y mínimos | §5–§6, §8, §12; `modules/catalog`; tests de constraints, precio y estado |
| RF-54 | Catálogo y mínimos | §5–§6, §8, §12; `modules/catalog`; tests de constraints, precio y estado |
| RF-55 | Catálogo y mínimos | §5–§6, §8, §12; `modules/catalog`; tests de constraints, precio y estado |
| RF-56 | Catálogo y mínimos | §5–§6, §8, §12; `modules/catalog`; tests de constraints, precio y estado |
| RF-57 | Mínimos de stock | §6.2–§6.3, §8, §12; `modules/inventory`; tests por sucursal |
| RF-58 | Stock bajo | §6.2–§6.3, §12–§13; inventory/dashboard; tests de umbral inclusivo |
| RF-59 | Stock bajo | §6.2–§6.3, §12–§13; inventory/dashboard; test sin alerta cuando no hay mínimo |
| RF-60 | Inventario y transferencias | §6.3, §9.2; `modules/inventory`; integración ledger/stock/concurrencia |
| RF-61 | Inventario y transferencias | §6.3, §9.2; `modules/inventory`; integración ledger/stock/concurrencia |
| RF-62 | Inventario y transferencias | §6.3, §9.2; `modules/inventory`; integración ledger/stock/concurrencia |
| RF-63 | Inventario y transferencias | §6.3, §9.2; `modules/inventory`; integración ledger/stock/concurrencia |
| RF-64 | Inventario y transferencias | §6.3, §9.2; `modules/inventory`; integración ledger/stock/concurrencia |
| RF-65 | Inventario y transferencias | §6.3, §9.2; `modules/inventory`; integración ledger/stock/concurrencia |
| RF-66 | Inventario y transferencias | §6.3, §9.2; `modules/inventory`; integración ledger/stock/concurrencia |
| RF-67 | Inventario y transferencias | §6.3, §9.2; `modules/inventory`; integración ledger/stock/concurrencia |
| RF-68 | Clientes y proveedores | §5–§8; `modules/customers`, `modules/suppliers`; constraints tenant/unicidad |
| RF-69 | Clientes y proveedores | §5–§8; `modules/customers`, `modules/suppliers`; constraints tenant/unicidad |
| RF-70 | Clientes y proveedores | §5–§8; `modules/customers`, `modules/suppliers`; constraints tenant/unicidad |
| RF-71 | Clientes y proveedores | §5–§8; `modules/customers`, `modules/suppliers`; constraints tenant/unicidad |
| RF-72 | Ventas, pagos y anulaciones | §8, §9.4, §13; `modules/sales`; integración transaccional y E2E POS |
| RF-73 | Ventas, pagos y anulaciones | §8, §9.4, §13; `modules/sales`; integración transaccional y E2E POS |
| RF-74 | Ventas, pagos y anulaciones | §8, §9.4, §13; `modules/sales`; integración transaccional y E2E POS |
| RF-75 | Ventas, pagos y anulaciones | §8, §9.4, §13; `modules/sales`; integración transaccional y E2E POS |
| RF-76 | Ventas, pagos y anulaciones | §8, §9.4, §13; `modules/sales`; integración transaccional y E2E POS |
| RF-77 | Ventas, pagos y anulaciones | §8, §9.4, §13; `modules/sales`; integración transaccional y E2E POS |
| RF-78 | Ventas, pagos y anulaciones | §8, §9.4, §13; `modules/sales`; integración transaccional y E2E POS |
| RF-79 | Ventas, pagos y anulaciones | §8, §9.4, §13; `modules/sales`; integración transaccional y E2E POS |
| RF-80 | Ventas, pagos y anulaciones | §8, §9.4, §13; `modules/sales`; integración transaccional y E2E POS |
| RF-81 | Ventas, pagos y anulaciones | §8, §9.4, §13; `modules/sales`; integración transaccional y E2E POS |
| RF-82 | Ventas, pagos y anulaciones | §8, §9.4, §13; `modules/sales`; integración transaccional y E2E POS |
| RF-83 | Ventas, pagos y anulaciones | §8, §9.4, §13; `modules/sales`; integración transaccional y E2E POS |
| RF-84 | Ventas, pagos y anulaciones | §8, §9.4, §13; `modules/sales`; integración transaccional y E2E POS |
| RF-85 | Ventas, pagos y anulaciones | §8, §9.4, §13; `modules/sales`; integración transaccional y E2E POS |
| RF-86 | Ventas, pagos y anulaciones | §8, §9.4, §13; `modules/sales`; integración transaccional y E2E POS |
| RF-87 | Ventas, pagos y anulaciones | §8, §9.4, §13; `modules/sales`; integración transaccional y E2E POS |
| RF-88 | Ventas, pagos y anulaciones | §8, §9.4, §13; `modules/sales`; integración transaccional y E2E POS |
| RF-89 | Ventas, pagos y anulaciones | §8, §9.4, §13; `modules/sales`; integración transaccional y E2E POS |
| RF-90 | Ventas, pagos y anulaciones | §8, §9.4, §13; `modules/sales`; integración transaccional y E2E POS |
| RF-91 | Caja y diferencias | §6, §9.3, §10; `modules/cash`; locks, ledger y E2E de cierre |
| RF-92 | Caja y diferencias | §6, §9.3, §10; `modules/cash`; locks, ledger y E2E de cierre |
| RF-93 | Caja y diferencias | §6, §9.3, §10; `modules/cash`; locks, ledger y E2E de cierre |
| RF-94 | Caja y diferencias | §6, §9.3, §10; `modules/cash`; locks, ledger y E2E de cierre |
| RF-95 | Caja y diferencias | §6, §9.3, §10; `modules/cash`; locks, ledger y E2E de cierre |
| RF-96 | Caja y diferencias | §6, §9.3, §10; `modules/cash`; locks, ledger y E2E de cierre |
| RF-97 | Caja y diferencias | §6, §9.3, §10; `modules/cash`; locks, ledger y E2E de cierre |
| RF-98 | Caja y diferencias | §6, §9.3, §10; `modules/cash`; locks, ledger y E2E de cierre |
| RF-99 | Caja y diferencias | §6, §9.3, §10; `modules/cash`; locks, ledger y E2E de cierre |
| RF-100 | Compras y pagos | §6, §9.5, §10; `modules/purchases`; integración stock/caja/anulación |
| RF-101 | Compras y pagos | §6, §9.5, §10; `modules/purchases`; integración stock/caja/anulación |
| RF-102 | Compras y pagos | §6, §9.5, §10; `modules/purchases`; integración stock/caja/anulación |
| RF-103 | Compras y pagos | §6, §9.5, §10; `modules/purchases`; integración stock/caja/anulación |
| RF-104 | Compras y pagos | §6, §9.5, §10; `modules/purchases`; integración stock/caja/anulación |
| RF-105 | Compras y pagos | §6, §9.5, §10; `modules/purchases`; integración stock/caja/anulación |
| RF-106 | Compras y pagos | §6, §9.5, §10; `modules/purchases`; integración stock/caja/anulación |
| RF-107 | Compras y pagos | §6, §9.5, §10; `modules/purchases`; integración stock/caja/anulación |
| RF-108 | Compras y pagos | §6, §9.5, §10; `modules/purchases`; integración stock/caja/anulación |
| RF-109 | Compras y pagos | §6, §9.5, §10; `modules/purchases`; integración stock/caja/anulación |
| RF-110 | Gastos y medios de pago | §5–§9; `modules/expenses`, `modules/organizations`; permisos y caja |
| RF-111 | Gastos y medios de pago | §5–§9; `modules/expenses`, `modules/organizations`; permisos y caja |
| RF-112 | Gastos y medios de pago | §5–§9; `modules/expenses`, `modules/organizations`; permisos y caja |
| RF-113 | Gastos y medios de pago | §5–§9; `modules/expenses`, `modules/organizations`; permisos y caja |
| RF-114 | Offline POS base | §7.4, §11; `modules/offline-sync`, `web/src/offline`; Playwright offline |
| RF-115 | Offline POS base | §7.4, §11; `modules/offline-sync`, `web/src/offline`; Playwright offline |
| RF-116 | Offline POS base | §7.4, §11; `modules/offline-sync`, `web/src/offline`; Playwright offline |
| RF-117 | Offline POS base | §7.4, §11; `modules/offline-sync`, `web/src/offline`; Playwright offline |
| RF-118 | Offline POS base | §7.4, §11; `modules/offline-sync`, `web/src/offline`; Playwright offline |
| RF-119 | Offline POS base | §7.4, §11; `modules/offline-sync`, `web/src/offline`; Playwright offline |
| RF-120 | Offline POS base | §7.4, §11; `modules/offline-sync`, `web/src/offline`; Playwright offline |
| RF-121 | Offline POS base | §7.4, §11; `modules/offline-sync`, `web/src/offline`; Playwright offline |
| RF-122 | Offline POS base | §7.4, §11; `modules/offline-sync`, `web/src/offline`; Playwright offline |
| RF-123 | Offline POS base | §7.4, §11; `modules/offline-sync`, `web/src/offline`; Playwright offline |
| RF-124 | Offline POS base | §7.4, §11; `modules/offline-sync`, `web/src/offline`; Playwright offline |
| RF-125 | Offline POS base | §7.4, §11; `modules/offline-sync`, `web/src/offline`; Playwright offline |
| RF-126 | Offline POS base | §7.4, §11; `modules/offline-sync`, `web/src/offline`; Playwright offline |
| RF-127 | Offline POS base | §7.4, §11; `modules/offline-sync`, `web/src/offline`; Playwright offline |
| RF-128 | Offline POS base | §7.4, §11; `modules/offline-sync`, `web/src/offline`; Playwright offline |
| RF-129 | Offline POS base | §7.4, §11; `modules/offline-sync`, `web/src/offline`; Playwright offline |
| RF-130 | Offline POS base | §7.4, §11; `modules/offline-sync`, `web/src/offline`; Playwright offline |
| RF-131 | Idempotencia, atomicidad y operación | §7, §9, §14–§16; `core/idempotency`, `core/audit`, observabilidad |
| RF-132 | Idempotencia, atomicidad y operación | §7, §9, §14–§16; `core/idempotency`, `core/audit`, observabilidad |
| RF-133 | Idempotencia, atomicidad y operación | §7, §9, §14–§16; `core/idempotency`, `core/audit`, observabilidad |
| RF-134 | Idempotencia, atomicidad y operación | §7, §9, §14–§16; `core/idempotency`, `core/audit`, observabilidad |
| RF-135 | Idempotencia, atomicidad y operación | §7, §9, §14–§16; `core/idempotency`, `core/audit`, observabilidad |
| RF-136 | Idempotencia, atomicidad y operación | §7, §9, §14–§16; `core/idempotency`, `core/audit`, observabilidad |
| RF-137 | Idempotencia, atomicidad y operación | §7, §9, §14–§16; `core/idempotency`, `core/audit`, observabilidad |
| RF-138 | Idempotencia, atomicidad y operación | §7, §9, §14–§16; `core/idempotency`, `core/audit`, observabilidad |
| RF-139 | Idempotencia, atomicidad y operación | §7, §9, §14–§16; `core/idempotency`, `core/audit`, observabilidad |
| RF-140 | Idempotencia, atomicidad y operación | §7, §9, §14–§16; `core/idempotency`, `core/audit`, observabilidad |
| RF-141 | Idempotencia, atomicidad y operación | §7, §9, §14–§16; `core/idempotency`, `core/audit`, observabilidad |
| RF-142 | Dashboard y reportes | §8, §13; `modules/dashboard`, `modules/reports`; filtros/scope/exports |
| RF-143 | Dashboard y reportes | §8, §13; `modules/dashboard`, `modules/reports`; filtros/scope/exports |
| RF-144 | Dashboard y reportes | §8, §13; `modules/dashboard`, `modules/reports`; filtros/scope/exports |
| RF-145 | Dashboard y reportes | §8, §13; `modules/dashboard`, `modules/reports`; filtros/scope/exports |
| RF-146 | Dashboard y reportes | §8, §13; `modules/dashboard`, `modules/reports`; filtros/scope/exports |
| RF-147 | Dashboard y reportes | §8, §13; `modules/dashboard`, `modules/reports`; filtros/scope/exports |
| RF-148 | Dashboard y reportes | §8, §13; `modules/dashboard`, `modules/reports`; filtros/scope/exports |
| RF-149 | Dashboard y reportes | §8, §13; `modules/dashboard`, `modules/reports`; filtros/scope/exports |
| RF-150 | Dashboard y reportes | §8, §13; `modules/dashboard`, `modules/reports`; filtros/scope/exports |
| RF-151 | Seguridad API | §7–§8; guards, Zod, CSRF, rate limiting; tests de seguridad |
| RF-152 | Responsive y accesibilidad | §12, §16; `packages/ui`, Playwright/axe-core |
| RF-153 | Responsive y accesibilidad | §12, §16; `packages/ui`, Playwright/axe-core |
| RF-154 | Responsive y accesibilidad | §12, §16; `packages/ui`, Playwright/axe-core |
| RF-155 | Cierre seguro de caja | §9.3, §10, §11.4; `modules/cash`; concurrencia cierre/sync |
| RF-156 | Cierre seguro de caja | §9.3, §10, §11.4; `modules/cash`; concurrencia cierre/sync |
| RF-157 | Cierre seguro de caja | §9.3, §10, §11.4; `modules/cash`; concurrencia cierre/sync |
| RF-158 | Cierre seguro de caja | §9.3, §10, §11.4; `modules/cash`; concurrencia cierre/sync |
| RF-159 | Estructura de catálogo y stock | §6.2–§6.3, §9.2; constraints y locks estructurales |
| RF-160 | Estructura de catálogo y stock | §6.2–§6.3, §9.2; constraints y locks estructurales |
| RF-161 | Estructura de catálogo y stock | §6.2–§6.3, §9.2; constraints y locks estructurales |
| RF-162 | Estructura de catálogo y stock | §6.2–§6.3, §9.2; constraints y locks estructurales |
| RF-163 | Estructura de catálogo y stock | §6.2–§6.3, §9.2; constraints y locks estructurales |
| RF-164 | Concurrencia de inventario | §9.1–§9.2; SQL `FOR UPDATE`; tests con conexiones reales |
| RF-165 | Concurrencia de inventario | §9.1–§9.2; SQL `FOR UPDATE`; tests con conexiones reales |
| RF-166 | Concurrencia de inventario | §9.1–§9.2; SQL `FOR UPDATE`; tests con conexiones reales |
| RF-167 | Configuración y seguridad offline | §7.4, §11; grants, cifrado, revocación y limpieza |
| RF-168 | Configuración y seguridad offline | §7.4, §11; grants, cifrado, revocación y limpieza |
| RF-169 | Configuración y seguridad offline | §7.4, §11; grants, cifrado, revocación y limpieza |
| RF-170 | Configuración y seguridad offline | §7.4, §11; grants, cifrado, revocación y limpieza |
| RF-171 | Configuración y seguridad offline | §7.4, §11; grants, cifrado, revocación y limpieza |
| RF-172 | Configuración y seguridad offline | §7.4, §11; grants, cifrado, revocación y limpieza |
| RF-173 | Configuración y seguridad offline | §7.4, §11; grants, cifrado, revocación y limpieza |
| RF-174 | Configuración y seguridad offline | §7.4, §11; grants, cifrado, revocación y limpieza |
| RF-175 | Configuración y seguridad offline | §7.4, §11; grants, cifrado, revocación y limpieza |
| RF-176 | Configuración y seguridad offline | §7.4, §11; grants, cifrado, revocación y limpieza |
| RF-177 | Configuración y seguridad offline | §7.4, §11; grants, cifrado, revocación y limpieza |
| RF-178 | Invariante OWNER y administración | §7.2–§7.3, §10; membresías e integración concurrente |
| RF-179 | Invariante OWNER y administración | §7.2–§7.3, §10; membresías e integración concurrente |
| RF-180 | Invariante OWNER y administración | §7.2–§7.3, §10; membresías e integración concurrente |
| RF-181 | Invariante OWNER y administración | §7.2–§7.3, §10; membresías e integración concurrente |
| RF-182 | Invariante OWNER y administración | §7.2–§7.3, §10; membresías e integración concurrente |
| RF-183 | Invariante OWNER y administración | §7.2–§7.3, §10; membresías e integración concurrente |
| RF-184 | Invariante OWNER y administración | §7.2–§7.3, §10; membresías e integración concurrente |
| RF-185 | Permisos y atomicidad de compras | §7.3, §9.5; `modules/purchases`; tests por rol |
| RF-186 | Permisos y atomicidad de compras | §7.3, §9.5; `modules/purchases`; tests por rol |
| RF-187 | Permisos y atomicidad de compras | §7.3, §9.5; `modules/purchases`; tests por rol |
| RF-188 | Permisos y atomicidad de compras | §7.3, §9.5; `modules/purchases`; tests por rol |
| RF-189 | Permisos y atomicidad de compras | §7.3, §9.5; `modules/purchases`; tests por rol |
| RF-190 | Permisos de ajustes | §7.3, §9.2; `modules/inventory`; tests por motivo/rol |
| RF-191 | Permisos de ajustes | §7.3, §9.2; `modules/inventory`; tests por motivo/rol |
| RF-192 | Permisos de ajustes | §7.3, §9.2; `modules/inventory`; tests por motivo/rol |
| RF-193 | Permisos de ajustes | §7.3, §9.2; `modules/inventory`; tests por motivo/rol |
| RF-194 | Permisos de ventas y sesión | §7.3, §9.4; `modules/sales`, `modules/cash`; E2E actores |
| RF-195 | Permisos de ventas y sesión | §7.3, §9.4; `modules/sales`, `modules/cash`; E2E actores |
| RF-196 | Permisos de ventas y sesión | §7.3, §9.4; `modules/sales`, `modules/cash`; E2E actores |
| RF-197 | Permisos de ventas y sesión | §7.3, §9.4; `modules/sales`, `modules/cash`; E2E actores |
| RF-198 | Permisos de ventas y sesión | §7.3, §9.4; `modules/sales`, `modules/cash`; E2E actores |
| RF-199 | Revisión de diferencias | §9.3, §10; `cash_difference_reviews`; tests normal/self-review |
| RF-200 | Revisión de diferencias | §9.3, §10; `cash_difference_reviews`; tests normal/self-review |
| RF-201 | Revisión de diferencias | §9.3, §10; `cash_difference_reviews`; tests normal/self-review |
| RF-202 | Revisión de diferencias | §9.3, §10; `cash_difference_reviews`; tests normal/self-review |
| RF-203 | Revisión de diferencias | §9.3, §10; `cash_difference_reviews`; tests normal/self-review |
| RF-204 | Revisión de diferencias | §9.3, §10; `cash_difference_reviews`; tests normal/self-review |
| RF-205 | Moneda inmutable | §6.1–§6.2; `modules/organizations`; constraints y tests de bloqueo |
| RF-206 | Moneda inmutable | §6.1–§6.2; `modules/organizations`; constraints y tests de bloqueo |
| RF-207 | Permisos de gastos | §7.3, §9.5; `modules/expenses`; tests sesión/dispositivo/rol |
| RF-208 | Permisos de gastos | §7.3, §9.5; `modules/expenses`; tests sesión/dispositivo/rol |
| RF-209 | Permisos de gastos | §7.3, §9.5; `modules/expenses`; tests sesión/dispositivo/rol |
| RF-210 | Permisos de gastos | §7.3, §9.5; `modules/expenses`; tests sesión/dispositivo/rol |
| RF-211 | Maestros de clientes/proveedores | §5–§8; módulos de partes; DTOs proyectados y scope |
| RF-212 | Maestros de clientes/proveedores | §5–§8; módulos de partes; DTOs proyectados y scope |
| RF-213 | Maestros de clientes/proveedores | §5–§8; módulos de partes; DTOs proyectados y scope |
| RF-214 | Maestros de clientes/proveedores | §5–§8; módulos de partes; DTOs proyectados y scope |
| RF-215 | Maestros de clientes/proveedores | §5–§8; módulos de partes; DTOs proyectados y scope |
| RF-216 | Maestros de clientes/proveedores | §5–§8; módulos de partes; DTOs proyectados y scope |
| RF-217 | Maestros de clientes/proveedores | §5–§8; módulos de partes; DTOs proyectados y scope |
| RF-218 | Maestros de clientes/proveedores | §5–§8; módulos de partes; DTOs proyectados y scope |
| RF-219 | Maestros de clientes/proveedores | §5–§8; módulos de partes; DTOs proyectados y scope |
| RF-220 | Maestros de clientes/proveedores | §5–§8; módulos de partes; DTOs proyectados y scope |
| RF-221 | Permisos y visibilidad de catálogo | §7.3, §12; catálogo/stock; tests de proyecciones por rol |
| RF-222 | Permisos y visibilidad de catálogo | §7.3, §12; catálogo/stock; tests de proyecciones por rol |
| RF-223 | Permisos y visibilidad de catálogo | §7.3, §12; catálogo/stock; tests de proyecciones por rol |
| RF-224 | Permisos y visibilidad de catálogo | §7.3, §12; catálogo/stock; tests de proyecciones por rol |
| RF-225 | Permisos y visibilidad de catálogo | §7.3, §12; catálogo/stock; tests de proyecciones por rol |
| RF-226 | Permisos y visibilidad de catálogo | §7.3, §12; catálogo/stock; tests de proyecciones por rol |
| RF-227 | Permisos y visibilidad de catálogo | §7.3, §12; catálogo/stock; tests de proyecciones por rol |
| RF-228 | Permisos y visibilidad de catálogo | §7.3, §12; catálogo/stock; tests de proyecciones por rol |
| RF-229 | Permisos y visibilidad de catálogo | §7.3, §12; catálogo/stock; tests de proyecciones por rol |
| RF-230 | Dispositivo exclusivo y cierre excepcional | §9.3, §10, §11.4; cash/offline; E2E pérdida y late data |
| RF-231 | Dispositivo exclusivo y cierre excepcional | §9.3, §10, §11.4; cash/offline; E2E pérdida y late data |
| RF-232 | Dispositivo exclusivo y cierre excepcional | §9.3, §10, §11.4; cash/offline; E2E pérdida y late data |
| RF-233 | Dispositivo exclusivo y cierre excepcional | §9.3, §10, §11.4; cash/offline; E2E pérdida y late data |
| RF-234 | Dispositivo exclusivo y cierre excepcional | §9.3, §10, §11.4; cash/offline; E2E pérdida y late data |
| RF-235 | Dispositivo exclusivo y cierre excepcional | §9.3, §10, §11.4; cash/offline; E2E pérdida y late data |
| RF-236 | Dispositivo exclusivo y cierre excepcional | §9.3, §10, §11.4; cash/offline; E2E pérdida y late data |
| RF-237 | Dispositivo exclusivo y cierre excepcional | §9.3, §10, §11.4; cash/offline; E2E pérdida y late data |
| RF-238 | Dispositivo exclusivo y cierre excepcional | §9.3, §10, §11.4; cash/offline; E2E pérdida y late data |
| RF-239 | Dispositivo exclusivo y cierre excepcional | §9.3, §10, §11.4; cash/offline; E2E pérdida y late data |
| RF-240 | Dispositivo exclusivo y cierre excepcional | §9.3, §10, §11.4; cash/offline; E2E pérdida y late data |
| RF-241 | Dispositivo exclusivo y cierre excepcional | §9.3, §10, §11.4; cash/offline; E2E pérdida y late data |
| RF-242 | Signos, dinero y caja disponible | §6.1, §9; value objects Decimal y property tests |
| RF-243 | Signos, dinero y caja disponible | §6.1, §9; value objects Decimal y property tests |
| RF-244 | Signos, dinero y caja disponible | §6.1, §9; value objects Decimal y property tests |
| RF-245 | Signos, dinero y caja disponible | §6.1, §9; value objects Decimal y property tests |
| RF-246 | Signos, dinero y caja disponible | §6.1, §9; value objects Decimal y property tests |
| RF-247 | Signos, dinero y caja disponible | §6.1, §9; value objects Decimal y property tests |
| RF-248 | Signos, dinero y caja disponible | §6.1, §9; value objects Decimal y property tests |
| RF-249 | Signos, dinero y caja disponible | §6.1, §9; value objects Decimal y property tests |
| RF-250 | Signos, dinero y caja disponible | §6.1, §9; value objects Decimal y property tests |
| RF-251 | Signos, dinero y caja disponible | §6.1, §9; value objects Decimal y property tests |
| RF-252 | Signos, dinero y caja disponible | §6.1, §9; value objects Decimal y property tests |
| RF-253 | Signos, dinero y caja disponible | §6.1, §9; value objects Decimal y property tests |
| RF-254 | Autoridad de precios | §8.2, §9.4, §11; quote/versionado y tests price-changed |
| RF-255 | Autoridad de precios | §8.2, §9.4, §11; quote/versionado y tests price-changed |
| RF-256 | Autoridad de precios | §8.2, §9.4, §11; quote/versionado y tests price-changed |
| RF-257 | Estados y reversión de compras | §9.5, §10; purchases/payments; integración idempotente |
| RF-258 | Estados y reversión de compras | §9.5, §10; purchases/payments; integración idempotente |
| RF-259 | Estados y reversión de compras | §9.5, §10; purchases/payments; integración idempotente |
| RF-260 | Estados y reversión de compras | §9.5, §10; purchases/payments; integración idempotente |
| RF-261 | Anulación de gastos | §9.5, §10; expenses/cash; integración de compensación |
| RF-262 | Anulación de gastos | §9.5, §10; expenses/cash; integración de compensación |
| RF-263 | Anulación de gastos | §9.5, §10; expenses/cash; integración de compensación |
| RF-264 | Anulación de gastos | §9.5, §10; expenses/cash; integración de compensación |
| RF-265 | Normalización y unicidad | §6.1–§6.2; índices únicos y tests de normalización |
| RF-266 | Normalización y unicidad | §6.1–§6.2; índices únicos y tests de normalización |
| RF-267 | Identidad y snapshots documentales | §6.2, §9.4, §13; sales/receipts; tests históricos |
| RF-268 | Identidad y snapshots documentales | §6.2, §9.4, §13; sales/receipts; tests históricos |
| RF-269 | Identidad y snapshots documentales | §6.2, §9.4, §13; sales/receipts; tests históricos |
| RF-270 | Identidad y snapshots documentales | §6.2, §9.4, §13; sales/receipts; tests históricos |
| RF-271 | Tiempo, sync e integridad local | §7.4, §11; offline queue/crypto/service worker; tests browser |
| RF-272 | Tiempo, sync e integridad local | §7.4, §11; offline queue/crypto/service worker; tests browser |
| RF-273 | Tiempo, sync e integridad local | §7.4, §11; offline queue/crypto/service worker; tests browser |
| RF-274 | Tiempo, sync e integridad local | §7.4, §11; offline queue/crypto/service worker; tests browser |
| RF-275 | Tiempo, sync e integridad local | §7.4, §11; offline queue/crypto/service worker; tests browser |
| RF-276 | Tiempo, sync e integridad local | §7.4, §11; offline queue/crypto/service worker; tests browser |
| RF-277 | Tiempo, sync e integridad local | §7.4, §11; offline queue/crypto/service worker; tests browser |
| RF-278 | Tiempo, sync e integridad local | §7.4, §11; offline queue/crypto/service worker; tests browser |
| RF-279 | Tiempo, sync e integridad local | §7.4, §11; offline queue/crypto/service worker; tests browser |
| RF-280 | Tiempo, sync e integridad local | §7.4, §11; offline queue/crypto/service worker; tests browser |
| RF-281 | Tiempo, sync e integridad local | §7.4, §11; offline queue/crypto/service worker; tests browser |
| RF-282 | Auditoría y aislamiento | §7, §14; audit/platform/RLS; suite negativa cross-tenant |
| RF-283 | Auditoría y aislamiento | §7, §14; audit/platform/RLS; suite negativa cross-tenant |
| RF-284 | Auditoría y aislamiento | §7, §14; audit/platform/RLS; suite negativa cross-tenant |
| RF-285 | Auditoría y aislamiento | §7, §14; audit/platform/RLS; suite negativa cross-tenant |
| RF-286 | Reportes, exportación y compatibilidad | §12–§16; reports/web; PDF/CSV/browser tests |
| RF-287 | Reportes, exportación y compatibilidad | §12–§16; reports/web; PDF/CSV/browser tests |
| RF-288 | Reportes, exportación y compatibilidad | §12–§16; reports/web; PDF/CSV/browser tests |
| RF-289 | Reportes, exportación y compatibilidad | §12–§16; reports/web; PDF/CSV/browser tests |
| RF-290 | Estados finales de caja | §9.3, §10–§11; state machine y tests de transición |
| RF-291 | Estados finales de caja | §9.3, §10–§11; state machine y tests de transición |
| RF-292 | Estados finales de caja | §9.3, §10–§11; state machine y tests de transición |
| RF-293 | Ciclo de invitaciones | §7.2, §10; users/invitations; tests expiración/reenvío |
| RF-294 | Ciclo de invitaciones | §7.2, §10; users/invitations; tests expiración/reenvío |
| RF-295 | Venta de total cero | §9.4; sales/cash/inventory/receipt; integración completa |
| RF-296 | Incidencias de inventario offline | §9.2, §10–§11; inventory incidents; tests de ciclo y permisos |
| RF-297 | Incidencias de inventario offline | §9.2, §10–§11; inventory incidents; tests de ciclo y permisos |
| RF-298 | Incidencias de inventario offline | §9.2, §10–§11; inventory incidents; tests de ciclo y permisos |
| RF-299 | Incidencias de inventario offline | §9.2, §10–§11; inventory incidents; tests de ciclo y permisos |
| RF-300 | Incidencias de inventario offline | §9.2, §10–§11; inventory incidents; tests de ciclo y permisos |
| RF-301 | Incidencias de inventario offline | §9.2, §10–§11; inventory incidents; tests de ciclo y permisos |
| RF-302 | Preservación histórica offline D01 | §6.4, §11; lifecycle, exposiciones/checkpoints, UI y pruebas de concurrencia/late data |
| RF-303 | Preservación histórica offline D01 | §6.4, §11; lifecycle, exposiciones/checkpoints, UI y pruebas de concurrencia/late data |
| RF-304 | Preservación histórica offline D01 | §6.4, §11; lifecycle, exposiciones/checkpoints, UI y pruebas de concurrencia/late data |
| RF-305 | Preservación histórica offline D01 | §6.4, §11; lifecycle, exposiciones/checkpoints, UI y pruebas de concurrencia/late data |
| RF-306 | Preservación histórica offline D01 | §6.4, §11; lifecycle, exposiciones/checkpoints, UI y pruebas de concurrencia/late data |
| RF-307 | Preservación histórica offline D01 | §6.4, §11; lifecycle, exposiciones/checkpoints, UI y pruebas de concurrencia/late data |
| RF-308 | Preservación histórica offline D01 | §6.4, §11; lifecycle, exposiciones/checkpoints, UI y pruebas de concurrencia/late data |
| RF-309 | Entrega opaca offline D02 | §7.3, §8.2, §11.1.1–§11.3.1; cifrado híbrido, canal delivery, RLS y pruebas de revocación |
| RF-310 | Entrega opaca offline D02 | §7.3, §8.2, §11.1.1–§11.3.1; cifrado híbrido, canal delivery, RLS y pruebas de revocación |
| RF-311 | Entrega opaca offline D02 | §7.3, §8.2, §11.1.1–§11.3.1; cifrado híbrido, canal delivery, RLS y pruebas de revocación |
| RF-312 | Entrega opaca offline D02 | §7.3, §8.2, §11.1.1–§11.3.1; cifrado híbrido, canal delivery, RLS y pruebas de revocación |
| RF-313 | Entrega opaca offline D02 | §7.3, §8.2, §11.1.1–§11.3.1; cifrado híbrido, canal delivery, RLS y pruebas de revocación |
| RF-314 | Entrega opaca offline D02 | §7.3, §8.2, §11.1.1–§11.3.1; cifrado híbrido, canal delivery, RLS y pruebas de revocación |
| RF-315 | Entrega opaca offline D02 | §7.3, §8.2, §11.1.1–§11.3.1; cifrado híbrido, canal delivery, RLS y pruebas de revocación |
| RF-316 | Entrega opaca offline D02 | §7.3, §8.2, §11.1.1–§11.3.1; cifrado híbrido, canal delivery, RLS y pruebas de revocación |
