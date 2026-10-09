import { expect, it } from 'vitest';
import { workerIsReady } from '../src/core/observability/worker-health.js';
it('T235 reports worker readiness only after a recent successful dispatch cycle', () => {
  expect(workerIsReady(0,1000)).toBe(false);
  expect(workerIsReady(1000,60999)).toBe(true);
  expect(workerIsReady(1000,61000)).toBe(false);
});
