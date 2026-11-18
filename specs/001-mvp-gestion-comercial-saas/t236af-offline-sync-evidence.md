# T236AF — Sincronización histórica tras cambios del catálogo

Solicitud del usuario: corregir el fallo al sincronizar desde la sección sin internet (2026-10-13).

RF vinculados: RF-120, RF-122, RF-128–RF-132, RF-275–RF-278, RF-309–RF-316. Compras offline siguen excluidas por RF-118.

## Causa y cambio

La demo tenía configuración actual en época 10 y dos grants históricos abiertos en época 4. El transporte validaba el dispositivo, pero PostgreSQL rechazaba la inserción con `sync operation belongs to a closed or stale grant`, provocando HTTP 503. Las ediciones de catálogo avanzan la época sin cerrar esos grants; su versión histórica sigue siendo la fuente de verdad para los pendientes legítimos.

Migración 0114 reemplaza el control de inserción manteniendo el lock de organización, RLS y FKs. Solo admite una época anterior para operaciones con metadatos de sobre, autorización persistida del actor transaccional y ocurrencia dentro de su vigencia. Grants cerrados, épocas futuras, falta de autorización, otros actores y tiempos inválidos siguen rechazados. La ingestión mantiene firma, snapshots, cadena, revocación conocida y validación de negocio antes de persistir; no se habilita emisión de grants obsoletos.

La pantalla distingue fallos de sincronización y renovación del mensaje de desbloqueo por PIN, sin exponer errores internos ni payloads.

## Evidencia

- RED: regresión en `historical-ingestion.integration.test.ts` avanzando época antes de entregar el sobre: mismo error PostgreSQL reproducido. RED UI: esperaba mensaje de sincronización y recibía aviso de PIN.
- `pnpm --filter @uconext/api test -- historical-ingestion.integration.test.ts configuration-barrier.integration.test.ts offline-bootstrap.integration.test.ts`: 29 PASS contra PostgreSQL real/Testcontainers. Incluye apertura/venta histórica, snapshots tras cambios, reintentos concurrentes, idempotencia, tenant, revocación, cierre, auditoría y rollback completo si falla el ACK. Tres negativos adicionales prueban metadatos ausentes, actor distinto y vencimiento al momento de creación, sin efectos parciales.
- `pnpm --filter @uconext/web test -- offline-settings.test.tsx offline-setup.test.ts opaque-delivery.test.ts`: 12 PASS. Conservación de bytes, ACK firmado, limpieza atómica, PIN y mensajes.
- `pnpm lint`, `pnpm typecheck`: PASS raíz.
- `pnpm build --filter=@uconext/api`: PASS.
- Vite con `apps/web/test/browser/offline-update.vite.mjs` en puerto 4179 y `pnpm exec playwright-cli -s=offline-fix run-code --filename apps/web/test/browser/offline-settings.mjs`: PASS Chromium, 11 escenarios, teclado, desktop/móvil, axe con contraste, pérdida/retorno de red, pendientes exactos y ACK firmado. Harness de navegador con servidor de entrega de prueba; no constituye prueba de sincronización del perfil del usuario.
- `node output/mvp-demo/migrate-local.mjs`: aplica migraciones versionadas a la demo existente mediante migrador y lock; no modifica secretos ni reabre grants. Migración previa 113; posterior 114. No requiere reiniciar API porque el cambio de persistencia reside en PostgreSQL y Next local sirve el frontend actualizado.

El canal de navegador del usuario no estuvo disponible para verificar su cola privada. Debe reintentar sincronización en ese perfil; no se afirma que sus pendientes ya recibieron ACK. No se borró IndexedDB ni se modificó el PIN. La ventana adjunta es un aviso del gestor de contraseñas de Google, separado del error de ingestión.

## Límite de reversión

Unidad localizada: migración 0114/journal, regresión de ingestión, mensajes/prueba de OfflineSettings y helper local de migraciones. Para revertir una base que ya recibió 0114 se requiere nueva migración revisada que restaure el control previo; no quitar una migración aplicada ni revertir otros cambios del usuario. Restaurar el control previo volvería a bloquear los pendientes de época anterior. No hay cambios de alcance, contratos ni excepciones constitucionales.
