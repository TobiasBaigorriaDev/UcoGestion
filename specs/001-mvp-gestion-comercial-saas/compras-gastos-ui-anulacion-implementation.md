# Compras y gastos: pantallas y anulación de gastos — T171–T173C

Las pantallas de `/workspace/purchases` y `/workspace/expenses` conectan alta, consulta y corrección con la API transaccional. Los estados actuales se derivan de registros históricos; las compras y gastos originales permanecen inmutables.

## Recorrido de revisión

1. En compras, OWNER/ADMIN pueden confirmar `PENDING_PAYMENT` o `PAID`; EMPLOYEE solo confirma recepciones pendientes con costos visibles dentro de esa compra. CASHIER no ve la ruta.
2. Una compra pendiente de importe positivo admite un pago exacto. Una compra confirmada admite anulación total si cumple las reglas de stock y caja. La consulta muestra pago y anulación históricos.
3. En gastos, OWNER/ADMIN eligen un medio habilitado; CASHIER solo registra efectivo en una sesión propia. OWNER/ADMIN pueden anular un gasto confirmado con motivo.

## Contratos y persistencia

| Área | Decisión implementada |
| --- | --- |
| Anulación de gasto | `POST /api/v1/expenses/:id/cancellations` exige motivo, CSRF e `Idempotency-Key`. La migración `0080_expense_cancellations.sql` crea una fila única por gasto, append-only, con snapshot de medio, importe y moneda enlazado por FK compuesta al gasto original. |
| Efectivo | Antes de anular se bloquea una sesión `OPEN` del mismo branch y se valida su dispositivo. La transacción inserta un ingreso `EXPENSE_CANCELLATION` por el importe histórico y actualiza la proyección de caja mediante el ledger. |
| No efectivo | La fila de anulación guarda `NONCASH_REVERSAL`; no se crea movimiento de caja ni se requiere sesión. |
| Consulta | `GET /api/v1/purchases/:id` y `GET /api/v1/expenses/:id` devuelven estado derivado y datos históricos de un documento autorizado. EMPLOYEE solo consulta compras que confirmó; CASHIER solo consulta gastos propios. RLS y branch scope siguen aplicando. |
| Selección de categorías | `GET /api/v1/expense-categories/active` expone categorías activas a OWNER, ADMIN y CASHIER con membresía vigente; la administración completa conserva sus permisos previos. |

## Casos límite

- Una compra pagada al confirmarse con total cero no crea pago. Una recepción `PENDING_PAYMENT` de total cero no ofrece un pago posterior inválido y puede anularse si fue errónea.
- Las pantallas envían la misma clave idempotente en un reintento sin cambios; al cambiar campos preparan una clave nueva.
- La UI muestra errores de API accionables y conserva lo ingresado cuando falla una operación.
- El método histórico de una compra o gasto anulado se conserva aunque se desactive para nuevas operaciones.

## Evidencia

`expenses.integration.test.ts` y los contratos HTTP de gastos/compras pasaron con PostgreSQL real. Las pruebas de componentes cubren permisos, total cero, pago exacto, sesión efectiva, anulación y accesibilidad automatizada. Se recorrió en Playwright el flujo real OWNER de compra pendiente → pago efectivo → anulación y gasto efectivo → anulación, con una base temporal. `lint`, `typecheck` y build de web/API verifican los paquetes afectados.
