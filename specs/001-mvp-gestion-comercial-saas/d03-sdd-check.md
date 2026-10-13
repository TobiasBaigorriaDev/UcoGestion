# D03 — verificación SDD del cambio aprobado

Fecha: 2026-10-11. Alcance de esta auditoría: RF-317–RF-323, plan §22 y D03-T01–T05. Se revisaron las aserciones y los resultados reales, no solo los nombres de pruebas. La implementación se realizó después del «apruebo» explícito. Este informe no vuelve a certificar RF-01–RF-316 ni cierra los pendientes previos del MVP, incluida T236.

**Veredicto: PENDIENTES.** La conducta D03 está comprobada en las suites ejecutadas y el recorrido Chromium con backend real. D03-T01–T04 están verificadas; D03-T05 permanece incompleta por las puertas detalladas abajo. No corresponde emitir `SPEC CUMPLIDA`.

## RF → pruebas → estado

| RF | Pruebas y aserciones revisadas | Estado |
| --- | --- | --- |
| RF-317 | `sale-confirmation.test.tsx`: UUID completo, cero, foco; `pos-consecutive-sales.test.tsx`: sustitución del ID; `pos-checkout.test.tsx`: respuesta incierta no confirma; `offline-pos-workspace.test.tsx`: commit dual y fallo de sellado sin éxito; `sale-id-browser.e2e.ts` y `sale-id.mjs`: IDs persistidos online/offline en componentes reales. | Cubierto en unitarias y Chromium. Gate multinavegador pendiente. |
| RF-318 | `sale-confirmation.test.tsx`: Tab/Enter, argumento exacto de Clipboard, feedback, API ausente/denegada; `sale-id.mjs`: Clipboard real y axe sin violaciones, incluidos contraste y vistas 1280/768/390 sin overflow. | Cubierto en unitarias y Chromium. Gate multinavegador pendiente. |
| RF-319 | `receipt-renderer.test.ts`: texto HTML y PDF descomprimido; `sales-http.e2e.test.ts`: JSON/print/PDF autorizados y snapshot intacto; `historical-ingestion.integration.test.ts`: UUID original tras conflicto; `offline-receipt-actions.test.tsx`: HTML escapado, fallo de artefacto, retiro de ventanas/URLs; `sale-id.mjs`: descarga HTML leída, impresión local/online y PDF. | Cubierto en suites ejecutadas. Gate multinavegador pendiente. |
| RF-320 | `pos-checkout.test.tsx`: mismo payload/ID/clave tras incertidumbre; `offline-sale-id.test.ts`: cinco secuencias variables de replay/reload conservan UUID, resultado y bytes; ingestión histórica PostgreSQL: replay concurrente, rollback del ACK y efectos únicos; `sale-id.mjs`: servidor recibe la venta, se pierde su ACK y el retry conserva ID; test backend exige dos ventas y dos eventos de confirmación; `offline-update.mjs`: IDs y bytes v1/v2 preservados por migración/reload, rechazo de formato desconocido sin mutación. | Cubierto con PostgreSQL, propiedades y Chromium. Resiliencia multinavegador pendiente. |
| RF-321 | `sale-lookup.test.tsx`: literal aprobado asociado mediante `aria-describedby`, UUID válido recuperado, referencias OFF/entrada inválida producen alerta sin API; `sale-id.mjs`: consulta de la venta original después del ACK real. | Cubierto en suites ejecutadas. Gate multinavegador pendiente. |
| RF-322 | `sales-http.e2e.test.ts`: runtime PostgreSQL no propietario, OWNER/ADMIN/CASHIER permitidos, otro tenant, branch scope, EMPLOYEE, sesión ajena del CASHIER, revocación y ausencia de autenticación denegados en detalle/JSON/HTML/PDF; `offline-pos-workspace.test.tsx`: revocación retira datos sin perder sobres y otra identidad no lee el recibo; suites existentes de retiro/autorización y entrega opaca pasan. | Cubierto en API e identidad local; no se identificó ampliación de permisos. Gate de navegadores pendiente. |
| RF-323 | Confirmación y HTML local distinguen pendiente; `offline-sale-id.test.ts`: grant expirado permite recuperación a identidad desbloqueada y bloquea creación; `offline-pos-workspace.test.tsx`: remount recupera ID y revocación retira lectura; `offline-setup.test.ts`: notificación tras sync; `sale-id.mjs`: ACK limpia payload local, conserva UUID y habilita consulta online sin nueva venta. | Cubierto en suites ejecutadas. Gate completo de settings/multinavegador pendiente. |

## Constitución aplicable

| Principio/regla | Verificación |
| --- | --- |
| Servidor autoritativo | Cumplido: las lecturas de recibo/detalle siguen en la API con contexto transaccional. El UUID recibido no prueba permisos. |
| Aislamiento tenant por capas | Cumplido: RLS y autorización se ejercitan con PostgreSQL real y runtime miembro de `uco_app`; negativas de organización/sucursal/sesión. Sin tablas, FKs ni políticas nuevas. |
| Consistencia antes que disponibilidad | Cumplido en pruebas ejecutadas: confirmación solo tras commit; rollback de estado/sobre y ACK; conflictos offline conservan sus restricciones y auditoría. |
| Historial inmutable | Cumplido: ID derivado de la fila autorizada al leer; snapshot anterior sin ID permanece idéntico. No se reescriben documentos ni ledgers. |
| Simplicidad evolutiva | Cumplido: monolito y motor offline existentes; sin dependencias, migraciones o servicios nuevos. |
| Contratos explícitos | Cumplido: `SaleReceiptView`, puerto de acciones tipado y validación UUID/Zod. Typecheck pasa. No se exporta una entidad Drizzle. |
| Operabilidad incorporada | Cumplido en alcance D03: no se cambia outbox/ledger/auditoría; pruebas reales verifican efectos únicos, rollback y reintentos. La suite completa API incluye checks de operaciones y recuperación. |
| Dinero/tiempo y stack | Cumplido: se reutilizan Money/Quantity/quote y strings decimales; las vistas no recalculan con floats. Se mantiene pnpm, scripts existentes y arquitectura. Turbo está impedido por el entorno, no sustituido en el proyecto. |
| Protección offline | Cumplido en pruebas ejecutadas: lectura autorizada antes/después de descifrar, generación de identidad, AES/DEK existentes, pendientes conservados hasta ACK, HTML pasivo y retiro de URLs/ventanas. Resiliencia Firefox/WebKit sin verificar. |
| Accesibilidad y pruebas | Teclado, foco, mensajes, móvil/tablet/escritorio y axe pasan en las suites ejecutadas. TDD RED/GREEN documentado. Sin skip/todo introducidos ni mocks de repositorios para probar atomicidad/aislamiento. Gate completo pendiente: no se considera terminada T05. |

No se identificaron violaciones constitucionales en el cambio inspeccionado. Esto no equivale a acreditar las pruebas que no pudieron ejecutarse.

## Resultados y pendientes concretos

- API: **606/606**, shared: **21/21**, UI: **8/8**, Web final: **237/237**; pruebas raíz Node: **3/3**. Los scripts por paquete de lint, typecheck y build pasan.
- `pnpm test:e2e:critical`: **6/6 Chromium**. `pnpm test:e2e:catalog`: **3/3**, incluido D03 contra NestJS/PostgreSQL real.
- `pnpm test:e2e:nightly`, Chromium: **12/17** escenarios pasan; `offline-settings` falla con página vacía al esperar «Desbloquear mi identidad». Pasa aislado dos veces, pero sigue fallando en secuencia tras tres intentos. Los cuatro escenarios posteriores no se ejecutaron en esa corrida. La causa no está demostrada; investigar la inicialización de iframe/IndexedDB/Service Worker antes de montar React.
- Los cuatro scripts raíz con Turbo no arrancan: Windows Application Control bloquea el ejecutable. Los scripts por paquete no acreditan esa puerta raíz.
- Firefox no arranca en dos intentos (`spawn UNKNOWN` en el último); causa pendiente de diagnóstico. WebKit no arranca y Windows Code Integrity registra rechazo Enterprise de `harfbuzz-icu.dll`. No se modifican políticas del equipo ni se acredita Safari real.

Para completar D03-T05 hace falta volver a `sdd-build` para la regresión del fixture Chromium y ejecutar las puertas pendientes en un entorno que permita iniciar Turbo y los motores requeridos. Conforme a `sdd-check`, un pendiente consciente conserva este veredicto.

[Archivos modificados, decisiones y comandos](d03-sale-id-evidence.md). Este reporte también es un archivo nuevo del cambio. Logs RED/GREEN y gates: `output/playwright/d03/`; capturas reales: `output/playwright/d03-sale-id-1280.png`, `d03-sale-id-768.png`, `d03-sale-id-390.png`. Los resultados de los motores se guardan bajo `output/playwright/{critical,nightly}-<motor>/results.json` y pueden ser reemplazados por una ejecución posterior; los logs D03 conservan cada intento.
