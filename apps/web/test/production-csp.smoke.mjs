/* global process, fetch */
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('production HTML gives framework scripts the request CSP nonce', async () => {
  const origin = process.env.UCONEXT_WEB_TEST_ORIGIN ?? 'http://localhost:3001';
  const response = await fetch(origin);
  assert.equal(response.status, 200);

  const policy = response.headers.get('content-security-policy') ?? '';
  const nonce = policy.match(/script-src[^;]*'nonce-([^']+)'/)?.[1];
  assert.ok(nonce, 'a request-specific script nonce is required');

  const html = await response.text();
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map(([tag]) => tag);
  assert.ok(scripts.length > 0, 'Next.js must emit hydration scripts');
  for (const script of scripts) {
    assert.ok(script.includes(`nonce="${nonce}"`), `script is missing the request nonce: ${script.slice(0, 120)}`);
  }
});
