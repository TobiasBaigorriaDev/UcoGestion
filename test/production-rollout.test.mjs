import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

// Docker is an external port here. No images are pulled and no DB is migrated.
// Exercising the real entrypoint proves invalid input cannot reach that port.
function attempt(origin) {
  return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "function docker { throw 'DOCKER_BOUNDARY_REACHED' }; & $env:UCO_TEST_ROLLOUT -PublicOrigin $env:UCO_TEST_ORIGIN"], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true,
    env: { ...process.env, UCO_TEST_ROLLOUT: resolve('infra/deploy/rollout.ps1'),
      UCO_TEST_ORIGIN: origin,
      API_IMAGE: `registry.example/api@sha256:${'a'.repeat(64)}`,
      WEB_IMAGE: `registry.example/web@sha256:${'b'.repeat(64)}`,
      WORKER_IMAGE: `registry.example/worker@sha256:${'c'.repeat(64)}` },
  });
}

for (const origin of ['http://gestion.example.com', 'not-an-origin',
  'https://gestion.example.com/api', 'https://gestion.example.com?token=private',
  'https://gestion.example.com#fragment', 'https://user:password@gestion.example.com',
  'https://localhost', 'https://127.0.0.1', 'https://[::1]']) {
  test(`rollout rejects invalid public origin before pull/migration: ${origin.replace('user:password', 'redacted')}`, () => {
    const result = attempt(origin);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    const diagnostic = result.stdout + result.stderr;
    assert.doesNotMatch(diagnostic, /DOCKER_BOUNDARY_REACHED/);
    assert.match(diagnostic, /PublicOrigin must be a public HTTPS origin/);
    assert.doesNotMatch(diagnostic, /user:password|token=private/);
  });
}

test('a public HTTPS origin passes validation and reaches the external Docker port', () => {
  const result = attempt('https://gestion.example.com/');
  assert.equal(result.error, undefined);
  assert.match(result.stdout + result.stderr, /DOCKER_BOUNDARY_REACHED/);
});
