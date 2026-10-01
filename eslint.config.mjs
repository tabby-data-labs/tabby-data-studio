import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', 'coverage/**', '*.md'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],

  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        sourceType: 'module',
        extraFileExtensions: ['.vue'],
      },
    },
  },

  // main + preload: Node APIs allowed, DOM forbidden.
  {
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'tests/**/*.ts',
      '*.config.ts',
      'scripts/**/*.mjs',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // shared: imported by all three processes, so it may use neither Node nor DOM.
  {
    files: ['src/shared/**/*.ts'],
    languageOptions: {
      globals: {},
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['electron', 'vue', 'pinia', 'node:*', 'pg'],
          paths: [
            { name: 'electron', message: 'src/shared must stay process-agnostic.' },
            { name: 'pg', message: 'Only src/main/db/driver-pg.ts may import pg.' },
          ],
        },
      ],
    },
  },

  // renderer: DOM allowed, Node built-ins forbidden.
  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.vue'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['node:*', 'electron'],
          paths: [{ name: 'pg', message: 'The renderer must never touch the database driver.' }],
        },
      ],
    },
  },

  // The grid is a self-contained module: no Vue, no Pinia, no app imports.
  // This rule is what keeps it headlessly testable and reusable.
  {
    files: ['src/renderer/src/grid/**/*.ts', 'src/renderer/src/grid/**/*.vue'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '@/app/*',
            '@/components/*',
            '@/stores/*',
            '@shared/ipc-contract',
            'node:*',
            'electron',
            'pinia',
            'vue',
          ],
          paths: [{ name: 'pg', message: 'The grid must never touch the database driver.' }],
        },
      ],
    },
  },

  // `pg` is allowed in exactly one file.
  {
    files: ['src/main/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'pg',
              message: 'Import pg only from src/main/db/driver-pg.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/main/db/driver-pg.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // Global house rules. Must come before any block that relaxes them, because
  // in flat config the LAST matching object wins.
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },

  // CLI scripts are meant to write to stdout.
  {
    files: ['scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },

  // The logging module is the one place console *is* the implementation. Every
  // other call site must go through it, so the redactor cannot be bypassed.
  {
    files: ['src/main/log.ts'],
    rules: { 'no-console': 'off' },
  },

  prettier,
);
