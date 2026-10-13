# T236W — Iconos SVG de categorías

Solicitud explícita del usuario del 2026-10-12 [RF-341–RF-343].

## Biblioteca y persistencia

Selección de 20 SVG de [Lucide](https://lucide.dev/), licencia ISC incluida, revisión `440a1e1dfb1e712505308da46bead3c28b1f1398`. Assets locales en `apps/web/public/icons/categories`, stroke adaptado al verde existente; SOURCE.md documenta modificación. Sin nueva dependencia npm, llamadas a CDN ni importaciones dinámicas de biblioteca completa. Identificadores finitos en shared y validación Zod/SQL; nunca se permite contenido SVG arbitrario.

Migración `0111_catalog_category_icons` agrega columna nullable/CHECK y permisos INSERT/UPDATE por columna bajo RLS. Debe aplicarse mediante el despliegue de migraciones versionadas en cada entorno, antes de servir la API actualizada; no se ejecuta sobre bases desconocidas ni producción desde esta tarea. Bases Testcontainers ejecutaron la migración.

## Archivos y comportamiento

- Shared `category-icons.ts` y export público: identificadores/schema.
- API: schema Drizzle, migración/journal, category management/lifecycle/read. Icono incluido en payload idempotente solo cuando se envía, auditado junto a cambio de nombre; actualización omitida conserva icono, null restaura carpeta. Misma transacción, locks, epoch y versionado. Status devuelve el icono conservado; replays anteriores sin campo siguen válidos.
- Web: `CategoryIcon`, `CategoryIconPicker` y CSS; category management, read y product list. Búsqueda sin acentos, radio buttons, preview, cierre tras elección/foco restaurado; crear/editar y carpetas. Expense categories conserva el flujo anterior.
- Tests de UI, integración PostgreSQL/HTTP y escenario browser `category-icons.mjs`.

## Verificación

- RED UI: selector ausente en `catalog-category-management.test.tsx -t 'selects a library'`.
- RED PostgreSQL: `catalog-category-management.integration.test.ts -t 'persists library'` falla por icon ausente. Primera integración con nueva columna detecta falta de INSERT(icon); grant por columna corregido y suites verdes.
- GREEN web: `pnpm --filter @uconext/web exec vitest run test/catalog-category-management.test.tsx test/catalog-item-management.test.tsx test/catalog-read.test.tsx test/catalog-sort.test.ts test/catalog-stock.test.tsx`: 34/34.
- GREEN PostgreSQL: `pnpm --filter @uconext/api exec vitest run test/catalog-category-management.integration.test.ts test/catalog-read.integration.test.ts`: 11/11. Persistencia, creación/edición/replay/hash distinto, omisión/null, negativas tenant/roles, DB CHECK, lectura y rollback de icon/name/version/epoch/idempotencia ante fallo de auditoría con reintento posterior. Se reejecutó lectura con icono no nulo en la fixture.
- GREEN HTTP: `pnpm --filter @uconext/api exec vitest run test/catalog-and-invitation-http.e2e.test.ts`: 14/14 con PostgreSQL real/runtime, validación de icon desconocido 400 y creación/lectura; conserva precondiciones y autorización existentes.
- `pnpm lint`, `pnpm typecheck`: pasan en monorepo. Shared compilado con `pnpm --filter @uconext/shared build`. Detector sin hallazgos; diff-check sin errores.
- Playwright CLI Chromium/Next dev a 1440/390: 20 SVG cargan; cero violaciones axe y sin overflow. Búsqueda sin acentos/vacío, selección con Space y retorno de foco, payload de creación/edición, recarga y carpeta muestran icon elegido. Resultado `output/playwright/category-icons-result.log`; capturas `category-icon-library-{1440,390}.png`. HTTP interceptado para UI; persistencia/autorización acreditadas separadamente en PostgreSQL/HTTP.

No se reescriben snapshots, ventas/compras ni cola offline; activos públicos nuevos se sirven localmente. Logs/trazas y errores usan infraestructura existente sin nuevos labels. No se declara verde suite global ni se cierran gates ajenos pendientes.
