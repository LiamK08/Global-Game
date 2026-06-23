// Client-side game engine — a no-backend implementation that mirrors the
// server's logic and response shapes, so the app can run as a fully static site
// (e.g. on GitHub Pages). It builds the country index from the loaded GeoJSON
// and scores guesses by haversine proximity, exactly like lib/game.js does.

import { haversineKm, proximityFromDistance, normalizeName, bearingTo } from './geo.js';
import { ALIASES } from './aliases.js';

export class LocalBackend {
  /**
   * @param {object} geojson FeatureCollection with per-feature {id,name,continent,guessable,lat,lng}
   * @param {object} [opts]
   * @param {() => number} [opts.random] injectable RNG (tests)
   */
  constructor(geojson, { random = Math.random } = {}) {
    this.random = random;
    this.all = geojson.features.map((f) => f.properties);
    this.guessable = this.all.filter((c) => c.guessable);
    this.byId = new Map(this.all.map((c) => [c.id, c]));

    // Forgiving name -> guessable country resolver (names + aliases).
    this.lookup = new Map();
    const addKey = (key, country) => {
      const k = normalizeName(key);
      if (k && !this.lookup.has(k)) this.lookup.set(k, country);
    };
    for (const c of this.guessable) addKey(c.name, c);
    const byName = new Map(this.guessable.map((c) => [normalizeName(c.name), c]));
    for (const [alias, canonical] of Object.entries(ALIASES)) {
      const c = byName.get(normalizeName(canonical));
      if (c) addKey(alias, c);
    }

    this.names = this.guessable.map((c) => c.name).sort((a, b) => a.localeCompare(b));
    this.games = new Map();
    this._seq = 0;
    this.bag = []; // shuffled queue of upcoming targets (no repeats until exhausted)
    this.lastTargetId = null;
  }

  resolve(raw) {
    if (!raw) return null;
    return this.lookup.get(normalizeName(raw)) || null;
  }

  /** Next random target, guaranteed not to repeat until every country is used. */
  nextTargetId() {
    if (this.bag.length === 0) {
      this.bag = shuffle(this.guessable.map((c) => c.id), this.random);
      // Avoid an immediate repeat across the bag boundary.
      if (this.bag.length > 1 && this.bag[this.bag.length - 1] === this.lastTargetId) {
        [this.bag[0], this.bag[this.bag.length - 1]] = [this.bag[this.bag.length - 1], this.bag[0]];
      }
    }
    this.lastTargetId = this.bag.pop();
    return this.lastTargetId;
  }

  /** Backend interface (async to match the HTTP client). */
  async getNames() {
    return this.names;
  }

  async createGame({ targetId } = {}) {
    const id = `local-${++this._seq}`;
    const chosen = targetId && this.byId.has(targetId) ? targetId : this.nextTargetId();
    this.games.set(id, { id, targetId: chosen, status: 'playing', guesses: [], closestId: null });
    return { gameId: id, status: 'playing', guessCount: 0 };
  }

  async submitGuess(gameId, raw) {
    const game = this.games.get(gameId);
    if (!game) throw err('game_not_found', 404);
    if (game.status !== 'playing') throw err('game_over', 409);

    const country = this.resolve(raw);
    if (!country) throw err('unknown_country', 400, `"${String(raw).trim()}" is not in the country list.`);

    const existing = game.guesses.find((g) => g.id === country.id);
    if (existing) return { ok: true, duplicate: true, guess: existing, ...this.#summary(game) };

    const target = this.byId.get(game.targetId);
    const correct = country.id === target.id;
    const from = { lat: country.lat, lng: country.lng };
    const to = { lat: target.lat, lng: target.lng };
    const distanceKm = haversineKm(from, to);
    const proximity = correct ? 1 : proximityFromDistance(distanceKm);
    const guess = {
      id: country.id,
      name: country.name,
      continent: country.continent,
      lat: country.lat,
      lng: country.lng,
      distanceKm: Math.round(distanceKm),
      proximity,
      proximityPercent: Math.round(proximity * 100),
      bearing: correct ? null : Math.round(bearingTo(from, to)),
      correct,
    };
    game.guesses.push(guess);

    const closestProx = game.closestId ? game.guesses.find((g) => g.id === game.closestId)?.proximity ?? -1 : -1;
    if (game.closestId === null || proximity > closestProx) game.closestId = guess.id;
    if (guess.correct) game.status = 'won';

    return { ok: true, duplicate: false, guess, ...this.#summary(game) };
  }

  async giveUp(gameId) {
    const game = this.games.get(gameId);
    if (!game) throw err('game_not_found', 404);
    if (game.status === 'playing') game.status = 'gaveup';
    return { ok: true, ...this.#summary(game) };
  }

  #summary(game) {
    const finished = game.status !== 'playing';
    const closest = game.closestId ? game.guesses.find((g) => g.id === game.closestId) || null : null;
    const target = this.byId.get(game.targetId);
    return {
      status: game.status,
      won: game.status === 'won',
      guessCount: game.guesses.length,
      closest: closest
        ? { id: closest.id, name: closest.name, proximity: closest.proximity, proximityPercent: closest.proximityPercent }
        : null,
      answer: finished ? { id: target.id, name: target.name, lat: target.lat, lng: target.lng } : undefined,
    };
  }
}

function err(code, status, message) {
  const e = new Error(message || code);
  e.code = code;
  e.status = status;
  return e;
}

/** Fisher–Yates shuffle using an injectable RNG. */
function shuffle(arr, random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
