import { defineConfig } from 'vitest/config';
import { createVitestConfig } from '../../vitest.config.mts';

const sharedConfig = createVitestConfig(['test/**/*.test.ts']);

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    hookTimeout: 120_000,
    pool: 'forks',
    singleFork: true,
    testTimeout: 120_000,
  },
});
