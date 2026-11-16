# Preparación de producción — UcoNext

Estado: **EN CURSO; producción todavía no acreditada**. Inicio: 2026-10-13.

Objetivo autorizado: completar pendientes del MVP y dejar aplicación, servidores y operación listos para producción. Preferencia del usuario: alternativa gratuita, sin dominio ni proveedor elegidos actualmente. No se ha creado una cuenta, contratado infraestructura ni desplegado el sistema públicamente.

## Alcance actual y fuentes

El corte SDD del 2026-10-10 tenía 316 RF. El spec 001 actual tiene 347 RF y el spec 002 aprobado tiene 26 RF propios de cuentas corrientes. El release debe incluir esas ampliaciones y verificar sus cambios actuales. Hay modificaciones existentes en código, migraciones, tests y documentos; se preservan y se verifican como parte del candidato, sin revertirlas ni adjudicarlas a esta preparación.

Fuentes: [spec 001](spec.md), [constitución](../../constitution.md), [plan 001](plan.md), [spec 002](../002-cuentas-corrientes/spec.md), [plan 002](../002-cuentas-corrientes/plan.md), [tasks-check](tasks-check.md), [entrega operativa](operational-delivery-evidence.md), [despliegue](../../infra/deploy/README.md) y [restauración](../../infra/restore/restore-runbook.md).

**SPEC CUMPLIDA** acredita requisitos y reglas del proyecto. **LISTO PARA PRODUCCIÓN** exige además infraestructura real configurada, release identificada, TLS, secretos, roles mínimos, servicios externos, backup restaurable, monitoreo y smoke sobre el entorno candidato. Ninguno sustituye al otro.

## Trabajo y evidencia de este bloque

### P01 — Validación del origen antes de modificar el entorno

- [x] Reproducir y corregir el acceso al puerto Docker antes de validar `PublicOrigin` en `infra/deploy/rollout.ps1`.
- [x] Probar HTTP, URL inválida, path, query, fragmento, credenciales y loopback IPv4/IPv6/localhost; un origen HTTPS público válido llega al puerto externo.

`test/production-rollout.test.mjs` ejecuta el script PowerShell real y sustituye exclusivamente el comando externo Docker para registrar si se llega a él. No descarga imágenes, migra bases ni demuestra un despliegue completo. La prueba inicial rechazó la implementación previa porque los nueve orígenes inválidos alcanzaban Docker; después de corregir, **10/10 PASS**, sin tests omitidos. Las excepciones no incluyen el origen recibido para evitar reproducir credenciales en diagnósticos.

Logs: [RED](../../output/production-rollout-red-2026-10-13.log), [GREEN](../../output/production-rollout-green-2026-10-13.log). Comando: `node --test test/production-rollout.test.mjs`.

### P02 — Inventario y autorización

- [x] Extraer rutas reales desde AST: 131 rutas HTTP y 128 declaraciones históricas de FK.
- [x] Añadir y ejecutar matriz de lectura HTTP con cuatro roles persistidos y PostgreSQL real: **64/64 PASS**.
- [ ] Completar revisión de aserciones, matriz de comandos, relaciones efectivas y auditoría de CHECK-01 a CHECK-05.

Artefactos regenerables: [inventario de rutas](authorization-inventory.md) y [JSON](authorization-inventory.json), generados por `ops/verification/authorization-inventory.mjs`. Los imports y rutas literales solo producen candidatos; no prueban cobertura. Las FK históricas tampoco prueban el esquema efectivo. CHECK-01/02 continúan pendientes.

`apps/api/test/authorization-read-http.e2e.test.ts` cubre 15 rutas × OWNER/ADMIN/CASHIER/EMPLOYEE, controles tenant, scope cuando aplica y 15 lecturas por rol tras desactivar su membresía autenticada. Usa LOGIN miembro de `uco_app`, no owner/superusuario de runtime. Verifica catálogos sin datos ajenos, Problem Details para rechazos y ausencia de finanzas globales en dashboards operativos.

La primera ejecución detectó expectativas de fixture incorrectas: dashboard operativo permitido por RF-144/145, inventario EMPLOYEE permitido por RF-150, páginas vacías de historial según plan §23, y `deactivated_at` obligatorio por constraint. Se corrigió el fixture contra esos contratos y se conserva el intento; no se atribuyen esos fallos a defectos del producto. Las lecturas sobre datasets vacíos no acreditan por sí solas conservación ni aislamiento de todas las operaciones comerciales.

Logs: [primer intento](../../output/authorization-read-matrix-2026-10-13.log), [ejecución válida](../../output/authorization-read-matrix-2026-10-13-repeat.log). Comando: `pnpm --filter @uconext/api exec vitest run --config vitest.config.mts test/authorization-read-http.e2e.test.ts`.

### P03 — Checks actuales

- `pnpm lint`: PASS en ejecución registrada; volver a comprobar tras cualquier cambio posterior pertinente.
- `pnpm typecheck`: PASS en ejecución registrada; volver a comprobar tras cualquier cambio posterior pertinente.
- `pnpm build`: PASS, tres tareas exitosas.
- `pnpm test` inicial: **FAIL del harness**, 125/126 archivos API con resultado y 632 tests API verdes; un fork terminó inesperadamente y `delivery-migration.integration.test.ts` no produjo resultado. Shared 30, UI 8 y web 301 tests PASS. La suite raíz no llegó a sus tests Node. El archivo de migración pasó aislado (1/1), pero eso no convierte la ejecución global en verde.
- `pnpm build:images`: PASS, reconstruidas web/API/worker `linux/amd64` con lockfile congelado sobre el árbol actual. El origen de build es localhost y la clave de build es la local: son imágenes para gates operativos, no una release HTTPS productiva ni validación ARM64.
- Segunda ejecución `pnpm test` con imágenes actuales: **FAIL del harness**, 125/127 archivos y 680/698 tests API con resultado PASS; dos errores «Worker exited unexpectedly». `catalog-and-invitation-http.e2e.test.ts` y `sales-http.e2e.test.ts` no entregaron resultado. El runtime de contenedores actual sí pasó. [Log de regresión](../../output/production-regression-2026-10-13-test.log). No se atribuye el fallo a falta de memoria sin diagnóstico; `maxWorkers` ya es 1. Se ejecutan los dos archivos faltantes con información de heap y los tests Node raíz por separado, sin convertir por ello el gate global en verde.
- Los dos archivos HTTP faltantes pasan juntos: **18/18**, [log](../../output/production-missing-workers-2026-10-13.log). Los tests Node raíz actuales pasan: **16/16**, [log](../../output/production-root-node-2026-10-13.log). Estos resultados no reemplazan el gate completo.
- Se añade el preload diagnóstico `ops/verification/trace-test-workers.cjs`: registra únicamente PID, exit code, señal y tiempo de los forks; no modifica su resultado ni registra argumentos/variables. Probe con salida 7 conserva y registra ese código. La primera invocación del preload falló antes de iniciar tests por escapes del path Windows en `NODE_OPTIONS`; se conserva el log. La siguiente usa path normalizado y repite `pnpm test` con diagnóstico: [ejecución](../../output/production-regression-traced-running-2026-10-13.log), pendiente hasta terminar.

Logs: [lint](../../output/production-lint-2026-10-13.log), [typecheck](../../output/production-typecheck-2026-10-13.log), [suite base](../../output/production-baseline-2026-10-13-test.log).

También: [build](../../output/production-build-2026-10-13.log), [migración aislada](../../output/production-delivery-migration-isolated-2026-10-13.log), [validación estática de entrega](../../output/production-delivery-validation-2026-10-13.log) e [imágenes](../../output/production-images-2026-10-13.log). No se atribuye la caída del fork a una causa no diagnosticada.

La primera ejecución del gate de navegador no inició escenarios. El build sin origen devolvía 500; después de reconstruir con origen local persistió el fallo de disponibilidad: un proceso de desarrollo previo (`ops/development/report-worker.mjs`) ya escuchaba en IPv4:3001 y devolvía 503. Se conserva ese proceso. El runner ahora admite `BROWSER_WEB_PORT` limitado a puertos loopback 1024–65535 y aplica el mismo origen al servidor, probe y escenarios UI; se recompila web con ese origen. Regresión RED → GREEN: **3/3 pruebas Node**, [log](../../output/production-browser-port-green-2026-10-13.log). Esto no acredita todavía los escenarios de navegador. Los intentos y sus logs se conservan.

Al iniciar el recorrido UI se corrigieron dos problemas del fixture: el locator parcial de «Stock bajo» coincidía también con la opción «Stock bajo primero», y faltaba la respuesta de lectura `/cash-sessions` usada por el POS actual. Ahora se exige exactamente un aviso «Stock bajo» visible y el fixture de caja cumple `cashWorkspaceSchema`; las respuestas simuladas solo prueban UI, no autorización ni persistencia. El intento `production-e2e-critical-final-2026-10-13.log` coincidió por error con una reconstrucción de `.next` y devolvió 500; no se acepta como evidencia del producto. El [gate aislado](../../output/production-e2e-critical-isolated-2026-10-13.log) se ejecutó después del build y falló por `/sales` ausente en el fixture. El bloque UI sigue pendiente; revisar todas sus rutas de historia y contratos antes de repetirlo, sin aceptar una corrida parcial como gate completo.

### P14 — Origen e identidad de release en el pipeline raíz (T236AM)

- [x] Reproducir que el dry-run real de Turbo no incluía las variables de origen/release y no cambiaba el hash al cambiar sus valores.
- [x] Declarar `NEXT_PUBLIC_WEB_ORIGIN` y `UCONEXT_BUILD_ID` en el entorno del build; configurar el origen del runner antes de compilar en CI.
- [x] Verificar el dry-run real con dos orígenes y dos releases: cambian los hashes y se incluyen las variables configuradas. Pruebas del build y runner: **5/5 PASS**.
- [x] Ejecutar build raíz con origen 3021: **3/3 tareas PASS**; lint y typecheck actuales: **4/4 tareas PASS** cada uno.
- [ ] Completar el gate de navegador sobre ese build estable antes de cerrar T236AM.

Evidencia: [RED](../../output/production-build-env-red-2026-10-13.log), [GREEN](../../output/production-build-env-green-2026-10-13.log), [build raíz](../../output/production-build-root-env-2026-10-13.log), [lint](../../output/production-lint-current-2026-10-13.log), [typecheck](../../output/production-typecheck-current-2026-10-13.log). No se modifica el alcance funcional ni se reemplaza el origen HTTPS exigido para producción por el origen loopback de las pruebas.

### P15 — Escenarios críticos independientes del recorrido UI

Ejecutados secuencialmente mediante `SCENARIO`, con `BROWSER_WEB_PORT=3021` y build ya terminado: **5/5 escenarios PASS** en Chromium **155.0.8059.12**, Windows **10.0.26200**. Se guardaron resultados por escenario antes de que el siguiente runner sobrescribiera su archivo común:

- [capability gate](../../output/production-pwa-capability-2026-10-13.json): soporte completo y degradación cuando faltan Service Worker, IndexedDB o Web Crypto;
- [operación de caja](../../output/production-cash-operations-2026-10-13.json);
- [cierre de caja](../../output/production-cash-closing-2026-10-13.json);
- [resiliencia offline](../../output/production-offline-resilience-2026-10-13.json): pérdida de red, respuesta incierta, reload, bytes exactos, rechazo de ACK falso, ACK firmado, Service Worker, revocación entre pestañas y limpieza final;
- [actualización offline](../../output/production-offline-update-2026-10-13.json).

Cada JSON tiene un `.log` homónimo con comando y resultado. Son fixtures de navegador que prueban los componentes indicados; no sustituyen la matriz real de navegadores/versiones ni el flujo de producción con API desplegada. El sexto escenario `ui-critical` sigue fallando; **el gate crítico completo permanece FAIL**, y T224/T227 no se cierran por estos cinco resultados.

### P13 — Conflicto de sesiones offline (CHECK-08 / RF-124)

- [x] Probar apertura sellada y firmada que llega después de existir una sesión online incompatible de la misma caja.
- [x] Conservar la sesión online y sus dos movimientos manuales completos; importar dos ventas offline con sus ítems, pagos y movimientos en la sesión CONFLICTED.
- [x] Verificar rollback si falla la firma del ACK, replay de bytes originales sin efectos nuevos, recibos sync y auditoría de cada operación importada.

Se añadió el caso RF-124 a `apps/api/test/historical-ingestion.integration.test.ts`; la suite afectada termina **17/17 PASS** contra PostgreSQL real y rol runtime `uco_app`. El estado online sigue OPEN con 15.00; el offline sigue CONFLICTED con 60.00. Se comparan snapshots completos de sesiones/documentos/ítems/pagos/movimientos tras cada replay y se verifican identidades de todas las operaciones del fixture. Se ejercita el importador real con grants, bootstrap, firma, cifrado, orden y recibos, no un INSERT manual de una sesión ya conflictuada.

Los primeros intentos del nuevo fixture detectaron claves de dispositivo duplicadas y cantidades UNIT con representación no canónica; se corrigieron los datos de entrada sin modificar validadores. Una ejecución posterior reprodujo una inestabilidad preexistente del fixture v1: reutilizaba la fecha de bootstrap para una operación creada antes de emitirse su grant. Ahora obtiene `occurredAt` después de la emisión, conservando el bootstrap y el requisito de vigencia. No se cambia código productivo para admitir operaciones ilegítimas.

Evidencia final: [17 pruebas](../../output/cash-conflict-preservation-2026-10-13-verified.log). Intentos conservados: `cash-conflict-preservation-2026-10-13.log`, `-repeat.log`, `-final.log` y `-gate.log` en `output/`. Comando: `pnpm --filter @uconext/api exec vitest run --config vitest.config.mts test/historical-ingestion.integration.test.ts`.

CHECK-08 queda acreditada por este caso y los checks del bloque; el veredicto global permanece pendiente hasta la conciliación SDD de todos los requisitos.

## Alternativa gratuita a evaluar

Investigación del 2026-10-13 con documentación oficial; condiciones sujetas a disponibilidad y a las cuotas efectivas de la cuenta.

**Candidata: VM Oracle Always Free A1**, para mantener Next, Nest y worker como procesos separados del monolito y PostgreSQL real bajo control propio. La documentación vigente ofrece, para cuentas Always Free, el equivalente a **2 OCPU y 12 GB de RAM**, 200 GB combinados de volúmenes y 20 GB de object storage. Debe provisionarse en la home region. La disponibilidad puede impedir crear la VM y Oracle puede recuperar instancias que considera inactivas. No asumir las cifras antiguas de 4 OCPU/24 GB ni ofrecer permanencia o disponibilidad garantizada. [Documentación oficial](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

Esta candidata **no está aprobada ni provisionada**. Antes de seleccionarla, verificar compatibilidad ARM64 de las imágenes actuales (el build fija `linux/amd64`), el driver PostgreSQL y dependencias nativas; no presentar emulación como validación en ARM real. PostgreSQL, cuotas, firewall, almacenamiento persistente, backup independiente y recuperación necesitan configuración y prueba propias. Las bases Oracle/MySQL gratuitas no sustituyen PostgreSQL.

**Render gratuito no completa este despliegue**: sus servicios se suspenden por inactividad/agotamiento de horas y su PostgreSQL gratuito expira a los 30 días y carece de backups. La propia documentación desaconseja esos servicios para producción. [Limitaciones oficiales](https://render.com/docs/free).

No se adopta una combinación de plataformas gratuitas sin verificar la ejecución continua del worker, conexiones/roles PostgreSQL, cuota de almacenamiento y restauración. Dominio o subdominio estable, TLS y entrega real de correo siguen pendientes; un preview de frontend no resuelve esos servicios.

## Tareas de infraestructura y operación para cerrar el objetivo

- [ ] **P04 — Resolver proveedor y cuotas de costo cero.** Verificar disponibilidad real de cuenta/VM, arquitectura, límites y uso previsto. Documentar decisión compatible con el plan y obtener del usuario la cuenta/control de acceso necesario sin pedir secretos en el chat. No activar recursos de pago ni cambiar a PAYG por inferencia.
- [ ] **P05 — Preparar release e imágenes verificadas.** Cerrar tareas funcionales y gates, identificar revisión completa incluyendo cambios existentes, instalación congelada, build reproducible y clave de build custodiada. Verificar imágenes de web/API/worker en arquitectura de destino y publicar referencias inmutables cuando haya registry autorizado.
- [ ] **P06 — Configurar servidor y PostgreSQL.** Sistema soportado, parches, red/firewall, acceso de administración, proxy en mismo origen, procesos aislados, volúmenes persistentes externos al filesystem efímero de contenedores y roles separados de migración/API/worker/plataforma. Probar RLS/default deny, ownership y ausencia de BYPASSRLS en runtime.
- [ ] **P07 — Configurar origen HTTPS y custodia.** Dominio/subdominio definitivo antes del build, certificado válido, redirección/rechazo HTTP, TLS a DB/storage donde corresponda, trusted proxies, cookies/CSRF/CSP, variables y claves offline/versiones, rotación y recuperación. Completar RF-12 mediante el camino HTTPS real.
- [ ] **P08 — Conectar archivos y correo reales.** S3 compatible privado, URLs firmadas y expiración, gateway de email con aceptación durable/deduplicación por jobKey, pruebas de invitación y reset con destinatario de prueba autorizado. Conservar límites y evitar secretos/tokens en logs. Verificar worker continuo, lease/backoff/dead-letter y health.
- [ ] **P09 — Probar backup y recuperación en el destino.** Backup diario cifrado, 35 días de retención conforme al plan, cuenta/bucket independiente y claves recuperables; restauración aislada DB/objetos, integridad/ledgers, migraciones y smoke. Medir RPO ≤24 h y RTO ≤8 h. Volúmenes o snapshots del mismo servidor no sustituyen backup independiente.
- [ ] **P10 — Activar monitoreo y alertas reales.** OTLP/Prometheus, readiness/liveness, fallos API/DB/worker/sync, disk/quotas y caducidad TLS; redacción y retención de logs 30 días; recepción efectiva de alertas y responsable operativo.
- [ ] **P11 — Completar compatibilidad y recorridos de release.** Dos versiones estables de Chrome/Edge/Firefox/Safari, OS y dispositivos, instalación/offline/capability gate, teclados y accesibilidad; Safari real, sin sustituirlo por WebKit. E2E con API/DB reales y escenarios offline exigidos por ambos specs.
- [ ] **P12 — Puerta final y rollout del candidato.** Cerrar `tasks-check.md`, SDD individual de ambos specs, auditoría constitucional y todos los gates de la misma revisión. Migración única, smoke externo de rutas/assets/API/worker/PDF, copia previa y procedimiento de rollback/recuperación revisado. Registrar evidencia del servidor y URL operativa; emitir LISTO PARA PRODUCCIÓN únicamente cuando todos los ítems estén acreditados.

Estos ítems siguen pendientes aunque existan scripts o pruebas locales equivalentes. La falta actual de cuenta/dominio no bloquea completar tests y preparación del release; sí impide afirmar que ya existe un servidor público verificado.
