import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/data/**',
      '**/coverage/**',
      '**/.tsbuildinfo',
      '**/*.cjs',
      'apps/docs-site/.astro/**',
      'apps/docs-site/src/content/docs/**',
      // Built studio UI. The bundle is committed because the Python package
      // must ship its front end; source tooling has no business linting it
      // (a single minified file once produced 156 of 157 lint errors).
      'studio/framescout_studio/web/assets/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Studio UI (Preact + hooks): enforce `react-hooks/exhaustive-deps` to
    // catch forgotten dependencies in useEffect.
    files: ['studio/web-src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Build scripts + Astro config run in Node, so `process` etc. are globals.
    files: ['**/*.mjs', '**/scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
