# T236I — Edición de categorías y comandos globales de catálogo

Verificado el 10 de octubre de 2026. Alcance: RF-221 y sus restricciones de historial y preservación offline. No cambia el spec cerrado ni las decisiones del plan. T236J/RF-269 sigue abierto: estas pruebas no acreditan la captura de categoría en snapshots de ventas.

## RED → GREEN

Antes de implementar, las regresiones de categorías fallaron por `service.update is not a function`; la prueba HTTP obtuvo 404 en vez de la precondición 428 y la UI no encontró `Editar Almacén`. La regresión de historial/exposición falló por la misma ausencia del comando. Se corrigió un fixture de contraseña para asegurar que los negativos fallaran por esa ausencia y no por una constraint de usuarios.

La implementación inicial reveló `permission denied for table catalog_categories` bajo el rol runtime real. La migración 0108 concede exclusivamente UPDATE de `name`, conservando los permisos previos y RLS. La matriz global también reprodujo un fallo de borrado de productos nuevos sin historial: la FK de sus proyecciones de stock cero impedía borrarlos. El trigger de 0108 limpia solamente las proyecciones vacías dentro de la misma transacción, valida contexto tenant y bloquea stock en orden canónico. No concede DELETE de stock al rol runtime. Las FKs históricas siguen siendo RESTRICT; historial de movimientos aun con stock cero produce SQLSTATE 23503 y stock no nulo produce 55000, sin efectos parciales.

## Aserciones verificadas

| Garantía | Prueba y aserción |
| --- | --- |
| Edición por OWNER/ADMIN | `catalog-category-management.integration.test.ts`: nombre normalizado, ID/status conservados, versión 1→2 y un solo avance de config_epoch. |
| Autorización e aislamiento | Misma suite: CASHIER/EMPLOYEE, ausencia de membresía y ID de otra organización rechazados sin edición ni auditoría. `catalog-and-invitation-http.e2e.test.ts` repite ADMIN/CASHIER/EMPLOYEE, tenant ajeno y recurso ajeno por HTTP real con runtime `uco_app`. |
| Comandos globales | `catalog-item-lifecycle.integration.test.ts`: OWNER/ADMIN crean, editan, desactivan, activan y eliminan ítems/categorías sin historial. ADMIN tiene asignada solo una de dos sucursales y administra el catálogo global, incluido el producto inicializado en ambas. Matriz negativa por comando para CASHIER/EMPLOYEE y OWNER de otro tenant. |
| Versión y concurrencia | Versión obsoleta produce VERSION_CONFLICT/currentVersion=2; dos ediciones simultáneas de versión 1 tienen exactamente un ganador y una auditoría. |
| Idempotencia y reintentos | Replay con nombre canónico devuelve la misma respuesta sin nueva versión/época/auditoría. Payload distinto con la misma clave produce IDEMPOTENCY_KEY_REUSED. Actor degradado pierde también el permiso de replay. |
| Atomicidad y auditoría | Actor, tenant, request, entidad, operación, timestamp, before/after/context se cotejan. Un trigger de prueba hace fallar la auditoría: nombre, versión, época e idempotencia se revierten; después de retirar el fallo, el mismo retry confirma. No hay repositorios simulados. |
| Historial e incertidumbre offline | Se permite renombrar/desactivar las categorías con referencia histórica o exposición offline. Sus registros de referencia/exposición permanecen idénticos y el borrado sigue rechazado con su código específico. No se reinterpretan operaciones históricas. |
| Contrato HTTP | PATCH `/api/v1/catalog/categories/:categoryId`: sesión tenant, CSRF/origen, UUID, JSON estricto, If-Match e Idempotency-Key. Ausencia de precondiciones devuelve 428; campos extra/nombre vacío, 400; conflicto, application/problem+json con traceId. Snapshot OpenAPI actualizado únicamente para la nueva operación. |
| UI real | `catalog-category-browser.e2e.ts`: componente de producción y sus clientes HTTP predeterminados contra NestJS/PostgreSQL runtime; edición por teclado a 1280 y 390 px, blank inválido sin PATCH, versión/idempotencia enviadas, reload y cancelación. Se cotejan en PostgreSQL nombre/version=3, dos auditorías y dos claves COMPLETED. Axe y overflow pasan con el reset/tema de la aplicación. No intercepta ni simula el backend. |
| Administración offline | El mismo navegador oculta comandos al perder red y los restaura al volver. `offline-restrictions.mjs` rechaza 25 solicitudes individuales, incluidos comandos de ítems/categorías, y observa cero requests. `api-client.test.ts` verifica además el rechazo antes de invocar transporte. |
| Observabilidad | Se utiliza el middleware real de correlación, trazas, métricas y logs HTTP; los conflictos incluyen traceId. Auditoría e idempotencia pertenecen a la misma transacción. Este cambio no requiere outbox ni un job nuevo. |

Las pruebas unitarias de UI con callbacks simulados se utilizan solo para interacción del componente; no son evidencia de autorización, RLS, atomicidad ni cobertura de RF-221.

## Comandos y resultados finales

| Comando | Resultado |
| --- | --- |
| `pnpm --filter @uconext/api test -- catalog-category-management.integration.test.ts catalog-item-lifecycle.integration.test.ts catalog-and-invitation-http.e2e.test.ts` | 3 archivos / 47 tests verdes antes de ampliar la protección SQL. |
| `pnpm --filter @uconext/api test -- catalog-category-management.integration.test.ts catalog-item-lifecycle.integration.test.ts catalog-lifecycle.e2e.test.ts category-lifecycle.integration.test.ts` | 4 archivos / 42 tests verdes. |
| `pnpm --filter @uconext/api test -- catalog-item-lifecycle.integration.test.ts` | 29 tests verdes en la última corrida, incluidos SQLSTATE específicos. |
| `pnpm --filter @uconext/api test -- catalog-item-creation.integration.test.ts catalog-item-edit.integration.test.ts catalog-price.integration.test.ts catalog-read.integration.test.ts inventory-foundation.integration.test.ts` | 4 archivos / 42 tests verdes; no existe un archivo separado de item-edit y Vitest no lo cuenta. |
| `pnpm --filter @uconext/api test -- request-contracts.test.ts -u` | 4 tests verdes; el diff de actualización del snapshot mostró solo la nueva operación PATCH. |
| `pnpm --filter @uconext/web test -- catalog-category-management.test.tsx expense-category-management.test.tsx api-client.test.ts` | 3 archivos / 10 tests verdes. |
| `pnpm test:e2e:catalog` | 1 test verde, backend real, dos viewports; listado de Vitest confirma que este gate incluye solo el archivo de navegador. |
| `$env:SCENARIO='offline-restrictions'; pnpm test:e2e:nightly` | Chromium: escenario verde, 25 rechazos, cero requests. |
| `pnpm lint --filter=@uconext/api --filter=@uconext/web` | 2 paquetes verdes. |
| `pnpm typecheck --filter=@uconext/api --filter=@uconext/web` | 2 paquetes verdes. |

Las corridas finales no contienen fallos ni tests saltados. Hubo fallos de arranque/timeout del harness y se corrigieron su readiness, sintaxis CLI y carga del reset; no se usan esas corridas para cobertura. Se detuvo una selección involuntaria de la suite completa al detectar que mergeConfig concatenaba include; el gate final reemplaza include y ejecuta únicamente su test. No se declara una corrida global del repositorio.

El gate de navegador usa Chromium instalado y el CSS/fonts del build web existente, igual que los escenarios del proyecto. CI lo ejecuta después de build e instalación de Chromium. No se ejecutó CI remotamente. No se acredita RF-289/Safari/versiones adicionales.

## Archivos y recuperación

Producción: servicio/controlador de catálogo, migración 0108 y su entrada de journal, componente/editor CSS. Contratos/pruebas: suites de categorías/lifecycle/HTTP/OpenAPI/UI/cliente y harness real de navegador. Gate: package.json, vitest.browser.config.mts y una llamada adicional en CI. Se conservaron los cambios previos del usuario en todos los archivos compartidos.

Los logs `output/t236i-*.log` y las capturas/resultados `output/playwright/t236i-*` quedan locales. El resultado estructurado de seguimiento registra sus hashes. No se versionan builds ni capturas voluminosas.

La frontera de rollback es T236I: retirar el PATCH, método update, editor y pruebas/gate asociados; retirar la llamada adicional en CI. En una base ya migrada, usar una migración compensatoria que revoque UPDATE(name) y retire el trigger/función de limpieza, conservando auditorías, versiones y nombres ya confirmados. No retirar migraciones o cambios anteriores del usuario. No se crearon commits ni se continuó con otra tarea.
