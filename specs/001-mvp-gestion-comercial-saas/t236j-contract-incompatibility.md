# T236J — Incompatibilidad del contrato offline con RF-269

Fecha: 2026-10-10. Estado de la revisión inicial: implementación detenida, pendiente de decisión de contrato.

Actualización del 2026-10-10: el usuario autorizó continuar con «hazlo» tras explicar la decisión necesaria. El versionado y su convivencia quedaron documentados en plan §11.2; T236J se implementó y verificó en la [evidencia final](t236j-category-snapshot-evidence.md). El contenido siguiente conserva el diagnóstico y los resultados anteriores a esa aprobación; no describe el estado final.

Este documento registra un bloqueo, no evidencia de cumplimiento de RF-269. No se modificaron contratos, lógica de negocio, sobres, migraciones ni documentos históricos durante esta revisión. Se preservaron los cambios previos del workspace.

## Fuentes y estado observado

RF-269 exige snapshots de identificación, unidad, categoría aplicable, precio/costo y moneda al confirmar ventas y compras. Constitución §9 exige preservar esos valores; §10 y §12 exigen contratos versionados y conservación de operaciones selladas. Plan §6.2, §9.4 y §11 exige snapshots inmutables y validación contra configuración histórica.

- `apps/api/src/database/migrations/0068_sales_foundation.sql` y `0073_purchase_foundation.sql` ya declaran `category_id` y `category_name` nullable en las líneas.
- `apps/api/src/modules/sales/sales-persistence.ts` consulta el ítem vigente bajo lock, pero no consulta categoría ni inserta sus columnas. Tampoco la captura en los ítems del comprobante.
- `apps/api/src/modules/purchases/purchase-persistence.ts` inserta explícitamente `NULL, NULL` para categoría, sin consultar su asignación. Compras tampoco cumple la captura requerida.
- `packages/shared/src/offline-contracts.ts` define un bootstrap versión 1 y configuración strict. Sus ítems no tienen asignación de categoría; `categories` solo enumera IDs/nombres, sin relacionarlos con ítems.
- `apps/api/src/modules/offline-sync/offline-bootstrap.service.ts` no selecciona la asignación en los ítems emitidos y retenidos. `configuration-version.service.ts` tampoco la incluye en su contrato ni consulta.
- `packages/shared/src/offline-operation-contracts.ts` define líneas strict sin categoría; `apps/web/src/offline/offline-sale.ts` produce esas mismas líneas.
- `historical-sale-snapshot.ts` valida contra la configuración retenida y `offline-sale-importer.ts` persiste líneas sin categoría. La ingestión conserva replay y transacción conjunta de documento, efectos y ACK.

## Incompatibilidad y punto de detención

La lista de categorías no demuestra cuál correspondía a cada ítem al confirmar. Dos asignaciones distintas pueden producir exactamente la misma configuración v1 y línea sellada. Ni siquiera una única categoría listada prueba pertenencia: RF-51 admite ítems sin categoría. Ausencia del campo significa información histórica faltante; no demuestra que el ítem careciera de categoría.

Capturar la categoría verificada en nuevas ventas offline requiere cambiar al menos el contrato de configuración/bootstrap para incluir la asignación y su identificación histórica. Capturarla también en el documento local sellado requiere ampliar/versionar el contrato de líneas. Los schemas strict actuales rechazan esos campos. Agregarlos como opcionales sigue siendo una modificación de contrato y exige distinguir explícitamente ausencia histórica de ausencia real de categoría.

Por instrucción del usuario se detiene aquí, antes de implementar ese cambio o avanzar con una entrega parcial online. La skill `C:/Users/tobib/.codex/skills/sdd-build/SKILL.md`, Build mode / Local decisions, también indica: “Stop only when a decision would change: […] a public contract” y “Do not silently change the approved plan.”

## Decisión necesaria para reanudar

Revisar y aprobar en el plan el versionado del contrato de configuración y de operación local, con identidad/nombre de categoría por ítem, diferenciando categoría ausente de dato histórico desconocido. Definir convivencia de lectores/validadores para versiones anteriores y nuevas, sin reescribir ni volver a sellar pendientes, alterar hashes, firmas o ACKs persistidos.

Las versiones anteriores deben conservar la semántica disponible, sin consultar catálogo actual ni rellenar retrospectivamente valores. No se propone rechazo de operaciones legítimas antiguas ni reconstrucción por timestamp. La decisión debe precisar la presentación de información desconocida, sin equipararla a «sin categoría».

Tras aprobación: comenzar con pruebas RED de venta/compra, cambio posterior de asignación y nombre, ítems sin categoría, configuración nueva verificada, ingestión histórica v1, replay exacto y rollback PostgreSQL de todos los efectos. Solo resultados GREEN habilitan cierre y evidencia de T236J.

## Verificación del estado existente

Todos los comandos terminaron con exit code 0:

| Comando | Resultado |
| --- | --- |
| `pnpm --filter @uconext/api exec vitest run --config vitest.config.mts --maxWorkers=1 historical-sale-snapshot.test.ts historical-ingestion.integration.test.ts purchases.integration.test.ts sales-quote.integration.test.ts offline-bootstrap.integration.test.ts` | 5 archivos; 58 tests verdes; integración PostgreSQL real. |
| `pnpm --filter @uconext/shared exec vitest run src/offline-contracts.test.ts` | 1 archivo; 2 tests verdes. |
| `pnpm --filter @uconext/web exec vitest run test/offline-sale.test.ts test/offline-sale-confirmation.test.ts` | 2 archivos; 13 tests verdes. |
| `pnpm lint` | 4 tareas correctas; 2 desde caché Turbo. |
| `pnpm typecheck` | 4 tareas correctas; 2 desde caché Turbo. |

Estos resultados verifican regresión del estado existente, no captura de categorías. No se agregaron pruebas de implementación ni se modificó `tasks.md`: T236J conserva `[ ]` y su evidencia de cumplimiento queda pendiente.
