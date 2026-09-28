# Creación de gastos — T166–T170

`POST /api/v1/expenses` confirma un gasto con `branchId`, `categoryId`, `concept`, `amount`, `method` y, para efectivo, `cashSessionId` y `deviceId`. Exige sesión web, CSRF e `Idempotency-Key`. El importe viaja como string decimal positivo. La respuesta incluye ID, importe y moneda, actor y timestamp UTC.

La migración `0079_expenses.sql` agrega `expenses` con FKs tenant de sucursal, categoría y medio, RLS default deny para el rol runtime, `numeric(20,2)` positivo y un trigger que impide modificar o eliminar un gasto confirmado. La persistencia guarda además referencias históricas de categoría y organización; esto impide eliminar la categoría o cambiar la moneda base tras registrar un gasto.

La política permite OWNER en todas las sucursales activas, ADMIN solo dentro de su scope y CASHIER solo en efectivo, en una sesión propia. EMPLOYEE carece de permiso. En efectivo se bloquea la sesión abierta y se comprueba el dispositivo asociado. La misma transacción valida categoría y medio activos, registra el gasto, descuenta caja con `cash_movements`, guarda auditoría e idempotencia. Si falta efectivo esperado, revierte todos los efectos. Los deadlocks y fallos de serialización se reintentan hasta tres veces con la misma clave.

Verificación: `expenses.integration.test.ts` sobre PostgreSQL real cubre aislamiento tenant, datos históricos, roles, scope, categoría, medio, dispositivo, caja, rollback e idempotencia; `expenses-http.e2e.test.ts` cubre el contrato HTTP. El gate afectado añadió pruebas de categoría de gasto y caja.
