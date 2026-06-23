// Pure geographic + string helpers shared by the browser, data builder, server
// and tests. This file is served to the browser; lib/geo.js re-exports it for
// Node so there is a single source of truth.

/** Mean Earth radius in kilometres. */
export const EARTH_RADIUS_KM = 6371;

/** Maximum great-circle distance between two points on Earth (antipodal). */
export const MAX_DISTANCE_KM = Math.PI * EARTH_RADIUS_KM; // ~20015.1 km

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance between two {lat, lng} points, in kilometres,
 * using the haversine formula.
 */
export function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  return EARTH_RADIUS_KM * c;
}

/**
 * Convert a great-circle distance to a proximity score in [0, 1].
 * 1 means the same location (distance 0); 0 means antipodal.
 */
export function proximityFromDistance(distanceKm) {
  const p = 1 - distanceKm / MAX_DISTANCE_KM;
  return Math.max(0, Math.min(1, p));
}

/**
 * Normalise a country name for forgiving matching: lower-cased, accents
 * stripped, punctuation removed and whitespace collapsed.
 */
export function normalizeName(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/['’.]/g, '') // drop apostrophes and dots
    .replace(/[^a-z0-9]+/g, ' ') // any other punctuation -> space
    .trim()
    .replace(/\s+/g, ' ');
}

/** Turn a name into a URL/id-safe slug (used as a fallback id). */
export function slugify(name) {
  return normalizeName(name).replace(/\s+/g, '-');
}

/**
 * Compute the centroid of a GeoJSON Polygon/MultiPolygon by area-weighting the
 * centroid of each ring. Returns {lat, lng}. Used only as a fallback when a
 * Natural Earth label point is unavailable.
 */
export function geometryCentroid(geometry) {
  const polygons =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];

  let totalArea = 0;
  let cx = 0;
  let cy = 0;

  for (const polygon of polygons) {
    const ring = polygon[0]; // outer ring
    if (!ring || ring.length < 3) continue;
    let area = 0;
    let x = 0;
    let y = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const cross = xj * yi - xi * yj;
      area += cross;
      x += (xi + xj) * cross;
      y += (yi + yj) * cross;
    }
    if (area === 0) continue;
    const ringArea = area / 2;
    cx += x / (6 * ringArea) * Math.abs(ringArea);
    cy += y / (6 * ringArea) * Math.abs(ringArea);
    totalArea += Math.abs(ringArea);
  }

  if (totalArea === 0) {
    // Degenerate: fall back to the average of all outer-ring vertices.
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (const polygon of polygons) {
      for (const [x, y] of polygon[0] || []) {
        sx += x;
        sy += y;
        n++;
      }
    }
    return n ? { lat: sy / n, lng: sx / n } : { lat: 0, lng: 0 };
  }

  return { lat: cy / totalArea, lng: cx / totalArea };
}
