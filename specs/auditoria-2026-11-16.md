# Auditoría del estado del proyecto — 2026-11-16

Auditoría previa a retomar el desarrollo con Claude Code. No se modificó código; solo se agregó este documento.

## 1. Dónde quedó el proyecto

- **Spec 001 (MVP)**: 339 tareas cerradas. Las pendientes son de verificación y cierre, no de funcionalidad base:
  - T224 / T227: PWA standalone e iconos, y matriz real de navegadores (Chrome/Edge/Firefox/Safari reales).
  - T236 (puerta final + `sdd-check`), T236K2/K3/K4/K8 (matrices de autorización exhaustivas: roles, scopes, desactivación, IDs cruzados).
  - D03-T05 (IDs de venta en escenarios offline) y D05-T01..T03 (código corto de 12 caracteres para la venta).
  - T236AL (repetir el gate completo) y T236AM (origen web e identidad de release en el build; falta el gate de navegador).
- **Spec 002 (cuentas corrientes)**: implementada, con `check-report.md` que da **SPEC CUMPLIDA** (26 RF). **Está todo sin commitear.**
- **Producción** (`production-readiness.md`): P04–P12 pendientes. No hay proveedor, dominio, servidor ni backup externo elegido.

## 2. Resultados verificados hoy

| Check | Resultado |
|---|---|
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| API (Vitest + Testcontainers/PostgreSQL) | 127 archivos / **698 tests PASS** (19 min) |
| Web | 91 archivos / 301 PASS |
| Shared / UI | 30 / 8 PASS |
| Tests Node raíz | 6 PASS, **10 FAIL**: `spawnSync pwsh ENOENT`. Falta PowerShell 7 en esta PC; no es un error del código |
| CI nightly (GitHub) | **FAIL todos los días**: "Branch stock alert missing from products". La corrección del fixture `ui-critical.mjs` está en los cambios sin commitear |
| CI backup diario | Queda en cola ~24 h y se cancela: espera un runner `self-hosted, operations-backup` que no existe |

El fallo "Worker exited unexpectedly" registrado el 2026-10-13 no se reprodujo: la suite completa de la API pasó entera.

## 3. Arquitectura: qué está bien

- Es un monolito modular NestJS + Next.js con pnpm/Turborepo, como pide el plan. No hay Server Actions y el Service Worker excluye `/api/` del caché.
- El dinero usa `numeric(20,2)` y `decimal.js` con strings. `Number(...)` solo aparece en conteos, fechas y versiones, nunca en importes.
- La tenancy usa RLS por `app.organization_id`, FKs compuestas, contexto con `set_config(..., true)` por transacción y un rol `uco_app` sin ownership.
- Ledgers append-only con triggers de inmutabilidad. La proyección de la cuenta corriente es un trigger `SECURITY DEFINER` con `search_path` fijo, `FOR UPDATE` y validación de contexto, organización, usuario y moneda.
- Las migraciones 0113/0114 son aditivas. Tienen CHECKs, `UNIQUE (kind, sale_id)` y `UNIQUE (kind, original_entry_id)`, que impiden compensar dos veces.

## 4. Hallazgos

### Críticos (bloquean seguir trabajando con seguridad)

1. **Trabajo sin commitear**: 62 archivos modificados y unos 30 nuevos, incluida la funcionalidad completa de spec 002 y las migraciones 0113/0114. Están en una carpeta de OneDrive y no hay respaldo en git. Commitear en bloques lógicos.
2. **El CI nightly está rojo hace más de 3 semanas** y oculta cualquier regresión nueva. Se corrige al commitear el fixture y verificarlo.

No encontré errores críticos de seguridad, aislamiento tenant ni cálculo monetario en lo revisado.

### Importantes

3. **Imports internos entre módulos**, prohibidos por AGENTS.md. Por ejemplo, `auth` importa `users/*-invitation-acceptance.service.js` y `users` importa `auth/password.js`, lo que forma una dependencia circular `auth ↔ users`. También `platform-admin`/`organizations → auth/*`, `catalog`/`organizations → offline-sync/resource-safety.service.js`, `cash ↔ offline-sync` y `expenses → catalog/*`. Solución: exponer `index.ts` públicos y mover las primitivas compartidas (password, session cookie, `PublicRoute`) a `core/`.
4. **`new CustomerAccountService()` dentro de `SalesPersistence` y `SalesOperationsService`**, en lugar de inyectarlo por DI. Funciona porque solo usa el cliente transaccional, pero esquiva NestJS y dificulta los tests.
5. **Las tasks de autorización (T236K2/K3/K4/K8) siguen abiertas.** Son el control más sensible de un SaaS multi-tenant. Deberían cerrarse antes de producción.
6. **Hay documentos con datos viejos.** `production-readiness.md` sigue describiendo el fallo de forks del 13-10 como vigente.

### Menores

7. `output/` acumula unos 60 logs sin trackear. Conviene ignorarlos en `.gitignore` o moverlos a un directorio de evidencia versionado.
8. Advertencias LF→CRLF en casi todos los archivos. Recomiendo un `.gitattributes` con `* text=auto eol=lf`.
9. `tests/production-rollout.test.mjs` exige `pwsh`. Instalar PowerShell 7 en local, o hacer que el test indique claramente que falta ese prerrequisito.
10. Hay código muy comprimido, con líneas de 200+ caracteres, en `customer-account.service.ts`, `sales-persistence.ts` y la UI offline. Es legible, pero cuesta revisarlo.

## 5. Plan sugerido para terminar

1. **Asegurar el estado**: commitear spec 002 y los cambios de UI/fixtures en commits separados. Push y CI verde, nightly incluido.
2. **Cerrar la deuda de verificación del MVP**: T236K2/K3/K4/K8, D05 (código corto), D03-T05, T236AM y luego T236AL.
3. **Refactor de límites de módulos** (hallazgos 3 y 4), con todos los tests en verde.
4. **Compatibilidad real** T224/T227. Safari real requiere un dispositivo Apple.
5. **Infraestructura** P04–P12: elegir proveedor gratuito, dominio, HTTPS, S3, email, backup externo y monitoreo. Luego T236 y el `sdd-check` final.

## 6. Seguimiento (mismo día)

Ejecutado en la rama `release/pre-production`. Detalle en [pre-production-closure-2026-11-16-evidence.md](001-mvp-gestion-comercial-saas/pre-production-closure-2026-11-16-evidence.md).

- Hallazgos 1 y 2 resueltos: el trabajo quedó commiteado y el CI y el nightly pasan en verde. La causa raíz del CI rojo era un problema de `turbo.json`.
- Hallazgo 3 resuelto: hay una regla ESLint para los límites entre módulos (de 23 violaciones a 0) y no quedan ciclos `auth ↔ users` ni `cash ↔ offline-sync`.
- Hallazgo 4 reclasificado: sigue la convención del módulo para puertos transaccionales.
- Hallazgo 5 avanzado: matriz default deny de todas las rutas e invariantes del esquema efectivo. Queda pendiente la matriz rol × comando de T236K2–K4.
- Hallazgo 6 resuelto: `production-readiness.md` está actualizado.
- Hallazgo 9 aclarado: los tests de rollout requieren PowerShell 7 (`pwsh`) en la máquina local.
- Nuevo: se corrigió el foco de teclado invisible en los filtros de fecha de los historiales (accesibilidad).

## 7. Estado al 2026-11-18

- **Todo en `main`**: preparación para producción (PR #1) y rediseño D08 fases 1–6 (PR #2, #3 y #7; las #4–#6 entraron con la #7). CI de `main` en verde, incluida la suite de navegador contra la API real.
- **Rediseño D08**: menú agrupado, Mostrador, Turno de caja guiado, historiales en lista, confirmaciones en el lugar, errores claros, idioma del negocio y pulido de todas las pantallas (D08-T01–T18).
- **Corregido al fusionar**: escenarios de navegador de la API desactualizados respecto del rediseño y contraste insuficiente de los productos en el mostrador sin conexión.
- **Mensajes de la API** en idioma del negocio («Solo el dueño o un administrador…»), con una prueba que impide volver a mostrar códigos de rol.

### Lo que falta para declarar LISTO PARA PRODUCCIÓN

| Ítem | Qué falta | Quién |
| --- | --- | --- |
| T236K2–K4 | Matriz rol × comando con payload válido (la matriz de rutas ya cubre sesión, tenant y membresía inválidos). | Desarrollo: tarea propia. |
| T224 / T227 | Instalación PWA y pruebas en Chrome/Edge con marca, Firefox y Safari reales. Safari requiere un dispositivo Apple. | Usuario con los dispositivos. |
| P04–P12, T236AL | Proveedor, dominio, HTTPS, S3, correo, backup externo y monitoreo reales. | Decisión y cuentas del usuario. |
| T236 | Puerta final `sdd-check` una vez cerrados los ítems anteriores. | Desarrollo, al final. |

**Notas de entorno local (Windows + OneDrive):** Vite no resuelve imports desde `apps/web` dentro de OneDrive y Git a veces no puede cambiar de rama por el bloqueo de la carpeta `apps`. Las pruebas de navegador de la API corren bien en una copia fuera de OneDrive (`git worktree add`). En CI (Linux) nada de esto ocurre.
