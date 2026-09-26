# Verificación de stock y ledger

La API ejecuta una comparación de solo lectura al iniciar y cada 15 minutos cuando `INVENTORY_VERIFIER_CONTEXTS` contiene una lista JSON de pares `organizationId` y `userId`. Cada usuario configurado debe conservar una membresía activa de su organización. El despliegue debe mantener la lista completa al crear o retirar organizaciones.

Ejemplo:

```json
[{"organizationId":"<uuid-de-organización>","userId":"<uuid-de-usuario-de-servicio>"}]
```

El verificador compara `branch_stocks.quantity` con `SUM(inventory_movements.delta)` en una transacción de lectura con RLS tenant. Una diferencia genera un log JSON con organización, sucursal, producto y ambos saldos. `/api/v1/metrics` expone `uconext_inventory_ledger_divergences` como total global de la última pasada y `uconext_inventory_ledger_verification_failures_total` sin etiquetas de tenant. Las reglas de alerta están en `observability/inventory-ledger-alerts.yaml`.

Ante una alerta, localizar el producto en los logs, investigar el origen y usar la operación compensatoria aprobada para corregirlo. El verificador no actualiza proyecciones ni modifica movimientos. Si una pasada falla, revisar credenciales, membresía y disponibilidad de PostgreSQL antes de interpretar el último valor de divergencias.
