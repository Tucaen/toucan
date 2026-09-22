import eslint from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['.agents/**', '.test-out/**', 'dist/**', 'dist-out/**', 'node_modules/**', 'out/**']
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx}']
  })),
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname
      },
      globals: globals.browser
    },
    plugins: {
      'react-hooks': reactHooks
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-implied-eval': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      /**
       * Off on purpose, not as a backlog item. This codebase passes methods as callbacks
       * constantly - `existsSync`, `terminal.write`, a store's own `list` handed to an IPC
       * registration - and every one of those is a free function or a method with no `this` to
       * lose. The rule cannot tell those from a real unbound `this`, and it reported 188 sites,
       * all of them correct code. `no-unsafe-*` and TypeScript's own `strictBindCallApply` cover
       * the cases that would actually break.
       */
      '@typescript-eslint/unbound-method': 'off',
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      'require-yield': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  {
    // Build and release scripts. They are plain Node ESM outside every tsconfig, so they get the
    // untyped core rules only - which is still the difference between linted and not linted at all.
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node
    }
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      // The DOM query helpers surface as `any` in this project's test graph, which is also why the
      // `no-unsafe-*` family below is off here. That makes "this assertion is unnecessary" unreliable:
      // it fires on the casts that document what a query returned, and removing them loses the only
      // type the reader had. The rule stays on for src and mobile, where the types are real.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/require-await': 'off',
      'no-useless-escape': 'off'
    }
  }
)
