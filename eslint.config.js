import tseslint from 'typescript-eslint';
export default tseslint.config(
  {ignores: ['node_modules/**', '_scratch/**']},
  ...tseslint.configs.recommended,
  {rules: {'@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}]}},
  {files: ['**/*.test.ts', '**/test-support.ts'], rules: {'@typescript-eslint/no-explicit-any': 'off'}},
);
