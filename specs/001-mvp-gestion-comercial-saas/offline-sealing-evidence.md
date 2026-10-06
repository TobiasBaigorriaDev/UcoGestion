# Evidencia del bloque T189A–T191

Este bloque implementa las primitivas criptográficas y la confirmación local. No habilita todavía ventas offline: bootstrap, grants, políticas comerciales, ingestión, ACK y limpieza tienen tareas propias pendientes.

| Tarea | Implementación | Evidencia |
| --- | --- | --- |
| T189A | `apps/api/src/modules/offline-sync/sync-envelope-decryptor.ts` | `sync-envelope-keys.test.ts`: RSA-3072/OAEP-SHA256, publicación ECDSA firmada, rotación, restauración, claves débiles, clave ausente y retención histórica |
| T190 | `apps/web/src/offline/offline-record-cipher.ts` | `offline-record-cipher.test.ts`: AES-256-GCM, IV aleatorio de 96 bits, AAD por schema/tenant/dispositivo/identidad/tipo/id, alteración y negativas de contexto/clave |
| T190A | `apps/web/src/offline/sync-envelope.ts` | `offline-envelope.test.ts`: CEK independiente, wrap RSA, routing duplicado y autenticado, firmas interior/exterior, exclusión de credenciales e interoperabilidad con el port servidor restaurado |
| T190B | `apps/web/src/offline/offline-lease.ts` | `offline-lease.test.ts`: conexiones independientes, exclusión mutua, recuperación tras vencimiento, fence monotónico y liberación obsoleta inocua |
| T191 | `apps/web/src/offline/offline-sealer.ts` | `offline-sealer.test.ts`: cadena SHA-256 y firma ECDSA del hash, secuencia de sesión cifrada, commit dual y head atómicos, fallo de escritura, expiración antes/durante commit, logout e identidad distinta |

## Decisiones locales

- La custodia recibe un inventario de claves privadas desde el gestor de secretos; no genera claves privadas efímeras al arrancar. El snapshot de backup es material secreto y debe respaldarse cifrado fuera del proceso. Rotación/restauración se preparan con `rotate`/`restore`; el integrador debe persistir el snapshot en custodia antes de publicar el bootstrap nuevo. El proveedor concreto sigue diferido por el plan.
- Se bloquea el retiro de **todas** las claves provisionadas: no se infiere ausencia de sobres a partir de tiempo transcurrido, ACK conocidos, revocación o dispositivo irrecuperable. Esta política conservadora cubre cualquier exposición D01 sin introducir una liberación no demostrada. `restore` sobre un inventario existente rechaza omisiones y sustituciones de claves históricas.
- La publicación versionada firma sus bytes exactos con ECDSA P-256/SHA-256 y firma IEEE-P1363 en base64. La PWA verifica con una clave pública de confianza y key ID fijados por el integrador; nunca confía en una clave de firma incluida por el emisor de la publicación.
- El routing exterior contiene únicamente versión, key ID, UUID aleatorio, certificado opaco, IV, CEK envuelta, ciphertext, hash y firma. Tenant, actor, sesión, grant y contexto comercial permanecen dentro del cifrado. La firma interior autentica el hash SHA-256 del JSON canónico; la firma exterior autentica el routing y ciphertext completos.
- `meta`, ya creado por T188, guarda el fence y head de dispositivo sin actor ni sesión. Los contadores de sesión permanecen en registros cifrados por identidad. No cambia el schema IndexedDB ni se necesita migración PostgreSQL.
- La preparación criptográfica ocurre fuera de la transacción IndexedDB. El commit vuelve a comprobar fence/head/vencimiento y la identidad desbloqueada, y escribe registro de operación, sobre opaco, contador de sesión y head en una sola transacción. Un fallo revierte todos esos efectos; el lease se libera o vence sin consumir secuencia. El commit exitoso libera el lease dentro de esa misma transacción.

## Verificación reproducible

Comandos desde la raíz:

```powershell
pnpm --filter @uconext/api test -- test/sync-envelope-keys.test.ts test/device-certificate.test.ts
pnpm --filter @uconext/web test
pnpm typecheck --filter=@uconext/web --filter=@uconext/api
pnpm lint --filter=@uconext/web --filter=@uconext/api
```

La suite web completa pasó con 116 pruebas en 46 archivos; después se agregó y verificó una prueba adicional de interoperabilidad servidor/PWA (7 pruebas verdes entre envelopes y sellado). API: 4 pruebas verdes en 2 archivos. Typecheck y lint de ambos paquetes pasan.

Harness de navegador: IndexedDB, persistencia de CryptoKeys no exportables, Argon2id y Web Crypto reales, sin `fake-indexeddb`. En una terminal iniciar Vite y, en otra, ejecutar el CLI:

```powershell
pnpm --filter @uconext/web exec vite ../.. --host 127.0.0.1 --port 4179 --strictPort
npx --yes --package @playwright/cli playwright-cli -s=offline-sealing open http://127.0.0.1:4179/apps/web/test/browser/offline-sealing.html --browser chrome
npx --yes --package @playwright/cli playwright-cli -s=offline-sealing run-code --filename apps/web/test/browser/offline-sealing.mjs
npx --yes --package @playwright/cli playwright-cli -s=offline-sealing close
```

Chrome 154 sobre Windows: creación sin red, rollback de escritura, logout, retorno de red, reload, cambio de identidad, dos pestañas, cierre de pestaña y fence obsoleto. El escenario exige conservar los bytes originales y terminar con secuencia 3 y exactamente tres sobres pendientes. La prueba de competencia usa un lease de 30 segundos para distinguir competencia simultánea de una recuperación legítima por vencimiento bajo carga.

## Límites y reversión

La importación comercial será quien valide grant, vigencia, permisos, branch scope y revocaciones históricas, compare routing interno/externo y persista auditoría/idempotencia dentro de PostgreSQL. Este bloque no contiene efectos de negocio servidor ni respuestas HTTP; los logs y métricas existentes no se modifican ni reciben payloads, claves o PIN. No corresponde afirmar integración PostgreSQL, verificación de ACK o matriz completa de navegadores con estos tests. La actualización PWA y las migraciones de cola quedan en T191A/T228; el service worker no se modifica aquí.

Las unidades reversibles son: port servidor y su test; cifrado por identidad/utilidades y tests; sobre híbrido y tests; lease más tipado del store `meta`; sellador y tests/harness. Retirar una unidad exige retirar sus consumidores posteriores del bloque. No eliminar los cambios previos de T185/T188/T189 ni datos locales persistidos para revertir código.
