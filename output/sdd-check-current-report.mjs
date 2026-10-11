import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const folder = 'specs/001-mvp-gestion-comercial-saas/';
const read = path => readFileSync(resolve(root, path), 'utf8');
const hash = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const original = JSON.parse(read(folder + 'sdd-check-t236-results.json'));
const delta = read(folder + 't236-followup-matrix.md');
const requirements = structuredClone(original.requirements);
for (const line of delta.split(/\r?\n/)) {
  if (!line.startsWith('| RF-')) continue;
  const cells = line.split(' | ');
  const id = cells[0].slice(2);
  const row = requirements.find(row => row.id === id);
  if (!row) throw new Error('Unknown requirement: ' + id);
  row.status = cells[1];
  row.observation = cells.slice(3).join(' | ').replace(/ \|$/, '');
  row.observation = row.observation.replace(/\]\((t236[^)]+)\)/g, (_, path) => `](<${resolve(root, folder + path).replaceAll('\\', '/')}>)`);
  row.gap = row.status === 'CUBIERTO' ? '' : row.observation;
  const paths = [...cells[2].matchAll(/\]\(([^)]+)\)/g)].map(match => match[1].replace(/^\.\.\/\.\.\//, ''))
    .filter(path => path.startsWith('apps/') || path.startsWith('packages/'));
  row.tests = [...new Set([...row.tests, ...paths])];
}
const category = requirements.find(row => row.id === 'RF-269');
category.status = 'CUBIERTO';
category.observation = 'T236J: ventas y compras capturan categoría asignada o ausencia explícita; cambio posterior del maestro, replay y rollback preservan el snapshot. Ingestión v2 usa configuración firmada retenida; v1 conserva bytes y UNKNOWN, sin inventar categoría histórica. Migración 0109 prueba esquema anterior, inmutabilidad, CHECK y FK tenant.';
category.gap = '';
category.tests = [...new Set([...category.tests, ...['sales-quote.integration.test.ts', 'purchases.integration.test.ts', 'historical-ingestion.integration.test.ts', 'document-category-migration.integration.test.ts', 'historical-sale-snapshot.test.ts'].map(name => 'apps/api/test/' + name), 'apps/web/test/offline-sale.test.ts', 'apps/web/test/offline-sale-confirmation.test.ts'])];
for (const number of [152,153,154]) {
  const row = requirements.find(row => row.n === number);
  row.status = 'PENDIENTE';
  row.observation = 'Ejecución actual: 129 estados en viewports 390/768/1024/1440 por Chromium, con teclado, foco, axe y contraste. Firefox/WebKit tienen evidencia Linux previa, pero hoy fallaron al iniciar en Windows. Falta acreditar la matriz completa de navegadores reales y versiones soportadas.';
  row.gap = row.observation;
}

const testLog = read('output/sdd-check-current-test.log');
const passed = new Set();
for (const match of testLog.matchAll(/@uconext\/(api|web|shared|ui):test:\s+✓ ([^\r\n]+?) \(\d+ tests?\)/g)) {
  passed.add((['api', 'web'].includes(match[1]) ? 'apps/' : 'packages/') + match[1] + '/' + match[2]);
}
const checks = [
  ['pnpm lint', 'lint', /Tasks:\s+4 successful, 4 total/],
  ['pnpm typecheck', 'typecheck', /Tasks:\s+4 successful, 4 total/],
  ['pnpm build', 'build', /Tasks:\s+3 successful, 3 total/],
  ['pnpm test', 'test', /(?:#|ℹ) fail 0/],
  ['pnpm test:e2e:critical', 'e2e-critical', /chromium: offline-update passed/],
  ['pnpm test:e2e:catalog', 'e2e-catalog', /Tests\s+1 passed \(1\)/],
  ['pnpm --filter @uconext/api exec vitest run --config vitest.authorization-browser.config.mts (aislado)', 'e2e-authorization-isolated', /Tests\s+2 passed \(2\)/],
  ['pnpm test:e2e:nightly (BROWSER=chromium por defecto)', 'nightly-chromium', /chromium: receipt-safety passed/],
  ['BROWSER=firefox pnpm test:e2e:nightly', 'nightly-firefox', /firefox: receipt-safety passed/],
  ['BROWSER=webkit pnpm test:e2e:nightly', 'nightly-webkit', /webkit: receipt-safety passed/],
].map(([command, suffix, success]) => {
  const log = 'output/sdd-check-current-' + suffix + '.log';
  const text = existsSync(log) ? read(log) : '';
  return { command, log, status: success.test(text) ? 'PASS' : text.includes('spawn UNKNOWN') ? 'BLOQUEADO: spawn UNKNOWN (Windows)' : text.includes('TargetClosedError') ? 'BLOQUEADO: WebKit cerró al iniciar (Windows)' : 'NO ACREDITADO', sha256: text ? hash(log) : null };
});
const catalogPassed = checks.find(check => check.log.endsWith('e2e-catalog.log')).status === 'PASS';
const authorizationPassed = checks.find(check => check.log.endsWith('authorization-isolated.log')).status === 'PASS';
if (catalogPassed) passed.add('apps/api/test/catalog-category-browser.e2e.ts');
if (authorizationPassed) passed.add('apps/api/test/organization-switch-browser.e2e.ts');
// A real Chromium execution proves the scenario's functional assertion. The
// complete browser/version matrix remains explicitly pending in RF-152–154/289.
const browserGreen = checks.find(check => check.log.endsWith('nightly-chromium.log')).status === 'PASS';
const expectedGaps = new Set([12,21,23,29,82,124,133,140,147,152,153,154,172,274,285,289,307,308]);
for (const row of requirements) {
  row.execution = row.tests.map(file => ({ file, passed: passed.has(file) || (file.startsWith('apps/web/test/browser/') && browserGreen) }));
  row.previousStatus = original.requirements.find(previous => previous.id === row.id).status;
  row.sourceSha256 = Object.fromEntries([...new Set([...row.tests, ...row.sources])].filter(existsSync).map(path => [path, hash(path)]));
  row.assertionLines = Object.fromEntries(row.tests.filter(existsSync).map(path => [path, read(path).split(/\r?\n/).flatMap((line, index) => /expect\(|assert\.|\.expect\(/.test(line) ? [index + 1] : [])]));
  if (row.status === 'CUBIERTO') {
    const missing = row.execution.filter(execution => !execution.passed);
    if (missing.length) {
      row.status = 'PENDIENTE';
      row.gap = 'Ejecución actual completa no acreditada de los candidatos requeridos: ' + missing.map(execution => execution.file).join(', ');
    }
  }
  row.coverageGapKnown = expectedGaps.has(row.n);
}
if (requirements.length !== 316 || new Set(requirements.map(row => row.id)).size !== 316) throw new Error('Incomplete RF matrix');
const counts = Object.fromEntries(['CUBIERTO', 'PENDIENTE', 'VIOLADO'].map(status => [status, requirements.filter(row => row.status === status).length]));
const openTasks = read(folder + 'tasks.md').split(/\r?\n/).filter(line => line.startsWith('- [ ] '));
const documents = ['spec.md', 'plan.md', 'tasks.md', 't236-followup-matrix.md', 't236j-category-snapshot-evidence.md', 't236k-authorization-evidence.md'].map(name => folder + name).concat(['constitution.md']);
const browserResults = JSON.parse(read('output/playwright/nightly-chromium/results.json'));
const browserMetadata = { browser: browserResults.browser, version: browserResults.results[0].version,
  os: browserResults.results[0].os, userAgent: browserResults.results[0].userAgent,
  scenarios: browserResults.results.length, passed: browserResults.results.every(result => result.passed),
  uiStates: browserResults.results.find(result => result.scenario === 'ui-critical').result.pages,
  source: 'output/playwright/nightly-chromium/results.json', sha256: hash('output/playwright/nightly-chromium/results.json') };
const suiteSummaries = [...testLog.matchAll(/@uconext\/(api|web|shared|ui):test:\s+Test Files\s+([^\r\n]+)[\s\S]*?@uconext\/\1:test:\s+Tests\s+([^\r\n]+)/g)]
  .map(match => ({ package: match[1], files: match[2].trim(), tests: match[3].trim() }));
const constitution = [
  ['§2.1 Servidor autoritativo', 'CUMPLIDO en casos probados; matriz integral pendiente', 'Cotización/precios calculados en backend, DTO manipulado rechazado sin efectos; RF-21/23 pendientes.', 'apps/api/test/sales-http.e2e.test.ts'],
  ['§2.2 Aislamiento por capas', 'PENDIENTE de acreditación exhaustiva', 'Runtime sin propiedad/BYPASSRLS, default deny y FKs negativas probados; RF-285 conserva relaciones/endpoints faltantes.', 'apps/api/test/t236k-authorization.integration.test.ts'],
  ['§2.3 Consistencia', 'CUMPLIDO en operaciones verificadas', 'Rollback real, stock concurrente, caja bloqueada y excepción offline explícita auditada.', 'apps/api/test/inventory-foundation.integration.test.ts'],
  ['§2.4 Historial inmutable', 'CUMPLIDO en operaciones verificadas', 'Triggers/privilegios rechazan mutaciones; compensaciones enlazadas y snapshots históricos.', 'apps/api/test/monetary-currency.integration.test.ts'],
  ['§2.5 Simplicidad evolutiva', 'CUMPLIDO', 'Monorepo y monolito NestJS; API y worker comparten código, sin servicios distribuidos añadidos.', 'apps/api/src/runtime-worker.ts'],
  ['§2.6 Contratos explícitos', 'CUMPLIDO en contratos verificados', 'Zod estricto, Problem Details/OpenAPI; D01/D02 y bootstrap v2 con lector v1 según plan §11.2.', 'packages/shared/src/offline-contracts.test.ts'],
  ['§2.7 Operabilidad', 'PENDIENTE de acreditación integral', 'Outbox y worker compilado, backup/restauración reales, OTLP/Prometheus; auditoría completa RF-140 pendiente.', 'apps/api/test/backup-restore.integration.test.ts'],
  ['§3 Stack/repositorio', 'CUMPLIDO en checks ejecutados', 'pnpm/workspaces/Turbo, exports/límites de imports con lint y TS estricto; lockfile y CI frozen.', 'package.json'],
  ['§4 Arquitectura', 'CUMPLIDO en rutas revisadas', 'Mutaciones REST NestJS, dominio/casos de uso y puertos públicos; reportes read-only bajo autorización.', 'apps/api/src/database/tenant-transaction.ts'],
  ['§5 Persistencia', 'CUMPLIDO en migraciones verificadas', 'PostgreSQL/Drizzle, UUID/timestamptz, CHECK, versiones, FKs históricas y migración 0109 desde anterior.', 'apps/api/test/document-category-migration.integration.test.ts'],
  ['§6 Tenancy/RLS', 'PENDIENTE de acreditación exhaustiva', 'PoolClient contextualizado por transacción, RLS default deny y credenciales plataforma separadas; completar RF-21/23/285.', 'apps/api/test/tenant-rls.integration.test.ts'],
  ['§7 Transacciones/concurrencia/idempotencia', 'CUMPLIDO en casos verificados', 'Locks de stock/caja, rollback de auditoría, adquisición concurrente/replay autorizado y clave-payload conflictivo.', 'apps/api/test/idempotency-concurrency.integration.test.ts'],
  ['§8 Dinero/cantidades/tiempo', 'CUMPLIDO en invariantes verificadas', 'decimal.js, strings, HALF_UP, escala previa a redondeo, propiedades con oráculo BigInt, ISO y UTC/zona local.', 'packages/shared/src/sale-arithmetic.test.ts'],
  ['§9 Ledgers/proyecciones', 'CUMPLIDO en casos verificados', 'Movimiento/proyección atómicos, append-only y divergencia detectada sin corrección silenciosa.', 'apps/api/test/inventory-foundation.integration.test.ts'],
  ['§10 API/contratos', 'PENDIENTE de acreditación integral', 'Validación estricta/allowlists y Problem Details pasan; mensajes seguros de todos los fallos RF-133 pendientes.', 'apps/api/test/problem-details.test.ts'],
  ['§11 Seguridad web', 'PENDIENTE de acreditación integral', 'Argon2id, sesiones hash, cookies __Host-, CSRF/origen, límites persistentes y proxy real; HTTPS de todos los flujos RF-12 pendiente.', 'apps/api/test/csrf.e2e.test.ts'],
  ['§12 PWA/offline', 'PENDIENTE de acreditación integral', 'Cifrado, firma, 72 h, cola/sobre atómicos, revocación, ACK, actualización y claves retenidas probados; RF-172/274/307 y compatibilidad pendientes.', 'apps/web/test/offline-sealer.test.ts'],
  ['§13 Frontend/diseño', 'PENDIENTE de acreditación integral', '129 estados/cuatro viewports, teclado, foco y axe automatizados; RF-152/153/154/289 no cierran matriz real/versiones.', 'apps/web/test/browser/ui-critical.mjs'],
  ['§14 Jobs/reportes/archivos', 'PENDIENTE de acreditación integral', 'Registry de producción para emails/expiración, lease/backoff/dead-letter, PDF pasivo y CSV seguro; equivalencia completa RF-147 pendiente.', 'apps/api/test/identity-worker.integration.test.ts'],
  ['§15 Auditoría/observabilidad', 'PENDIENTE de acreditación integral', 'Allowlist/append-only, rollback y correlación redactada pasan; matriz action→todos los campos RF-140 pendiente.', 'apps/api/test/audit-events.integration.test.ts'],
  ['§16 Migraciones/despliegue/recuperación', 'CUMPLIDO en verificación local', 'Migraciones reales, imágenes compiladas ejercitadas, pg_dump/restore autenticado, 35 días y límites RPO/RTO; no certifica IAM/volumen productivos.', 'apps/api/test/delivery-runtime.integration.test.ts'],
  ['§17 Pruebas/gate final', 'PENDIENTE', 'Checks registrados abajo; T224/T227/T236 abiertos y cobertura faltante. No habilita declarar spec cumplida.', '.github/workflows/ci.yaml'],
  ['§18 Cambios/excepciones', 'CUMPLIDO para esta auditoría', 'No se cambian implementación, tests, spec, plan ni tareas; contrato T236J autorizado y trazado en plan §11.2.', folder + 'plan.md'],
  ['§19 Decisiones diferidas', 'CUMPLIDO dentro del alcance', 'Puertos de email/archivos y OTLP reemplazables; proveedores productivos diferidos no se presentan como desplegados.', folder + 'plan.md'],
];
const report = { date: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), verdict: 'PENDIENTES', counts,
  method: 'Conciliación RF por RF de evidencia T236, follow-up, T236I/J/K, revisión de aserciones e implementación y reejecución actual. Las ejecuciones verdes son necesarias pero no sustituyen una aserción del comportamiento. No se certifica entorno productivo ni Safari real.',
  documents: Object.fromEntries(documents.map(path => [path, hash(path)])), checks, suiteSummaries, browserMetadata,
  initialAuthorizationAttempt: { status: 'FAIL: 1 failed / 1 passed', log: 'output/sdd-check-current-e2e-authorization.log', sha256: hash('output/sdd-check-current-e2e-authorization.log'),
    console: '.playwright-cli/console-2026-10-10T22-47-47-047Z.log', consoleSha256: hash('.playwright-cli/console-2026-10-10T22-47-47-047Z.log'),
    diagnosis: 'Vite devolvió 504 Outdated Optimize Dep antes del montaje. Dos fixtures compartieron caché; se repite aislado sin cambiar código ni tests.' },
  openTasks, constitution, requirements };
writeFileSync('output/sdd-check-2026-10-10.json', JSON.stringify(report, null, 2) + '\n');
const esc = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const link = path => `[${basename(path)}](<${resolve(root, path).replaceAll('\\', '/')}>)`;
let md = '# SDD Check — MVP UcoNext\n\nVeredicto: **PENDIENTES**. Corte: ' + report.date + '. Commit: `' + report.head + '`.\n\n';
md += `Matriz: **${counts.CUBIERTO} CUBIERTO, ${counts.PENDIENTE} PENDIENTE y ${counts.VIOLADO} VIOLADO**, sobre 316 RF.\n\n`;
md += report.method + '\n\nLos informes anteriores se conservan como cortes históricos. La fila antigua VIOLADO de RF-269 no describe la implementación T236J actual. V1 mantiene UNKNOWN por ausencia de evidencia histórica; v2 distingue NONE/ASSIGNED. No se reconstruye historia a partir del maestro actual.\n\n';
md += 'El escenario UI-critical usa respuestas de API simuladas para verificar presentación, teclado, foco y accesibilidad. No demuestra autorización ni atomicidad de negocio. RF-03/116 y categorías tienen gates separados contra NestJS y PostgreSQL reales; las garantías comerciales se verifican en integración/HTTP real.\n\n';
md += 'La ejecución actual ampliada acredita Chromium en Windows (17 escenarios). Firefox falló con spawn UNKNOWN y WebKit cerró al iniciar (exitCode=3236495362 / TargetClosedError), antes de ejecutar escenarios. Ubuntu disponible no tiene Node Linux en PATH. Sus resultados Linux anteriores son evidencia histórica, no se presentan como una ejecución actual. Las garantías funcionales concretas del navegador se acreditan por Chromium; la matriz completa permanece PENDIENTE en RF-152/153/154/289.\n\n';
md += `Versión observada: Chromium ${browserMetadata.version}, ${browserMetadata.os}; ${browserMetadata.scenarios} escenarios, ${browserMetadata.uiStates} estados UI. ${link(browserMetadata.source)}.\n\n`;
md += '## Checks actuales\n\n| Comando | Resultado | Log |\n| --- | --- | --- |\n';
for (const check of checks) md += `| \`${esc(check.command)}\` | ${check.status} | ${link(check.log)} |\n`;
md += '\n| Paquete | Archivos | Tests |\n| --- | --- | --- |\n';
for (const summary of suiteSummaries) md += `| ${summary.package} | ${summary.files} | ${summary.tests} |\n`;
md += '\nEl primer E2E de autorización tuvo 1 fallo/1 éxito: RF-03 expiró esperando el selector. El console log registra 504 Outdated Optimize Dep de Vite mientras corrían dos fixtures que compartían caché. Se conserva ' + link('output/sdd-check-current-e2e-authorization.log') + ' y la repetición aislada se informa por separado. Un timeout no prueba por sí solo un defecto funcional.\n\n';
md += '## Pendientes concretos\n\n| RF | Evidencia faltante |\n| --- | --- |\n';
for (const row of requirements.filter(row => row.status !== 'CUBIERTO')) md += `| ${row.id} | ${esc(row.gap)} |\n`;
md += '\nTareas abiertas del plan:\n\n' + openTasks.join('\n') + '\n\nNo se marcan como completadas. Para cerrar las brechas corresponde volver a sdd-build con tareas atómicas y TDD; una decisión de postergarlas conserva este veredicto PENDIENTES.\n\n';
md += '## Constitución\n\nCUMPLIDO se limita a evidencia observada; PENDIENTE señala una garantía integral no acreditada, sin inventar un incumplimiento reproducible.\n\n| Regla aplicable | Evaluación | Evidencia/alcance | Fuente |\n| --- | --- | --- | --- |\n';
for (const [rule, status, evidence, file] of constitution) md += `| ${rule} | ${status} | ${esc(evidence)} | ${link(file)} |\n`;
md += '\nBloques críticos: atomicidad e idempotencia verificadas con PostgreSQL real, fallos inducidos, concurrencia y replay; auditoría transaccional/append-only verificadas, pero RF-140 impide acreditar su matriz exhaustiva; observabilidad y redacción verificadas; contratos de error probados con RF-133 pendiente; reintentos/ACK/preservación probados con RF-274 pendiente de flujo integrado individual. Ninguno de estos resultados habilita cerrar T236 mientras subsistan las brechas.\n';
md += '\n## Matriz individual de los 316 RF\n\nCada fila conserva el requisito literal en el JSON, los candidatos examinados, líneas de aserción, hashes actuales y resultado de ejecución por archivo. Una suite verde con cobertura parcial conserva PENDIENTE.\n\n| RF | Tests examinados | Estado | Aserción o límite |\n| --- | --- | --- | --- |\n';
for (const row of requirements) md += `| ${row.id} | ${row.tests.map(link).join(', ')} | ${row.status} | ${esc(row.status === 'CUBIERTO' ? row.observation : row.gap)} |\n`;
md += '\n## Integridad y límites\n\n' + link('output/sdd-check-2026-10-10.json') + ' contiene SHA-256 de documentos, fuentes y logs. Los controles locales no acreditan IAM, HTTPS ni capacidad/RPO/RTO de una instalación productiva concreta. WebKit no acredita Safari real y una versión por motor no cierra RF-289.\n\nNo se modificaron código, tests, migraciones, especificación, plan ni tareas durante sdd-check. Solo se generaron logs/resultados de verificación y este informe.\n';
writeFileSync('output/sdd-check-2026-10-10.md', md);
console.log(JSON.stringify({ counts, checks: checks.map(({command,status}) => ({command,status})), openTasks: openTasks.length }));
