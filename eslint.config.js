export default [
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**', 'dist/**', 'coverage/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {        // ambiente Node
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      // o Express identifica o middleware de erro pela aridade de 4
      // argumentos, então `next` precisa existir mesmo sem ser usado
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
