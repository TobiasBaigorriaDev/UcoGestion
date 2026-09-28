# Exportaciones de reportes

La API entrega CSV en streaming y encola PDF. Cada página vuelve a consultar el dataset con el alcance vigente del actor. El worker vuelve a validar membresía, rol y sucursal antes de generar el PDF. Los archivos y sus URLs vencen a las 24 horas y cinco minutos, respectivamente.

## Puesta en marcha

1. Aplicar las migraciones `0082`–`0085`.
2. Configurar `DATABASE_URL` para el rol tenant, `WORKER_DISPATCH_DATABASE_URL` para el rol `uco_worker` y `WORKER_USER_ID` con un UUID de identidad de servicio para auditoría. Los dos URLs deben apuntar a la misma base.
3. Configurar `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID` y `S3_SECRET_ACCESS_KEY` en API y worker. En desarrollo se usan los valores de MinIO de `compose.yaml`; el adaptador crea el bucket si falta. En producción todos los valores son obligatorios y el bucket debe estar aprovisionado.
4. Ejecutar `pnpm --filter @uconext/api start:worker` junto a la API compilada.

## Contratos

| Ruta | Resultado |
| --- | --- |
| `GET /api/v1/reports/:dataset` | Página autorizada; fechas locales del tenant y anulados visibles. |
| `GET /api/v1/reports/:dataset/csv` | CSV filtrado, sin paginación externa y con celdas ejecutables neutralizadas. |
| `POST /api/v1/reports/:dataset/exports` | Solicitud PDF con filtros JSON, CSRF e `Idempotency-Key`; devuelve `QUEUED`. |
| `GET /api/v1/reports/exports/:id` | Estado y, si está listo y autorizado, URL firmada de hasta cinco minutos. |

La creación de `report_exports` y el job `REPORT_PDF` ocurre en una transacción. El worker reclama únicamente jobs de PDF y limpieza de archivos; un cambio de permisos antes de generar deja la exportación en `FAILED`. La subida usa una clave determinista por exportación para que un reintento no cree otro archivo. La limpieza de object storage se programa en outbox al vencer cada archivo y conserva los metadatos históricos.

`@react-pdf/renderer` implementa el render de PDF previsto en el plan. El SDK oficial de AWS S3 firma URLs SigV4 y funciona con MinIO; ambas dependencias quedan limitadas al módulo de reportes y al adaptador de storage.
