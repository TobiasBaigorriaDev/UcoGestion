# T236X — Iconos sin nombres y variedad para almacenes/kioscos

Solicitud explícita del usuario, 2026-10-12. RF-341–RF-343 y RF-221–RF-222. Cambios localizados sobre T236W; nombres de categoría y flujos de creación/edición conservados.

## Archivos y decisiones

- `apps/web/src/features/catalog/components/category-icon-picker.tsx` y CSS: elimina nombres visibles de opciones y vista previa; cuadrícula compacta de objetivos de 64px. Etiquetas ARIA y búsqueda en español conservan identificación accesible. Radio nativo, selección marcada y retorno de foco.
- `apps/web/public/icons/categories`: 32 SVG adicionales Lucide/ISC, misma revisión fijada; biblioteca total de 52. Bebidas, snacks, alimentos, hielo, limpieza, higiene, tabaco, diarios, pilas y recargas. `SOURCE.md` conserva procedencia; sin dependencia npm, CDN ni SVG de usuario.
- `packages/shared/src/category-icons.ts`, schema Drizzle, migración `0112_catalog_category_kiosk_icons.sql` y journal: ampliación compatible de allowlist, conserva los 20 identificadores previos. Migración 0111 no se modifica; no cambia datos, permisos, RLS ni auditoría.
- Tests UI, integración y browser actualizados; spec, plan, tasks y DESIGN trazan el refinamiento autorizado.

## Verificación

- RED UI: nuevo test falla por texto visible «Icono: Carpeta general».
- RED PostgreSQL: prueba de creación/auditoría/replay con cup-soda falla inicialmente con CATALOG_CATEGORY_ICON_INVALID.
- Shared: `pnpm --filter @uconext/shared build`, pasa.
- Web: `pnpm --filter @uconext/web exec vitest run test/catalog-category-management.test.tsx test/catalog-item-management.test.tsx test/catalog-read.test.tsx test/catalog-sort.test.ts test/catalog-stock.test.tsx`: 35/35.
- API: `pnpm --filter @uconext/api exec vitest run --config vitest.config.mts test/catalog-category-management.integration.test.ts test/catalog-read.integration.test.ts test/catalog-and-invitation-http.e2e.test.ts`: 25/25. PostgreSQL real con migraciones 0111/0112; nuevo icono admitido, idempotencia/auditoría, autorización y rechazo de iconos desconocidos; rollback/reintento conservados.
- Raíz: `pnpm lint` y `pnpm typecheck`, 4 tareas exitosas cada uno.
- Playwright CLI Chromium/Next dev: desktop 1440px y móvil 390px, 52 SVG cargados, ningún nombre visible de iconos ni desbordamiento; axe sin violaciones. Selección por Space, retorno de foco, búsqueda, creación del nuevo icono cup-soda, recarga, edición y carpeta. HTTP interceptado para flujo UI; persistencia comprobada separadamente en PostgreSQL. Resultado en `output/playwright/category-icons-result.log`; capturas `category-icon-library-{1440,390}.png` inspeccionadas en una ronda conjunta. Sesión temporal cerrada.
- Diff-check de archivos modificados por esta tarea: pasa. Diff-check global detecta una línea vacía preexistente al final de `apps/web/test/middleware-security-headers.test.ts`, archivo ajeno a esta tarea, conservado.

Las migraciones están preparadas y probadas en Testcontainers; no se aplicaron a una base de desarrollo o producción. No se declara verde la suite global ni se cierran gates ajenos. No cambian atomicidad, idempotencia, locks, audit, logs/traces, errores ni comportamiento de reintentos.

## Corrección del entorno local — rechazo al guardar (2026-10-12)

El usuario reportó VALIDATION_FAILED al guardar nombre/icono. La API de localhost:4000 ejecutaba PID 10380 desde `apps/api/dist/main.js`; su compilación previa validaba solo name y rechazaba icon como campo desconocido. El frontend y el código fuente ya enviaban/admitían los nuevos iconos. Se añadió cobertura HTTP explícita de edición y replay con cup-soda (14/14).

`pnpm --filter @uconext/api build` recompiló API y assets de migración. Tras verificar destino de demostración en loopback:55432 y base `uconext_small_business_demo`, `node output/mvp-demo/update-catalog-category.mjs` aplicó migraciones pendientes y reinició exclusivamente la API identificada por PID/commandline. Readiness pasó; Next existente conservado. La base local ahora incluye 0111/0112; la afirmación anterior de migraciones no aplicadas describe el estado previo a esta corrección.

Playwright CLI contra la API real, sin interceptar HTTP: login local, categoría temporal nueva, cambio solo de nombre, cambio solo de icono cup-soda, reload que conserva el icono y eliminación de la categoría temporal. Todas las operaciones pasaron. `output/playwright/category-save-green.log` registra nameSaved/iconSaved/reload/temporaryCategoryRemoved=true. Se conserva auditoría y el resto de los datos del usuario. Sesión temporal cerrada.
