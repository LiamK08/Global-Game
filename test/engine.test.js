import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalBackend } from '../public/js/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const geojson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'countries.geojson'), 'utf8'));
const make = () => new LocalBackend(geojson);

test('engine: builds the same guessable set and names', () => {
  const e = make();
  assert.ok(e.guessable.length >= 190);
  assert.equal(e.names.length, e.guessable.length);
  assert.equal(e.resolve('usa').name, 'United States');
  assert.equal(e.resolve('DRC').name, 'DR Congo');
  assert.equal(e.resolve('Atlantis'), null);
});

test('engine: guessing the target wins with proximity 1', async () => {
  const e = make();
  const { gameId } = await e.createGame({ targetId: 'FRA' });
  const res = await e.submitGuess(gameId, 'France');
  assert.equal(res.guess.correct, true);
  assert.equal(res.guess.proximity, 1);
  assert.equal(res.won, true);
  assert.equal(res.answer.name, 'France');
});

test('engine: wrong guess scores between 0 and 1 and hides the target', async () => {
  const e = make();
  const { gameId } = await e.createGame({ targetId: 'FRA' });
  const res = await e.submitGuess(gameId, 'Brazil');
  assert.equal(res.guess.correct, false);
  assert.ok(res.guess.proximity > 0 && res.guess.proximity < 1);
  assert.equal(res.won, false);
  assert.equal(res.answer, undefined);
});

test('engine: closer countries score higher; closest is tracked', async () => {
  const e = make();
  const { gameId } = await e.createGame({ targetId: 'FRA' });
  const spain = await e.submitGuess(gameId, 'Spain');
  const brazil = await e.submitGuess(gameId, 'Brazil');
  assert.ok(spain.guess.proximity > brazil.guess.proximity);
  assert.equal(brazil.closest.name, 'Spain');
});

test('engine: duplicates flagged, unknowns rejected, no play after end', async () => {
  const e = make();
  const { gameId } = await e.createGame({ targetId: 'FRA' });
  await e.submitGuess(gameId, 'Spain');
  const dup = await e.submitGuess(gameId, 'spain');
  assert.equal(dup.duplicate, true);

  await assert.rejects(() => e.submitGuess(gameId, 'Narnia'), (err) => err.code === 'unknown_country');

  await e.submitGuess(gameId, 'France'); // win
  await assert.rejects(() => e.submitGuess(gameId, 'Italy'), (err) => err.code === 'game_over');
});

test('engine: giveUp reveals the answer', async () => {
  const e = make();
  const { gameId } = await e.createGame({ targetId: 'JPN' });
  const res = await e.giveUp(gameId);
  assert.equal(res.status, 'gaveup');
  assert.equal(res.answer.name, 'Japan');
});

test('engine: a wrong guess carries a bearing toward the target; the win has none', async () => {
  const e = make();
  const { gameId } = await e.createGame({ targetId: 'FRA' });
  const res = await e.submitGuess(gameId, 'Brazil');
  assert.equal(typeof res.guess.bearing, 'number');
  assert.ok(res.guess.bearing >= 0 && res.guess.bearing < 360);
  const win = await e.submitGuess(gameId, 'France');
  assert.equal(win.guess.bearing, null);
});

test('engine: targets never repeat until the whole pool has been used', async () => {
  const e = make();
  const n = e.guessable.length;
  const seen = [];
  for (let i = 0; i < n; i++) {
    const { gameId } = await e.createGame();
    seen.push(e.games.get(gameId).targetId);
  }
  assert.equal(new Set(seen).size, n, 'all targets unique within one cycle');
  const { gameId } = await e.createGame();
  assert.notEqual(e.games.get(gameId).targetId, seen[seen.length - 1], 'no repeat across the cycle boundary');
});

test('engine: random target selection stays within the guessable pool', async () => {
  const e = new LocalBackend(geojson, { random: () => 0.999999 });
  const { gameId } = await e.createGame();
  const g = e.games.get(gameId);
  assert.ok(e.byId.has(g.targetId));
  assert.equal(e.byId.get(g.targetId).guessable, true);
});
