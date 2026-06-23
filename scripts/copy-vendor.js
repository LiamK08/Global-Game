#!/usr/bin/env node
// Refresh the vendored, self-contained globe.gl UMD bundle from node_modules.
// Run after `npm install` if you bump the globe.gl version: `npm run build:vendor`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const SRC = path.join(ROOT, 'node_modules', 'globe.gl', 'dist', 'globe.gl.min.js');
const DEST = path.join(ROOT, 'public', 'vendor', 'globe.gl.min.js');

if (!fs.existsSync(SRC)) {
  console.error(`Source not found: ${SRC}\nRun "npm install" first.`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.copyFileSync(SRC, DEST);
const kb = (fs.statSync(DEST).size / 1024).toFixed(0);
console.log(`Vendored globe.gl -> ${path.relative(ROOT, DEST)} (${kb} KB)`);
