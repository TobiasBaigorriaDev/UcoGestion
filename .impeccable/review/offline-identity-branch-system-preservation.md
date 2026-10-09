# Preservación del sistema — identidad offline y sucursales

T220A (PIN, vigencia, sincronización y cola propia), T220B (progreso opaco general del equipo) y T221A (bloqueos accionables de desactivación) extienden el mundo establecido en modo **Operate**, mediante código y con alcance acotado. Se conserva «El Mostrador Digital de la Cordillera»: Plus Jakarta Sans, acciones Bosque, texto español operativo, superficies claras con profundidad moderada y adaptación móvil. No hay comp, rediseño ni cambio duradero del sistema autorizado.

La frontera de escritura de este pase es este informe. PRODUCT.md, DESIGN.md, los tokens y el código permanecen intactos. La referencia `document.md` se aplica como comparación documental del sistema existente; no autoriza reemplazar DESIGN.md ni generar un sidecar. `.impeccable/design.json` no existe en el checkout inspeccionado y no se crea.

## Evidencia cotejada

Se leyeron PRODUCT.md, DESIGN.md, `packages/ui/src/tokens.css`, `apps/web/src/features/offline/{offline-settings,offline-workspace,opaque-progress}.tsx`, `apps/web/src/features/identity/{branch-deactivation.tsx,management.module.css}` y los guiones `apps/web/test/browser/{offline-settings,branch-deactivation}.mjs`. Los informes previos de caja y del bloque SDD 10 permiten distinguir diferencias incumbentes de cambios de esta extensión.

Se inspeccionaron visualmente estas capturas finales de `output/playwright`:

| Captura | Estado observado |
| --- | --- |
| `offline-settings-1440.png` | Autorización vigente, fechas, acciones de sincronización/renovación/bloqueo, apertura de caja propia pendiente y entrega general del equipo. |
| `offline-settings-390.png` | Mismo estado con acciones apiladas, títulos y UUID que envuelven dentro de los paneles. |
| `opaque-progress-retired-390.png` | Identidad bloqueada con formulario PIN; entrega general persistente, rechazo definitivo y error recuperable sin detalle de la operación ajena. |
| `branch-deactivation-1440.png` | Sucursal activa con bloqueos de sesiones, pendientes, inventario e incertidumbre; enlaces de resolución separados del texto. |
| `branch-deactivation-390.png` | Mismos bloqueos en móvil, enlaces legibles y explicación completa de incertidumbre. |

Las imágenes documentan estos estados del fixture con componentes y estilos reales; no acreditan el AppShell completo, RLS, atomicidad ni garantías del backend. El PIN y la separación tras retiro sí cuentan con captura móvil; autorización inicial, vencimiento, confirmación sin bloqueos y éxito se cotejan en fuente o guion, sin atribuirles una captura inexistente.

## Sistema preservado

- **Paleta y profundidad:** primarios Bosque con texto blanco, secundarios de contorno verde, tinta oscura y texto secundario sobre fondo claro. Los paneles reutilizan radio y sombra ambiental incumbentes; no agregan acentos ornamentales, ilustraciones ni materiales.
- **Tipografía y composición:** fuente y escala heredadas, labels persistentes, fechas con semántica `time` y títulos de sección reconocibles. A 390 px las acciones se apilan y los identificadores envuelven; se conserva el orden de lectura. El progreso opaco queda separado de la cola propia por el margen existente de 24 px.
- **Interacción:** botones y campos heredan altura mínima de 44 px y foco visible. El PIN usa campo password, ayuda y validación ARIA. Los enlaces de bloqueos conservan subrayado, foco explícito y color Bosque; el fix añade `min-height: 44px` a `.branchBlockers a` con alineación flex. Los estados comunican causa y próximo paso mediante texto. El stylesheet condiciona transiciones a la preferencia de movimiento.

La cola propia exige identidad desbloqueada y presenta detalle comercial; el progreso general expone cantidades, entrega, rechazo y reintento sin identidad, sucursal ni payload privado. Tras retiro desaparece el detalle propio y permanece la entrega protegida. Esa distinción funcional pertenece a estas superficies y no se convierte en una nueva regla visual global.

La desactivación primero revisa bloqueos y enlaza sesiones de caja, sincronización e inventario. La incertidumbre explica que vencimiento o revocación no eliminan el bloqueo. La fuente muestra confirmación explícita únicamente sin bloqueos, nueva validación al confirmar, errores recuperables y conservación del historial.

## Verificación y disposition

El handoff del agente principal informa detector con `[]`, exit 0 y disposition final **ship** tras resolver el hallazgo del tamaño táctil de los enlaces de bloqueos. La verificación de bounds reales se efectuó a 1440 y 390 px. El guion cotejado exige para cada enlace `boundingBox().height >= 44` y `width >= 44`, además de ausencia de desborde y axe completo en ambos tamaños; la fuente contiene la corrección correspondiente. Este pase documental no vuelve a ejecutar navegador ni detector y distingue esos resultados comunicados de su propia inspección.

El guion offline cotejado ejercita PIN real, cola de identidad, teclado, pérdida/retorno de red, conservación exacta del sobre ante error, ACK firmado, retiro y progreso genérico sin metadatos ajenos. Comprueba axe y desborde en la vista desbloqueada a ambos tamaños, y axe adicional sobre el error genérico móvil. El guion de sucursales verifica ausencia de confirmación bloqueada, confirmación por teclado y reintento idéntico de clave/payload/versión tras respuesta perdida. Estas comprobaciones del fixture no sustituyen las pruebas reales de persistencia y autorización.

El ship comunicado cierra el hallazgo revisado y acepta esta extensión acotada; no constituye una aprobación universal de cada estado del producto ni una auditoría de seguridad.

## Drift preexistente preservado

El módulo compartido usa contenedor de 72rem, panel sólido sin blur/borde glass, padding de botón `.65rem 1rem`, display con line-height 1.15 y labels de peso 650. DESIGN.md describe contenedor de 1280 px, tarjetas glass, padding `14px 28px`, display con 1.12 y labels de peso 500. Estas diferencias ya constan en los informes de caja: se registran sin corregirlas ni canonizarlas como tokens nuevos.

La ausencia del sidecar es preexistente. La proporción de uso móvil afirmada por DESIGN.md carece de respaldo empírico en PRODUCT.md y no se usa como evidencia. El informe conserva las fuentes de autoridad sin ampliar su alcance ni alterar decisiones duraderas.
