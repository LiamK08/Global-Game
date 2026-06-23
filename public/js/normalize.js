// Browser-side name normalisation, mirroring lib/geo.js on the server so that
// client autocomplete and server matching agree.

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
