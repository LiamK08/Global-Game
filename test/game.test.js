import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCountryIndex } from '../lib/countries.js';
import { GameStore } from '../lib/game.js';

const index = loadCountryIndex();
const newStore = () => new GameStore(index);

test('createGame chooses the forced target', () => {
  const store = newStore();
  const game = store.createGame({ targetId: 'FRA' });
  assert.equal(game.targetId, 'FRA');
  assert.equal(game.status, 'playing');
});

test('guessing the target wins with proximity 1', () => {
  const store = newStore();
  const game = store.createGame({ targetId: 'FRA' });
  const res = store.guess(game, 'France');
  assert.equal(res.ok, true);
  assert.equal(res.guess.correct, true);
  assert.equal(res.guess.proximity, 1);
  assert.equal(res.guess.proximityPercent, 100);
  assert.equal(res.won, true);
  assert.equal(res.answer.name, 'France');
});

test('a wrong guess scores a proximity strictly between 0 and 1', () => {
  const store = newStore();
  const game = store.createGame({ targetId: 'FRA' });
  const res = store.guess(game, 'Germany');
  assert.equal(res.guess.correct, false);
  assert.ok(res.guess.proximity > 0 && res.guess.proximity < 1);
  assert.ok(res.guess.distanceKm > 0);
  assert.equal(res.won, false);
  assert.equal(res.answer, undefined); // target stays hidden while playing
});

test('closer countries score higher than far ones', () => {
  const store = newStore();
  const game = store.createGame({ targetId: 'FRA' });
  const germany = store.guess(game, 'Germany').guess;
  const australia = store.guess(game, 'Australia').guess;
  assert.ok(germany.proximity > australia.proximity);
});

test('closest tracks the best guess so far', () => {
  const store = newStore();
  const game = store.createGame({ targetId: 'FRA' });
  store.guess(game, 'Australia');
  let res = store.guess(game, 'Germany');
  assert.equal(res.closest.name, 'Germany');
  res = store.guess(game, 'Japan');
  assert.equal(res.closest.name, 'Germany'); // Japan is farther; closest unchanged
});

test('duplicate guesses are flagged and not double counted', () => {
  const store = newStore();
  const game = store.createGame({ targetId: 'FRA' });
  store.guess(game, 'Germany');
  const dup = store.guess(game, 'germany');
  assert.equal(dup.duplicate, true);
  assert.equal(game.guesses.length, 1);
});

test('unknown country is rejected', () => {
  const store = newStore();
  const game = store.createGame({ targetId: 'FRA' });
  const res = store.guess(game, 'Narnia');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unknown_country');
});

test('cannot guess after the game is over', () => {
  const store = newStore();
  const game = store.createGame({ targetId: 'FRA' });
  store.guess(game, 'France'); // win
  const res = store.guess(game, 'Spain');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'game_over');
});

test('giveUp reveals the answer and ends the game', () => {
  const store = newStore();
  const game = store.createGame({ targetId: 'JPN' });
  const res = store.giveUp(game);
  assert.equal(res.status, 'gaveup');
  assert.equal(res.answer.name, 'Japan');
  assert.equal(game.status, 'gaveup');
});

test('a wrong guess carries a bearing toward the target; the win has none', () => {
  const store = newStore();
  const game = store.createGame({ targetId: 'FRA' });
  const g = store.guess(game, 'Brazil').guess;
  assert.equal(typeof g.bearing, 'number');
  assert.ok(g.bearing >= 0 && g.bearing < 360);
  assert.equal(store.guess(game, 'France').guess.bearing, null);
});

test('targets never repeat until the whole pool has been used', () => {
  const store = newStore();
  const n = index.guessable.length;
  const seen = [];
  for (let i = 0; i < n; i++) seen.push(store.createGame().targetId);
  assert.equal(new Set(seen).size, n);
  assert.notEqual(store.createGame().targetId, seen[seen.length - 1]);
});

test('every guessable target produces valid proximities for sampled guesses', () => {
  const store = newStore();
  const samples = ['France', 'Brazil', 'Japan', 'Egypt', 'Australia', 'Canada'];
  for (const target of index.guessable) {
    const game = store.createGame({ targetId: target.id });
    for (const name of samples) {
      const res = store.guess(game, name);
      if (!res.ok || res.duplicate) continue;
      assert.ok(res.guess.proximity >= 0 && res.guess.proximity <= 1, `${target.name} vs ${name}`);
    }
  }
});
