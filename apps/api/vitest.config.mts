import { defineConfig } from 'vitest/config';
import { createVitestConfig } from '../../vitest.config.mts';

const sharedConfig = createVitestConfig(['test/**/*.test.ts']);

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    hookTimeout: 120_000,
    pool: 'forks',
    // Each integration file starts its own PostgreSQL Testcontainer. Running
    // them serially prevents a child process from being terminated under the
    // combined container load while retaining the real-PostgreSQL coverage.
    maxForks: 1,
    minForks: 1,
    testTimeout: 120_000,
  },
});
