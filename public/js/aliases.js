// Human-friendly name handling for countries. Served to the browser; lib/aliases.js
// re-exports it for Node so there is a single source of truth.
//
// `DISPLAY_OVERRIDES` maps a Natural Earth ADMIN name to a cleaner label shown
// in the UI. `ALIASES` maps alternative spellings / common names that a player
// might type to the canonical display label, so guesses are forgiving.

/** Natural Earth ADMIN name -> preferred display label. */
export const DISPLAY_OVERRIDES = {
  'United States of America': 'United States',
  'United Republic of Tanzania': 'Tanzania',
  'Democratic Republic of the Congo': 'DR Congo',
  'Republic of Serbia': 'Serbia',
  'The Bahamas': 'Bahamas',
  'Federated States of Micronesia': 'Micronesia',
  'Cabo Verde': 'Cape Verde',
  'East Timor': 'Timor-Leste',
  'eSwatini': 'Eswatini',
};

/**
 * Alternative names a player may type -> canonical display label.
 * Keys are matched loosely (case- and accent-insensitive, punctuation ignored).
 */
export const ALIASES = {
  // United States
  usa: 'United States',
  'u.s.a.': 'United States',
  'u.s.': 'United States',
  us: 'United States',
  america: 'United States',
  'united states of america': 'United States',
  'the states': 'United States',
  // United Kingdom
  uk: 'United Kingdom',
  'u.k.': 'United Kingdom',
  britain: 'United Kingdom',
  'great britain': 'United Kingdom',
  england: 'United Kingdom',
  scotland: 'United Kingdom',
  wales: 'United Kingdom',
  // United Arab Emirates
  uae: 'United Arab Emirates',
  emirates: 'United Arab Emirates',
  // Congos
  drc: 'DR Congo',
  'dr congo': 'DR Congo',
  'drc congo': 'DR Congo',
  'democratic republic of the congo': 'DR Congo',
  'democratic republic of congo': 'DR Congo',
  'congo kinshasa': 'DR Congo',
  'congo-kinshasa': 'DR Congo',
  'congo brazzaville': 'Republic of the Congo',
  'congo-brazzaville': 'Republic of the Congo',
  congo: 'Republic of the Congo',
  // Koreas
  'south korea': 'South Korea',
  'republic of korea': 'South Korea',
  'north korea': 'North Korea',
  'dprk': 'North Korea',
  // Others
  'czech republic': 'Czechia',
  burma: 'Myanmar',
  'ivory coast': 'Ivory Coast',
  "cote d'ivoire": 'Ivory Coast',
  'cote divoire': 'Ivory Coast',
  swaziland: 'Eswatini',
  'cape verde': 'Cape Verde',
  'cabo verde': 'Cape Verde',
  'east timor': 'Timor-Leste',
  'timor leste': 'Timor-Leste',
  macedonia: 'North Macedonia',
  'holy see': 'Vatican',
  'vatican city': 'Vatican',
  'the gambia': 'Gambia',
  'the bahamas': 'Bahamas',
  bahamas: 'Bahamas',
  'russian federation': 'Russia',
  turkiye: 'Turkey',
  'türkiye': 'Turkey',
  'tanzania': 'Tanzania',
  'state of palestine': 'Palestine',
  'republic of ireland': 'Ireland',
  'south sudan': 'South Sudan',
  'eq guinea': 'Equatorial Guinea',
  'car': 'Central African Republic',
  'png': 'Papua New Guinea',
  'usa.': 'United States',
  'serbia': 'Serbia',
  'micronesia': 'Micronesia',
  'federated states of micronesia': 'Micronesia',
  'fsm': 'Micronesia',
};
