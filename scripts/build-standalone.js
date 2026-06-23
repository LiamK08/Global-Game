#!/usr/bin/env node
// Build a single, self-contained HTML file with EVERYTHING inlined: the globe.gl
// library, the country data, all CSS, and the bundled game code. The result runs
// completely offline from a file:// page — no server, no network requests,
// nothing to install. Handy when a host/domain is blocked by a content filter.
//
// Requires esbuild (a dev-time tool):  npm install --no-save esbuild
// Then:  node scripts/build-standalone.js   (or: npm run build:standalone)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'dist', 'globe-guesser.html');

const read = (p) => fs.readFileSync(p, 'utf8');

// Stop inlined content from prematurely closing its <script>/<style> tag.
const safe = (s) => s.replace(/<\/(script|style)/gi, '<\\/$1');

async function main() {
  const html = read(path.join(PUB, 'index.html'));
  const css = read(path.join(PUB, 'styles.css'));
  const globe = read(path.join(PUB, 'vendor', 'globe.gl.min.js'));
  const geo = read(path.join(PUB, 'countries.geojson')); // raw JSON text

  // Bundle the ES modules into one classic IIFE so it runs from file:// (module
  // scripts are blocked under the file: protocol in most browsers).
  const bundled = await build({
    entryPoints: [path.join(PUB, 'js', 'main.js')],
    bundle: true,
    format: 'iife',
    minify: true,
    write: false,
    legalComments: 'none',
  });
  const appJs = bundled.outputFiles[0].text;

  const out = html
    .replace('<link rel="stylesheet" href="styles.css" />', () => `<style>\n${safe(css)}\n</style>`)
    .replace('<script src="vendor/globe.gl.min.js"></script>', () => `<script>${safe(globe)}</script>`)
    .replace(
      '<script type="module" src="js/main.js"></script>',
      () => `<script>window.__GEO__=${safe(geo)};</script>\n    <script>${safe(appJs)}</script>`
    );

  if (out.includes('href="styles.css"') || out.includes('src="vendor/') || out.includes('src="js/main.js"')) {
    throw new Error('Inlining failed: an external reference was left in place. Did index.html change?');
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out);
  const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(2);
  console.log(`Wrote ${path.relative(ROOT, OUT)} (${mb} MB) — open it in any browser, no server needed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
