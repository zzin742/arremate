import react from 'eslint-plugin-react';

const globaisNode = {
  process: 'readonly', console: 'readonly', Buffer: 'readonly',
  URL: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
};

const globaisNavegador = {
  window: 'readonly', document: 'readonly', fetch: 'readonly',
  localStorage: 'readonly', console: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
};

export default [
  {
    // backend e scripts
    files: ['services/**/*.js', 'packages/**/*.js', '*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globaisNode },
    rules: {
      'no-undef': 'error',
      // o Express identifica middleware de erro pela aridade de 4 argumentos,
      // então `next` precisa existir mesmo sem ser usado
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // frontend
    files: ['web/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globaisNavegador,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // sem isto o eslint acha que componente usado só dentro do JSX
      // nunca foi usado
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
    },
  },
  { ignores: ['node_modules/**', '**/dist/**', 'coverage/**'] },
];
