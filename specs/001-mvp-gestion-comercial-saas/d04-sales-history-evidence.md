# D04 — Historial de ventas

Solicitud explícita del usuario (2026-10-11), RF-324–RF-328 y plan §23. Alcance exclusivo del historial de la sucursal activa; conserva consulta por ID, detalle, comprobante y permisos. No cierra pendientes D03 ni declara cumplimiento global del MVP.

## Archivos del incremento

- API: `sales.controller.ts`, `sales-operations.service.ts`, snapshot OpenAPI.
- Web: `sale-history.tsx`, `sale-lookup.tsx`, `sales-api.ts`, estilos localizados en `pos.module.css`.
- Pruebas: `sales-http.e2e.test.ts`, `sale-lookup.test.tsx`, escenario `sales-history.mjs` y ejecución adicional en `sale-id-browser.e2e.ts`.
- Trazabilidad: spec RF-324–RF-328, plan §23 y D04-T01. Se preservan cambios previos del usuario en archivos compartidos.

## Evidencia TDD y gates

1. RED API: `pnpm --filter @uconext/api test -- sales-http.e2e.test.ts`: nuevo GET devolvió 404; dos pruebas anteriores pasaron.
2. RED UI: `pnpm --filter @uconext/web test -- sale-lookup.test.tsx`: faltaba el botón de selección del historial; pruebas anteriores pasaron.
3. GREEN API final: mismo comando, 3/3 tests con PostgreSQL Testcontainers y rol runtime sin bypass. Prueba empates a microsegundos, cursor sin duplicación, fechas locales inclusivas, estados, entradas inválidas, tenant ajeno y scope de rol/sesión/sucursal. Membresía revocada devuelve 403.
4. Contrato: `pnpm --filter @uconext/api test -- request-contracts.test.ts`, 4/4; snapshot actualizado exclusivamente con GET y parámetros de historial. La ejecución conjunta inicial sufrió un worker terminado mientras corrían gates de navegador; ejecución aislada posterior pasó.
5. UI final: `pnpm --filter @uconext/web test -- sale-lookup.test.tsx pos-checkout.test.tsx`, 7/7. Filtros, cursor, selección/detalle/foco, reinicio de sucursal, fechas inválidas, error/reintento y regresión checkout.
6. `pnpm test:e2e:catalog`: 4/4 en 2 archivos, incluido historial real con páginas de 25 y 2 ventas, teclado, detalle/anulación/refresco, filtro anuladas y vacío. Axe sin violaciones y sin overflow a 390/768/1280px. Capturas y resultado en `output/playwright/sales-history-*`.
7. Lint y typecheck de `@uconext/api` y `@uconext/web` pasaron. Builds directos de API y web pasaron; Next informa advertencia preexistente de middleware/proxy.
8. Comandos raíz `pnpm lint`, `pnpm typecheck`, `pnpm build`: Turborepo no inició (`spawn UNKNOWN`) en este Windows. Se ejecutaron los scripts equivalentes de ambos paquetes; no se modificó tooling ajeno al alcance.
9. Detector Impeccable de las dos vistas: resultado `[]`. `git diff --check` sin errores.

## Invariantes y límites

Lectura bajo transacción tenant contextualizada y RLS. Autorización replica el detalle (incluye actor y titular para CASHIER). SQL parametrizado, filtros allowlist, límites 1–100 y decimales string. Cancelación se deriva de historial inmutable. No agrega escrituras: atomicidad de efectos, claves idempotentes y auditoría de nuevas mutaciones son N/A; la anulación reutiliza el caso de uso existente. Observabilidad HTTP y Problem Details existentes cubren lectura y errores. Reintento de consulta no produce efectos.

Sin migraciones ni dependencias nuevas. La paginación no congela el conjunto frente a ventas o anulaciones concurrentes; reiniciar filtros o volver a la primera página refresca los datos. Rollback detallado en plan §23, limitado a D04.


Verificación posterior al ajuste de foco: `pnpm --filter @uconext/api exec vitest run --config vitest.browser.config.mts sale-id-browser.e2e.ts`, 2/2, PostgreSQL runtime y Playwright CLI; `pnpm --filter @uconext/web build` pasó. El primer intento tras una pausa no encontró Docker; se inició Docker Desktop y se repitió exitosamente sin omitir tests. Lint web final pasó después de declarar URL como global del escenario browser. D04-T01 completada; gates raíz mantienen el límite de infraestructura informado.
