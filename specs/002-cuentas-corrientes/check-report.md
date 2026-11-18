# SDD check — cuentas corrientes

Fecha: 2026-10-13. Revisión específica de spec 002, plan aprobado y constitución 1.1.0; no certifica nuevamente todos los RF del MVP. Las aserciones se inspeccionaron, no se infirió cobertura por nombres. [Evidencia, archivos y comandos](evidence.md).

## Pruebas de referencia

`customer-accounts.integration.test.ts` ejecuta PostgreSQL real y rol runtime sin ownership/BYPASSRLS; sus casos se referencian por el comienzo de su nombre:

- A: starts at zero, versions limits…: saldo/tope cero, versión, límites negativos, roles, RLS y mutación cross-tenant.
- B: cash collection is atomic and idempotent…: cobro parcial, replay/conflicto, efectivo/transferencia, auditoría, sobrecobro/cero.
- C: accepts the existing debit/credit…: cliente inactivo, deuda persistente, cobros por tarjetas, compra rechazada y eliminación protegida.
- D: rolls back account, cash, idempotency…: fallo real de auditoría, rollback total y reintento con misma clave.
- E: serializes simultaneous collections…: dos sesiones en sucursales distintas, sobrecobro concurrente, tope bajo deuda y medio deshabilitado.
- F: reverses a collection once…: compensación única, motivo, permisos, otra sucursal, saldo compartido/historial autorizado y ledger inmutable.
- G: refuses a cash reversal without enough cash…: retiro append-only y rechazo sin saldo/caja/compensación parcial.
- H: cancels partial credit…: venta 10 con efectivo 4/deuda 6; compensación deuda y reintegro exactamente 4.
- I: confirms partial and full credit sales…: cliente identificado, snapshots pago/deuda, replay, stock y rechazo de pago parcial sin fiado explícito.
- J: serializes credit sales from two branches…: solamente una venta de 10 confirma bajo tope global 10 y no quedan efectos de la perdedora.
- K: rolls back stock failures and compensates cancellation…: rollback, anulación rechazada tras cobros, reversión previa, compensación y ningún reintegro ficticio.
- L: exposes real HTTP contracts…: Supertest, schema estricto, CSRF, If-Match, replay, comprobante HTML, cursor y reversión.

## Cobertura funcional

| RF | Tests y aserciones exactas | Estado |
|---|---|---|
| 01 | C lectura cliente con balance/creditLimit; navegador customer-accounts.mjs espera Deuda: 6,00 ARS en listado; panel muestra deuda | Cubierto |
| 02 | A balance/limit/available; F saldo global 50 con movimientos solo de sucursal autorizada; panel resumen | Cubierto |
| 03 | A cliente nuevo sin cuenta; customer-account-migration.integration.test.ts aplica 0113 sobre 0112, conserva cliente y defaults cero | Cubierto |
| 04 | A versión 1→2, VERSION_CONFLICT, negativo rechazado y CASHIER denegado; L If-Match/replay; panel límite versionado | Cubierto |
| 05 | E límite 29 rechazado ante deuda 30; panel validación antes de enviar | Cubierto |
| 06 | I falta de customerId rechazada; C inactivo denegado; account-checkout.test.tsx cliente requerido | Cubierto |
| 07 | I venta 10/pago 4/cargo 6 y venta totalmente fiada; sale-account.test.ts ejemplos y fast-check con oráculo bigint | Cubierto |
| 08 | J dos sucursales bajo límite compartido; navegador tope 7 bloquea fiado de 10 | Cubierto |
| 09 | I stock 5→4; H efectivo vuelve al importe previo después de reintegrar 4; navegador variación neta de caja 4 | Cubierto |
| 10 | I/L snapshots y HTML; receipt-renderer.test.ts verifica pago 4 y cargo 6 en HTML y texto PDF decodificado | Cubierto |
| 11 | B/C/K cobros parciales/completos y medios; E medio deshabilitado; F alcance; cash-foundation.integration.test.ts y sales-quote.integration.test.ts garantías de sesión abierta del puerto usado | Cubierto |
| 12 | B cero/negativo/sobrecobro; panel sobrecobro no envía | Cubierto |
| 13 | B saldo 60→30, caja suma solo 20 CASH; transferencia 10 no altera caja | Cubierto |
| 14 | F reversa única, inmutabilidad y replay; L HTTP; navegador cobro/reversa 6→4→6 | Cubierto |
| 15 | F otra sucursal denegada; G efectivo insuficiente con rollback; policy de sesión abierta real | Cubierto |
| 16 | H deuda 6→0 y reintegro exactamente 4; K venta totalmente fiada sin reintegros | Cubierto |
| 17 | K anulación rechazada tras cobro; ausencia de sale_cancellation; revierte cobro y luego anula | Cubierto |
| 18 | F movimientos autorizados exclusivamente y ledger protegido; L cursor de una entrada y página siguiente | Cubierto |
| 19 | B/F/I/L replay idéntico y conteos; navegador un único cobro pese a respuesta perdida | Cubierto |
| 20 | B payload de cobro distinto con misma clave rechaza; L cambio de límite con misma clave devuelve 409 | Cubierto |
| 21 | D falla auditoría después de ledger/caja; G falla reversa después de insertar compensación; K stock/anulación inválida sin efectos | Cubierto |
| 22 | E dos sesiones simultáneas contra deuda 30, un cobro 20 confirma; J dos cargos de 10, uno confirma | Cubierto |
| 23 | account-checkout.test.tsx conserva payload/key aunque se refresquen crédito y fingerprint tras respuesta perdida; panel recupera cobro total con deuda refrescada en cero; navegador reproduce venta confirmada con respuesta perdida, crédito actualizado y replay, además de rechazo offline/cobro único | Cubierto |
| 24 | C conserva deuda 20 de cliente INACTIVE, cobra tarjetas y rechaza cargo | Cubierto |
| 25 | C CUSTOMER_DELETE_BLOCKED_BY_HISTORY y eliminación permitida solo para cuenta sin movimientos; F ledger inmutable | Cubierto |
| 26 | A EMPLOYEE lectura/cobro denegados, otra organización sin cuenta/mutación; F scope entre sucursales | Cubierto |

## Principios constitucionales aplicables

| Principio | Verificación |
|---|---|
| Servidor autoritativo | Cumplido: regla monetaria y tope repetidos bajo locks en PostgreSQL; UI anticipa sin autorizar |
| Tenant por capas | Cumplido: contexto transaccional, RLS, FKs compuestas y autorizaciones reales A/F/migración |
| Consistencia y transacciones | Cumplido: saldo/caja/stock/history/audit/idempotencia atómicos; D/G/H/J/K |
| Historial inmutable | Cumplido: append-only y compensaciones enlazadas; F/H/K; snapshots no se recalculan |
| Exactitud monetaria | Cumplido: numeric(20,2), strings, helpers decimales compartidos; fast-check bigint, sin number en cálculos |
| Monolito y APIs explícitas | Cumplido: puertos públicos customers/cash, mutaciones NestJS /api/v1; sin servicios ni dependencias nuevas |
| Idempotencia/concurrencia | Cumplido: registros existentes, hash canónico, autorización en replay, locks y tres reintentos acotados |
| Seguridad online/errores | Cumplido: auth/CSRF/origen existentes, DTO estrictos, problem+json y trazabilidad; L |
| Offline/PWA | Cumplido: crédito online-only; contratos/sobres locales intactos; escenario completo verifica venta offline y entrega existentes |
| UX/accesibilidad | Cumplido: teclado/labels/foco, RHF/Zod y Query; axe en 1280/390 y revisión visual independiente ship |
| Migraciones/recuperación | Cumplido: vacía/0112 en PG real; migración versionada aditiva local; sin schema push ni reconstrucción de datos |
| Observabilidad/secretos | Cumplido: middleware y auditoría existentes, sin nuevos logs de payloads ni secretos |

## Ejecuciones

Cuenta/migración/comprobantes: 17 PASS. Cuenta con guards finales: 12 PASS. Web completa: 90 archivos/293 PASS; regresiones de UI tras los últimos ajustes: 3 archivos/8 PASS. Shared: 11 archivos/30 PASS. UI: 3 archivos/8 PASS. Browser real final: 3 PASS incluyendo regresión online/offline, sin filtros (customer-accounts-browser-verified.log). Lint/typecheck/build raíz PASS.

La primera ejecución ampliada de API terminó con 624 PASS, un snapshot desactualizado y dos cierres de workers. Se actualizó el contrato revisado y se ejecutaron los tres archivos afectados sin filtros: 16 PASS. La ejecución completa final verifica 126 archivos/632 casos PASS, success=true, salida cero y ningún fallo o pendiente; se conserva también el log original. El navegador final pasó después de corregir una carrera de sincronización del escenario de respuesta perdida, documentada en evidence.md.

Veredicto: SPEC CUMPLIDA. Los 26 RF de esta ampliación tienen cobertura verificada y los gates requeridos pasan. No quedan tareas, pruebas fallidas o pendientes de este bloque autorizado.
