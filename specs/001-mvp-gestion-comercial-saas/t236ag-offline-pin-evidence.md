# T236AG — Cambiar PIN offline

Autorizado explícitamente por el usuario el 2026-10-13; RF-344–RF-345 incorporados al spec cerrado y plan. Solo cambia la credencial local por usuario/equipo, no la contraseña de acceso ni la vigencia del grant. No permite recuperar un PIN olvidado ni omitir el bloqueo de intentos.

## Implementación y garantías

- `apps/web/src/offline/offline-keys.ts`: `changePin` valida el actual mediante `unlock`, conservando backoff/bloqueo. Reenvuelve la DEK original con salt nuevo y Argon2id existente, AES-KW y AES-GCM del dispositivo con IV nuevo. La DEK activa permanece no exportable; una CryptoKey temporal permite `wrapKey`, sin exportar bytes. No reescribe ciphertext, operaciones, grants, dispositivos ni ACKs.
- El único reemplazo de envoltura ocurre en transacción IndexedDB, con comparación de salt/version/ciphertext original, revalidación de identidad/revocación y generación de bloqueo. Dos reemplazos simultáneos no pueden sobrescribirse silenciosamente. Error de escritura conserva la credencial previa; fallo deja la identidad bloqueada en memoria.
- `offline-setup.ts` y `offline-workspace.tsx` conectan la acción a la identidad activa. `offline-settings.tsx` y el nuevo `offline-pin-change.tsx` muestran formulario desplegable con PIN actual/nuevo/confirmación, cancelación, resumen enfocable enlazado y errores junto a campos. Un fallo de verificación oculta el detalle privado; éxito conserva el estado y elimina inputs. Se permiten cambios con grant vencido porque no conceden permiso para crear operaciones nuevas.
- Ningún PIN se envía por HTTP, logs, auditoría o outbox; la operación es local, no una mutación comercial. No cambia API, PostgreSQL, contratos públicos ni dependencias.

## Verificación

- RED motor: dos regresiones fallaron porque `changePin` no existía. RED UI: no había botón Cambiar PIN offline. Después GREEN.
- `pnpm --filter @uconext/web test -- offline-keys.test.ts offline-settings.test.tsx offline-setup.test.ts offline-identity.test.ts offline-revocation.test.ts opaque-delivery.test.ts`: 26 PASS. Cifrado/DEK original, nuevo PIN tras reapertura, viejo rechazado, otro usuario intacto, cola exacta, fallo de escritura con rollback, bloqueo durante inicio, revocación conocida, incorrecto y lockout, cambio concurrente, mensajes/confirmación y entrega idempotente.
- Tras añadir resumen accesible: `pnpm --filter @uconext/web test -- offline-settings.test.tsx`: 5 PASS, incluido foco del resumen y enlace al campo incorrecto.
- Fixture Vite en 4179, `pnpm exec playwright-cli -s=pin-change run-code --filename apps/web/test/browser/offline-settings.mjs`: PASS Chromium, 13 escenarios. Cambio sin red, bytes pendientes idénticos, recarga sin reseed (`?resume`), PIN anterior rechazado, nuevo desbloquea mismos datos, fallo recuperable de entrega y ACK firmado. También 1440/390px, teclado, foco y axe con contraste en formulario con error. Capturas en `output/playwright/offline-settings-1440.png` y `offline-settings-390.png`.
- `pnpm lint`, `pnpm typecheck`: PASS raíz. `pnpm build --filter=@uconext/web`: PASS. Se repiten tras la corrección del resumen de validación.
- Detector Impeccable sobre los dos archivos de interfaz: `[]`. Revisión visual independiente solicitó resumen de validación; se implementó y recapturó. Veredicto final **ship**, único hallazgo puntuado resuelto; revisión limitada a código y capturas desktop/móvil. Documenter independiente confirmó extensión del sistema existente; sin cambios de DESIGN/tokens/assets.

El navegador de prueba usa almacenamiento/Web Crypto reales y un servidor de ACKs de fixture. No se cambió el PIN del perfil del usuario ni se borraron sus datos; debe elegir e ingresar el nuevo PIN en el formulario. No se afirma certificación de todos los navegadores/versiones RF-289 ni ejecución de sdd-check global. No hay mutaciones PostgreSQL en esta unidad que requieran una prueba de integración adicional.

## Uso y reversión

POS sin conexión → desbloquear con el PIN actual → Cambiar PIN offline → completar tres campos → Guardar nuevo PIN. Funciona sin conexión y conserva pendientes sin exigir sincronización previa.

Reversión de código: quitar formulario/acción y pruebas/docs de T236AG, sin tocar el arreglo previo T236AF ni cambios del usuario. El formato de la envoltura sigue siendo versión 1, compatible con el código anterior; si ya se cambió el PIN, seguirá siendo necesario usar el nuevo. No restaurar envolturas viejas ni eliminar IndexedDB para revertir interfaz.
