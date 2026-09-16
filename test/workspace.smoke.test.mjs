import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('declares a pnpm and Turborepo workspace with the required root scripts', () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'),
  );
  const workspaceDefinition = readFileSync(
    resolve(repositoryRoot, 'pnpm-workspace.yaml'),
    'utf8',
  );
  const turboConfig = JSON.parse(
    readFileSync(resolve(repositoryRoot, 'turbo.json'), 'utf8'),
  );
  const gitignore = readFileSync(resolve(repositoryRoot, '.gitignore'), 'utf8');

  assert.match(packageJson.packageManager, /^pnpm@/);
  assert.equal(packageJson.private, true);
  assert.match(workspaceDefinition, /^packages:\s*$/m);
  assert.match(workspaceDefinition, /^\s*- ['"]apps\/\*['"]\s*$/m);
  assert.match(workspaceDefinition, /^\s*- ['"]packages\/\*['"]\s*$/m);
  assert.match(gitignore, /^node_modules\/?$/m);
  assert.match(gitignore, /^\.turbo\/?$/m);

  for (const script of ['lint', 'typecheck', 'test', 'build']) {
    assert.match(packageJson.scripts[script], /^turbo run /);
  }

  for (const task of ['lint', 'typecheck', 'test', 'build']) {
    assert.ok(turboConfig.tasks[task], `missing Turbo task: ${task}`);
  }

  for (const workspacePackage of [
    'apps/api/package.json',
    'apps/web/package.json',
    'packages/config/package.json',
    'packages/shared/package.json',
    'packages/ui/package.json',
  ]) {
    assert.ok(existsSync(resolve(repositoryRoot, workspacePackage)));
  }

  const ciWorkflowPath = resolve(repositoryRoot, '.github/workflows/ci.yaml');
  assert.ok(existsSync(ciWorkflowPath), 'missing .github/workflows/ci.yaml');

  const ciWorkflowContent = readFileSync(ciWorkflowPath, 'utf8');
  assert.match(ciWorkflowContent, /pnpm install --frozen-lockfile/);
  assert.match(ciWorkflowContent, /pnpm run lint/);
  assert.match(ciWorkflowContent, /pnpm run typecheck/);
  assert.match(ciWorkflowContent, /pnpm run test/);
  assert.match(ciWorkflowContent, /pnpm run build/);
  assert.match(ciWorkflowContent, /actions\/checkout@v4/);
  assert.match(ciWorkflowContent, /pnpm\/action-setup@v4/);
});
