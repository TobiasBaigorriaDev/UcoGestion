import { defineConfig, mergeConfig } from 'vitest/config';

import { createVitestConfig } from '../../vitest.config.mts';

export default mergeConfig(
  createVitestConfig(['src/**/*.test.{ts,tsx}']),
  defineConfig({ test: { environment: 'jsdom' } }),
);
