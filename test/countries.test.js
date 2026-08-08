import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCountryIndex, resolveCountry } from '../lib/countries.js';

const index = loadCountryIndex();

test('index loads a sensible number of countries', () => {
  assert.ok(index.all.length > 200, `all=${index.all.length}`);
  assert.ok(index.guessable.length >= 190, `guessable=${index.guessable.length}`);
  assert.equal(index.names.length, index.guessable.length);
});

test('names are sorted alphabetically', () => {
  const sorted = [...index.names].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(index.names, sorted);
});

test('every guessable country has a finite anchor point and unique id', () => {
  const ids = new Set();
  for (const c of index.guessable) {
    assert.ok(Number.isFinite(c.lat) && Number.isFinite(c.lng), `${c.name} missing coords`);
    assert.ok(c.lat >= -90 && c.lat <= 90, `${c.name} lat out of range`);
    assert.ok(c.lng >= -180 && c.lng <= 180, `${c.name} lng out of range`);
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
  }
});

test('resolveCountry handles canonical names and aliases', () => {
  assert.equal(resolveCountry(index, 'France').name, 'France');
  assert.equal(resolveCountry(index, 'usa').name, 'United States');
  assert.equal(resolveCountry(index, 'United States of America').name, 'United States');
  assert.equal(resolveCountry(index, 'UK').name, 'United Kingdom');
  assert.equal(resolveCountry(index, 'DRC').name, 'DR Congo');
  assert.equal(resolveCountry(index, "Côte d'Ivoire").name, 'Ivory Coast');
  assert.equal(resolveCountry(index, 'ivory coast').name, 'Ivory Coast');
  assert.equal(resolveCountry(index, 'czech republic').name, 'Czechia');
});

test('resolveCountry returns null for unknown input', () => {
  assert.equal(resolveCountry(index, 'Atlantis'), null);
  assert.equal(resolveCountry(index, ''), null);
  assert.equal(resolveCountry(index, '   '), null);
});

test('non-guessable territories are not resolvable as guesses', () => {
  // Antarctica is rendered but excluded from play.
  assert.equal(resolveCountry(index, 'Antarctica'), null);
});
