# T236P — Categoría en alta y edición de ítems

Solicitud autorizada el 2026-10-11: corregir la pantalla que no permitía asignar ni cambiar la categoría de producto. RF-50, RF-51, RF-152–RF-154, RF-221 y preservación de RF-269; plan §7.3, §11.2 y §12.

El alta y la edición incorporan un selector con «Sin categoría» y las categorías activas de catálogo de la organización. El listado informa la categoría actual. Una categoría inactiva ya asignada se conserva y se identifica como inactiva; no se ofrece como nueva asignación. Al volver a abrir edición se cargan los datos vigentes del ítem. Workspace carga ambos recursos con TanStack Query y permite reintentar si falla cualquiera.

El PATCH existente acepta `categoryId` opcional: omitido preserva la asignación y el hash de requests anteriores, `null` la retira. El GET administrativo devuelve el ID actual. Se valida OWNER/ADMIN y pertenencia tenant dentro de la transacción RLS; se bloquea el ítem y se verifica la versión, y una categoría nueva se valida activa bajo `FOR SHARE`. Actualización, versión, respuesta idempotente y auditoría con valores previos/posteriores se confirman juntos. Replays idénticos devuelven el resultado persistido y payloads diferentes con la misma clave son rechazados. La migración 0110, registrada en el journal, concede solo UPDATE de `category_id` al rol runtime. No modifica RLS, FK tenant RESTRICT, snapshots ni contratos offline.

Archivos de implementación: `apps/web/src/features/catalog/catalog-item-management.tsx`, `apps/web/src/features/identity/workspace.tsx`; `apps/api/src/modules/catalog/catalog-item-edit.service.ts`, `catalog-item-management.controller.ts`, `catalog-read.service.ts`; `apps/api/src/database/migrations/0110_catalog_item_category_edit.sql` y `meta/_journal.json`. Traces y errores utilizan el pipeline HTTP existente. No se agregaron dependencias.

Pruebas: `apps/web/test/catalog-item-management.test.tsx`; `apps/api/test/catalog-item-lifecycle.integration.test.ts`, `catalog-and-invitation-http.e2e.test.ts`, `document-category-migration.integration.test.ts`; arnés real `catalog-category-browser.e2e.ts`, `apps/web/test/browser/catalog-category.tsx`, `catalog-category.vite.mjs` y `catalog-item-category.mjs`. Se actualiza la respuesta de categorías de la fixture `catalog-search.mjs` para el nuevo GET de Workspace.

Evidencia RED: la nueva prueba UI falló por ausencia del selector; la nueva regresión PostgreSQL falló porque el resultado no incluía la asignación.

Verificación:

- `pnpm --filter @uconext/web test -- catalog-item-management.test.tsx`: 7/7.
- `pnpm --filter @uconext/web test -- catalog-item-management.test.tsx catalog-read.test.tsx catalog-category-management.test.tsx --maxWorkers=1 --testTimeout=20000`: 17/17. La primera ejecución concurrente agotó el límite de 5 segundos de una prueba existente; repetición serial correcta, sin omitir escenarios.
- `pnpm --filter @uconext/api test -- catalog-item-lifecycle.integration.test.ts catalog-and-invitation-http.e2e.test.ts catalog-read.integration.test.ts`: 44/44 con PostgreSQL real y rol runtime, incluyendo cambio/retiro, replay, conflicto de clave/version, rollback, categoría inexistente/inactiva/ajena y roles negativos.
- `pnpm --filter @uconext/api test -- catalog-and-invitation-http.e2e.test.ts`: 12/12 tras ampliar el contrato PATCH/GET, UUID inválido, replay y conflictos HTTP.
- `pnpm --filter @uconext/api test -- document-category-migration.integration.test.ts`: 1/1. Aplica 0109/0110 sobre documentos existentes y asigna/retira mediante servicio runtime; conserva líneas históricas UNKNOWN y comprobante original, con triggers defensivos vigentes.
- `pnpm lint`, `pnpm typecheck`, `pnpm build`: correctos. Build conserva el aviso existente de migración futura de middleware a proxy.
- `pnpm test:e2e:catalog`: 2/2, 139.01 segundos. Playwright CLI contra NestJS/PostgreSQL runtime: alta con categoría, cambio a otra, persistencia tras reload y retiro desde móvil; headers de versión e idempotencia correctos y resultado final contrastado en PostgreSQL. Axe sin violaciones y sin overflow a 1280/390 px. Capturas `output/playwright/t236p-item-category-1280.png` y `t236p-item-category-390.png` inspeccionadas. Las primeras ejecuciones agotaron el tiempo al navegar y luego el límite al combinar ambos escenarios; Vite limita el escaneo a la entrada y los escenarios se verifican como dos pruebas independientes, sin omitir pasos.

Entorno local de demostración: se aplicaron las migraciones versionadas usando la configuración local existente y se reinició únicamente la API registrada, verificando su identidad de proceso. Readiness HTTP 200 después del arranque. No se ejecutó setup ni se reinicializó la base. El script `output/mvp-demo/update-catalog-category.mjs` conserva configuración, claves y PID de web; su espera inicial fue insuficiente para el arranque, pero la comprobación posterior confirmó readiness 200.

Límite de reversión: retirar exclusivamente los cambios T236P de los archivos compartidos, manteniendo las modificaciones previas del usuario. No borrar la migración aplicada del journal: un rollback de permisos requiere una migración compensatoria que revoque UPDATE de `category_id`; no borra asignaciones ni documentos. No se creó commit que incluyera cambios previos ajenos.
