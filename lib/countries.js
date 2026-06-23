// Loads the country dataset and builds the lookup structures the game needs:
// a list of guessable countries (with anchor points) and a forgiving
// name -> country resolver that understands aliases.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALIASES } from './aliases.js';
import { normalizeName } from './geo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA = path.join(__dirname, '..', 'public', 'countries.geojson');

/**
 * @typedef {Object} Country
 * @property {string} id        Stable id (ISO A3 or slug)
 * @property {string} name      Display name
 * @property {string} continent
 * @property {boolean} guessable
 * @property {number} lat
 * @property {number} lng
 */

/** Read and parse the countries GeoJSON file. */
export function loadGeoJson(file = DEFAULT_DATA) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Build the country index from a parsed GeoJSON FeatureCollection.
 * @param {object} geojson
 */
export function buildCountryIndex(geojson) {
  /** @type {Country[]} */
  const all = geojson.features.map((f) => ({ ...f.properties }));
  const guessable = all.filter((c) => c.guessable);

  const byId = new Map(all.map((c) => [c.id, c]));

  // Resolver: normalized name/alias -> guessable country.
  const lookup = new Map();
  const addKey = (key, country) => {
    const k = normalizeName(key);
    if (k && !lookup.has(k)) lookup.set(k, country);
  };

  for (const country of guessable) {
    addKey(country.name, country);
  }

  // Aliases reference a canonical display name; wire them to that country.
  const byName = new Map(guessable.map((c) => [normalizeName(c.name), c]));
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    const country = byName.get(normalizeName(canonical));
    if (country) addKey(alias, country);
  }

  const names = guessable.map((c) => c.name).sort((a, b) => a.localeCompare(b));

  return { all, guessable, byId, lookup, names };
}

/** Convenience: load the dataset and build the index in one step. */
export function loadCountryIndex(file = DEFAULT_DATA) {
  return buildCountryIndex(loadGeoJson(file));
}

/**
 * Resolve a raw, player-typed name to a guessable country, or null.
 * @param {ReturnType<typeof buildCountryIndex>} index
 * @param {string} raw
 * @returns {Country | null}
 */
export function resolveCountry(index, raw) {
  if (!raw) return null;
  const key = normalizeName(raw);
  return index.lookup.get(key) || null;
}
