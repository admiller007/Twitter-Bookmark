import { build } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Content scripts are classic (non-module) scripts, so each one must be a
 * single self-contained IIFE. Rollup refuses to emit IIFE for a multi-entry
 * (code-splitting) build, so we run one build per entry.
 *
 *   content.js    - ISOLATED world: DOM extraction + collector loop.
 *   x-net-hook.js - MAIN world: optional network-response enhancement.
 */
const entries = [
  { name: 'content', file: 'src/content/index.ts' },
  { name: 'x-net-hook', file: 'src/x/network-hook.ts' },
];

for (const entry of entries) {
  await build({
    root,
    configFile: false,
    resolve: { alias: { '@': resolve(root, 'src') } },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      target: 'es2022',
      minify: 'esbuild',
      sourcemap: false,
      lib: {
        entry: resolve(root, entry.file),
        formats: ['iife'],
        name: `XBV_${entry.name.replace(/-/g, '_')}`,
        fileName: () => `${entry.name}.js`,
      },
    },
    logLevel: 'warn',
  });
  console.log(`built dist/${entry.name}.js`);
}
