# T236O — Búsqueda en administración de ítems

Solicitud: disponer del buscador al entrar en «Administrar ítems».

El listado administrativo incorpora el mismo buscador de consulta: nombre, SKU o código de barras, normalización de mayúsculas/tildes/espacios exteriores, contador, limpieza con foco y mensaje sin coincidencias. Filtra productos y servicios activos e inactivos presentes en la respuesta autorizada. Las acciones de los resultados conservan sus handlers, versiones y permisos existentes; el formulario de alta permanece intacto. Componente y filtrado ahora se comparten dentro del módulo de catálogo.

Trazabilidad: RF-152–RF-154 y RF-221; plan §7.3 y §12. Sin cambios de API, persistencia, dependencias ni autorización. T236 conserva su estado pendiente.

Archivos:

- `apps/web/src/features/catalog/components/catalog-search.tsx`: componente y filtro compartidos.
- `apps/web/src/features/catalog/catalog-read.tsx`: utiliza el componente compartido.
- `apps/web/src/features/catalog/catalog-item-management.tsx`: búsqueda encima del listado administrativo.
- `apps/web/test/catalog-item-management.test.tsx`: regresiones de búsqueda, acciones, ítems inactivos y catálogo vacío.
- `apps/web/test/browser/catalog-search.mjs`: navegación desde catálogo al botón «Administrar ítems» y comprobación del buscador.
- `specs/001-mvp-gestion-comercial-saas/tasks.md`: tarea y evidencia.

Verificación:

- RED: `pnpm --filter @uconext/web test -- catalog-item-management.test.tsx`: 2 fallos por ausencia del buscador y 4 pruebas existentes verdes.
- GREEN: `pnpm --filter @uconext/web test -- catalog-read.test.tsx catalog-item-management.test.tsx catalog-category-management.test.tsx`: 16 pruebas verdes en 3 archivos. La prueba de interacción usa el timeout de 15 segundos empleado por otros escenarios del archivo; la primera ejecución concurrente superó el límite predeterminado de 5 segundos.
- `pnpm lint --filter=@uconext/web`: correcto.
- `pnpm typecheck --filter=@uconext/web`: correcto.
- Impeccable `detect --json` sobre los tres archivos de implementación: `[]`.
- `pnpm exec playwright-cli run-code --filename output/playwright/catalog-search-check.mjs --raw`: búsqueda, administración, teclado y accesibilidad correctos. Se genera el escenario sustituyendo `AXE_SOURCE` con el contenido JSON serializado de `apps/web/node_modules/axe-core/axe.min.js`.

Navegador: navegación mediante el botón real; filtrado por tres campos, ausencia de coincidencias, edición del resultado, limpieza con recuperación de foco y recuperación de ítems inactivos. Axe sin violaciones y sin overflow en administración a 1440 y 390 px; consulta también verificada a 768 px. Capturas inspeccionadas: `output/playwright/managed-catalog-1440.png` y `output/playwright/managed-catalog-390.png`.

El escenario usa respuestas HTTP controladas para verificar UI; no sustituye evidencia de autorización o PostgreSQL. Los avisos previos de CSP corresponden a Next DevTools en desarrollo, cuyo portal se retira de los escaneos. No se modifican garantías transaccionales, idempotencia, auditoría ni reintentos del backend.
