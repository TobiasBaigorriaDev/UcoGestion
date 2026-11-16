# Cuentas corrientes de clientes — ESTADO: CERRADO

## Resumen

Clientes con deuda y límite de crédito, ventas online total o parcialmente a cuenta y cobros posteriores desde Clientes.

Autorización: el usuario confirmó pagos parciales, bloqueo al superar el límite y modificación previa por OWNER/ADMIN. El 2026-10-12 autorizó expresamente ejecutar las recomendaciones restantes («A partir de ahora realiza todas las recomendaciones que tú digas»). Esta ampliación sustituye la exclusión de cuentas corrientes y la obligación de pago completo de RF-78 exclusivamente para ventas online explícitamente a cuenta; el resto del MVP conserva su alcance. No requiere excepciones constitucionales.

## Requisitos funcionales

- **RF-01**: Cuando personal OWNER, ADMIN o CASHIER consulte Clientes, el sistema debe mostrar la deuda de cada cliente en la moneda de la organización.
- **RF-02**: Cuando se consulte una cuenta, el sistema debe mostrar límite y crédito disponible sobre un saldo compartido entre sucursales de la organización.
- **RF-03**: Cuando se cree un cliente o migren clientes existentes, el sistema debe iniciar su deuda y límite en cero.
- **RF-04**: Cuando OWNER o ADMIN modifique un límite, el sistema debe aceptar un importe no negativo con control de versión e historial de auditoría.
- **RF-05**: Si el nuevo límite es menor que la deuda vigente, el sistema no debe permitir reducirlo.
- **RF-06**: Cuando se seleccione A cuenta en el POS online, el sistema debe exigir un cliente activo identificado.
- **RF-07**: Cuando se confirme una venta a cuenta, el sistema debe cargar a la deuda la diferencia exacta entre el total y los pagos recibidos.
- **RF-08**: Si la deuda resultante supera el límite, el sistema no debe confirmar la venta ni sus efectos relacionados.
- **RF-09**: Cuando se confirme una venta a cuenta, el sistema debe descontar stock y registrar únicamente el efectivo efectivamente aplicado en caja.
- **RF-10**: Cuando se emita el comprobante de una venta a cuenta, el sistema debe distinguir importe pagado e importe cargado a cuenta mediante snapshots históricos.
- **RF-11**: Cuando OWNER, ADMIN o CASHIER registre un cobro posterior desde Clientes, el sistema debe permitir un importe total o parcial con un medio habilitado y sesión abierta autorizada.
- **RF-12**: Si un cobro es cero, negativo o mayor que la deuda vigente, el sistema no debe registrarlo.
- **RF-13**: Cuando se registre un cobro, el sistema debe reducir la deuda y sumar a caja solamente si el medio es efectivo.
- **RF-14**: Cuando OWNER o ADMIN revierta un cobro por error, el sistema debe crear una compensación enlazada con motivo sin modificar el original.
- **RF-15**: Cuando se revierta efectivo, el sistema debe exigir sesión abierta autorizada en la sucursal del cobro y efectivo suficiente.
- **RF-16**: Cuando se anule una venta a cuenta, el sistema debe compensar su cargo y reintegrar únicamente sus pagos originales.
- **RF-17**: Si compensar una venta produciría deuda negativa, el sistema no debe anularla y debe indicar que se reviertan primero los cobros necesarios.
- **RF-18**: Cuando se consulte historial de cuenta, el sistema debe mostrar movimientos inmutables paginados de las sucursales autorizadas, sin exponer operaciones de sucursales ajenas al alcance.
- **RF-19**: Cuando se repita una mutación con la misma clave y payload, el sistema debe devolver el resultado original sin duplicar deuda, caja ni auditoría.
- **RF-20**: Si se reutiliza una clave con otro payload, el sistema no debe aceptar la mutación.
- **RF-21**: Si falla una venta, cobro o reversión, el sistema debe revertir todos sus efectos y conservar íntegro el historial previo.
- **RF-22**: Cuando dos cajas operen simultáneamente sobre un cliente, el sistema debe serializar saldo y límite para impedir sobrecobros o exceso de crédito.
- **RF-23**: Si no hay conexión o la respuesta es incierta, el sistema no debe autorizar crédito local y debe conservar la clave de reintento de las operaciones online sin duplicarlas.
- **RF-24**: Cuando se desactive un cliente con deuda, el sistema debe conservar su cuenta y permitir cobrarla sin autorizar nuevas ventas.
- **RF-25**: Si un cliente tiene movimientos de cuenta, el sistema no debe permitir su eliminación física.
- **RF-26**: Si el actor es EMPLOYEE o pertenece a otra organización, el sistema no debe conceder acceso a cuentas ni mutaciones financieras.

## Fuera de alcance

- Ventas fiadas offline, intereses, vencimientos, cuotas, recordatorios, pagos online y carga manual de deudas anteriores.
- Anticipos, saldos a favor y asignación de cobros a facturas individuales: la cuenta es un saldo global. Para anular un cargo ya cobrado que dejaría saldo negativo, se revierten cobros antes de anular.
- Excepciones para superar el tope: OWNER/ADMIN debe modificarlo primero. Una reversión correctiva de cobro puede restaurar deuda por encima de un límite reducido posteriormente; no habilita nuevas ventas.

## Autocrítica

La deuda total compartida es información operativa de Clientes para los roles habilitados; el detalle conserva alcance por sucursal. Cobros no aumentan las ventas del dashboard: las ventas se reconocen al confirmar, caja reconoce cobros reales.
