import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readScenarioResult } from '../ops/browser/run.mjs';

test('a CLI tool error or incomplete scenario cannot produce green browser evidence', () => {
  const response = value => JSON.stringify({ result: JSON.stringify(value) });
  assert.throws(() => readScenarioResult('{"isError":true,"error":"Timeout"}'), /Timeout/);
  assert.throws(() => readScenarioResult(response({ passed: false })));
  assert.throws(() => readScenarioResult(response({})));
  assert.throws(() => readScenarioResult(response({ results: [{ passed: true }, { passed: false }] })));
  assert.deepEqual(readScenarioResult(response({ passed: true })), { passed: true });
});

test('CI runs the critical browser gate and nightly expands all three engines', () => {
  const ci = readFileSync('.github/workflows/ci.yaml', 'utf8');
  assert.match(ci, /pnpm run test:e2e:critical/);
  const nightly = readFileSync('.github/workflows/browser-nightly.yaml', 'utf8');
  assert.match(nightly, /schedule:/);
  assert.match(nightly, /browser: \[chromium, firefox, webkit\]/);
  assert.match(nightly, /pnpm run test:e2e:nightly/);
  assert.match(nightly, /if: always\(\)/);
});
