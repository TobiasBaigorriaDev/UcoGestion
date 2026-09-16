import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export const createEslintConfig = () =>
  tseslint.config(
    {
      ignores: ['**/dist/**', '**/coverage/**', '**/.next/**'],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      files: ['**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-non-null-assertion': 'error',
      },
    },
  );
