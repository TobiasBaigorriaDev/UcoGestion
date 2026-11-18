# Cuentas corrientes — ESTADO: APROBADO

Aprobación por autorización expresa del usuario para ejecutar las recomendaciones el 2026-10-12. Diseño dentro de la constitución existente, sin dependencias nuevas ni servicios externos.

## Modelo y transacciones

Migración 0113: `customer_accounts` (organization_id, customer_id, balance numeric(20,2), credit_limit numeric(20,2), version). Inicialización lazy con cero para evitar FK que impida borrar clientes sin historial. `customer_account_entries` append-only con FK tenant compuesta a cliente, sucursal, sesión, dispositivo, venta y movimiento original; delta signed, moneda, tipo, medio, motivo, actor y fecha. RLS default deny, SELECT/INSERT y triggers defensivos; proyección balance mediante trigger SECURITY DEFINER con search_path fijo y contexto validado. No grants de escritura a balance runtime; límite/version se actualizan con permisos de columna y validación bajo lock. Historial e idempotencia integran la misma transacción. FK RESTRICT protege historial.

Orden: cash_session → cotización con locks compartidos de catálogo → customer → customer_account → stock canónico. Cobros toman cash_session → customer → account → medio habilitado. Clientes/límite toman customer → account. Cancelar conserva orden cash → sale → customer/account → stock. READ COMMITTED, retries acotados de 40P01/40001 con misma clave. El saldo inicial no requiere historial; el primer movimiento marca referencia monetaria y cliente. Saldo no negativo, cobro <= balance, venta balance+deferred <= limit. Corrección de cobro restaura deuda sin usar tope como impedimento de reparación.

## Módulos y contratos

`customers/customer-account.service.ts` ofrece puerto público vía `customers/index.ts`: preparar cargo en transacción contextualizada, registrar cargo/cancelación, leer cuenta/historial, modificar tope, cobrar y revertir. Ventas solo utiliza ese puerto. Cash expone puerto público de movimiento de cobro/reintegro y no se consulta/escribe su persistencia desde controladores.

GET `/customers/:id/account?branchId&cursor&limit`: saldo, límite, disponible, moneda, versión y movimientos con alcance y cursor. PATCH `/customers/:id/account/limit`: `{creditLimit}`, If-Match e Idempotency-Key. POST `/customers/:id/account/collections`: `{cashSessionId,deviceId,amount,method}`. POST `/customers/:id/account/collections/:entryId/reverse`: `{cashSessionId,deviceId,reason}`. Schemas estrictos, decimales canónicos, auth/CSRF/origin middleware existente, errores problem+json estables.

POST `/sales` agrega `onAccount?: boolean` default false; `customerId` ya existente. Persistencia calcula deferred con Money; pago completo sigue obligatorio salvo onAccount explícito. Snapshot incluye paidAmount/onAccountAmount. Detalle venta agrega onAccountAmount. Offline no recibe este contrato ni nuevos medios ficticios. Listado Clientes agrega saldo/tope/moneda para lectura; no altera los snapshots históricos ni replays de altas existentes.

## UI

Extender mundo visual existente de DESIGN.md. Cliente: deuda/tope visible y Cuenta corriente desplegable; resumen, historial, cobro con caja activa, editor de tope solo OWNER/ADMIN y reversión con motivo. Usar contexto sucursal activa, Query y RHF/Zod, claves persistentes en reintentos, invalidación tras ventas/cobros/cancelaciones y cambio de contexto. POS: selector de cliente, checkbox A cuenta, deuda actual, disponible y cargo previsto; pago parcial válido solo explícitamente a cuenta, sin cambiar POS offline. Comprobantes HTML/PDF distinguen pago y cargo.

## Trazabilidad

| RF | Implementación | Prueba |
|---|---|---|
| 01–05 | migración, account service, lectura clientes, editor límite | PostgreSQL límites/version/roles; UI |
| 06–10 | sales persistence/controller, POS, receipt renderer | ventas completas/parciales, efectivo, snapshot; UI/PDF |
| 11–15 | account service/controller, puerto cash, UI cobros | PostgreSQL cobros/reversión/efectivo/alcance; Supertest/UI |
| 16–17 | puerto cancelación y sales operations | PostgreSQL cancelación/rollback/saldo insuficiente |
| 18,24–26 | RLS, permisos, historial, FKs, Clientes | cross-tenant, branch scope, EMPLOYEE, cliente inactivo |
| 19–23 | idempotencia existente, locks, retry, Query | concurrencia dos sesiones, replays/conflictos, fallos sin efectos; navegador |

## Riesgos y verificación

Migración desde base previa/vacía en PostgreSQL real. TDD RED/GREEN por tarea, fast-check para cálculo a cuenta, integración sin mocks de repositorios, Supertest contrato, Testing Library/axe y Playwright escritorio/móvil. Lint/typecheck/build raíz y suites afectadas; `sdd-check` final específico a esta ampliación.

No recalcular ventas antiguas ni modificar sobres offline. Saldo compartido revelado únicamente a roles que ya acceden a Clientes; historial financiero detallado sujeto a scope. Evitar duplicar ingresos de ventas en dashboard con cobros posteriores. Cambios previos del usuario permanecen preservados. Unidades revisables: backend de cuenta; integración ventas/comprobantes; UI y verificación. No crear commits/PRs mezclados con cambios previos.
