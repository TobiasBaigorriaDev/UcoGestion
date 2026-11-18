# T236AH — Aviso y cambio de POS al perder internet

Solicitud explícita del usuario, 2026-10-13; RF-346–RF-347 complementan RF-116–RF-120 y RF-275–RF-279. Una sola tarea: bloquear el POS online abierto, ofrecer acceso local y preservar el reintento original. Sin migraciones, dependencias ni cambios de protocolo.

## Problema y solución

`OnlineOnlyBoundary` ya rechazaba el uso sin red, pero desmontaba la pantalla completa y no ofrecía acceso al POS local. Eso descartaba el carrito y la referencia en memoria con el payload y la Idempotency-Key de una venta cuya respuesta se perdió. El shell público del Service Worker es informativo: navegar a otra página sin conexión no inicia el POS local.

`PosConnectionBoundary` conserva ambas superficies montadas. `OfflineWorkspace` valida identidad/equipo online al abrir el POS normal, sin emitir grants ni preparar credenciales automáticamente. Al recibir `offline`, el aviso toma foco y la venta online queda `hidden` e `inert`. El botón pasa al POS local en la misma pantalla, con las comprobaciones de PIN, grant y dispositivo existentes. Con red, el botón «Preparar o abrir POS sin conexión» permite preparar el equipo. La recuperación de red no interrumpe el modo local elegido; volver online es una acción explícita.

Se conservan datos previamente cargados del contexto POS ante errores de transporte de revalidación; errores reales de autorización siguen cerrando la superficie. El checkout permanece montado: el test de respuesta perdida verifica que después del corte, cambio de modo y retorno se reenvía exactamente el payload y clave originales, incluso tras cambios del crédito/precio remoto.

## Archivos

- `apps/web/src/offline/pos-connection-boundary.tsx`: aviso, bloqueo, modos y foco.
- `apps/web/src/offline/online-only-boundary.tsx`: hook de conectividad compartido; administración mantiene su bloqueo previo.
- `apps/web/src/offline/online-only-boundary.module.css`: acción con tokens y ocultamiento explícito.
- `apps/web/src/features/identity/workspace.tsx`: integración y precarga del controlador local por organización/sucursal.
- `apps/web/test/pos-connection-boundary.test.tsx`, `account-checkout.test.tsx`: conservación de montaje, carrito, modo y reintento original.
- `apps/web/test/browser/offline-settings.tsx`, `pos-connection.mjs`, `ops/browser/run.mjs`: escenario registrado con IndexedDB/Web Crypto/Settings/POS local reales. La venta online en ese fixture es un formulario mínimo; su checkout real se verifica en Vitest.
- Spec, plan, tasks y esta evidencia: autorización y trazabilidad.

## Verificación

RED: prueba nueva antes de implementación falla por ausencia de la superficie requerida. GREEN: 30 pruebas PASS (14 de interacción/checkout y 16 de setup, autorización, identidad, expiración y entrega):

```powershell
pnpm --filter @uconext/web test pos-connection-boundary.test.tsx account-checkout.test.tsx online-only-boundary.test.tsx pos-consecutive-sales.test.tsx offline-pos-workspace.test.tsx offline-settings.test.tsx
pnpm --filter @uconext/web test offline-setup.test.ts offline-authorization.test.ts offline-identity.test.ts offline-expiry.test.ts opaque-delivery.test.ts
pnpm lint
pnpm typecheck
pnpm build --filter=@uconext/web
```

Chromium por skill Playwright, servidor Vite de fixtures en 4179:

```powershell
pnpm exec vite . --config apps/web/test/browser/offline-update.vite.mjs --host 127.0.0.1 --port 4179 --strictPort
pnpm exec playwright-cli -s=pos-connection open http://127.0.0.1:4179/apps/web/test/browser/offline-settings.html?connection
pnpm exec playwright-cli -s=pos-connection run-code --filename apps/web/test/browser/pos-connection.mjs
pnpm exec playwright-cli -s=pos-connection goto http://127.0.0.1:4179/apps/web/test/browser/offline-pos.html
pnpm exec playwright-cli -s=pos-connection run-code --filename apps/web/test/browser/offline-pos.mjs
pnpm exec playwright-cli -s=pos-connection run-code --filename apps/web/test/browser/offline-expiry.mjs
pnpm exec playwright-cli -s=pos-update-check open http://127.0.0.1:4179/apps/web/test/browser/offline-update.html
pnpm exec playwright-cli -s=pos-update-check run-code --filename apps/web/test/browser/offline-update.mjs
```

Escenario nuevo PASS: pérdida/retorno de red, bloqueo de controles online, desbloqueo offline en la misma URL, motor local real, conservación del carrito, escritorio 1440 y móvil 390, axe sin violaciones y foco. Motor offline PASS en versiones 1/2: apertura, venta y cobro, rollback al fallar el sobre, replay, logout, reload byte a byte, rechazo de apertura duplicada y competencia de pestañas.

Expiración PASS (8 escenarios), actualización/migración PWA PASS (5 escenarios, perfil nuevo). El primer intento de actualización en el perfil usado por otros escenarios informó «No installing worker», porque ese worker ya estaba instalado; el escenario exige un perfil limpio y pasó allí. Lint/typecheck raíz y build web PASS; advertencia previa de Next sobre middleware deprecated. Los errores iniciales de validación de fixture (prop opcional y global window) quedaron corregidos antes de los checks finales.

Capturas `output/playwright/pos-connection-1440.png` y `pos-connection-390.png`. Impeccable detector sin hallazgos; revisión independiente **ship**, sin correcciones materiales. Documenter confirma extensión del sistema existente, sin cambios de tokens ni DESIGN.md; capturas de fixture sin chrome completo de la aplicación.

## Garantías y límites

- Atomicidad, firma, cifrado, cola, auditoría, ACK y observabilidad siguen en los casos de uso existentes. No se crea ni traslada automáticamente una venta al cambiar de modo; la pantalla no escribe movimientos ni nuevas operaciones comerciales por sí misma.
- Idempotencia: el corte no destruye la referencia online; reintento idéntico probado. El aviso advierte que una venta incierta no se recree offline. No bloquea por sí mismo que una persona la cargue manualmente como otra venta.
- La señal usada es `navigator.onLine` y sus eventos. Si el equipo conserva red pero el API no responde, sigue apareciendo el error de transporte existente; no se agrega sondeo de disponibilidad.
- El carrito online y la clave incierta se preservan en memoria mientras se conserve esta pantalla; no se promete persistencia online tras reload, cierre, cambio de sucursal o navegación. Los pendientes offline conservan su persistencia cifrada previa.
- Abrir o recargar la aplicación estando totalmente offline continúa usando el shell informativo existente. Para pasar al POS local durante el corte hay que haber abierto esta pantalla con conexión y tener el equipo preparado. Las pruebas usan un perfil Chromium aislado; no acceden a los pendientes reales del usuario.
- Reversión: retirar la integración y la superficie nueva. No hay datos ni esquema que revertir; conservar la cola existente.
