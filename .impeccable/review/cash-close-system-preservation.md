# Preservación del sistema visual — caja T218B

El cierre normal, la sincronización final, el contado, el aborto y la revisión de diferencias extienden «El Mostrador Digital de la Cordillera». Este pase documenta la aplicación del sistema incumbente a T218B; no establece una dirección visual nueva ni modifica tokens. PRODUCT.md y DESIGN.md permanecen intactos. `.impeccable/design.json` no existe en el checkout inspeccionado y no se crea: la frontera de escritura es este informe.

## Fuentes y artefacto observado

Se leyeron PRODUCT.md, DESIGN.md, `.impeccable/review/cash-direction.md`, `packages/ui/src/tokens.css`, `apps/web/app/globals.css`, `cash-closing.tsx`, `cash-workspace.tsx`, `cash-api.ts` y el stylesheet heredado `features/identity/management.module.css`. Se cotejó el guion `apps/web/test/browser/cash-closing.mjs` para distinguir comportamiento ejercitado de evidencia visual estática.

Las capturas inspeccionadas son `cash-closing-1440.png`, `cash-closing-390.png` y `cash-reviewed-mobile.png`. Las dos primeras muestran cierre en curso después de verificar la sincronización final, contado de 8.00 ARS, esperado consolidado de 7.00 ARS, motivo y diferencia previa de 1.00 ARS. La tercera muestra la sesión finalizada y la diferencia revisada, conservando esos importes. Son capturas del fixture con componentes y estilos reales, no del AppShell completo.

## Sistema preservado

- **Paleta:** Bosque para acciones principales y foco, blanco para su texto, tinta oscura y texto secundario gris sobre fondo claro. El aborto usa la variante secundaria transparente heredada. No se amplía el uso ornamental de Manzana.
- **Tipografía:** Plus Jakarta Sans; escala display para el título, headline para las secciones y cuerpo para importes, estado y ayuda. Las etiquetas persisten junto al campo y los importes incluyen moneda.
- **Composición:** el estado de sesión precede al cierre. Dentro del cierre se presentan sincronización, aborto, esperado consolidado, contado, motivo, diferencia y confirmación. Los campos comparten fila en escritorio y se apilan a 390 px; las acciones se envuelven sin desborde.
- **Formas y profundidad:** panel sólido con radio de tarjeta y sombra ambient incumbentes; campos con radio pequeño, botones con radio propio. La extensión reutiliza el módulo de administración y no agrega materiales, ilustraciones ni adornos.
- **Interacción:** controles heredados de al menos 44 px de alto, foco visible, texto de estado, ayuda y validación ARIA junto al campo. La transición de hover respeta la preferencia de movimiento del stylesheet; el reset global conserva la reducción de movimiento.

## Conducta operativa expresada por la interfaz

La sesión abierta ofrece congelar y comenzar cierre desde su dispositivo asociado. El estado en cierre explica que no admite nuevas operaciones y puede retomarse tras reload. El formulario de contado aparece únicamente cuando el servidor devuelve la sincronización final verificada; el motivo resulta obligatorio cuando el contado difiere del esperado. El cálculo utiliza Money y strings decimales del contrato existente.

El aborto explica que devuelve la sesión a abierta conservando importes y operaciones. La pantalla finalizada muestra el snapshot del cierre y permite consolidar el estado local si la respuesta se interrumpió. La revisión comunica su efecto documental, conserva los importes y expresa las restricciones de OWNER/ADMIN y autorrevisión con texto. Las vistas activas, finalizadas y pendientes de revisión, junto con la paginación, recuperan el historial desde el servidor.

`cash-api.ts` valida los datos de sesión, consulta las vistas autorizadas y conserva únicamente claves/hash opacos para reintentos. La respuesta perdida, el replay y la recuperación del intento son garantías operativas de esta extensión; no se promueven a reglas estéticas generales.

La corrección funcional posterior añade `lastAbortedAttemptId` al snapshot autenticado de la sesión abierta. Al comenzar otro cierre tras perder la respuesta del aborto y recargar, `cash-closing.tsx` consolida primero ese aborto local y después prepara/firma el nuevo checkpoint. Se cotejaron la fuente y la regresión que comprueba ese orden; no cambia markup, textos, estilos ni tokens, por lo que las capturas conservan su alcance visual original.

## Evidencia y límites de aceptación

Según la ejecución comunicada por el agente principal, quedaron verdes 25 pruebas web en nueve archivos, cinco pruebas de revisión en dos archivos y 16 pruebas API en dos archivos con PostgreSQL real. Esos resultados son evidencia histórica previa a la corrección de recuperación del aborto. La fuente actual contiene cinco pruebas en `cash-closing.test.tsx`; la ejecución posterior con `offline-close` pasó sus nueve pruebas, y foundation volvió a pasar sus quince pruebas con la lectura autenticada del aborto. Este pase documental no reejecuta esas suites ni atribuye a las capturas sus garantías transaccionales.

Chromium pasó el fixture con HTTP sustituido como puerto externo, componentes/query/cliente/IndexedDB reales y criptografía ECDSA real. El guion verifica comienzo con respuesta perdida y reload, aborto con respuesta perdida y replay, clave nueva por intento, contado después de sincronizar, motivo, revisión, confirmación por teclado y pérdida/retorno de red. Ejecuta axe completo y comprobación de ausencia de desborde en el estado de contado a 1440 y 390 px. La captura de revisión acredita su composición móvil; el guion no ejecuta un segundo axe específico sobre ese estado final.

El detector se ejecutó una vez: exit 0 sin findings. La revisión completa tuvo disposition `fix` por un único documento de dirección desactualizado; ese documento ya incorpora T218B. El verdict posterior marcó ese hallazgo documental `Resolved` con disposition `ship` únicamente sobre el finding señalado. No se declara un whole-surface pass ni aprobación de toda la superficie.

## Diferencias incumbentes no canonizadas

El CSS compartido conserva contenedor de 72rem, panel sólido sin blur/borde glass, padding de botón `.65rem 1rem`, display con altura de línea 1.15 y etiquetas de peso 650. DESIGN.md describe contenedor de 1280 px, tarjetas glass, botón de `14px 28px`, display con altura 1.12 y label de peso 500. Son diferencias heredadas, visibles también en la documentación previa de caja; no se corrigen ni se convierten en tokens o reglas nuevas durante esta extensión.

La proporción de uso móvil indicada en DESIGN.md no tiene evidencia en PRODUCT.md y no se usa como validación empírica. El pase conserva la autoridad del sistema existente y registra sus límites sin ampliar el alcance funcional o visual de T218B.
