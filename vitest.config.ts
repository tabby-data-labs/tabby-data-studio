import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Needed for the Phase 6 component specs, which mount real SFCs. It only
  // transforms `.vue`, so the pure-module and canvas specs are unaffected.
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    // Node by default: the grid's pure modules and the main-process code need no DOM.
    // Individual component specs opt into happy-dom via a docblock comment.
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'src/**/*.spec.ts'],
    typecheck: {
      enabled: false,
    },
  },
});
