import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import { builtinModules } from 'node:module';

const browserBoundary =
  '(^|/)(backend|gateway)(/|$)|^@openclaw/|^node:|^@messenger/contracts(?:/|$)|(^|/)packages/contracts/';
const importBoundaryPlugin = {
  rules: {
    'no-server-dynamic-import': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        return {
          ImportExpression(node) {
            const value = node.source.value;
            if (
              typeof value === 'string' &&
              (new RegExp(browserBoundary).test(value) ||
                builtinModules.includes(value))
            )
              context.report({
                node,
                message:
                  'Browser dynamic imports cannot load server implementations or runtime contracts.',
              });
          },
        };
      },
    },
  },
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.cloudflare/**',
      '**/.context/**',
      '.agents/**',
      '.claude/**',
      '.gstack/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
    },
  },
  {
    files: ['apps/frontend/src/**/*.{ts,tsx}'],
    plugins: { 'import-boundary': importBoundaryPlugin },
    rules: {
      'import-boundary/no-server-dynamic-import': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...builtinModules.map((name) => ({
              name,
              message: 'Node built-ins stay server-side.',
            })),
            {
              name: '@messenger/contracts',
              allowTypeImports: true,
              message:
                'Browser contracts are type-only; backend implementations and secrets stay server-side.',
            },
          ],
          patterns: [
            {
              regex: '(^|/)(backend|gateway)(/|$)|^@openclaw/|^node:',
              message:
                'Browser code cannot import server implementations or the Gateway SDK.',
            },
            {
              group: ['@messenger/contracts/*', '**/packages/contracts/**'],
              message:
                'Import shared browser contracts only through the type-only package entry point.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/contracts/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex:
                '(^|/)(apps|backend|frontend|gateway)(/|$)|^@openclaw/|^node:',
              message:
                'Shared contracts must not depend on application implementations or server SDKs.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: globals.node },
  },
);
