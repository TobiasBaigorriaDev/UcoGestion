# T236M — Dashboard con gráficos y períodos

Fecha: 2026-10-11. Solicitud autorizada: mejorar el inicio con gráficos, estadísticas y resumen de hoy, semana, mes o fechas elegidas. Preferencia confirmada por el usuario: semana actual y mes actual.

## Alcance y trazabilidad

RF-142: seis indicadores y gráficos de actividad, medios de pago y más vendidos para OWNER/ADMIN. Se representan los agregados que ya entrega `/api/v1/dashboard`; no se inventa una serie temporal ni se agregan consultas diarias múltiples. Los filtros conservan sucursales autorizadas.

RF-143: el resultado operativo conserva ventas netas menos gastos netos, con explicación visible; las compras se presentan por separado.

RF-144/RF-145: CASHIER ve sus ventas y sesiones de caja; EMPLOYEE conserva catálogo e inventario sin filtros de ventas ni gráficos globales.

RF-152/RF-153/RF-154: distribución responsive, botones con selección anunciada, campos etiquetados, foco visible, validación en el formulario y valores textuales junto a las barras. SVG decorativo oculto a lectores de pantalla; no depende del color para identificar los datos.

Los accesos usan el día de la organización, semana de lunes a domingo y mes calendario. Desde/Hasta incluyen ambas fechas; elegir el mismo día permite consultar una fecha concreta. La consulta transmite desde medianoche local hasta la medianoche posterior al último día, exclusiva, conforme al contrato existente. Editar el rango no consulta hasta pulsar Aplicar período. Se mantiene Todo el historial.

Stock bajo muestra existencias actuales independientemente del período, y el resumen de cajas corresponde a sesiones abiertas dentro del período; ambas condiciones se aclaran en pantalla. Un error de actualización retira los indicadores anteriores y permite reintentar.

No se añaden dependencias, migraciones ni cambios backend. Dinero se conserva como string y se formatea mediante Money; la geometría de las barras usa proporciones bigint sin recalcular totales comerciales ni convertir importes a number. Se mantienen autorización, RLS, transacciones, auditoría e idempotencia existentes. No se cambia DESIGN.md para esta extensión ni se cierra T236/RF-289.

## Archivos

- `apps/web/src/features/insights/dashboard-workspace.tsx`: presentación, gráficos, filtros, carga y errores.
- `apps/web/src/features/insights/dashboard-presentation.ts`: fechas calendario, límites de consulta y representación exacta de importes.
- `apps/web/src/features/insights/dashboard.module.css`: estilos scoped y responsive compatibles con CSP.
- `apps/web/src/features/identity/workspace.tsx`: transmisión de moneda de la organización al dashboard.
- `apps/web/test/dashboard-periods.test.ts`: límites de fecha, horario de verano, año bisiesto, entradas inválidas, importes grandes y propiedad de proporciones gráficas.
- `apps/web/test/dashboard-workspace.test.tsx`: períodos, aplicación explícita del rango, permisos de presentación y equivalentes textuales.
- `apps/web/test/browser/dashboard-periods.mjs`: escenario reproducible de navegador con fixtures de presentación.
- `apps/web/test/browser/ui-critical.mjs`: expectativas de texto localizadas y equivalentes de los gráficos.

## Verificación

- `pnpm lint`: aprobado.
- `pnpm typecheck`: aprobado.
- `pnpm build`: aprobado; conserva el aviso previo de Next sobre middleware/proxy.
- `pnpm --filter @uconext/web test`: 77 archivos, 214 pruebas aprobadas, sin skips.
- `pnpm --filter @uconext/ui test`: 3 archivos, 8 pruebas aprobadas, sin skips.
- Playwright CLI con Edge 155: aprobado; nueve escaneos axe sin infracciones ni desbordamiento horizontal. Datos en 1440, 1024, 768 y 390 px; además rango inválido, vacío, error, CASHIER y EMPLOYEE en móvil.
- Navegador: comprobados requests exactos de hoy, semana, mes, fecha única inclusiva, historial y sucursal; aplicación con teclado y foco visible. Error de actualización oculta estadísticas anteriores.
- Detector manual de Impeccable sobre el componente: sin hallazgos (`[]`). Inspección visual de escritorio/móvil en una ronda conjunta y una confirmación después de ajustar importes móviles.

Capturas locales con datos de ejemplo: `output/playwright/dashboard-1440.png` y `output/playwright/dashboard-390.png`. El escenario requiere sustituir `const source = AXE_SOURCE;` por el contenido serializado de `apps/web/node_modules/axe-core/axe.min.js` antes de ejecutarlo con `playwright-cli run-code --filename`.

Límite de esta evidencia: navegador sobre servidor dev existente y respuestas de API de prueba; acredita UI y filtros, no una nueva validación de aislamiento PostgreSQL ni compatibilidad Safari. Se excluye solamente `nextjs-portal` (herramientas de desarrollo ajenas al producto) del escaneo. El servidor dev emite errores CSP de esas herramientas; se conserva la política CSP. La compilación de producción está verificada.
