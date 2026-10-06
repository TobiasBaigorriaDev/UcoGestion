# T191A — Migración y actualización sin pérdida de pendientes

La versión Dexie 3 valida formatos de registros AES-GCM, envelopes y claves envueltas dentro de la transacción de upgrade. No reescribe bytes ni IDs de claves históricas. Un formato incompatible aborta el upgrade completo, dejando la versión anterior disponible. Las versiones anteriores siguen declaradas; no existe downgrade ni borrado de stores.

`prepareOfflineUpdate` migra todas las bases del dispositivo sin desbloquear identidades, antes de registrar el worker. El worker verifica independientemente durante install que las bases ya estén migradas y que todos los sobres usen un formato soportado. Una instalación rechazada conserva el worker anterior y su caché. No se usa `skipWaiting`; las pestañas existentes conservan el ciclo normal del navegador. Falta de enumeración IndexedDB o formato desconocido bloquea conservadoramente la instalación. El provider emite `uco:offline-update-blocked` sin metadatos privados; la presentación del estado corresponde a T220A.

## Evidencia

- RED: las dos pruebas de migración fallaron inicialmente por versión 2 y aceptación del formato 99. La prueba de instalación falló por aceptar una base sin migrar.
- `pnpm --filter @uconext/web test`: **48 archivos, 121 pruebas verdes**.
- `pnpm typecheck --filter=@uconext/web`: verde.
- `pnpm lint --filter=@uconext/web`: verde.
- Chrome real / Windows, Playwright CLI: **passed=true** en bloqueo previo a migración, activación posterior, reload, preservación exacta de registros/sobres y rollback de formato desconocido. No se presenta como matriz completa de Safari/Firefox.

Reproducción desde la raíz, en dos terminales:

```powershell
pnpm --filter @uconext/web exec vite ../.. --config test/browser/offline-update.vite.mjs --host 127.0.0.1 --port 4179 --strictPort
npx --yes --package @playwright/cli playwright-cli -s=offline-update open http://127.0.0.1:4179/apps/web/test/browser/offline-update.html --browser chrome
npx --yes --package @playwright/cli playwright-cli -s=offline-update run-code --filename apps/web/test/browser/offline-update.mjs
npx --yes --package @playwright/cli playwright-cli -s=offline-update close
```

Usar un contexto nuevo de navegador para repetir el escenario de primera instalación. El middleware del harness sirve los archivos de producción sin alterarlos.

## Garantías y reversión

La atomicidad es la transacción IndexedDB de upgrade; idempotencia es abrir nuevamente una base ya migrada sin modificarla. Los tests comprueban la versión y bytes originales después del aborto. No hay efectos PostgreSQL, auditoría comercial, ACKs ni nuevos logs sensibles en esta tarea; la cadena, los sobres firmados y la evidencia existente permanecen intactos. La indisponibilidad de actualización se notifica con un evento genérico y permite reintentar tras resolver incompatibilidad.

Unidad de revisión/reversión: versión 3 en `offline-database.ts`, `prepare-offline-update.ts`, coordinación del provider y guard de instalación en `public/sw.js`, con sus tests y harness. Retirar código no autoriza eliminar bases persistidas ni deshacer upgrades; conservar siempre las declaraciones de versiones ya distribuidas. Los cambios anteriores T185–T191 permanecen fuera de esta unidad.
