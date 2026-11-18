---
name: UcoNext
description: Warm shop-counter design system for PyME commercial management
colors:
  primary: "#166534"
  primary-vibrant: "#22C55E"
  primary-emerald: "#15803D"
  bg-light: "#F4F5F0"
  surface: "#FFFFFF"
  sidebar: "#ECEEE6"
  primary-soft: "#E7F1E9"
  divider: "#D9DDD1"
  control-border: "#7A8471"
  text-primary: "#1C2118"
  text-secondary: "#485043"
  text-muted: "#575F52"
  text-disabled: "#94A3B8"
  text-on-vibrant: "#052E16"
  success: "#16A34A"
  warning: "#F59E0B"
  danger: "#EF4444"
typography:
  display:
    fontFamily: "Plus Jakarta Sans, sans-serif"
    fontSize: "clamp(2rem, 5vw, 3.5rem)"
    fontWeight: 800
    lineHeight: 1.12
  headline:
    fontFamily: "Plus Jakarta Sans, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "Plus Jakarta Sans, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Plus Jakarta Sans, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.4
  pdf-body:
    fontFamily: "Helvetica"
    fontSize: "9pt"
    lineHeight: 1.4
  pdf-heading:
    fontFamily: "Helvetica-Bold"
    fontSize: "24pt"
    lineHeight: 1.15
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "14px 28px"
---

# Design System: UcoNext

Los reportes PDF usan Helvetica y Helvetica-Bold, fuentes estándar incorporadas en el renderer, para impresión y generación autónoma sin descargas externas. Conservan los colores de marca y la jerarquía de títulos. Esta variante se limita a documentos PDF; la interfaz web mantiene Plus Jakarta Sans. Encabezados y columnas se repiten en cada hoja, importes alineados a la derecha, filas suaves alternadas y paginación estable.

## Overview

**Creative North Star: "El Mostrador Digital de la Cordillera"**

UcoNext es la herramienta del mostrador de un almacén del Valle de Uco: verde Bosque como identidad y fondos neutros cálidos (piedra verdosa, no crema). Las superficies son sólidas, con borde fino y una sombra corta. No hay vidrio ni desenfoque en superficies operativas (rediseño D08, 2026-11-16). Funciona igual de rápido en teléfonos modestos que en una notebook.

El sistema prioriza la *simplicidad funcional sobre la complejidad técnica*. La pantalla dice qué hacer a continuación («¿Qué querés hacer?») y habla el idioma del negocio, no el del sistema: «Turno de caja», «Fiado», «Dueño», `$ 1.800,00`.

**Key Characteristics:**
- Navegación agrupada por tarea (Vender, Caja, Stock, Clientes y proveedores, Dinero y Ajustes), con iconos de trazo y una barra inferior en el teléfono.
- Mostrador pensado para la fila: botones de producto, Enter para agregar, +/− por unidad, total grande y cobro en un toque.
- Mobile-first estricto (80% del uso en teléfonos celulares).
- Plus Jakarta Sans con números tabulares para precios y totales.

## Colors

La paleta cromática se estructura en tonos verdes de contraste y neutros limpios sobre fondo claro.

### Primary
- **Bosque (Primary Dark)** (`#166534`): Identidad institucional, navegación principal y contraste alto.
- **Manzana (Primary Vibrant)** (`#22C55E`): Indicadores de avance, selección, confirmaciones y estados activos. Reservado exclusivamente para interacción o feedback, nunca meramente decorativo.
- **Esmeralda (Accent)** (`#15803D`): Estados hover y transiciones de interacción.

### Neutral
- **Piedra (Background)** (`#F4F5F0`): Fondo general de la aplicación.
- **Surface** (`#FFFFFF`): Paneles, tarjetas, encabezado y barra inferior.
- **Sidebar** (`#ECEEE6`): Segunda capa neutra del menú lateral en escritorio.
- **Primary Soft** (`#E7F1E9`): Ítem activo del menú, estado «Caja abierta», hover y total del cobro.
- **Text Primary** (`#1C2118`): Títulos y textos críticos (≥14:1 sobre cualquier superficie).
- **Text Secondary** (`#485043`): Descripciones y explicaciones (≥7:1).
- **Text Muted** (`#575F52`): Texto auxiliar y placeholders (≥5,6:1 incluso sobre Sidebar).
- **Aviso cálido** (`#FDF6E7` con borde `#E7C58A`): «No hay una caja abierta», precio actualizado. Siempre acompañado de texto y acción.
- **Text Disabled** (`#94A3B8`): Solo estados deshabilitados o marcas decorativas que no transmiten información necesaria; no se usa para placeholders ni texto operativo.

### Named Rules
**The Vibrant Action Rule.** El color *Primary Vibrant* (`#22C55E`) se reserva para indicadores de avance, selección e interacción activa; nunca se usa como fondo ornamental invasivo ni como fondo de texto blanco. El botón primario usa Bosque (`#166534`) con texto blanco. Cuando Manzana se use como superficie, lleva texto oscuro (`#052E16`) o un par validado con contraste mínimo 4.5:1.

## Typography

**Display Font:** Plus Jakarta Sans (Google Fonts)
**Body Font:** Plus Jakarta Sans
**Character:** Geometría moderna, trazos limpios y excelente legibilidad para lectura de números y precios en dispositivos móviles.

### Hierarchy
- **Display** (Bold 700 / ExtraBold 800, 2rem - 3.5rem, 1.12): Títulos de alto impacto en vistas y hero.
- **Headline** (SemiBold 600 / Bold 700, 1.5rem, 1.3): Encabezados de tarjetas y secciones.
- **Título de página operativa** (Bold 700 / 750, 1.875rem, 1.25): Encabezados de administración, acceso, POS y reportes. Tamaño fijo para conservar una jerarquía predecible en móvil y escritorio; Display queda reservado para la portada.
- **Title** (Medium 500 / SemiBold 600, 1.125rem, 1.4): Títulos de módulos internos y subbloques.
- **Body** (Regular 400, 1rem, 1.5): Párrafos y textos explicativos (máx. 65–75ch).
- **Label** (Medium 500, 0.875rem, 1.4): Microcopia, chips y etiquetas táctiles.

### Superficies operativas

Separadores `#D9DDD1` delimitan filas y navegación sin competir con los datos. Los controles usan el borde `#7A8471` (≥3:1). La superficie `#E7F1E9` acompaña hover y selección con texto Bosque, conservando la regla de Manzana. Estos valores viven en `packages/ui` como `--color-divider`, `--color-control-border`, `--color-primary-soft` y `--color-sidebar`. Las pruebas de tokens verifican el contraste de cada texto sobre cada superficie.

**Navegación.**
- Los grupos son Inicio, Vender (Mostrador, Ventas), Caja (Turno de caja, Cajas registradoras, Este equipo sin conexión), Stock (Productos, Compras), Clientes y proveedores, Dinero (Gastos, Reportes) y Ajustes (Negocio, Sucursales, Usuarios, Medios de pago, Categorías de gasto, Auditoría). Cada ítem tiene un icono Lucide de trazo 1,8 en `currentColor`.
- La visibilidad por rol replica la del backend: EMPLOYEE no ve venta ni caja.
- En escritorio, el menú lateral queda fijo debajo del encabezado. En el teléfono, una barra inferior ofrece tres destinos diarios (Inicio, Mostrador, Turno de caja; para EMPLOYEE: Inicio, Productos, Compras) y «Más» abre el menú completo; Escape lo cierra y devuelve el foco.
- El ítem activo usa Primary Soft y texto Bosque en negrita, sin borde lateral de color.
- Cuando hay una sola organización o sucursal, el encabezado las muestra como texto, sin selector. Con una sola organización se entra automáticamente.
- Los formularios agrupan campos alineados, mantienen labels persistentes y usan acciones secundarias de menor peso visual en listados.

**Inicio.** Arranca con el estado de caja: «Caja abierta: …» en Primary Soft, o «No hay una caja abierta» con el enlace «Abrir turno de caja». Sigue «¿Qué querés hacer?», con Vender como acción principal y accesos por rol. Después vienen el período y las métricas. El selector de sucursal del resumen aparece solo si hay más de una.

**Mostrador.**
- La búsqueda agrega el primer resultado con Enter. Los botones de producto muestran nombre y precio.
- El carrito va antes que la grilla de productos.
- Hay botones +/− para unidades enteras y agregar otra vez suma una unidad. Las unidades fraccionables se escriben.
- El cobro muestra la caja como texto si hay una sola y el total en 2rem.
- «¿Cómo paga?» ofrece un botón por medio de pago que cubre todo el total. «Agregar pago» divide el pago.
- Cliente, fiado y descuento quedan plegados en «Cliente, fiado o descuento».
- Una barra fija repite el total junto a «Confirmar venta».
- Los importes aceptan el formato argentino (`5.000`, `5.000,50`).
- «Preparar o abrir POS sin conexión» es una acción secundaria al pie.

**Turno de caja.**
- Bajo el título está «Ver turnos»: Abiertos o en cierre, Cerrados y Con diferencias para revisar.
- Le sigue el resumen del turno: caja, estado en una píldora (Abierto, Cerrando, Con conflicto, Cerrado), «Efectivo esperado en la caja» en 2rem Bosque, apertura e inicial.
- Un equipo no habilitado muestra un aviso cálido con «Habilitar este equipo» para OWNER/ADMIN. A CASHIER le indica que se lo pida al dueño o a un administrador.
- «Abrir turno» y «Ingresar o retirar efectivo» aceptan importes argentinos.
- El cierre es una lista numerada de cuatro pasos (pendiente, actual en Bosque, hecho con tilde SVG): Empezar el cierre, Revisar ventas pendientes, Contar el efectivo y Confirmar el cierre. Muestra «En la caja debería haber $ …» y, mientras se escribe, «Faltan $ …», «Sobran $ …» o «El efectivo coincide». «Cancelar el cierre» devuelve la caja a abierta.
- «Caja cerrada» resume Esperado, Contado y Diferencia.

**Listados.**
- Los historiales se recorren en lista, no por ID.
- Gastos (OWNER/ADMIN): «Historial de gastos» con filtros Desde, Hasta y «Estado del gasto», «Total del período» en Primary Soft y filas-botón con concepto, categoría, medio, fecha, importe y la píldora «Anulado». Tocar una fila abre el detalle, encabezado por el concepto.
- La búsqueda por ID queda plegada en «Buscar un gasto por su ID»; para CASHIER está abierta.
- Auditoría: tabla Fecha, «Qué pasó» (acción traducida), Persona (correo o «Otra persona») y Sucursal. Los filtros son listas: «Qué pasó» y «Persona». «Mostrar también tareas automáticas del sistema» está apagado por defecto.

**Formato.** El dinero se muestra siempre como `$ 1.800,00` (`formatMoney`). Las cantidades agrupan miles (`22.000`). Los roles, medios de pago y estados de turno se muestran en español.

Catálogo e inventario comparten una entrada en la navegación principal. Dentro de esa sección, una navegación local identifica Productos y, según el rol, Historial de ajustes, Transferencias y Categorías. Productos presenta inicialmente nombre, precio y stock. Seleccionar una fila despliega detalles y dos entradas: Editar y Cambiar stock. Precio, estructura, estado y eliminación se ofrecen dentro de Editar. Cambiar stock abre un formulario vertical de nuevo ajuste; Historial de ajustes conserva consulta y compensaciones sin duplicar el alta. El ajuste de existencias y el mínimo por sucursal se gestionan dentro del producto, conservando motivos, historial y permisos. La ruta anterior de Stock redirige a Productos. La consulta muestra el stock de la sucursal activa junto a cada producto inventariable; nunca interpreta un saldo ausente como cero. Para OWNER/ADMIN también reúne la gestión de ítems: búsqueda, edición, precio, estado y eliminación sujeta al historial. El alta se abre cuando se necesita, inmediatamente debajo de su botón y antes del listado; las acciones menos frecuentes se despliegan por producto. La ruta anterior de ítems conserva enlaces directos y las acciones siguen sujetas a sus permisos propios.

El listado ofrece orden por nombre, precio, stock y alerta de stock bajo configurada. «Agrupar por categorías» es opcional, apagado inicialmente: al activarlo muestra carpetas cerradas con fondo verde suave, borde verde, icono de carpeta, nombre, cantidad de ítems y flecha de apertura. Cada carpeta se abre por separado mediante botón accesible; los productos se muestran debajo con sangría. «Sin categoría» usa la misma presentación y aparece al final. La búsqueda y el orden elegido se conservan dentro de cada grupo; los grupos sin resultados se omiten. Reactivar la agrupación inicia nuevamente todas las carpetas cerradas.

## Layout

Diseño mobile-first y responsivo integral con espaciados múltiplos de 4px/8px.
- Contenedores principales: max-width 1280px (`max-w-7xl`).
- Padding perimetral seguro en móviles (16px a 24px) y desktop (32px a 48px).

## Elevation & Depth

La profundidad viene de superficies sólidas con borde fino y sombras cortas con desplazamiento; no se usa desenfoque. El encabezado y la barra inferior se separan del contenido con un borde de 1px.

### Shadow Vocabulary
- **Raised** (`0 1px 2px rgb(28 33 24 / 6%), 0 4px 12px rgb(28 33 24 / 5%)`): Paneles y accesos rápidos en reposo (`--shadow-raised`).
- **Bar** (`0 -4px 16px rgb(28 33 24 / 6%)`): Barra inferior móvil y barra de confirmación del cobro.
- `--shadow-glass` y `.uco-glass` quedan solo en la primitiva de diálogo de `packages/ui`; las superficies operativas no los usan.

## Shapes

- Esquinas suaves y amplias con radio de 16px (`rounded-2xl`) a 24px (`rounded-3xl`) en tarjetas principales.
- Botones con radio de 12px (`rounded-xl`).
- Bordes finos de 1px en Divider que definen cada superficie contra el fondo Piedra.

## Components

### Buttons
- **Shape:** Radio de 12px (`rounded-xl`).
- **Primary:** Fondo `#166534`, texto blanco, sombra suave, padding `14px 28px`.
- **Hover:** Transición a `#15803D` con escala sutil `scale-[0.98]` en activo.
- **Secondary:** Fondo Surface, borde Control Border, texto Text Primary; hover con borde y texto Bosque.
- **Touch target:** Área interactiva mínima de 44×44px, aun cuando el contenido visual sea menor.

### Forms and feedback

- Labels persistentes; el placeholder nunca sustituye al label y usa `text-muted` con opacidad 1.
- Errores junto al campo y en un resumen enfocable, enlazados mediante semántica ARIA.
- Estados de carga, vacío, éxito, advertencia, conflicto, offline y permiso denegado usan icono/texto además de color.
- El foco visible debe conservar contraste de al menos 3:1 contra cada superficie. Los `input type="date"` usan `:focus-within`, porque Chromium no aplica `:focus-visible` al host.

### Panels
- **Fondo:** Surface `#FFFFFF`.
- **Borde:** `1px solid` Divider.
- **Sombra:** Raised.
- **Radio:** 16px (`--radius-card`).

## Do's and Don'ts

### Iconos de categorías

La categoría de catálogo puede elegir entre 52 iconos SVG Lucide orientados a almacenes y kioscos, con búsqueda y etiquetas accesibles en español, mediante «Elegir icono» en el alta o «Cambiar icono» en la edición. La cuadrícula y la vista previa muestran solamente iconos, sin nombres visibles. Las etiquetas ARIA mantienen el buscador y la identificación con lector de pantalla. Radio buttons accesibles muestran la selección con marca y fondo; al elegir se cierra la biblioteca y retorna el foco a su botón. Los mismos assets locales acompañan nombre y carpeta en Productos. Sin selección se usa carpeta. SVG estático de procedencia y licencia fijadas en `apps/web/public/icons/categories/SOURCE.md`; no se carga biblioteca externa ni contenido SVG del usuario.

### Do:
- **Do** garantizar contraste mínimo de 4.5:1 para texto y 3:1 para bordes de controles sobre cada superficie.
- **Do** diseñar primero para la experiencia en teléfono móvil de una mano.
- **Do** escribir en el idioma del comercio y mostrar el próximo paso (por ejemplo, «Abrir turno de caja») en lugar de explicar el sistema.

### Don't:
- **Don't** usar vidrio, desenfoque ni bordes laterales de color como decoración.
- **Don't** mostrar códigos internos (`CASH`, `OWNER`, `OPEN`) ni importes con punto decimal (`1800.00`).
- **Don't** usar el color verde vibrante `#22C55E` como fondo decorativo estático.

### Cuestionario de edición de productos

Al abrir Editar, los campos de datos, categoría, SKU/código de barras, precio, tipo/unidad/inventario y estado aparecen juntos en el mismo editor. No hay botonera de «Cambiar precio», «Cambiar estructura», «Desactivar» o «Eliminar». Se guarda cada apartado explícitamente, con instrucción visible y las operaciones versionadas existentes. Estado usa un select Activo/Inactivo; su guardado no está disponible si no cambia. La eliminación se despliega al final dentro del editor con confirmación, mientras cambiar stock conserva el flujo independiente. Jerarquía mediante encabezados y tokens existentes, responsive y teclado nativo.
