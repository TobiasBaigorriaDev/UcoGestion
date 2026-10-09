# Evidencia T224–T229 — 9 de octubre de 2026

Se verificó el bloque solicitado con `sdd-build`, preservando los cambios previos del repositorio. No se agregaron uploads, dependencias, migraciones ni funcionalidades. T225, T226, T228 y T229 están verificadas. T224 y T227 siguen pendientes porque RF-289 exige las dos últimas versiones estables de cuatro navegadores y este entorno no permite completar esa matriz.

## Estado y cobertura

| Tarea | Resultado | Evidencia y límite |
|---|---|---|
| T224 | Parcial | Instalación real en Chrome con ventana standalone, entrada `/workspace`, PNG decodificados 192/512 y SW con `no-cache`. Capability gate en Chrome, Edge y WebKit: funcionamiento nativo y degradación ante ausencia de SW, IndexedDB o Web Crypto, sin POST de autorización y con lectura online disponible. Falta completar RF-289. |
| T225 | Verificada | Playwright y axe completo, incluido contraste, a 390 y 1440 px. Recorrido de Tab, foco visible, labels y envío por Enter. La ejecución general cubrió 27 rutas y 75 estados: 74 pasaron y el estado de error de reportes detectó falta de h1. Tras la corrección, los cuatro estados de reportes pasaron. Suites específicas de cajas, cierre normal/excepcional, baja de sucursal y ajustes offline también pasaron. |
| T226 | Verificada | Dashboard, inventario, auditoría y reportes: 11 estados en Chrome. Tablas conservan semántica y cinco encabezados en el árbol accesible; filas móviles son cards, con labels y valores. Métricas y desgloses tienen valores textuales accesibles; alertas de stock no dependen del color. Capturas mobile/desktop revisadas. |
| T227 | Parcial | Chrome y Edge reales y WebKit automatizado ejecutados. Firefox y Chromium descargados no iniciaron; Safari real y versiones adicionales no disponibles. WebKit no acredita Safari. |
| T228 | Verificada | IndexedDB, AES y firmas reales: cierre/reapertura, logout, cambio de identidad, rechazo de descifrado ajeno, revocación entre pestañas, pérdida/retorno de red, reload, sync parcial, pérdida de ACK, ACK falsificado, actualización SW/migración y fencing de escritor tras cierre de pestaña. PostgreSQL real valida entrega histórica y autorización. |
| T229 | Verificada | HTML generado con texto adversarial no produce elementos activos ni ejecución en Chrome. PDFs parseados sin acciones, JavaScript, formularios, anotaciones o adjuntos; los destinos pasivos de PDF son válidos. HTTP verifica content type/disposition, tamaño exacto PDF, `nosniff`, CSV `no-store`, protección contra fórmulas, autenticación y aislamiento. Objetos temporales validan nombre, tamaño persistido, expiración, actor y tenant bajo RLS; URL S3 firma tipo y attachment. |

Las pruebas UI usan respuestas HTTP controladas para aislar representación y errores; no acreditan transacciones ni autorización backend. Esas garantías se verifican con Supertest y PostgreSQL 16 en Testcontainers. Las pruebas de entrega que simulan ACKs se complementan con los escenarios existentes de sellado criptográfico y backend histórico real. Los tamaños verificados son los bytes efectivamente generados y persistidos; no se inventó un límite funcional ni una vía de upload.

## Matriz ejecutada

Host: Windows 11 Home, 10.0.26200, build 26200. Herramienta: `@playwright/cli@0.1.22`.

| Navegador | Versión observada | Resultado |
|---|---|---|
| Chrome branded | 154.0.8037.98 | UI general, cards, cajas, offline, capability gate y recibo pasaron. Instalación standalone pasó en perfil persistente con ventana; aplicación de prueba desinstalada. |
| Edge branded | 154.0.4258.62 | Capability gate (4 casos) y UI representativa (14 estados: login, dashboard, inventario, auditoría, reportes) pasaron. |
| WebKit Playwright | 26.6 | Capability gate nativo (4 casos) pasó. UI representativa (14 estados) pasó con SW bloqueado en el contexto para permitir interception HTTP de fixtures; no acredita offline UI completo ni Safari real. |
| Chromium descargado | Chrome for Testing 155.0.8059.12 | Lanzamiento rechazado con `spawn UNKNOWN`; sin ejecución acreditada. |
| Firefox Playwright | 156.0, build 1553 | Validación reportó `lgpllibs.dll`; ejecución directa informó configuración side-by-side inválida. No se acreditó ejecución. |
| Firefox branded | No instalado | Pendiente. |
| Safari real | Sin macOS/iOS disponible | Pendiente. |
| Segunda versión estable de cada navegador | No disponible | Pendiente. |

Las versiones observadas no se presentan como certificación de las dos últimas estables. Para cerrar T224/T227 se necesita ejecutar los mismos escenarios en las versiones objetivo, incluyendo Safari real, registrar OS/versión y comprobar instalación/capacidades donde corresponda.

## Correcciones y TDD

1. Chrome rechazó instalación por no disponer de icono `purpose: any`. `pwa-manifest.test.ts` reprodujo RED. Se agregaron entradas `any` 192/512 conservando las maskable; GREEN y posterior instalación real standalone.
2. Playwright detectó ausencia de foco visible al recorrer partes del selector nativo de fecha. Se agregó `:focus-within` con outline a los inputs date de insights y el recorrido pasó.
3. Axe detectó ausencia de h1 cuando fallaba la configuración inicial de reportes. `workspace-errors.test.tsx` reprodujo RED; se preservó el título Reportes en esa rama de error y las pruebas pasaron.

T226, T228 y T229 verifican comportamiento existente sin crear RED artificial. La primera aserción PDF prohibía todo diccionario Names; se corrigió la prueba para distinguir destinos pasivos de árboles JavaScript/EmbeddedFiles. No fue una vulnerabilidad del renderer.

## Comandos y resultados

- `pnpm --filter @uconext/web test -- <29 archivos UI afectados> --maxWorkers=2`: 83 pruebas, 29 archivos, verdes.
- `pnpm --filter @uconext/web test -- test/pwa-manifest.test.ts test/offline-capability.test.ts test/workspace-errors.test.tsx test/dashboard-workspace.test.tsx test/inventory-stock.test.tsx test/reports-workspace.test.tsx test/audit-workspace.test.tsx --maxWorkers=2`: 13 pruebas, 7 archivos, verdes.
- Suite offline afectada (`offline-identity`, `identity-retirement`, `offline-revocation`, `offline-keys`, `opaque-delivery`, `offline-migration`, `service-worker-update`, `offline-expiry`, `offline-sealer`, `offline-lease`, `offline-pos`): 30 pruebas, 11 archivos, verdes.
- `pnpm --filter @uconext/api test -- test/historical-ingestion.integration.test.ts test/device-authorization-http.e2e.test.ts --maxWorkers=1`: 22 pruebas, 2 archivos, PostgreSQL real, verdes.
- `pnpm --filter @uconext/api test -- test/generated-files.test.ts test/sales-http.e2e.test.ts test/reports-http.e2e.test.ts test/temporary-objects.integration.test.ts test/s3-object-storage.test.ts --maxWorkers=1`: suites HTTP verdes; se corrigió la aserción Names descrita arriba. Reejecución final de `generated-files`, `temporary-objects` y `s3-object-storage`: 7 pruebas verdes. Cobertura final conjunta de cinco archivos: 12 pruebas verificadas.
- `pnpm --filter @uconext/web lint`, `pnpm --filter @uconext/web typecheck`, `pnpm --filter @uconext/api lint`, `pnpm --filter @uconext/api typecheck`: verdes.
- `pnpm --filter @uconext/web build`: verde después de las correcciones; aviso existente de deprecación de middleware Next.
- Scripts raíz `pnpm lint --filter=@uconext/web` y `pnpm typecheck --filter=@uconext/web`: Turbo falla con `spawn UNKNOWN` en este host. Los scripts equivalentes de los paquetes afectados se ejecutaron directamente y pasaron.
- `git diff --check`: sin errores; Git muestra avisos de conversión LF/CRLF.
- `impeccable detect apps/web/src/features/insights/insights.module.css`: salida limpia, código 0. Capturas de dashboard desktop y reportes mobile revisadas visualmente.

## Reproducción del navegador

Construir web con `NEXT_PUBLIC_WEB_ORIGIN=http://localhost:3001` y arrancar `pnpm --filter @uconext/web start --port 3001`. Arrancar el servidor de fixtures con `pnpm --filter @uconext/web exec vite ../.. --config test/browser/offline-update.vite.mjs --host 127.0.0.1 --port 4179`. La configuración local temporal usada para construir no se conserva en el repositorio.

Abrir un perfil de prueba con `npx --yes --package @playwright/cli@0.1.22 playwright-cli -s=verify open http://localhost:3001 --browser chrome`, y ejecutar `run-code --filename apps/web/test/browser/ui-critical.mjs` en esa sesión. Para cards, abrir `/workspace?verifyRoutes=/workspace,/workspace/inventory,/workspace/audit,/workspace/reports&verifyCards=1`. Para Edge usar `--browser msedge`; para UI WebKit usar `--browser webkit --config apps/web/test/browser/webkit-ui.config.json`. El gate nativo usa el contexto WebKit sin ese bloqueo.

Los demás escenarios están en `apps/web/test/browser/{pwa-capability,pwa-install,cash-operations,cash-closing,cash-exceptional,branch-deactivation,offline-settings,offline-resilience,opaque-delivery,offline-pos,offline-update,offline-sealing,receipt-safety}.mjs`. `pwa-install` requiere Chrome persistente y headed; `offline-update` requiere perfil nuevo, sin worker previo. Cada script navega a su fixture excepto `ui-critical`, que toma la selección opcional de la URL inicial.

## Archivos de este bloque

Producción: `apps/web/app/manifest.ts`, `apps/web/src/features/insights/insights.module.css`, rama de error Reportes en `apps/web/src/features/identity/workspace.tsx`.

Pruebas nuevas: `apps/web/test/pwa-manifest.test.ts`, `apps/web/test/workspace-errors.test.tsx`, fixtures `pwa-capability.{html,tsx,mjs}`, scripts `pwa-install.mjs`, `ui-critical.mjs`, `offline-resilience.mjs`, `receipt-safety.mjs`, configuraciones `chromium.config.json`, `webkit-ui.config.json` y `apps/api/test/generated-files.test.ts`.

Pruebas ampliadas: `opaque-delivery.{html,mjs}`, `opaque-delivery-server.mjs`, `offline-update.vite.mjs`, `apps/api/test/{sales-http.e2e,reports-http.e2e,temporary-objects.integration,s3-object-storage}.test.ts`. Documentación: este archivo y checkboxes del bloque en `tasks.md`. Los demás cambios presentes al comenzar pertenecen a trabajo previo.
