# Preservación del sistema visual — bloque SDD 10

La autorización y el PIN offline, la vigencia, la cola propia, la entrega opaca del equipo y la desactivación de sucursales extienden el sistema existente en modo **Operate**. La comparación conserva PRODUCT.md y DESIGN.md. No hay una nueva dirección visual, marca, componente normativo ni token aprobado. La única escritura de este pase es este informe; `.impeccable/design.json` no existe en el checkout y no se genera.

## Fuentes y evidencia

Se leyeron PRODUCT.md, DESIGN.md, `packages/ui/src/tokens.css`, `packages/ui/src/primitives.css`, `apps/web/src/features/offline/{offline-settings,offline-workspace,opaque-progress}.tsx` y `apps/web/src/features/identity/{branch-management,branch-deactivation}.tsx`, junto con `management.module.css`. La comparación con `.impeccable/review/cash-close-system-preservation.md` identifica diferencias ya documentadas antes de este bloque.

Se inspeccionaron las cuatro capturas finales de este directorio:

| Superficie | Escritorio | Teléfono | Estado visible |
| --- | --- | --- | --- |
| Sucursales | `branch-deactivation-1440.png` | `branch-deactivation-390.png` | Sucursal activa con sesiones, pendientes, conflicto e incertidumbre que bloquean la desactivación. |
| POS sin conexión | `offline-settings-1440.png` | `offline-settings-390.png` | Identidad desbloqueada, autorización vigente, operación propia pendiente y entrega protegida general del equipo. |

Las capturas acreditan esos estados y tamaños. El PIN, la autorización inicial, el vencimiento, los errores y la confirmación sin bloqueos se cotejaron en fuente; no están representados en estas imágenes. Este pase no ejecuta suites, navegador, axe ni verificaciones transaccionales y no atribuye esas garantías a evidencia estática.

## Correspondencia con el sistema

- **Paleta y materiales:** acciones Bosque con texto blanco, secundarios con borde verde, tinta oscura y texto secundario sobre fondo claro. Paneles blancos con radio de tarjeta y sombra ambiental reutilizan el módulo de administración. No se añade verde Manzana ornamental ni otro material.
- **Tipografía y jerarquía:** Plus Jakarta Sans, título display y secciones headline; texto español operativo y labels persistentes. La información de vigencia y última sincronización usa fechas y horas; los pendientes propios muestran tipo, identificación, secuencia y fecha.
- **Composición responsive:** escritorio presenta acciones en fila; a 390 px se envuelven y los títulos y datos largos saltan de línea dentro de los paneles. Ambas superficies conservan el orden de lectura y márgenes móviles visibles. La separación de 24 px entre cola propia y entrega opaca hace reconocibles los dos ámbitos.
- **Interacción:** botones y campos tienen altura mínima de 44 px; los estados usan texto además de color. El PIN tiene ayuda, validación ARIA y tipo password. Las acciones de caja, sincronización e inventario dentro de los bloqueos son enlaces subrayados con foco visible explícito. El CSS respeta la preferencia de movimiento al habilitar hover/transición.

## Conducta expresada por la UI

La preparación online crea el PIN y exige autorización del equipo; la UI permite OWNER/ADMIN o un dispositivo ya autorizado y explica al resto cómo obtener autorización. EMPLOYEE recibe una denegación explícita. La vista desbloqueada separa renovación, sincronización y bloqueo de datos; comunica vencimiento y conserva la explicación de reintentos sin duplicación de pendientes propios.

La entrega protegida es un estado general del equipo: muestra cantidades y resultado de entrega, sin listar identidad, sucursal ni detalle comercial. El texto remite a la vista autenticada para consultar operaciones. La cola propia sí muestra detalles de la identidad desbloqueada. Esta distinción pertenece al comportamiento de estas superficies y no se convierte en una regla estética global.

La administración ofrece desactivación únicamente a OWNER para sucursales activas. Primero revisa bloqueos; cada bloqueo presenta causa y próximo paso, incluida la incertidumbre que no desaparece por revocación o vencimiento. Cuando los contadores son cero exige confirmación mediante checkbox, explica la conservación del historial y anuncia que se verificará nuevamente al confirmar. La fuente conserva mensajes de error, actualización ante bloqueos/versiones y estado de éxito.

## Diferencias preexistentes y alcance del veredicto

El módulo compartido mantiene contenedor de 72rem, panel sólido sin blur/borde glass, padding de botón `.65rem 1rem`, display con altura 1.15 y labels de peso 650. DESIGN.md describe contenedor de 1280 px, tarjetas glass, padding de botón `14px 28px`, display con altura 1.12 y labels de peso 500. La primitiva general de botón también usa `10px 20px`, diferente del documento normativo. Estas diferencias no se corrigen ni se canonizan en este pase; las del módulo ya constan en el informe previo de caja.

La ausencia del sidecar sigue siendo una ausencia preexistente. El porcentaje de uso móvil de DESIGN.md carece de respaldo en PRODUCT.md y no se usa como prueba empírica. Se preservan ambos documentos y sus decisiones sin ampliar su autoridad con inferencias del fixture.

Según el handoff del agente principal, la revisión fresca aprobó **los dos fixes**: enlaces de bloqueos subrayados con foco y separación de 24 px del progreso opaco. La disposition `ship` corresponde a esos hallazgos; no se presenta como aprobación completa de todas las superficies ni de todas sus garantías de seguridad. La evidencia visual y el código confirman que los fixes aplican el vocabulario incumbente, por lo que este bloque no requiere actualizar PRODUCT.md, DESIGN.md ni crear el sidecar.
