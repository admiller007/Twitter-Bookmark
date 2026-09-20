/**
 * Post-build sanity checks.
 *
 * Catches the failure modes that only show up when Chrome loads the folder:
 * a missing file the manifest points at, a content script that ended up as an
 * ES module, or a remote script URL sneaking into an extension page.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

if (!existsSync(dist)) {
  console.error('dist/ does not exist - run the build first.');
  process.exit(1);
}

// --- manifest ---------------------------------------------------------------
const manifestPath = join(dist, 'manifest.json');
if (!existsSync(manifestPath)) fail('manifest.json is missing from dist/');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
if (!manifest.name || !manifest.version) fail('manifest is missing name or version');

const referenced = new Set();
const add = (file) => file && referenced.add(file);

add(manifest.background?.service_worker);
add(manifest.action?.default_popup);
add(manifest.options_ui?.page);
for (const size of Object.values(manifest.icons ?? {})) add(size);
for (const size of Object.values(manifest.action?.default_icon ?? {})) add(size);
for (const script of manifest.content_scripts ?? []) {
  for (const file of script.js ?? []) add(file);
  for (const file of script.css ?? []) add(file);
}

for (const file of referenced) {
  const full = join(dist, file);
  if (!existsSync(full)) fail(`manifest references "${file}", which is not in dist/`);
  else if (statSync(full).size === 0) fail(`"${file}" is empty`);
}

// --- content scripts must be classic scripts --------------------------------
for (const script of manifest.content_scripts ?? []) {
  for (const file of script.js ?? []) {
    const full = join(dist, file);
    if (!existsSync(full)) continue;
    const source = readFileSync(full, 'utf8');
    if (/^\s*import\s|\bfrom\s+["']\.|\bexport\s+(default|const|function|\{)/m.test(source)) {
      fail(`content script "${file}" contains ES module syntax; it must be a self-contained IIFE`);
    }
  }
}

// --- extension pages must not load remote code ------------------------------
for (const file of readdirSync(dist)) {
  if (!file.endsWith('.html')) continue;
  const html = readFileSync(join(dist, file), 'utf8');
  const remote = html.match(/<script[^>]+src=["'](https?:)?\/\//g);
  if (remote) fail(`${file} loads a remote script, which Manifest V3 forbids`);

  for (const match of html.matchAll(/(?:src|href)="\/?([^"#?]+\.(?:js|css))"/g)) {
    const asset = match[1];
    if (!existsSync(join(dist, asset))) fail(`${file} references missing asset "${asset}"`);
  }
}

// --- no eval ----------------------------------------------------------------
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) {
      const source = readFileSync(full, 'utf8');
      if (/\beval\s*\(/.test(source)) fail(`${entry.name} calls eval(), which Manifest V3 forbids`);
    }
  }
}
walk(dist);

// --- report -----------------------------------------------------------------
const files = [];
function tally(dir, prefix = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) tally(full, `${prefix}${entry.name}/`);
    else files.push([`${prefix}${entry.name}`, statSync(full).size]);
  }
}
tally(dist);

notes.push(`${files.length} files, ${(files.reduce((sum, [, size]) => sum + size, 0) / 1024).toFixed(0)} KB total`);

console.log('\nExtension output (dist/):');
for (const [name, size] of files.sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(Math.round(size / 1024)).padStart(5)} KB  ${name}`);
}
console.log(`\n${notes.join(' | ')}`);

if (problems.length > 0) {
  console.error('\nBuild verification FAILED:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('\nBuild verification passed: dist/ is ready to load unpacked in Chrome.\n');
