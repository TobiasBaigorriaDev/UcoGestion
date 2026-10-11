# Tareas para cerrar SDD Check — MVP UcoNext

Estado: **PENDIENTE DE EJECUCIÓN**. Fecha de preparación: 2026-10-10.

Este archivo organiza el trabajo necesario para obtener el veredicto **SPEC CUMPLIDA**. El MVP ya tiene funcionalidad probada; estos pendientes son garantías que todavía no cuentan con evidencia completa. No son 18 defectos confirmados. Revisar los tests puede demostrar que basta ampliarlos o puede revelar una corrección necesaria.

Base: auditoría del 2026-10-10, commit `f46e82bdadd54123280012a855a4663429106ad0`: **298 de 316 requisitos cubiertos, 18 pendientes y ningún RF con violación reproducida**. El informe completo y su matriz siguen siendo la evidencia de ese corte:

- [Informe SDD Check](../../output/sdd-check-2026-10-10.md).
- [Matriz y evidencia estructurada](../../output/sdd-check-2026-10-10.json).
- [Spec cerrado](spec.md), [constitución](../../constitution.md), [plan aprobado](plan.md) y [tareas de construcción](tasks.md).

## Cómo usar este archivo

Los IDs CHECK son locales a esta lista; los RF identifican requisitos del spec. Se conserva `tasks.md`: esta lista complementa su seguimiento y no declara completadas sus tareas abiertas.

Ejecutar una unidad atómica por vez. Cuando una tarea abarque una matriz grande, dividirla en casos concretos antes de implementarla. Revisar primero las aserciones existentes; reutilizar pruebas significativas y agregar únicamente la evidencia faltante. Los archivos citados son puntos de partida, no afirmaciones de cobertura suficiente.

**Autorización explícita del usuario:** al ejecutar estas tareas, se permite escribir, editar y refactorizar código, agregar o modificar tests y realizar los cambios necesarios en contratos y migraciones cuando correspondan, para corregir fallos reproducidos o completar comportamientos faltantes exigidos por el MVP aprobado. No limitar el trabajo a señalar el problema: implementar la solución y verificarla. No hace falta pedir una nueva autorización por cada corrección dentro de este alcance. Esta autorización permite los cambios necesarios durante la ejecución; la creación de esta lista no inicia ni da por completadas las tareas.

Si hay que escribir tests o corregir código, realizar ese trabajo mediante **sdd-build**, con TDD estricto: prueba que falle por la garantía faltante, cambio mínimo y refactorización con pruebas verdes; después volver a **sdd-check** para verificar la evidencia. La separación de etapas no impide corregir el código: SDD Check verifica y reporta, y SDD Build implementa las correcciones autorizadas. No debilitar las aserciones para ocultar un fallo, cambiar el alcance, reinterpretar un RF ni alterar reglas constitucionales para hacer pasar el gate. Los cambios de alcance, excepciones constitucionales y acciones externas, irreversibles o destructivas conservan sus requisitos de aprobación.

Para marcar una tarea como completada, adjuntar casos probados, archivos y aserciones concretas, comandos, resultados, commit y límites de la evidencia. No valen tests omitidos, un nombre de test, un mock de repositorio para probar aislamiento o atomicidad, ni una decisión de aceptar el riesgo. Si falta entorno o navegador, registrar el bloqueo y mantener el pendiente.

## 1. Permisos y aislamiento — comenzar aquí

- [ ] **CHECK-01 — Inventariar acciones, rutas y relaciones que deben cubrirse.**
  - Enumerar desde el spec, plan y API las acciones y lecturas por módulo, roles permitidos, sucursales involucradas y asociaciones tenant.
  - Cruzar cada fila con pruebas existentes y señalar las faltantes; incluir operaciones administrativas, comerciales, dispositivos, configuración, sincronización y compensaciones.
  - **Terminado cuando:** existe una matriz verificable `acción/ruta → rol → scope → relación → test/aserción`, sin extrapolar un caso de un módulo a otro.
  - **Dependencias:** ninguna. Alimenta CHECK-02 a CHECK-05, CHECK-13 y CHECK-14.

- [ ] **CHECK-02 — Completar autorización de los cuatro roles (RF-21 / T236K2).**
  - Revisar `apps/api/test/operational-role-policy.test.ts`, `owner-branch-scope.integration.test.ts` y `t236k-authorization.integration.test.ts`.
  - Cubrir acciones y lecturas faltantes de CHECK-01 mediante membresías reales OWNER, ADMIN, CASHIER y EMPLOYEE, incluyendo rutas HTTP y cotización POS.
  - Probar permisos válidos y rechazos por rol, organización, sucursal y actor inactivo; verificar ausencia de efectos comerciales ante rechazo.
  - **Terminado cuando:** todas las filas de autorización aplicables tienen aserciones y ejecuciones verdes con NestJS/PostgreSQL reales donde corresponda.
  - **Dependencias:** CHECK-01.

- [ ] **CHECK-03 — Completar límites del administrador (RF-23 / T236K3).**
  - Revisar las pruebas de CHECK-02 y `apps/api/test/membership-administration.integration.test.ts`.
  - Cubrir operaciones administrativas/comerciales restantes, dispositivos y configuración de organización. Verificar alcance de sucursales asignadas y protección de propietarios.
  - Incluir recursos con sucursales mixtas, cambios de permisos y reintentos: conservar lo ajeno al scope y rechazar acciones globales no autorizadas según el contrato aprobado.
  - **Terminado cuando:** cada operación ADMIN tiene controles positivos y negativos de scope, sin modificación ni exposición de recursos fuera de sus permisos.
  - **Dependencias:** CHECK-01; reutilizar CHECK-02.

- [ ] **CHECK-04 — Completar comportamiento de sucursales desactivadas (RF-29 / T236K4).**
  - Revisar `apps/api/test/branch-management.integration.test.ts` y `t236k-authorization.integration.test.ts`.
  - Desactivar realmente una sucursal con historial; cubrir todas las operaciones nuevas y sus rutas HTTP, no solo los diez comandos ya probados.
  - Distinguir consulta histórica, nueva operación y compensación. Comprobar cada comportamiento contra el spec/plan, sin bloquear o permitir compensaciones por suposición.
  - **Terminado cuando:** nuevas operaciones no dejan efectos en la sucursal inactiva, el historial se conserva y consultas/compensaciones respetan sus reglas y autorización.
  - **Dependencias:** CHECK-01.

- [ ] **CHECK-05 — Completar relaciones entre organizaciones (RF-285 / T236K8).**
  - Revisar `apps/api/test/tenant-base.integration.test.ts`, `tenant-rls.integration.test.ts` y `t236k-authorization.integration.test.ts`.
  - Completar asociaciones pendientes: categorías, membresías/invitaciones, cajas/dispositivos, grants/sync y compensaciones, además de revisar el inventario completo de relaciones.
  - Por relación y endpoint, usar dos organizaciones reales: aceptar IDs locales válidos y rechazar IDs ajenos; comprobar lecturas, escrituras y efectos secundarios. Verificar FK compuesta y RLS cuando corresponda.
  - **Terminado cuando:** ninguna asociación inventariada queda sin evidencia negativa cross-tenant y control positivo; no se usa una FK o caso aislado como prueba de todas las rutas.
  - **Dependencias:** CHECK-01.

## 2. Contraseñas y almacenamiento offline

- [ ] **CHECK-06 — Probar transporte protegido de contraseñas (RF-12).**
  - Revisar `apps/api/test/login.integration.test.ts`, `global-users.integration.test.ts` y `password.test.ts`; conservar la evidencia de hash existente.
  - Inventariar todos los flujos que reciben/procesan contraseñas y ejercitarlos mediante HTTPS real, con proxy/TLS representativo del contrato de despliegue. Comprobar que HTTP no admite el envío inseguro y que logs/almacenamiento no guardan el texto plano.
  - **Terminado cuando:** cada flujo tiene evidencia del canal cifrado y de no conservación de la contraseña; los unitarios de Argon2 no sustituyen TLS.
  - **Dependencias:** entorno de prueba HTTPS reproducible; no requiere publicar el producto.

- [ ] **CHECK-07 — Revisar todos los almacenes de credenciales offline (RF-172).**
  - Revisar `apps/web/test/offline-keys.test.ts` y `offline-authorization.test.ts`.
  - Inventariar IndexedDB/Dexie, localStorage, sessionStorage, Cache Storage y cualquier otro mecanismo persistente usado. Inspeccionar lo guardado después de login, grant/PIN, uso offline, reload, cambio de usuario/organización, logout y revocación.
  - Probar vinculación usuario/organización/dispositivo, protección de material criptográfico y ausencia de contraseñas, tokens reutilizables o secretos en texto plano. Conservar sobres pendientes conforme al contrato.
  - **Terminado cuando:** el inventario completo tiene evidencia automatizada apropiada y verificación real en navegador de las garantías de almacenamiento y aislamiento.

## 3. Operación offline y recuperación

- [ ] **CHECK-08 — Conservar ambas sesiones de caja y sus operaciones en un conflicto (RF-124).**
  - Revisar `apps/api/test/cash-foundation.integration.test.ts`.
  - Crear sesiones incompatibles con operaciones identificables en ambas; sincronizar la apertura offline y comprobar `CONFLICTED` para esa sesión.
  - Comparar todas las operaciones, documentos, movimientos y vínculos de ambas sesiones antes/después y después de un reintento, incluyendo cualquier efecto legítimo previsto por el contrato.
  - **Terminado cuando:** PostgreSQL real demuestra conservación de ambas sesiones y de todas sus operaciones, sin traslado, pérdida ni duplicación.

- [ ] **CHECK-09 — Probar fallo individual y reintentos en un único flujo (RF-274).**
  - Revisar `apps/web/test/opaque-delivery.test.ts`, `apps/api/test/offline-ack.test.ts` y `sync-envelope-keys.test.ts`.
  - Inducir un fallo de una operación entre otras sincronizables; comprobar estado visible, contenido local exacto y retención hasta ACK definitivo.
  - En el mismo escenario, recuperar red/servicio, ejecutar retry automático y manual, incluir reload y ACK perdido; comprobar una sola aplicación y mismos bytes/clave idempotente.
  - **Terminado cuando:** el flujo integrado prueba fallo → estado → preservación → ambos reintentos → ACK, sin borrar operaciones pendientes ni duplicar efectos.

- [ ] **CHECK-10 — Aplicar operaciones tardías con su versión histórica (RF-307).**
  - Revisar `apps/api/test/historical-sale-snapshot.test.ts` y `historical-ingestion.integration.test.ts`, más evidencia T236J del plan §11.2.
  - Crear operaciones legítimas con versión anterior, cambiar posteriormente cada campo semántico relevante y realizar la ingestión tardía completa: referencias, moneda, unidad, tipo y control de inventario.
  - Comprobar importes, cantidades, recursos, snapshots, movimientos y auditoría usando la versión verificable original, no solo el rechazo del validador actual. Incluir replay idempotente y rollback de fallo inducido.
  - Conservar compatibilidad v1/v2 y semántica de categoría UNKNOWN/NONE/ASSIGNED; no reconstruir historia desde el maestro actual.
  - **Terminado cuando:** cada campo requerido tiene evidencia de efectos correctos en PostgreSQL real, sin reinterpretación ni reasignación.

## 4. Impresión, reportes, mensajes y auditoría

- [ ] **CHECK-11 — Mantener la venta confirmada ante problemas de impresión (RF-82).**
  - Revisar `apps/web/test/receipt-actions.test.tsx`, `apps/api/test/sales-http.e2e.test.ts`, `sales-quote.integration.test.ts` y `generated-files.test.ts`.
  - Probar impresora ausente, desconectada y error de impresión mediante dispositivo real o puerto externo equivalente. Un fallo de generación PDF no cubre por sí solo estos tres casos.
  - Comprobar venta persistida y efectos de caja/stock/auditoría; un reintento de impresión no debe volver a confirmar la venta.
  - **Terminado cuando:** los tres casos preservan la venta y sus efectos exactamente una vez.

- [ ] **CHECK-12 — Comparar pantalla, CSV y PDF de todos los reportes (RF-147).**
  - Revisar `apps/api/test/reports.integration.test.ts`, `dashboard.integration.test.ts` y pruebas del worker PDF.
  - Enumerar todos los datasets y filtros soportados. Con datos controlados, comparar filas, totales, períodos y scope entre visualización, CSV y PDF; contemplar paginación si aplica.
  - Incluir organización y sucursal ajenas, actor sin permiso y límites temporales según zona horaria. Verificar autorización también al obtener el archivo.
  - **Terminado cuando:** cada dataset/filtro tiene equivalencia semántica comprobada y solo exporta datos autorizados.

- [ ] **CHECK-13 — Revisar mensajes de error de cada función principal (RF-133).**
  - Revisar `apps/api/test/problem-details.test.ts` y `apps/web/test/workspace-errors.test.tsx`.
  - Inventariar rechazos/fallos relevantes por función; probar respuesta y mensaje visible con causa comprensible y acción posible. Cubrir validación, permisos, stock/caja, conflicto, red y servicio según corresponda.
  - Verificar códigos estables, `traceId`, ausencia de secretos, SQL, stack traces y datos ajenos al scope; comprobar presentación accesible del error.
  - **Terminado cuando:** cada fila de la matriz tiene aserciones de contrato y de mensaje, no únicamente un formato Problem Details genérico.
  - **Dependencias:** CHECK-01; coordinar con CHECK-14 y CHECK-18.

- [ ] **CHECK-14 — Completar eventos de auditoría de todas las acciones relevantes (RF-140).**
  - Revisar `apps/api/test/audit-events.integration.test.ts` y `audit-query.integration.test.ts`.
  - Crear matriz de acciones de seguridad, administración, inventario, ventas, compras, gastos y caja; verificar actor, organización, fecha/hora, entidad, acción y contexto aplicable en cada evento.
  - Conservar pruebas de inmutabilidad, permisos de lectura y redacción. Para mutaciones transaccionales, inducir fallo de auditoría y comprobar rollback; los replays no duplican eventos de la operación.
  - **Terminado cuando:** todas las acciones relevantes tienen pruebas del evento correcto y de las garantías transaccionales aplicables, no solo del writer.
  - **Dependencias:** CHECK-01.

## 5. Navegadores, dispositivos y accesibilidad

Estas cuatro tareas comparten una misma matriz de ejecución; separar criterios evita confundir un navegador que arranca con uno que cumple todos los flujos.

- [ ] **CHECK-15 — Completar compatibilidad e instalación PWA (RF-289 / T224 / T227).**
  - Revisar `apps/web/test/browser/pwa-install.mjs`, `pwa-capability.mjs` y el runner `ops/browser/run.mjs`.
  - Ejecutar las dos últimas versiones estables de Chrome, Edge, Firefox y Safari reales al momento de verificar. Registrar nombre, versión exacta, OS, capacidades, fecha y resultado por escenario.
  - Probar instalación standalone, iconos 192/512, offline donde existan capacidades y degradación online segura donde falten. Resolver los bloqueos de Firefox/WebKit observados en Windows o usar un entorno compatible documentado.
  - Safari real requiere entorno que lo ejecute; WebKit automatizado no sustituye esta evidencia. Chromium tampoco sustituye automáticamente Chrome/Edge branded ni sus versiones objetivo.
  - **Terminado cuando:** la matriz exigida está completa, con resultados verificables y sin celdas omitidas; T224/T227 tienen evidencia para su cierre.

- [ ] **CHECK-16 — Completar interfaz responsive y funcional (RF-152).**
  - Revisar `apps/web/test/browser/ui-critical.mjs` y los flujos E2E existentes.
  - Reutilizar los 129 estados ya probados en Chromium y completar escenarios en la matriz CHECK-15 para computadora, notebook, tablet y teléfono; revisar controles, contenido y acciones sin desbordamientos impeditivos.
  - Registrar viewports y capturas/fallos. Los fixtures UI sirven para presentación; los flujos de negocio requieren sus gates con API real.
  - **Terminado cuando:** cada función principal funciona en tamaños y navegadores exigidos con evidencia actual.
  - **Dependencias:** entorno de CHECK-15.

- [ ] **CHECK-17 — Completar teclado y foco (RF-153).**
  - Revisar `apps/web/test/browser/ui-critical.mjs` y `apps/web/test/error-summary.test.tsx`.
  - Recorrer funciones principales sin mouse en la matriz requerida: orden lógico, foco visible, modales, menús, formularios y recuperación del foco tras errores/cierre.
  - **Terminado cuando:** las interacciones principales tienen aserciones de teclado y foco en los navegadores objetivo, sin trampas ni acciones inaccesibles.
  - **Dependencias:** entorno de CHECK-15; compartir recorridos con CHECK-16.

- [ ] **CHECK-18 — Completar accesibilidad de controles y errores (RF-154).**
  - Revisar las pruebas de CHECK-17, Testing Library y axe-core existentes.
  - Completar labels, nombres de iconos interactivos, semántica, estados ARIA, contraste mínimo 4.5:1 y comunicación que no dependa solo del color; incluir validación, loading, vacío y error en la matriz requerida.
  - Combinar verificaciones automatizadas y comprobación real de los estados que axe no demuestra por sí solo.
  - **Terminado cuando:** los estados inventariados cumplen cada garantía con evidencia actual por navegador aplicable.
  - **Dependencias:** entorno de CHECK-15; compartir recorridos con CHECK-16/17.

## 6. Motivos de bloqueo administrativo y puerta final

- [ ] **CHECK-19 — Distinguir motivos de bloqueo sin revelar datos ajenos (RF-308).**
  - Revisar `apps/web/test/organization-settings.test.tsx` y `catalog-item-management.test.tsx`, y sus contratos/backend de barreras.
  - Probar separadamente historial confirmado, incertidumbre pendiente de sincronización y bloqueo permanente de moneda por dispositivo irrecuperable.
  - Cruzar cada causa con roles y scopes relevantes, verificar mensaje y datos devueltos por API; comprobar que la UI no filtra datos fuera del alcance del actor.
  - **Terminado cuando:** la matriz causa × autorización distingue los tres motivos y preserva confidencialidad en backend y frontend.
  - **Dependencias:** reutilizar matrices CHECK-02/03/13.

- [ ] **CHECK-20 — Ejecutar revisión final y obtener veredicto (T236).**
  - Requiere CHECK-01 a CHECK-19 completas con evidencia; reconciliar T224, T227, T236K2/K3/K4/K8 en `tasks.md` mediante la etapa correspondiente, sin marcar completado por anticipación.
  - Ejecutar checks raíz y gates afectados sobre la misma revisión de código. Conservar logs, versiones, resultados y comandos exactos; ejecutar fixtures de navegador compartidos secuencialmente para evitar interferencia de caché Vite.
  - Volver a **sdd-check**: revisar uno por uno los **316 RF**, sus aserciones y ejecuciones. Comprobar todos los principios/reglas constitucionales; revisar explícitamente atomicidad, idempotencia, auditoría, observabilidad, errores y reintentos de bloques críticos.
  - Verificar que los cambios no hayan invalidado los 298 RF previamente cubiertos. Evidencia histórica o logs de otro commit no sustituyen la ejecución final correspondiente.
  - **Terminado cuando:** 316/316 RF tienen cobertura real con tests verdes, no queda tarea requerida abierta ni violación constitucional y el reporte emite **SPEC CUMPLIDA**. Si una condición falla, conservar **PENDIENTES** con causa concreta.

### Comandos de referencia para CHECK-20

Usar los scripts raíz existentes y agregar las suites afectadas que exijan las tareas; estos comandos no sustituyen la matriz real de versiones de navegador ni el entorno HTTPS.

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e:critical
pnpm test:e2e:catalog
pnpm --filter @uconext/api exec vitest run --config vitest.authorization-browser.config.mts
pnpm test:e2e:nightly
pnpm test:compatibility
```

El runner selecciona navegador mediante `BROWSER`, no mediante `--browser`. Ejecutar secuencialmente por entorno, por ejemplo:

```powershell
$env:BROWSER = 'firefox'
pnpm test:e2e:nightly
Remove-Item Env:BROWSER
```

Valores admitidos actualmente: `chromium`, `firefox`, `webkit`, `chrome`, `msedge`. Para Safari real y versiones anteriores estables, preparar y documentar el mecanismo de ejecución adicional necesario; no atribuir esa cobertura al runner actual.

## Registro que debe acompañar cada cierre

| Tarea | Caso y RF | Test y aserción | Comando / entorno / versión | Resultado / evidencia | Commit | Límite o bloqueo |
| --- | --- | --- | --- | --- | --- | --- |
| CHECK-xx | Por completar al ejecutar | | | | | |

**Este documento es la lista de trabajo, no un nuevo veredicto.** No se han ejecutado ni completado sus tareas por crear el archivo. La certificación SDD del alcance no sustituye la preparación y verificación del entorno productivo, cuyos proveedores siguen diferidos en el plan.
