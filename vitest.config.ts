import { defineConfig } from 'vitest/config';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Tests run against the plain TypeScript modules - no React plugin needed,
 * since the suites cover extraction, storage, classification and export logic.
 */
export default defineConfig({
  resolve: {
    alias: { '@': resolve(root, 'src') },
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    restoreMocks: true,
  },
});
