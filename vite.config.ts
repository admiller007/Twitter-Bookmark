import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Main build: extension pages (options + popup, React) and the MV3 background
 * service worker. Both run in the chrome-extension:// origin and support ES
 * modules, so they can share code chunks.
 *
 * The content scripts are built separately (vite.content.config.ts) because
 * classic content scripts cannot be ES modules and must be single files.
 */
export default defineConfig({
  resolve: {
    alias: { '@': resolve(root, 'src') },
  },
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    minify: 'esbuild',
    rollupOptions: {
      input: {
        options: resolve(root, 'options.html'),
        popup: resolve(root, 'popup.html'),
        background: resolve(root, 'src/background/index.ts'),
      },
      output: {
        // The manifest references background.js by an exact path.
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
