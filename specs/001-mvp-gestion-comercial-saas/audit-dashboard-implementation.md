# Auditoría y dashboard: T174–T178

## Contratos

- `GET /api/v1/audit` recibe `cursor`, `limit`, `branchId`, `action` y `actorUserId`. Ordena por `(occurred_at, id)` descendente y conserva precisión de microsegundos en el cursor. OWNER ve todos los eventos del tenant; CASHIER y EMPLOYEE reciben 403.
- ADMIN ve eventos de sucursales asignadas. Para eventos sin sucursal, ve recursos administrables globales (catálogo, categorías de gastos, medios de pago, clientes, proveedores y edición de perfil) y eventos de membresías o invitaciones no OWNER que compartan una sucursal asignada. No se infiere autorización a partir del filtro enviado.
- `GET /api/v1/dashboard` acepta `branchId`, `from` y `to` como filtros; los períodos de este bloque son instantes ISO con offset. La interpretación de límites locales por timezone corresponde a T181.
- OWNER ve todas las sucursales; ADMIN, solo las asignadas. El resultado incluye ventas netas, cantidad, ticket promedio, medios de pago, gastos y compras netos, más vendidos, stock bajo y resumen de cajas. CASHIER recibe solo agregados de ventas propias y sesiones propias. EMPLOYEE recibe catálogo e inventario de sus sucursales.
- El resultado operativo se calcula en PostgreSQL como ventas netas menos gastos netos y se etiqueta «Resultado operativo». No se consulta ni expone costo, margen o rentabilidad. Las anulaciones se excluyen de todos los agregados netos; la consulta histórica con estado queda para T179–T181.

## Persistencia y seguridad

Las consultas usan `TenantTransaction.read`, contexto tenant y RLS con rol runtime. Se revalida membresía activa y alcance dentro de la transacción. La migración `0081_audit_dashboard_read_indexes.sql` agrega índices de lectura para auditoría, ventas, compras, gastos y cajas. No hay mutaciones de negocio, idempotencia ni auditoría de escritura en estos GET.

## Evidencia

- `pnpm --filter @uconext/api test -- audit-query.integration.test.ts dashboard.integration.test.ts audit-dashboard-http.e2e.test.ts audit-events.integration.test.ts tenant-transaction-audit.integration.test.ts`: 5 archivos, 14 tests aprobados antes de ampliar la cobertura de membresías e invitaciones. La suite de auditoría ampliada pasó con 5 tests.
- `pnpm --filter @uconext/api typecheck` y `pnpm --filter @uconext/api lint`: aprobados.
- Límite de reversión: módulos `audit` y `dashboard`, sus tres archivos de pruebas, registro en `app.module.ts`, migración 0081 y las marcas T174–T178. Los cambios preexistentes de compras, gastos y UI quedan fuera de este bloque.
