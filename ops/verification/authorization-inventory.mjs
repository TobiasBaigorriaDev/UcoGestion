import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const portable = file => relative(root, file).replaceAll('\\', '/');
const hash = text => createHash('sha256').update(text).digest('hex');
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = resolve(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  }).sort();
}
function parse(file) {
  const text = readFileSync(file, 'utf8');
  return { text, ast: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true) };
}
function visit(node, action) {
  action(node);
  ts.forEachChild(node, child => visit(child, action));
}
function decorators(node) {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
}
function decorator(node, name) {
  return decorators(node).map(value => value.expression).find(value =>
    ts.isCallExpression(value) && value.expression.getText() === name);
}
function literal(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : '';
}
function imports(ast, file) {
  const result = new Map();
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    if (!node.moduleSpecifier.text.startsWith('.')) continue;
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const path = resolve(dirname(file), node.moduleSpecifier.text.replace(/\.js$/, '.ts'));
    for (const entry of bindings.elements) result.set(entry.name.text, path);
  }
  return result;
}
const testFiles = files(resolve(root, 'apps/api/test')).filter(file => /\.(?:test|e2e)\.ts$/.test(file));
const tests = testFiles.map(file => {
  const { text, ast } = parse(file), titles = [], assertions = [], literalPaths = [];
  visit(ast, node => {
    // Data-driven HTTP matrices declare paths separately from the request call.
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'path' && ts.isStringLiteral(node.initializer)) {
      const path = node.initializer.text.split('?')[0];
      literalPaths.push(path.startsWith('/api/v1/') ? path : `/api/v1/${path}`);
    }
    if (!ts.isCallExpression(node)) return;
    if (ts.isPropertyAccessExpression(node.expression) && ['get', 'post', 'put', 'patch', 'delete'].includes(node.expression.name.text)
      && ts.isStringLiteral(node.arguments[0] ?? ast) && node.arguments[0].text.startsWith('/api/v1/')) {
      literalPaths.push(node.arguments[0].text.split('?')[0]);
    }
    const call = node.expression.getText(ast);
    if (/^(?:it|test)(?:\.each\([\s\S]*\))?$/.test(call) && ts.isStringLiteralLike(node.arguments[0] ?? ast)) {
      titles.push({ title: node.arguments[0].text, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 });
    }
    if (ts.isPropertyAccessExpression(node.expression) && /^to[A-Z]/.test(node.expression.name.text)) {
      assertions.push(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1);
    }
  });
  return { file: portable(file), sha256: hash(text), imports: [...imports(ast, file).values()], titles,
    literalPaths: [...new Set(literalPaths)], assertionLines: [...new Set(assertions)] };
});
const routes = [];
for (const file of files(resolve(root, 'apps/api/src')).filter(file => file.endsWith('.controller.ts'))) {
  const { text, ast } = parse(file), imported = imports(ast, file);
  for (const node of ast.statements.filter(ts.isClassDeclaration)) {
    const prefix = literal(decorator(node, 'Controller')?.arguments[0]);
    if (!decorator(node, 'Controller')) continue;
    const constructor = node.members.find(ts.isConstructorDeclaration);
    const dependencies = new Map((constructor?.parameters ?? []).map(parameter =>
      [parameter.name.getText(ast), imported.get(parameter.type?.getText(ast))]));
    for (const method of node.members.filter(ts.isMethodDeclaration)) {
      const verb = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options'].find(name => decorator(method, name));
      if (!verb) continue;
      const calls = [];
      visit(method, value => {
        if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)) return;
        const receiver = value.expression.expression;
        if (!ts.isPropertyAccessExpression(receiver) || receiver.expression.kind !== ts.SyntaxKind.ThisKeyword) return;
        const service = dependencies.get(receiver.name.text);
        if (service) calls.push({ file: portable(service), method: value.expression.name.text });
      });
      const sources = [...new Set(calls.map(call => resolve(root, call.file)))];
      const path = '/api/v1/' + [prefix, literal(decorator(method, verb).arguments[0])].filter(Boolean).join('/');
      const candidates = tests.filter(test => test.literalPaths.includes(path) || test.imports.some(path => path === file || sources.includes(path)));
      routes.push({ verb: verb.toUpperCase(), path,
        controller: portable(file), handler: method.name.getText(ast), line: ast.getLineAndCharacterOfPosition(method.getStart(ast)).line + 1,
        sha256: hash(text), calls, candidateTests: candidates.map(test => test.file),
        authorizationStatus: 'PENDING_ASSERTION_REVIEW', scopeStatus: 'PENDING_ASSERTION_REVIEW' });
    }
  }
}
const relationships = [];
for (const file of files(resolve(root, 'apps/api/src/database/migrations')).filter(file => file.endsWith('.sql'))) {
  const text = readFileSync(file, 'utf8');
  const pattern = /FOREIGN\s+KEY\s*\([^;]*?REFERENCES\s+[\s\S]*?(?=;|,\s*\n|\n\s*\);)/gi;
  for (const match of text.matchAll(pattern)) relationships.push({ file: portable(file),
    line: text.slice(0, match.index).split('\n').length, declaration: match[0].replace(/\s+/g, ' ').trim(),
    status: 'MIGRATION_DECLARATION_NOT_EFFECTIVE_SCHEMA_PROOF' });
}
const output = resolve(root, 'specs/001-mvp-gestion-comercial-saas');
const report = { date: new Date().toISOString(), method: 'AST inventory. Imports and literal HTTP paths identify candidates only; assertion review and execution are required. Migration declarations are historical and require effective-schema verification.', routes, relationships,
  tests: tests.map(({ imports: ignored, ...test }) => test) };
writeFileSync(resolve(output, 'authorization-inventory.json'), JSON.stringify(report, null, 2) + '\n');
const rows = routes.map(route => `| ${route.verb} ${route.path} | ${route.controller}:${route.line} | ${route.calls.map(call => `${call.file} → ${call.method}`).join('<br>') || 'Inspeccionar guard/controlador'} | ${route.candidateTests.join('<br>') || 'Sin candidato por import directo'} | Pendiente de revisión de aserciones/rol/scope |`);
writeFileSync(resolve(output, 'authorization-inventory.md'), [
  '# Inventario de autorización — CHECK-01', '',
  `Generado: ${report.date}. ${routes.length} rutas HTTP y ${relationships.length} declaraciones históricas de FK.`, '',
  'Esta extracción identifica rutas y servicios reales. Los tests candidatos se vinculan por imports o paths literales de HTTP/matrices; no prueba que ejerciten el verbo de esa ruta ni que sus aserciones cubran permisos. El JSON conserva títulos, líneas de aserción y hashes para revisar cada caso. No declara cobertura ni completa CHECK-01.', '',
  'Por cada fila, verificar roles positivos/negativos, scope de sucursal, IDs ajenos, actor inactivo, operaciones sobre sucursal inactiva, errores y auditoría aplicable. Incorporar también los puertos públicos sin controlador y comprobar el esquema PostgreSQL efectivo: una declaración histórica puede haber cambiado en migraciones posteriores.', '',
  '| Ruta | Controlador | Servicio/método | Tests candidatos | Estado |', '| --- | --- | --- | --- | --- |', ...rows, '',
  'Regenerar desde la raíz: `node ops/verification/authorization-inventory.mjs`.', '',
].join('\n'));
process.stdout.write(`${routes.length} routes; ${relationships.length} historical FK declarations. No coverage inferred.\n`);
