import test from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineKm,
  proximityFromDistance,
  normalizeName,
  slugify,
  geometryCentroid,
  MAX_DISTANCE_KM,
} from '../lib/geo.js';

test('haversineKm: same point is zero', () => {
  assert.equal(haversineKm({ lat: 10, lng: 20 }, { lat: 10, lng: 20 }), 0);
});

test('haversineKm: London to Paris is ~343 km', () => {
  const d = haversineKm({ lat: 51.5074, lng: -0.1278 }, { lat: 48.8566, lng: 2.3522 });
  assert.ok(Math.abs(d - 343) < 10, `expected ~343, got ${d}`);
});

test('haversineKm: antipodal points are ~max distance', () => {
  const d = haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 180 });
  assert.ok(Math.abs(d - MAX_DISTANCE_KM) < 1, `expected ~${MAX_DISTANCE_KM}, got ${d}`);
});

test('proximityFromDistance: maps distance to [0,1]', () => {
  assert.equal(proximityFromDistance(0), 1);
  assert.ok(Math.abs(proximityFromDistance(MAX_DISTANCE_KM) - 0) < 1e-9);
  assert.ok(Math.abs(proximityFromDistance(MAX_DISTANCE_KM / 2) - 0.5) < 1e-9);
  assert.equal(proximityFromDistance(MAX_DISTANCE_KM * 2), 0); // clamped
});

test('normalizeName: strips accents, case and punctuation', () => {
  assert.equal(normalizeName("Côte d'Ivoire"), 'cote divoire');
  assert.equal(normalizeName('  United   States. '), 'united states');
  assert.equal(normalizeName('São Tomé & Príncipe'), 'sao tome principe');
});

test('slugify produces id-safe strings', () => {
  assert.equal(slugify('Bosnia and Herzegovina'), 'bosnia-and-herzegovina');
});

test('geometryCentroid: unit square centroid is its centre', () => {
  const square = {
    type: 'Polygon',
    coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
  };
  const c = geometryCentroid(square);
  assert.ok(Math.abs(c.lng - 1) < 1e-9 && Math.abs(c.lat - 1) < 1e-9);
});
