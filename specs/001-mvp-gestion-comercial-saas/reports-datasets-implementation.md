# Datasets de reportes: T179–T179E

`GET /api/v1/reports/:dataset` expone `sales`, `inventory`, `inventory-movements`,
`cash`, `purchases` y `expenses`. Los filtros son `branchId`, `from`, `to`, `status`
cuando corresponde, `lowStock` para inventario, `limit` y `cursor`. `from` es una
fecha local inclusiva y `to` una fecha local exclusiva en la zona horaria vigente
de la organización. Los cursores de eventos conservan microsegundos.

Las consultas corren con `TenantTransaction.read`, RLS y membresía revalidada.
OWNER ve sus sucursales; ADMIN y EMPLOYEE se limitan a las asignadas. CASHIER ve
solo ventas y sesiones propias. EMPLOYEE ve inventario y movimientos; compras y
gastos están limitados a OWNER/ADMIN. Los importes y cantidades se exponen como
strings decimales. Los netos de ventas, compras y gastos excluyen cancelaciones,
que permanecen en las filas con estado `CANCELLED`.

El dataset de caja ya muestra sesiones, efectivo inicial/esperado y agregado de
movimientos. `countedCash` y `difference` son `null`: aún no existe la tabla
`cash_closures` ni el flujo de cierre (T214D) que registra el conteo. Por eso
T179C permanece pendiente. Al implementarse ese flujo, el dataset deberá unir
el snapshot inmutable de cierre y exponer diferencia y estado de revisión sin
derivarlos del efectivo esperado.

Verificación: `reports.integration.test.ts` (7 pruebas con PostgreSQL real),
`reports-http.e2e.test.ts` (2 pruebas), `pnpm --filter @uconext/api lint`,
`typecheck` y `build`. Los GET no crean auditoría de escritura ni registros de
idempotencia; no hay mutaciones, reintentos transaccionales ni efectos parciales.
