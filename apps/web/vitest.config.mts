import react from '@vitejs/plugin-react';
import { defineConfig, mergeConfig } from 'vitest/config';

import { createVitestConfig } from '../../vitest.config.mts';

export default mergeConfig(
  createVitestConfig(['test/**/*.test.{ts,tsx}']),
  defineConfig({
    plugins: [react()],
    test: {
      environment: 'jsdom',
      // Bound JSDOM and Argon2 concurrency to keep the root CI gate within its
      // resource budget while API PostgreSQL integration tests run alongside it.
      maxWorkers: 2,
    },
  }),
);
