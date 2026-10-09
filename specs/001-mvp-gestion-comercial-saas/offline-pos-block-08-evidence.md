# Offline POS — segundo grupo: T214F, T214, T215, T216, T216A

T214F agrega eventos append-only de revisión. OWNER/ADMIN con alcance puede revisar una diferencia; el responsable del cierre solo puede autorrevisar con justificación y SELF_REVIEW si no hay otro revisor activo con alcance. La revisión conserva importes, cierre y movimientos. Una corrección real continúa mediante ingreso/retiro en una sesión abierta (T122/T123). El endpoint `/cash-sessions/review-difference` revalida autorización e idempotencia y confirma evento/auditoría juntos.

T214 expone `/cash-sessions/reconcile`. OWNER/ADMIN concilia bajo locks y checkpoint firmado/verificable, con contado no negativo y motivo. Conserva CONFLICTED durante la preparación y confirma directamente CLOSED_CONFLICT_RESOLVED, snapshot, diferencia y auditoría; la sesión previa no se fusiona ni modifica.

T215 prueba PostgreSQL real: begin-close versus ingreso manual, begin-close versus venta offline legítima, recuperación mediante replay después de perder respuesta, aborto y rechazo de formularios obsoletos, conflicto y rechazo de ventas nuevas en CLOSING. Si gana una venta, el checkpoint queda obsoleto; si gana begin-close, la ingestión se revierte completamente y el sobre puede reintentarse después de abortar. El test no usa mocks de repositorios.

T216 prepara cierre excepcional desde OPEN/CLOSING/CONFLICTED para dispositivo UNRECOVERABLE, OWNER/ADMIN dentro de scope, confirmación explícita y motivo. T216A prepara un snapshot congelado con efectivo conocido consolidado, contado/diferencia opcionales, dispositivo/contacto, operaciones recibidas, completeness UNKNOWN y marcador inicial de late data. No aplica todavía el cierre: su persistencia/transición corresponden a T217. Conserva las exposiciones D01 y el bloqueo permanente de moneda cuando la declaración tiene posible historia desconocida.

## Evidencia

- RED T214F: servicio de revisión ausente; GREEN: revisión ADMIN, negativos tenant/EMPLOYEE, denegación de autorrevisión con alternativa, autorrevisión justificada sin alternativa y preservación de snapshot.
- RED T214: método reconcile ausente; GREEN: finalización separada, rechazo CASHIER, motivo obligatorio, replay y conservación de la sesión previa.
- T215 agrega regresiones sobre garantías ya implementadas; no se creó un RED artificial.
- RED T216/T216A: preparación y método snapshot ausentes; GREEN: restricciones de política, datos conocidos, no transición durante preparación y D01 con exposiciones reales.
- Migración 0101 incorpora eventos inmutables de revisión con FK compuesta, RLS y permisos SELECT/INSERT. El bloqueo de revisión usa la sesión, sin conceder UPDATE sobre el ledger de revisiones.

Gate final:

- `pnpm --filter @uconext/api test test/cash-foundation.integration.test.ts test/historical-ingestion.integration.test.ts test/cash-http.e2e.test.ts`: **28 pruebas / 3 archivos verdes**, PostgreSQL 16 real y migraciones desde cero.
- `pnpm lint --filter=@uconext/api`: **verde**.
- `pnpm typecheck --filter=@uconext/api`: **verde**.
- `git diff --check`: **sin errores**, solo avisos de normalización LF/CRLF.

El harness Chromium del primer grupo sigue aplicando a la congelación local; este grupo no introduce UI. Firefox/WebKit y sdd-check global permanecen fuera de este gate.

## Rollback

Retirar el servicio/ruta/proveedor de revisión y la migración 0101 antes de aplicarla; si ya hay eventos, preservarlos y migrar hacia adelante. Retirar reconcile y su ruta sin alterar cierres históricos. La preparación excepcional es una unidad independiente y no produce efectos comerciales. Las pruebas de concurrencia pertenecen a estas conductas y no sustituyen pruebas anteriores. T217–T218C forman el tercer grupo solicitado.
