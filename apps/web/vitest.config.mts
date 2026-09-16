import react from '@vitejs/plugin-react';
import { defineConfig, mergeConfig } from 'vitest/config';

import { createVitestConfig } from '../../vitest.config.mts';

export default mergeConfig(
  createVitestConfig(['test/**/*.test.{ts,tsx}']),
  defineConfig({
    plugins: [react()],
    test: {
      environment: 'jsdom',
    },
  }),
);
