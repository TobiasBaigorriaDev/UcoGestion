# Preservación del sistema visual — caja T218C

La conciliación, el cierre por dispositivo irrecuperable y la revisión de datos tardíos extienden «El Mostrador Digital de la Cordillera» en modo Operate. Este pase registra el sistema observado en T218C, sin nueva identidad ni nuevos tokens. PRODUCT.md y DESIGN.md se conservan. `.impeccable/design.json` está ausente y no se crea: la frontera de escritura de este pase es este informe. No comprende tareas T219 ni posteriores.

## Fuentes y artefacto observado

Se consultaron los requisitos pertinentes del spec cerrado y del plan aprobado: conciliación separada, cierre excepcional, UNKNOWN permanente, snapshot original, incorporación tardía y revisión administrativa. Se leyeron PRODUCT.md, DESIGN.md, `.impeccable/review/cash-direction.md`, `packages/ui/src/tokens.css`, `apps/web/app/globals.css`, `apps/web/src/features/cash/cash-exceptional.tsx`, `cash-workspace.tsx`, el CSS incumbente `features/identity/management.module.css` y el guion `apps/web/test/browser/cash-exceptional.mjs`.

Se inspeccionaron las seis capturas `cash-reconciliation-1440.png`, `cash-reconciliation-390.png`, `cash-exceptional-1440.png`, `cash-exceptional-390.png`, `cash-late-1440.png` y `cash-late-390.png`. Son estados del fixture con componentes y estilos reales; no documentan la composición del AppShell completo.

## Sistema preservado

- **Paleta:** acciones y foco Bosque, texto blanco sobre botón primario, tinta oscura y gris secundario sobre fondo claro; Manzana no se amplía como ornamento.
- **Tipografía:** Plus Jakarta Sans y escala incumbente display/headline/body; los labels persisten, la información crítica usa texto y los importes muestran ARS en estas capturas.
- **Composición:** estado y contexto de sesión antes de cada operación; campos en dos columnas cuando caben y apilados a 390 px, confirmación explícita junto a la acción y ayudas junto al campo.
- **Material y formas:** panel sólido, radio de tarjeta y sombra ambient heredados; inputs de radio pequeño y botones de radio propio. No se añaden ilustraciones, adornos ni materiales nuevos.
- **Interacción y reglas:** Vibrant Action Rule preservada, controles de al menos 44 px de alto, foco visible, errores enlazados mediante ARIA, estados textuales y movimiento condicionado por la preferencia existente.

## Conducta operativa expresada por la interfaz

La sesión en conflicto explica que no admite cierre normal ni compensaciones automáticas. OWNER/ADMIN con alcance concilia desde el dispositivo asociado; la preparación congela la creación local, entrega pendientes y obtiene el esperado actualizado. El formulario presenta contado, motivo, diferencia observada y una confirmación de conservar sesiones, ventas y operaciones separadas. La captura muestra esperado 10.00 ARS, contado 11.00 ARS y diferencia 1.00 ARS.

El dispositivo irrecuperable bloquea el cierre normal. El cierre excepcional exige motivo y confirmación de incertidumbre permanente; el contado es opcional y vacío significa no registrado, nunca cero inventado. La captura mantiene ese campo vacío y explica que el cierre no libera restricciones históricas ni el bloqueo permanente de moneda. La autorización administrativa y la operación desde otro equipo se expresan mediante texto; la interfaz no convierte ese aviso en prueba de autorización backend.

La sesión final excepcional distingue completitud UNKNOWN permanente de revisión pendiente. Presenta dispositivo, motivo, contado y diferencia originales, último contacto y operaciones recibidas al cerrar. Las capturas separan explícitamente **esperado original 10.00 ARS** de **esperado actualizado 30.00 ARS**, conservan contado y diferencia no registrados y muestran restricciones históricas y bloqueo de moneda. El marcador tardío identifica cantidad, última secuencia y fecha; una nota y confirmación registran la revisión hasta el corte indicado. La revisión no modifica el snapshot ni convierte el cierre en normal; nuevas recuperaciones exigen una revisión nueva.

El workspace dirige conflicto y final excepcional a esta extensión, y dirige dispositivo irrecuperable solo mientras su sesión está OPEN o CLOSING. Los cierres normales anteriores conservan su snapshot en CashClosing aunque el dispositivo sea declarado irrecuperable después. Los finales vuelven a la vista de sesiones finalizadas; el resto recarga el estado del servidor. Los reintentos de comandos usan el mecanismo opaco incumbente de clave/hash. Estos comportamientos son particulares de caja, no nuevas reglas estéticas para otras superficies.

La corrección funcional posterior restringe ese dispatch: antes, todo dispositivo UNRECOVERABLE llegaba a CashExceptional y podía ocultar el snapshot de un cierre normal previo. Se cotejaron la condición actual y la regresión de `cash-workspace.test.tsx`, que mantiene visible la diferencia del cierre histórico. No cambian markup, textos, CSS ni tokens de los tres estados excepcionales capturados; sus seis PNG conservan el mismo alcance visual.

## Evidencia y límites de aceptación

Según los resultados comunicados por el agente principal, el gate API pasó **31 pruebas en cuatro archivos** con PostgreSQL real, Supertest y migraciones; el gate web pasó **31 pruebas en once archivos**, incluidas las tres pruebas T218C. Build raíz API/web pasó sus tres tareas Turbo, incluida shared, con la ruta cash-sessions presente; lint raíz, typecheck raíz y `git diff --check` pasaron. Estos resultados web y de checks raíz preceden a la corrección del dispatch y se conservan como evidencia histórica; API permanece sin cambios. El build conserva únicamente el warning heredado de middleware deprecated. Este pase documental no reejecuta dichas suites ni esos checks.

La regresión de workspace se confirmó RED antes de restringir el dispatch; después pasaron **nueve pruebas en tres archivos** de exceptional/closing/workspace. También pasaron **cuatro pruebas en dos archivos** de revocación/actualización del Service Worker, el navegador `offline-update` con perfil nuevo y `offline-sealing` para cierre de pestaña, reload y fencing. Son resultados comunicados separadamente por el agente principal, no pruebas añadidas al alcance de las capturas. El rerun final de lint, typecheck y build web terminó verde después de la corrección, conservando la ruta de sesiones y el warning heredado de middleware.

`cash-exceptional.mjs` pasó en Chromium: confirmación obligatoria, conciliación, prohibición de cierre normal para dispositivo irrecuperable, contado opcional sin cero, respuesta excepcional perdida y replay con la misma clave, snapshot original inmutable, corte de revisión, nueva recuperación con nueva revisión, UNKNOWN permanente, teclado, reload y pérdida/retorno de red. El guion ejecuta axe completo y control de ausencia de desborde en **tres estados, cada uno a 1440 y 390 px**, y genera los seis PNG inspeccionados.

El fixture sustituye HTTP como puerto externo y utiliza componentes/query/cliente/IndexedDB reales. Acredita interacción y composición de esta extensión; no acredita aislamiento, locks, atomicidad, auditoría transaccional ni idempotencia persistida del backend. Esas garantías requieren la evidencia PostgreSQL/Supertest separada. Tampoco acredita una prueba del AppShell completo ni de todos los navegadores.

El detector único sobre el target C devolvió `[]`, exit 0. La revisión completa independiente terminó con disposition `ship`, sin correcciones materiales pendientes dentro de los tres estados T218C inspeccionados: TYPE, MATERIAL y GROUND corresponden al sistema incumbente, las seis capturas responsive son válidas, el snapshot original se distingue del actualizado y la limitación del fixture HTTP queda explícita. La corrección posterior del dispatch no representa un nuevo whole-surface pass; conserva esa revisión en su alcance original y suma únicamente la regresión funcional indicada. La aceptación está circunscrita a esta extensión y a la evidencia indicada.

## Diferencias incumbentes no canonizadas

El CSS compartido conserva contenedor de 72rem, panel sólido sin blur ni borde glass, padding de botón `.65rem 1rem`, display con line-height 1.15 y labels de peso 650. DESIGN.md describe contenedor de 1280 px, tarjetas glass, padding de botón `14px 28px`, display con line-height 1.12 y label de peso 500. Estas diferencias preceden a T218C; no se reparan ni se convierten en nuevos tokens o reglas. La cifra de uso móvil de DESIGN.md no cuenta con evidencia en PRODUCT.md y no se usa como validación empírica.

El sidecar ausente y ese drift se registran como límites del sistema incumbente, no como defectos que T218C autorice a corregir. Se conserva la autoridad de PRODUCT.md y DESIGN.md y la frontera documental asignada.
