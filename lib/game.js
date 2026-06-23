// In-memory game store and guess logic for unlimited Globle-style play.
//
// A game holds a hidden target country. Each guess is scored by the great-circle
// distance from the guessed country's anchor point to the target's, expressed as
// a proximity in [0, 1] (1 = correct). The target id is never serialised to the
// client until the game is finished (won or given up), which keeps it honest.

import { randomUUID } from 'node:crypto';
import { haversineKm, proximityFromDistance } from './geo.js';
import { resolveCountry } from './countries.js';

const MAX_GAMES = 5000; // cap the store; oldest finished games are evicted first
const GAME_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export class GameStore {
  /** @param {ReturnType<import('./countries.js').buildCountryIndex>} index */
  constructor(index, { random = Math.random, now = () => Date.now() } = {}) {
    this.index = index;
    this.random = random;
    this.now = now;
    /** @type {Map<string, object>} */
    this.games = new Map();
  }

  /** Pick a random guessable country id. */
  randomTargetId() {
    const pool = this.index.guessable;
    const i = Math.floor(this.random() * pool.length);
    return pool[Math.min(i, pool.length - 1)].id;
  }

  /**
   * Create a new game. `targetId` may be forced (used by tests); otherwise a
   * random country is chosen.
   */
  createGame({ targetId } = {}) {
    this.#sweep();
    const id = randomUUID();
    const chosen = targetId && this.index.byId.has(targetId) ? targetId : this.randomTargetId();
    const ts = this.now();
    const game = {
      id,
      targetId: chosen,
      status: 'playing', // 'playing' | 'won' | 'gaveup'
      guesses: [], // [{ id, name, continent, lat, lng, distanceKm, proximity, proximityPercent, correct }]
      closestId: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.games.set(id, game);
    return game;
  }

  getGame(id) {
    return this.games.get(id) || null;
  }

  /**
   * Apply a guess to a game.
   * @returns {object} result describing the guess and updated state.
   */
  guess(game, rawName) {
    if (game.status !== 'playing') {
      return { ok: false, error: 'game_over', status: game.status };
    }
    const country = resolveCountry(this.index, rawName);
    if (!country) return { ok: false, error: 'unknown_country' };

    const existing = game.guesses.find((g) => g.id === country.id);
    if (existing) {
      return { ok: true, duplicate: true, guess: existing, ...this.#summary(game) };
    }

    const target = this.index.byId.get(game.targetId);
    const distanceKm = haversineKm({ lat: country.lat, lng: country.lng }, { lat: target.lat, lng: target.lng });
    const proximity = country.id === target.id ? 1 : proximityFromDistance(distanceKm);
    const guess = {
      id: country.id,
      name: country.name,
      continent: country.continent,
      lat: country.lat,
      lng: country.lng,
      distanceKm: Math.round(distanceKm),
      proximity,
      proximityPercent: Math.round(proximity * 100),
      correct: country.id === target.id,
    };
    game.guesses.push(guess);
    game.updatedAt = this.now();

    // Track the closest guess so far.
    if (game.closestId === null || proximity > this.#proximityOf(game, game.closestId)) {
      game.closestId = guess.id;
    }

    if (guess.correct) game.status = 'won';

    return { ok: true, duplicate: false, guess, ...this.#summary(game) };
  }

  /** Player gives up: reveal the answer and end the game. */
  giveUp(game) {
    if (game.status === 'playing') {
      game.status = 'gaveup';
      game.updatedAt = this.now();
    }
    return { ok: true, ...this.#summary(game) };
  }

  // --- internal helpers ---

  #proximityOf(game, id) {
    const g = game.guesses.find((x) => x.id === id);
    return g ? g.proximity : -1;
  }

  /** Shared trailing fields for guess/giveUp results. */
  #summary(game) {
    const finished = game.status !== 'playing';
    const closest = game.closestId
      ? game.guesses.find((g) => g.id === game.closestId) || null
      : null;
    const target = this.index.byId.get(game.targetId);
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

  /** Public, cheat-safe view of a game's state. */
  publicState(game) {
    return {
      id: game.id,
      status: game.status,
      guesses: game.guesses,
      ...this.#summary(game),
    };
  }

  /** Evict expired games, then trim to the size cap (finished games first). */
  #sweep() {
    const cutoff = this.now() - GAME_TTL_MS;
    for (const [id, g] of this.games) {
      if (g.updatedAt < cutoff) this.games.delete(id);
    }
    if (this.games.size <= MAX_GAMES) return;
    const sorted = [...this.games.values()].sort((a, b) => {
      const af = a.status !== 'playing' ? 0 : 1;
      const bf = b.status !== 'playing' ? 0 : 1;
      if (af !== bf) return af - bf; // finished first
      return a.updatedAt - b.updatedAt; // then oldest first
    });
    for (const g of sorted) {
      if (this.games.size <= MAX_GAMES) break;
      this.games.delete(g.id);
    }
  }
}
