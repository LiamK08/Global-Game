#!/usr/bin/env node
// Build the app's country dataset from Natural Earth 1:50m Admin 0 countries.
//
// Output: data/countries.geojson — a FeatureCollection where every feature keeps
// its geometry but carries only a slim, stable set of properties:
//   { id, name, continent, guessable, lat, lng }
//
// `guessable` flags the ~200 sovereign states / countries that can be a target
// or a guess; non-guessable features (dependencies, disputed areas, Antarctica)
// are still rendered so the globe looks complete.
//
// Usage:
//   node scripts/build-data.js [path-or-url-to-source.geojson]
// Defaults to the cached raw file, then falls back to the Natural Earth source.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISPLAY_OVERRIDES } from '../lib/aliases.js';
import { geometryCentroid, slugify } from '../lib/geo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const CACHED_RAW = path.join(ROOT, 'data', '.raw', 'ne_50m_admin_0_countries.geojson');
const SOURCE_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';
const OUT_FILE = path.join(ROOT, 'public', 'countries.geojson');

// Never guessable: Antarctica plus de-facto states that overlap or aren't
// widely recognised, keeping the playable list to UN-style sovereign nations.
const EXCLUDE_NAMES = new Set(['Antarctica', 'Somaliland', 'Northern Cyprus', 'Western Sahara', 'Kosovo']);

/**
 * A guessable country is one that is its own sovereign. Comparing the
 * SOVEREIGNT name to ADMIN keeps real states (France, UK, USA, China…) while
 * dropping autonomous regions whose sovereign is another country
 * (Greenland→Denmark, Åland→Finland, Hong Kong→China, Jersey→UK, …).
 */
function isGuessable(props) {
  return props.SOVEREIGNT === props.ADMIN && !EXCLUDE_NAMES.has(props.ADMIN);
}

async function loadSource(arg) {
  if (arg && /^https?:\/\//.test(arg)) {
    console.log(`Fetching source: ${arg}`);
    const res = await fetch(arg);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    return res.json();
  }
  const candidates = [arg, CACHED_RAW].filter(Boolean);
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      console.log(`Reading source: ${file}`);
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  }
  console.log(`No local source found; fetching: ${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.json();
}

function validIso(code) {
  return typeof code === 'string' && /^[A-Z]{3}$/.test(code) && code !== '-99';
}

function displayName(admin) {
  return DISPLAY_OVERRIDES[admin] || admin;
}

async function main() {
  const source = await loadSource(process.argv[2]);
  if (!source || source.type !== 'FeatureCollection') {
    throw new Error('Source is not a GeoJSON FeatureCollection');
  }

  const usedIds = new Set();
  const features = [];
  let guessableCount = 0;

  for (const feat of source.features) {
    const p = feat.properties || {};
    if (!feat.geometry) continue;

    const name = displayName(p.ADMIN || p.NAME || p.NAME_LONG || 'Unknown');

    // Stable id: prefer ISO A3, fall back to a slug of the name.
    let id = validIso(p.ISO_A3_EH) ? p.ISO_A3_EH : validIso(p.ISO_A3) ? p.ISO_A3 : slugify(name);
    while (usedIds.has(id)) id = `${id}-${slugify(name)}`;
    usedIds.add(id);

    // Anchor point: Natural Earth label point, else computed centroid.
    let lat = typeof p.LABEL_Y === 'number' ? p.LABEL_Y : null;
    let lng = typeof p.LABEL_X === 'number' ? p.LABEL_X : null;
    if (lat === null || lng === null) {
      const c = geometryCentroid(feat.geometry);
      lat = c.lat;
      lng = c.lng;
    }

    const guessable = isGuessable(p);
    if (guessable) guessableCount++;

    features.push({
      type: 'Feature',
      properties: {
        id,
        name,
        continent: p.CONTINENT || 'Other',
        guessable,
        lat: Number(lat.toFixed(4)),
        lng: Number(lng.toFixed(4)),
      },
      geometry: feat.geometry,
    });
  }

  const out = { type: 'FeatureCollection', features };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  const bytes = fs.statSync(OUT_FILE).size;
  console.log(
    `Wrote ${features.length} features (${guessableCount} guessable) -> ` +
      `${path.relative(ROOT, OUT_FILE)} (${(bytes / 1024 / 1024).toFixed(2)} MB)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
