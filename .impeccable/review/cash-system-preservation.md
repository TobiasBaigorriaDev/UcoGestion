# Preservación del sistema visual — caja T218A

La apertura y los movimientos manuales de caja extienden «El Mostrador Digital de la Cordillera». Esta revisión registra la aplicación del sistema existente a T218A; no introduce identidad, tokens ni reglas globales nuevas. PRODUCT.md, DESIGN.md y `.impeccable/design.json` se conservan sin cambios. El alcance no certifica AppShell, T218B/T218C, cierres ni la finalización del grupo 3.

## Fuentes y artefacto observado

Se cotejaron PRODUCT.md, DESIGN.md, `cash-direction.md`, los tokens y primitivas de `packages/ui/src`, `management.module.css`, `cash-operations.tsx`, `cash-workspace.tsx`, `cash-api.ts`, la ruta `app/workspace/cash-sessions/page.tsx` y la carga de Plus Jakarta Sans en `app/layout.tsx`. El script `apps/web/test/browser/cash-operations.mjs` delimita las comprobaciones de navegador.

Se inspeccionaron las cinco capturas existentes: `cash-opening-desktop.png`, `cash-opening-mobile.png`, `cash-desktop.png`, `cash-mobile.png` y `cash-reason-error-mobile.png`. Corresponden a la superficie de prueba con CSS/reset y la fuente reales de Next; no son una captura del AppShell completo. Las vistas de escritorio usan 1440 px de ancho y las móviles 390 px.

## Sistema preservado

- **Paleta:** acciones Bosque y texto blanco, texto principal oscuro y secundario gris sobre fondo claro y panel blanco. Los valores proceden de los tokens existentes; el hover conserva Esmeralda. No se amplía el uso ornamental de Manzana.
- **Tipografía:** Plus Jakarta Sans cargada por Next; el título usa la escala display existente, los encabezados la escala headline y el cuerpo conserva lectura de importes, moneda y fecha. Las etiquetas permanecen visibles.
- **Composición:** apertura primero cuando hay caja disponible y dispositivo autorizado; luego sesión, estado textual, esperado y apertura. Tipo, importe y motivo siguen ese orden. La grilla heredada distribuye los campos en escritorio y los apila en móvil.
- **Formas y profundidad:** paneles con radio de tarjeta, sombra ambient existente; campos con radio pequeño y botones con radio propio. El artefacto conserva los paneles sólidos del módulo de administración incumbente.
- **Interacción:** controles de al menos 44 px de alto, foco visible, botones junto al formulario, ayuda y validación junto al campo. La confirmación vuelve desde el servidor y explica la actualización del estado.

Las restricciones de rol, dispositivo y estado se expresan con texto. El formulario de movimientos aparece para la sesión abierta ligada al dispositivo local; otras situaciones explican por qué no se puede operar. La respuesta perdida conserva clave y hash opacos para el reintento exacto. Esa conducta es una propiedad de esta operación, no una nueva regla estética.

## Evidencia de revisión y corrección

El detector mecánico previo sobre los tres targets devolvió `[]`. La revisión completa encontró una sola corrección local: la validación del motivo superior a 2000 caracteres mostraba el mensaje predeterminado en inglés. Se registró una prueba RED y se explicitó el mensaje «El motivo no puede superar los 2000 caracteres.». La captura móvil de error evidencia la traducción, el foco y la lectura del mensaje sin desborde.

Según la evidencia de ejecución comunicada por el agente principal, quedaron verdes cuatro pruebas web en dos archivos y, posteriormente, una quinta prueba de vínculo criptográfico del dispositivo en un tercer archivo; también Playwright y los checks de lint/typecheck de API y web. La revisión completa tuvo disposition `fix`; el verdict posterior fue `pass` para el único hallazgo, con resolución `resolved/ship`. Esto no constituye aprobación de toda la superficie. Este pase documental coteja fuentes y capturas; no vuelve a ejecutar ni amplía esas pruebas.

El cambio posterior de key por `actorUserId` y dispositivo en CashWorkspace desmonta los borradores cuando cambia la identidad o el equipo. No altera el sistema visual; los cinco PNG y PRODUCT.md/DESIGN.md se conservan.

El script de navegador comprueba apertura con respuesta perdida y reintento sin duplicación, reload, asociación de dispositivo, envío por teclado, foco del resumen de error, rechazo del motivo largo antes del envío, ingreso de efectivo, retorno de red, ausencia de mutación al estar offline y axe sin violaciones en escritorio y móvil. También comprueba carga de la fuente y ausencia de desborde horizontal a 390 px. Usa componentes, query, cliente e IndexedDB reales y sustituye HTTP como puerto externo; sus capturas no prueban por sí solas atomicidad o aislamiento PostgreSQL.

## Diferencias incumbentes no canonizadas

El stylesheet compartido de administración usa un contenedor de 72rem, panel sólido sin blur/borde glass, padding de botón `.65rem 1rem`, título con altura de línea 1.15 y labels de peso 650. DESIGN.md describe contenedor de 1280 px, tarjeta glass, botón de `14px 28px`, display con altura 1.12 y label de peso 500. Las capturas reflejan el stylesheet heredado. Estas diferencias preexistentes se registran como drift y no se convierten en tokens o reglas nuevas ni se corrigen dentro de T218A.

La afirmación de DESIGN.md «80% del uso en teléfonos celulares» no tiene evidencia de producto en PRODUCT.md y no se usa como prueba de comportamiento real. Tampoco se promueven diferencias de reset o de densidad del formulario a una identidad nueva. Una reconciliación general del sistema requeriría un alcance propio.
