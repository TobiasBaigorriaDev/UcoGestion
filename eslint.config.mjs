import { createEslintConfig } from './packages/config/eslint.config.mjs';

export default [
  ...createEslintConfig(),
  {
    // Backend modules collaborate only through each module's public index.ts.
    files: ['apps/api/src/modules/**/*.ts', 'src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '^\\.\\./[a-z-]+/(?!index\\.js$).+',
          message: 'Importá otro módulo solo mediante su index.ts público.',
        }],
      }],
    },
  },
];
