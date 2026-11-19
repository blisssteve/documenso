import path from 'node:path';
import { fileURLToPath } from 'node:url';
import macrosPlugin from 'vite-plugin-babel-macros';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Transform lingui macros (e.g. `msg`) used by the code under test.
  plugins: [macrosPlugin()],
  resolve: {
    alias: {
      '~': path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/remix/app'),
    },
  },
  test: {
    include: ['**/*.test.ts'],
  },
});
