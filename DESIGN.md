---
name: UcoNext
description: Clean Glassmorphism design system for PyME commercial digitalization
colors:
  primary: "#166534"
  primary-vibrant: "#22C55E"
  primary-emerald: "#15803D"
  bg-light: "#F8FAFC"
  surface-glass: "rgba(255, 255, 255, 0.78)"
  surface-border: "rgba(255, 255, 255, 0.50)"
  text-primary: "#0F172A"
  text-secondary: "#475569"
  text-muted: "#5B677A"
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

## Overview

**Creative North Star: "El Mostrador Digital de la Cordillera"**

UcoNext combina una estética moderna *Clean Glassmorphism* inspirada en iOS/macOS con la calidez y practicidad del comercio del Valle de Uco y Mendoza. Las superficies translúcidas con desenfoque de fondo (`backdrop-filter: blur(14px)`), los bordes con brillo sutil y las sombras suaves generan profundidad sin saturar la pantalla ni sobrecargar procesadores en teléfonos móviles.

El sistema está concebido bajo una filosofía estricta de *simplicidad funcional sobre complejidad técnica*, garantizando que cualquier comerciante pueda operar o evaluar el sistema sin frustraciones directamente en el mostrador del negocio.

**Key Characteristics:**
- Superficies translúcidas con desenfoque (`glass-card`).
- Paleta verde regional inspirada en la producción y la cordillera del Valle de Uco.
- Mobile-first estricto (80% del uso en teléfonos celulares).
- Tipografía geométrica de alta legibilidad para cifras y precios (*Plus Jakarta Sans*).

## Colors

La paleta cromática se estructura en tonos verdes de contraste y neutros limpios sobre fondo claro.

### Primary
- **Bosque (Primary Dark)** (`#166534`): Identidad institucional, navegación principal y contraste alto.
- **Manzana (Primary Vibrant)** (`#22C55E`): Indicadores de avance, selección, confirmaciones y estados activos. Reservado exclusivamente para interacción o feedback, nunca meramente decorativo.
- **Esmeralda (Accent)** (`#15803D`): Estados hover y transiciones de interacción.

### Neutral
- **Background Light** (`#F8FAFC`): Fondo general de la aplicación.
- **Surface Glass** (`rgba(255, 255, 255, 0.78)`): Fondo de tarjetas y paneles translúcidos.
- **Surface Border** (`rgba(255, 255, 255, 0.50)`): Borde perimetral de 1px con brillo sutil.
- **Text Primary** (`#0F172A`): Títulos principales y textos críticos con alto contraste.
- **Text Secondary** (`#475569`): Descripciones y explicaciones.
- **Text Muted** (`#5B677A`): Texto auxiliar y placeholders legibles sobre fondos claros.
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
- **Title** (Medium 500 / SemiBold 600, 1.125rem, 1.4): Títulos de módulos internos y subbloques.
- **Body** (Regular 400, 1rem, 1.5): Párrafos y textos explicativos (máx. 65–75ch).
- **Label** (Medium 500, 0.875rem, 1.4): Microcopia, chips y etiquetas táctiles.

## Layout

Diseño mobile-first y responsivo integral con espaciados múltiplos de 4px/8px.
- Contenedores principales: max-width 1280px (`max-w-7xl`).
- Padding perimetral seguro en móviles (16px a 24px) y desktop (32px a 48px).

## Elevation & Depth

Profundidad basada en desenfoque óptico (`backdrop-filter`) y sombras sutiles multidireccionales, evitando sombras duras artificiales.

### Shadow Vocabulary
- **Glass Ambient** (`0 8px 32px 0 rgba(15, 23, 42, 0.05)`): Profundidad natural de tarjetas glassmorphic en reposo.
- **Glass Hover** (`0 12px 40px 0 rgba(22, 101, 52, 0.12)`): Elevación interactiva al pasar el cursor o enfocar.

## Shapes

- Esquinas suaves y amplias con radio de 16px (`rounded-2xl`) a 24px (`rounded-3xl`) en tarjetas principales.
- Botones con radio de 12px (`rounded-xl`).
- Bordes finos de 1px semitransparentes que definen el corte del cristal contra el fondo.

## Components

### Buttons
- **Shape:** Radio de 12px (`rounded-xl`).
- **Primary:** Fondo `#166534`, texto blanco, sombra suave, padding `14px 28px`.
- **Hover:** Transición a `#15803D` con escala sutil `scale-[0.98]` en activo.
- **Secondary Glass:** Fondo `rgba(255, 255, 255, 0.80)`, borde `1px solid rgba(226, 232, 240, 0.8)`, texto `#0F172A`.
- **Touch target:** Área interactiva mínima de 44×44px, aun cuando el contenido visual sea menor.

### Forms and feedback

- Labels persistentes; el placeholder nunca sustituye al label y usa `text-muted` con opacidad 1.
- Errores junto al campo y en un resumen enfocable, enlazados mediante semántica ARIA.
- Estados de carga, vacío, éxito, advertencia, conflicto, offline y permiso denegado usan icono/texto además de color.
- El foco visible debe conservar contraste de al menos 3:1 contra superficies sólidas o glass.

### Cards (.glass-card)
- **Fondo:** `rgba(255, 255, 255, 0.78)` con `backdrop-filter: blur(14px)`.
- **Borde:** `1px solid rgba(255, 255, 255, 0.5)`.
- **Sombra:** `0 8px 32px 0 rgba(15, 23, 42, 0.05)`.
- **Radio:** 16px (`rounded-2xl`).

## Do's and Don'ts

### Do:
- **Do** garantizar contraste mínimo de 4.5:1 sobre superficies translúcidas.
- **Do** diseñar primero para la experiencia en teléfono móvil de una mano.
- **Do** verificar contraste sobre el color compuesto final que produce la transparencia, no solo sobre el token RGBA aislado.

### Don't:
- **Don't** saturar la interfaz con desenfoques excesivos que degraden los FPS en dispositivos móviles modestos.
- **Don't** usar el color verde vibrante `#22C55E` como fondo decorativo estático.
