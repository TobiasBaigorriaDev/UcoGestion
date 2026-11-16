# Cierre previo a producción — 2026-11-16

Rama `release/pre-production`, [PR #1](https://github.com/TobiasBaigorriaDev/UcoGestion/pull/1). Este bloque continúa la [auditoría del 2026-11-16](../auditoria-2026-11-16.md). No modifica el spec ni las decisiones aprobadas del plan. **No emite LISTO PARA PRODUCCIÓN**, porque la infraestructura real (P04–P12) sigue pendiente.

## Correcciones con regresión previa

| Defecto | Prueba que lo reproduce | Corrección |
|---|---|---|
| El CI fallaba en cada push desde el 2026-10-10. En un checkout limpio, `typecheck` no encontraba `@uconext/shared`, porque sus tipos se exportan desde `dist` | `test/workspace.smoke.test.mjs` (nuevo caso). Además, se borró `packages/shared/dist` localmente y `pnpm typecheck --force` dio 41 errores TS2307 | `lint`, `typecheck` y `test` dependen de `^build` en `turbo.json` |
| El nightly estaba rojo: el fixture UI no servía `/sales`, `/purchases` ni las tendencias | `ui-critical` fallaba con "Unhandled UI fixture /sales" | Respuestas del fixture conformes a los schemas reales |
| Los filtros de fecha del historial de ventas y compras no mostraban foco de teclado (Chromium no aplica `:focus-visible` al host de `input[type=date]`) | `ui-critical`: `sales-from`, `sales-to`, `purchases-from` y `purchases-to` con `indicated:false` en las 5 vistas | `.historyFilters input[type="date"]:focus-within`, el mismo patrón que ya usaba el dashboard |
| `catalog-category` y `sale-id` (backend real) esperaban la UI previa a T236W y T236AF | Timeouts reproducibles con `pnpm test:e2e:catalog` | Envío con Enter desde el campo y nuevo aviso de sincronización |

## Pruebas nuevas

- `packages/shared/src/sale-code.test.ts` (D05). Propiedades fast-check:
  - los 12 caracteres salen del alfabeto sin I/L/O/U;
  - el código es determinista;
  - el código se resuelve a un rango que contiene el UUID;
  - se toleran variantes O/0, I/L/1, espacios y guiones;
  - entradas inválidas;
  - colisión controlada.
- `apps/api/test/sale-code-lookup.e2e.test.ts` (D05). HTTP con PostgreSQL y runtime `uco_app`:
  - el código resuelve, también con variantes y con el UUID completo;
  - responde 400 ante formato inválido;
  - responde 404 ante otro tenant, un ADMIN fuera de su sucursal o un CASHIER con sesión ajena;
  - responde 409 `SALE_CODE_AMBIGUOUS` sin revelar los IDs;
  - las consultas no cambian ventas, auditoría ni idempotencia.
- `apps/api/test/authorization-route-matrix.e2e.test.ts` (T236K, RF-19/RF-21/RF-23). Las rutas se descubren desde los metadatos de Nest en tiempo de ejecución. Cada ruta protegida rechaza seis casos: sin sesión, sesión cerrada, sin organización, tenant ajeno, membresía `INACTIVE` y membresía `REVOKED`. Todos responden `problem+json` con un código estable y sin escrituras en ninguna tabla. Las 15 rutas públicas son una lista revisada explícita. Mutación: aceptar `INACTIVE` en `TenantMembershipService` hace fallar el test.
- `apps/api/test/tenant-schema-invariants.integration.test.ts` (CHECK-02, RF-285). Sobre el esquema efectivo que producen todas las migraciones:
  - RLS en toda tabla con `organization_id`, y política en las que el runtime puede acceder;
  - `uco_app` sin superuser, sin BYPASSRLS y sin ownership;
  - toda FK entre tablas tenant incluye `organization_id`;
  - ninguna FK cascadea ni pone `NULL`.

  Las tablas `catalog_*_identities` tienen RLS sin políticas y ningún privilegio del runtime, es decir, niegan todo. Las escribe exclusivamente un trigger `SECURITY DEFINER`.

## Arquitectura

- Una regla de ESLint `no-restricted-imports` en `apps/api/src/modules/**` obliga a que los módulos colaboren solo mediante su `index.ts`. Antes había 23 violaciones; ahora hay 0.
- `hashPassword`, `normalizeEmail` y `DeviceCertificate` pasan a `core/security`. Eso elimina los ciclos `auth ↔ users` y `cash ↔ offline-sync`. Los archivos que exponen los índices son hojas, así que no quedan ciclos entre archivos.
- `new CustomerAccountService()` dentro de ventas se mantiene. Sigue la convención del módulo para puertos que solo reciben el cliente transaccional (`SaleCancellationPreparation`, `SalesQuoteService`).

## Ejecuciones

| Comando | Resultado |
|---|---|
| CI `ci.yaml` sobre `ad5d662` (run 43803943283, Linux): lint, typecheck, suite completa con PostgreSQL, build, gate crítico y catálogo | **success**: la primera corrida verde del repositorio |
| Nightly `browser-nightly.yaml` sobre la rama (run 43802651078): Chromium, Firefox y WebKit | **success** en los tres motores |
| Local `pnpm test:e2e:critical` (Windows, Chromium) | 6/6 PASS |
| Local `pnpm test:e2e:catalog` | Tras la corrección, `catalog-category` 2/2 y `sale-id` 3/3 PASS |
| Local nightly Chromium | 17/18 en secuencia. `branch-deactivation` falla solo en la secuencia local; pasa aislado 2/2 y en el CI. `receipt-safety` PASS aislado |
| Local API, suite completa (antes de este bloque) | 698/698 PASS |

### Límite conocido del entorno local Windows

Cuando varios archivos de la API se ejecutan seguidos, un fork de Vitest puede terminar con `exitCode 3221226505` (0xC0000409, abort nativo) sin mensaje. Lo registra `ops/verification/trace-test-workers.cjs`. Se reproduce con apenas `sale-code-lookup` + `authorization-route-matrix`, y bajar el nivel de logs no lo evita. Los mismos archivos pasan aislados y en la suite completa de Linux CI. No afecta al runtime de producción (contenedores Linux). Sigue abierto como deuda del entorno de desarrollo.

## Estado de tareas tras este bloque

- **Cerradas:**
  - D05-T01–T03 (D05 completo).
  - D03-T05: gates multimotor en CI y escenario real con ACK perdido.
  - T236AM: build con origen e identidad de release, y gate de navegador en verde sobre ese build.
  - T236K8: invariante de esquema sobre todas las relaciones, más los casos de IDs cruzados previos.
- **Abiertas:**
  - T236K2, T236K3 y T236K4. La dimensión membresía/tenant ya cubre todas las rutas. Falta la matriz rol × comando con payloads válidos para los comandos que no cubren `t236k-authorization` ni `authorization-read-http`.
  - T224 y T227: instalación PWA y navegadores con marca reales (Safari real requiere un dispositivo Apple).
  - T236AL: imágenes e infraestructura reales.
  - T236 y P04–P12.
