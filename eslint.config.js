export default [
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**', 'dist/**', 'coverage/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
    },
  },
];
