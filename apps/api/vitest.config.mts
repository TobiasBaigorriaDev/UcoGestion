import { defineConfig } from 'vitest/config';
import { createVitestConfig } from '../../vitest.config.mts';

const sharedConfig = createVitestConfig(['test/**/*.test.ts']);

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    hookTimeout: 120_000,
    pool: 'forks',
    maxForks: 2,
    minForks: 1,
    testTimeout: 120_000,
  },
});
