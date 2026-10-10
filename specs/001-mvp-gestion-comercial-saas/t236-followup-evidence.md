# Evidencia del seguimiento de T236

Este bloque implementa hallazgos del `sdd-check` original mediante `sdd-build`. No modifica el spec ni el plan aprobado. La [matriz individual](t236-followup-matrix.md) y el [resultado estructurado](t236-followup-results.json) describen los 74 hallazgos revisados; el informe original permanece intacto. El veredicto global continúa **PENDIENTES**.

## Worker, correo y expiración

`worker.ts` procesa el outbox tenant y el outbox global de recuperación. `runtime-worker.ts` registra `INVITATION_EMAIL`, `INVITATION_EXPIRATION`, generación de reportes y limpieza de objetos. La recuperación utiliza funciones PostgreSQL con permisos mínimos, `FOR UPDATE SKIP LOCKED`, lease, backoff y dead-letter. Un lease vencido no puede confirmar entrega; los jobs completados eliminan el token del payload y los errores persistidos no incluyen respuestas del proveedor.

El puerto HTTP exige HTTPS salvo loopback de prueba, Bearer, timeout y rechazo de redirects. `Idempotency-Key` identifica la entrega incluso ante pérdida de respuesta. El gateway debe persistir esa deduplicación y transformar el token en un enlace de producto. El proveedor concreto y su provisión siguen diferidos por el plan; los tests usan un gateway externo local y no envían correo a destinatarios.

`identity-worker.integration.test.ts` prueba el registry real, vencimiento, leases, reintentos y dead-letter contra PostgreSQL. `delivery-runtime.integration.test.ts` ejecuta las imágenes compiladas de web/API/worker, verifica entregas de reset e invitación, y observa `EXPIRED` y su auditoría sin invocar manualmente el handler.

La migración `0106` agrega columnas de lease y funciones del dispatch global. La restauración provisiona `uco_identity_dispatcher` antes del restore y repone el ownership mínimo después de migrar. Se prueba también la existencia previa del rol al migrar un backup antiguo. `backup-restore.integration.test.ts` comprueba recuperación y ejecución bajo `uco_worker`.

## CI, HTTP y navegadores

CI instala con lockfile congelado, ejecuta lint/typecheck, construye imágenes antes de los tests de contenedores, construye web y ejecuta seis escenarios críticos de navegador. El workflow nocturno ejecuta 17 escenarios por Chromium/Firefox/WebKit a las 06:00 UTC, con `workflow_dispatch` y conservación de artefactos incluso ante fallo.

`ops/browser/run.mjs` utiliza la CLI oficial de Playwright. Cada escenario tiene contexto aislado; los errores de herramienta y resultados incompletos fallan el comando. Las pruebas raíz verifican ese contrato. La UI crítica recorre 27 rutas a 1440, 1024, 768 y 390 px, con axe, contraste, labels, teclado, foco, overflow y estados de validación/error. Los fixtures UI interceptan respuestas HTTP para estados controlados; la suite de API prueba contratos y negocio con PostgreSQL real. Las pruebas PWA/offline ejecutan Service Worker, IndexedDB y Web Crypto reales. Esta combinación no debe describirse como una única prueba de negocio de punta a punta sin fixtures.

`proxy-rate-limit.integration.test.ts` carga las directivas exactas de `ops/reverse-proxy/rate-limit.conf` en Nginx real. Una ráfaga de 200 requests HTTP prueba admisión, rechazo 503 sin llegar al upstream, disponibilidad de la ruta pública y recuperación del límite.

T224/T227 y RF-289 permanecen abiertos: las versiones observadas de los motores automatizados no acreditan las dos últimas versiones estables de los cuatro navegadores exigidos. WebKit no acredita Safari real. El usuario informó que no tiene acceso a macOS. Las corridas previas Chrome/Edge locales se conservan como evidencia parcial, sin extrapolarlas a versiones no ejecutadas.

## Regresiones de negocio y offline

- La anulación de venta fallaba con el rol runtime real aunque pasaba con credenciales de migración. `0107` concede solo el permiso de columna requerido por `SELECT FOR UPDATE`; el trigger continúa rechazando toda reescritura de venta. La función pública de inventario valida tenant, actor, rol/sucursal y vínculo de anulación, bloquea stock en orden canónico y aplica movimiento/proyección atómicamente. Se prueban replay, contexto cruzado, escritura directa rechazada y stock restaurado.
- La matriz monetaria ejecuta ventas, compras, pagos, gastos, caja y anulaciones reales en ARS y USD. Compara doce clases monetarias, magnitudes positivas de reintegro/reversión, dirección del efectivo y saldos finales. Tras desactivar el ítem, nuevas ventas/compras/ajustes fallan sin alterar historia ni proyecciones.
- La ingestión histórica registra `offline.configuration_discrepancy` dentro de la misma transacción que los efectos y el ACK. La versión retenida determina el negocio; el maestro actual se consulta únicamente para diagnóstico. Desactivar sucursal, caja, medio de pago e ítem o cambiar precio no reasigna recursos ni recalcula la operación histórica. El replay no duplica la discrepancia.
- La autorización offline rechaza una sucursal que ya no aparece en el bootstrap firmado. Se prueban también caja y medio de pago desactivados conocidos, con cola y registros sin cambios.
- El retiro de identidad cierra claves y lectura entre pestañas mediante evento local, storage, BroadcastChannel y comprobación al volver al foreground. Las pestañas quedan protegidas aunque no monten el observador de UI. Se conservan los bytes de los sobres pendientes y su entrega opaca por Service Worker.
- Las fechas operativas usan la zona horaria de la organización desde settings o bootstrap firmado. La regresión compara Pacific/Auckland y UTC sobre el mismo timestamp absoluto; los componentes de caja, ventas, compras, gastos, usuarios y estado offline comparten esta regla.
- Las restantes ampliaciones comparan historia completa antes/después de cambios, permisos reales de maestros, scope de reportes, cantidades inválidas, campos económicos manipulados y recursos eliminables después de anulaciones. Cada RF conserva sus pruebas y aserciones individuales en la matriz.

## Ejecución y límites

Los comandos raíz utilizados son `pnpm run lint`, `pnpm run typecheck`, `pnpm run build`, `pnpm run test` y `pnpm run build:images`. Se ejecutan en Linux con Docker/Testcontainers porque el proceso raíz de Turbo en Windows presenta `spawn UNKNOWN`; las comprobaciones directas afectadas de TypeScript/ESLint y las pruebas raíz también se ejecutan en Windows.

Los logs locales y artefactos se conservan en `output/playwright/t236/` y `output/playwright/`; no se versionan builds ni capturas voluminosas. El resultado JSON registra los totales finales, versiones/OS observados y hashes SHA-256 de los logs. Se conservan los fallos reproducibles que motivaron correcciones y las corridas finales verdes. La corrida incompleta por copia del build durante compilación no se usa como evidencia de cobertura.

Resultado final del bloque: lint, typecheck, build y construcción de las tres imágenes pasan; API **119 archivos / 505 tests**, web **75 archivos / 200 tests**, shared **9 archivos / 20 tests**, UI **3 archivos / 8 tests**, pruebas raíz **3 tests**, sin fallos ni skips. La matriz nocturna pasa **17 escenarios por motor**, con **129 estados de UI por motor**. Versiones observadas: Chromium `155.0.8059.12`, Firefox `156.0` y WebKit `26.6`, todos ejecutados en Linux. El user agent de WebKit puede mencionar macOS/Safari; no modifica el OS real registrado ni acredita Safari real.

La configuración de CI queda preparada en el repositorio; no se ha publicado ni ejecutado remotamente desde este chat. No se crearon commits ni se alteraron cambios previos del usuario. T236 sigue abierto mientras haya RF pendientes o violados; la matriz detalla el trabajo restante y evita convertir evidencia parcial en conformidad.

## Delta T236I

RF-221 pasa a CUBIERTO tras implementar edición de categorías en servicio/HTTP/UI y verificar la matriz global de comandos y las restricciones históricas/offline. La [evidencia específica](t236i-catalog-category-evidence.md) conserva RED, decisiones, comandos, resultados y frontera de rollback. La prueba de navegador usa el componente de producción contra NestJS/PostgreSQL runtime real; no simula respuestas del backend. El seguimiento actual tiene 51 resueltos, 22 pendientes de evidencia y 1 incumplimiento. Los resultados/hashes anteriores siguen siendo el snapshot de T236D–T236H; el JSON agrega un delta T236I con hashes y resultados propios. T236J/RF-269 y el veredicto global PENDIENTES no cambian.
