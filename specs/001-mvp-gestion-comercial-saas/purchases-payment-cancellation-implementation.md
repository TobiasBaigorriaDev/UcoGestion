# Compras: pago y anulación (T162–T165)

La API expone `POST /api/v1/purchases/paid`, `POST /api/v1/purchases/:id/pay` y
`POST /api/v1/purchases/:id/cancel`. Cada comando exige `Idempotency-Key` y se
ejecuta con autorización tenant y de sucursal dentro de una transacción.

`PAID` de total cero no crea un pago. El pago posterior requiere el total exacto
y consulta si la compra ya fue anulada después de bloquearla. El efectivo exige
sesión abierta del dispositivo asociado; los medios no efectivos no requieren ni
modifican caja.

Las migraciones `0076`–`0078` añaden cancelación única, función de reversión de
stock y reversión histórica del pago. La función bloquea proyecciones en orden
`(branch_id, item_id)`, comprueba todos los saldos y solo entonces inserta
movimientos compensatorios. La reversión del pago copia medio, importe y moneda
de la fila histórica aun si el medio está desactivado. Un pago en efectivo crea
un ingreso vinculado a la cancelación en una sesión válida. Compra, pagos y
movimientos originales permanecen inmutables.

La prueba de integración en PostgreSQL cubre falta de stock sin efectos parciales,
RLS cross-tenant, caja, medio desactivado, auditoría y replay. La prueba HTTP
cubre contratos, permisos, validación y errores de la API.
