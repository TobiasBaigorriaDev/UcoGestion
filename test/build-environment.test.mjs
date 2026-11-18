import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function webBuild(origin, buildId) {
  const stdout = execFileSync(process.execPath, ['node_modules/turbo/bin/turbo', 'run', 'build', '--dry=json'], {
    env: { ...process.env, NEXT_PUBLIC_WEB_ORIGIN: origin, UCONEXT_BUILD_ID: buildId },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const result = JSON.parse(stdout);
  const task = result.tasks.find(value => value.taskId === '@uconext/web#build');
  assert.ok(task, 'the actual pipeline must include the web build');
  return task;
}

test('the real Turbo build passes and hashes the origin and release ID', () => {
  const first = webBuild('https://first.example.test', 'release-one');
  const nextOrigin = webBuild('https://second.example.test', 'release-one');
  const nextRelease = webBuild('https://first.example.test', 'release-two');
  assert.notEqual(first.hash, nextOrigin.hash, 'changing the origin must invalidate the web cache');
  assert.notEqual(first.hash, nextRelease.hash, 'changing the release ID must invalidate the web cache');
  assert.ok(first.environmentVariables.specified.env.includes('NEXT_PUBLIC_WEB_ORIGIN'));
  assert.ok(first.environmentVariables.specified.env.includes('UCONEXT_BUILD_ID'));
  assert.ok(first.environmentVariables.configured.some(value => value.startsWith('NEXT_PUBLIC_WEB_ORIGIN=')));
  assert.ok(first.environmentVariables.configured.some(value => value.startsWith('UCONEXT_BUILD_ID=')));
});

test('the CI browser gate builds with its actual local origin', () => {
  const workflow = readFileSync('.github/workflows/ci.yaml', 'utf8');
  assert.match(workflow, /name: Run build\s+run: pnpm run build\s+env:\s+NEXT_PUBLIC_WEB_ORIGIN: http:\/\/localhost:3001/);
});
