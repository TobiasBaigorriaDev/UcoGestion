# T236L — Mejora general de interfaz

Fecha: 2026-10-11. Solicitud: corregir y hacer más amigable la experiencia general usando `impeccable`, conservando la identidad verde de UcoNext.

## Alcance y trazabilidad

RF-152: portada con accesos reales, menú desplegable en móvil/tablet y lateral en escritorio, formularios con márgenes seguros, resumen de dos columnas en móvil y tres en escritorio.

RF-153: botón “Secciones” operable con teclado, `aria-expanded`/`aria-controls`, sección activa y enlace para saltar al contenido. Se mantienen los controles nativos de organización y sucursal.

RF-154: labels persistentes, bordes de controles distinguibles, estados de selección accesibles, cuenta con landmark propio, datos de clientes separados en líneas y jerarquía consistente. La vista previa usa CSS Modules: sus estilos inline anteriores eran bloqueados por CSP. Se conserva la política de seguridad existente.

No se modifican contratos API, autorización, transacciones, idempotencia, auditoría, cálculos ni sincronización. No se cierra el gate global T236 ni la matriz de compatibilidad RF-289.

## Archivos

- `apps/web/app/page.tsx`, `page.module.css`: acceso a login, ayuda de inicio y recuperación; se sustituyen anclas sin destino.
- `apps/web/app/preview/page.tsx`, `preview.module.css`: estilos compatibles con CSP, selección accesible, etiquetas en español y aviso sobre datos de ejemplo.
- `apps/web/src/components/app-shell.tsx`, `app-shell.module.css`: navegación móvil desplegable y menú lateral desplazable; la marca vuelve al espacio de trabajo.
- `apps/web/src/features/identity/workspace.tsx`, `management.module.css`: cuenta accesible, botones secundarios, títulos, campos alineados y metadatos de listados.
- `apps/web/src/features/identity/identity.module.css`: formularios de acceso con margen seguro y errores visibles.
- `apps/web/src/features/insights/insights.module.css`: métricas responsive, filtros y filas legibles.
- `apps/web/src/features/sales/pos.module.css`: jerarquía de títulos operativos.
- `apps/web/app/globals.css`, `packages/ui/src/tokens.css`, `DESIGN.md`: tokens de separadores, controles y hover; título operativo de 30px, placeholders y caret.
- `apps/web/test/home.test.tsx`, `app-shell.test.tsx`, `visual-preview.test.tsx`: regresiones de entrada, menú y vista previa.

## Pruebas y checks

RED: las tres regresiones nuevas fallaron por ausencia de acceso a login, ausencia de control de menú y presencia de estilos inline. GREEN: las mismas pruebas y los tests afectados pasaron.

- `pnpm lint --filter=@uconext/web --filter=@uconext/ui`: aprobado.
- `pnpm typecheck --filter=@uconext/web --filter=@uconext/ui`: aprobado.
- `pnpm test --filter=@uconext/web --filter=@uconext/ui`: aprobado. El script raíz ejecutó todas las suites; web obtuvo 76 archivos/207 tests y UI 3 archivos/8 tests. API/shared se recuperaron de caché; no son evidencia nueva de backend.
- `pnpm --filter @uconext/web test -- workspace-retirement.test.tsx workspace-errors.test.tsx app-shell.test.tsx home.test.tsx visual-preview.test.tsx`: 5 archivos/10 tests aprobados tras los ajustes.
- `pnpm build --filter=@uconext/web`: compilación aprobada. Advertencia preexistente sobre convención `middleware` de Next.js; migración fuera de este alcance.
- `git diff --check`: sin errores.

Playwright CLI sobre Microsoft Edge local: login, recuperación, dashboard, clientes, catálogo, POS y reportes revisados a 1440, 1024, 768 y 390px, incluyendo validación y error recuperable. Los controles de producto tuvieron foco visible; axe no encontró errores de contraste ni desbordamientos. La barra de cuenta introdujo un hallazgo `region`, corregido con landmark explícito y comprobado nuevamente. Portada y vista previa se verificaron también a 1440/390px, con navegación real de secciones y rol simulado.

Los fixtures de API existentes se usan exclusivamente para presentación y estados de UI. No prueban garantías de seguridad ni atomicidad. Las comprobaciones se realizaron sobre el servidor de desarrollo existente; se excluyó el portal de herramientas de Next.js del escaneo de producto. Sus errores CSP preexistentes no se resolvieron relajando la política. La revisión automática rechazó configurar `NEXT_PUBLIC_WEB_ORIGIN` para levantar una instancia de producción de prueba (“blocked by policy”); no se afirma un smoke de producción.

Artefactos locales: `output/playwright/ui-refinement-results.json` conserva el hallazgo de cuenta antes de la corrección; `output/playwright/ui-final-results.json` contiene el resultado final. Las capturas `ui-before-*` y `ui-after-*` permiten comparar portada, gestión, acceso, dashboard y POS.

El detector mecánico de Impeccable se ejecutó una vez. Solo reportó tamaños tipográficos como avisos: el título operativo se centralizó y documentó, y las etiquetas/marca se alinearon con tokens existentes. No se añadieron dependencias.
