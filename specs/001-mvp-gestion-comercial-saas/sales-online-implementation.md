# Notas de implementación — T152A–T152D

La UI POS necesita dos lecturas operativas adicionales a las mutaciones previstas en el plan:

- `GET /api/v1/sales/checkout-context?branchId=...` devuelve sesiones abiertas utilizables por el actor y medios de pago habilitados. La consulta valida organización, rol y alcance de sucursal; CASHIER recibe únicamente sesiones propias. La confirmación vuelve a validar todo dentro de su transacción.
- `GET /api/v1/sales/:id` devuelve estado derivado de `sale_cancellations`, ítems y pagos históricos. OWNER/ADMIN se limitan a su alcance de sucursal; CASHIER solo puede consultar ventas propias. EMPLOYEE no accede. El recibo aplica el mismo límite de lectura.

La interfaz solicita una nueva cotización al cambiar carrito o descuento. Ante `PRICE_CHANGED`, muestra el total actualizado, exige revisar los pagos y requiere aceptación explícita antes de reintentar con una clave idempotente nueva. La vista imprimible y el PDF se cargan después de confirmar o consultar la venta, con contexto de organización y sin alterar la transacción comercial.

La UI de apertura de caja y gestión del dispositivo corresponde a T218A. Hasta entonces, el POS muestra las sesiones válidas ya abiertas; no crea sesiones ni autoriza dispositivos por sí mismo.
