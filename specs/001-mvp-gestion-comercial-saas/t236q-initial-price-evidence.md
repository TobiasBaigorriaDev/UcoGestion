# T236Q — Precio de venta en el alta

Solicitud del 2026-10-11: permitir cargar el precio al agregar un producto. Trazabilidad RF-43, RF-44, RF-46, RF-152–RF-154 y RF-221; extensión del alta prevista en T095A y documentada en plan §11.2.

Se agrega «Precio de venta opcional» con teclado decimal, ayuda persistente y error vinculado mediante ARIA. Acepta enteros, coma o punto y hasta dos decimales, incluyendo cero; rechaza negativos, más de dos decimales y valores que exceden numeric(20,2). Money convierte la entrada a string canónico sin cálculos de punto flotante. Campo vacío conserva el alta sin precio. Después de guardar se limpian los campos y se informa si el ítem se creó con precio.

El POST existente acepta `price` opcional. Se reutiliza `normalizeCatalogPrice` tanto en alta como en cambio de precio. El servicio guarda ítem, versión append-only de precio y moneda base vigente, referencia monetaria de la organización, respuesta idempotente y auditoría en una sola transacción RLS bajo lock de organización. El trigger existente exige incrementar la versión del ítem: el alta con precio termina con version 2 y priceVersion 1. Omitir precio mantiene request hash y respuesta anteriores. Un fallo de auditoría revierte todos los efectos; replay devuelve el mismo ID/precio sin duplicar historial y reutilización con otro precio produce conflicto. Se conservan autorización OWNER/ADMIN y validación de categorías tenant. No hay nuevas dependencias, migraciones ni cambios de contratos offline o snapshots.

Archivos de implementación:

- `apps/web/src/features/catalog/catalog-item-management.tsx`: formulario, validación, normalización, body y respuesta del alta.
- `apps/api/src/modules/catalog/catalog-item-creation.service.ts`: precio inicial transaccional para alta interna e idempotente.
- `apps/api/src/modules/catalog/catalog-price.service.ts`: validador reutilizado.
- `apps/api/src/modules/catalog/catalog-item-management.controller.ts`: campo opcional estricto.
- `specs/001-mvp-gestion-comercial-saas/plan.md` y `tasks.md`: contrato y trazabilidad.

Pruebas y resultados:

- RED: la prueba UI falló por ausencia de «Precio de venta opcional»; PostgreSQL falló porque el resultado no tenía precio ni priceVersion y version seguía en 1.
- `pnpm --filter @uconext/web test -- catalog-item-management.test.tsx --maxWorkers=1 --testTimeout=20000`: 8/8. Precio con coma normalizado, negativos/precisión/texto inválidos bloqueados sin enviar alta, éxito y reset; conserva regresiones de categoría y edición.
- `pnpm --filter @uconext/api test -- catalog-item-creation.integration.test.ts catalog-price.integration.test.ts`: 19/19 con PostgreSQL real y rol runtime. Persistencia inicial, moneda ARS, historial único, replay, conflicto de payload, permiso negativo, cero, validación y rollback al forzar fallo real en el trigger de auditoría. Pruebas existentes de precios preservadas.
- `pnpm --filter @uconext/api test -- catalog-and-invitation-http.e2e.test.ts catalog-item-creation.integration.test.ts`: 28/28. POST estricto con price string, HTTP 201, replay, conflicto 409 y decimal inválido/tipo numérico rechazados con 400; categoría ajena/inactiva rechazada también en altas con precio.
- `pnpm lint`, `pnpm typecheck`, `pnpm build`: correctos. El aviso de middleware/proxy en build es previo.
- `pnpm test:e2e:catalog`: 2/2, 110,23 s. Escenario ampliado en `apps/web/test/browser/catalog-item-category.mjs` y `apps/api/test/catalog-category-browser.e2e.ts`: rechaza precio negativo, crea con 1500,50, conserva precio tras reload y cambios de categoría, y compara estado final en PostgreSQL. Axe sin violaciones y sin desbordamiento horizontal a 1280/390 px. Capturas `output/playwright/t236q-initial-price-1280.png` y `t236q-initial-price-390.png` inspeccionadas: campo, ayuda, categoría y precio guardado legibles en ambos tamaños.

El entorno local se actualiza usando el script existente `output/mvp-demo/update-catalog-category.mjs`: conserva datos, claves y servidor web, aplica migraciones versionadas idempotentes y reinicia únicamente la API cuyo PID/identidad se verificaron. Se amplió su espera de arranque a 60 segundos. No se ejecuta setup ni se crea un producto de prueba en la base del usuario.

La API actualizada respondió 200 en `/api/v1/health/ready`. El launcher encontró una aserción de Node en Windows al terminar mediante `process.exit` después del arranque; la API detached permaneció saludable. Se sustituyó esa salida forzada por finalización natural del script.

Observabilidad y errores: pipeline HTTP existente con trace/request IDs y application/problem+json; auditoría `catalog_item.created` incluye el precio inicial. No hay cambios de outbox, worker ni retry de transacciones; el comando conserva la política existente de idempotencia y autorización por replay.

Límite de reversión: retirar solo T236Q de los archivos compartidos, conservando las correcciones de categorías y cambios previos del usuario. Los precios e historiales ya confirmados permanecen intactos. No se creó commit que incluyera modificaciones previas ajenas.

## Ajuste de alineación solicitado

Se separan los datos básicos del alta y los campos categoría/precio/SKU/código de barras en dos grillas. La clase específica `itemCreateFields` alinea los campos desde arriba, evitando que la ayuda del precio desplace el SKU. En escritorio categoría, precio y SKU comparten fila; en móvil conservan el orden de lectura y teclado en una columna. No se modifican otros formularios ni contratos.

La regresión de Playwright compara la coordenada vertical real de los tres controles: RED reproducido con «Category, price and SKU controls are not aligned on desktop». Las ocho pruebas del formulario pasan y el detector layout no informa hallazgos. Los scripts raíz lint/typecheck encontraron un error de lanzamiento de Turbo en Windows (`spawn UNKNOWN`); se ejecutan los mismos scripts de todos los workspaces mediante `pnpm -r lint` y `pnpm -r typecheck`.

GREEN: `pnpm test:e2e:catalog` pasa 2/2 (89,30 s), incluyendo la comparación de alineación, axe y controles responsive. Capturas de 1280/390 px inspeccionadas; la fila de categoría/precio/SKU/código de barras queda alineada en escritorio y no hay desbordamiento móvil. `pnpm -r lint` y `pnpm -r typecheck` pasan en todos los workspaces. El servidor web local incorpora el ajuste mediante recarga, sin reiniciar API ni modificar datos.
