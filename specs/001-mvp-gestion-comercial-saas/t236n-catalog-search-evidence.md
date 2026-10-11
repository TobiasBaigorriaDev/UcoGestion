# T236N — Buscador y accesos de catálogo

Solicitud: hacer visible el buscador de productos y los botones «Administrar ítems» y «Administrar categorías de catálogo».

La búsqueda existente ahora presenta label persistente, icono, placeholder, ayuda, contador anunciado y acción para limpiar conservando el foco. Filtra el conjunto autorizado actual por nombre, SKU o código, ignorando mayúsculas, tildes y espacios exteriores. Conserva la consulta de servicios y el contexto histórico de EMPLOYEE. Los accesos usan las primitivas visuales `uco-button` y mantienen semántica de enlace y disponibilidad exclusiva para OWNER/ADMIN.

Trazabilidad: RF-152–RF-154 (responsive, accesibilidad y teclado), RF-221–RF-223 (administración y consulta por rol), plan §7.3 y §12. No requiere migraciones, dependencias ni cambios de contratos. Se preservan los cambios anteriores del usuario y el estado pendiente de T236.

Archivos de implementación y pruebas:

- `apps/web/src/features/catalog/catalog-read.tsx`
- `apps/web/src/features/catalog/catalog-read.module.css`
- `apps/web/test/catalog-read.test.tsx`
- `apps/web/test/browser/catalog-search.mjs`
- `specs/001-mvp-gestion-comercial-saas/tasks.md`

Verificación ejecutada:

- RED: `pnpm --filter @uconext/web test -- catalog-read.test.tsx`: 3 fallos esperados, 4 pruebas verdes antes de implementar.
- GREEN: `pnpm --filter @uconext/web test -- catalog-read.test.tsx catalog-item-management.test.tsx catalog-category-management.test.tsx`: 14 pruebas verdes en 3 archivos, incluida accesibilidad de componente y restricciones de rol.
- `pnpm lint --filter=@uconext/web`: correcto.
- `pnpm typecheck --filter=@uconext/web`: correcto.
- Impeccable `detect --json` sobre ambos archivos de implementación: `[]`.
- `pnpm exec playwright-cli run-code --filename output/playwright/catalog-search-check.mjs`: correcto. Escenario generado desde el archivo de navegador sustituyendo `AXE_SOURCE` por el contenido JSON serializado de `apps/web/node_modules/axe-core/axe.min.js`.

Playwright verificó las tres entradas de búsqueda, el estado sin coincidencias, limpieza y recuperación, URLs de administración, orden de tabulación, foco visible, controles de al menos 44 px, ausencia de desbordes y axe sin violaciones a 1440, 768 y 390 px. Capturas inspeccionadas de escritorio y teléfono: `output/playwright/catalog-1440.png` y `output/playwright/catalog-390.png`.

Límite de esta evidencia: el escenario de navegador sustituye los puertos HTTP por respuestas controladas; verifica presentación e interacción, no autenticación ni aislamiento PostgreSQL. La sesión de prueba sin fixtures requería login. Next en desarrollo emite errores previos de CSP de DevTools; se retiró únicamente su portal de las capturas y del escaneo axe. La CSP del producto permanece intacta. No se modifica operación offline ni ningún bloque transaccional: atomicidad, idempotencia, auditoría y reintentos de negocio siguen en sus implementaciones existentes.
