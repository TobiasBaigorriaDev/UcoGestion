import { defineConfig } from 'vitest/config';

export const createVitestConfig = (include: string[]) =>
  defineConfig({
    test: {
      environment: 'node',
      include,
      exclude: ['**/dist/**', '**/node_modules/**'],
      clearMocks: true,
      mockReset: true,
      restoreMocks: true,
    },
  });

export default createVitestConfig([
  'apps/*/test/**/*.test.{ts,tsx}',
  'packages/*/src/**/*.test.{ts,tsx}',
]);
