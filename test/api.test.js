import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

/** Start the app on an ephemeral port and return { base, close }. */
function startServer() {
  return new Promise((resolve) => {
    const server = createApp().listen(0, () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test('API: full happy-path plumbing', async (t) => {
  const { base, close } = await startServer();
  t.after(close);

  await t.test('health reports counts', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.guessable >= 190);
  });

  await t.test('countries list is served', async () => {
    const res = await fetch(`${base}/api/countries`);
    const body = await res.json();
    assert.ok(Array.isArray(body.names) && body.names.length >= 190);
  });

  await t.test('geojson is served and parseable', async () => {
    const res = await fetch(`${base}/countries.geojson`);
    assert.equal(res.status, 200);
    const geo = JSON.parse(await res.text());
    assert.equal(geo.type, 'FeatureCollection');
    assert.ok(geo.features.length > 200);
  });

  let gameId;
  await t.test('create a game', async () => {
    const res = await fetch(`${base}/api/games`, { method: 'POST' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.gameId);
    gameId = body.gameId;
  });

  await t.test('a valid guess is scored', async () => {
    const res = await fetch(`${base}/api/games/${gameId}/guesses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guess: 'France' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.guess.proximity >= 0 && body.guess.proximity <= 1);
    assert.equal(body.guess.name, 'France');
  });

  await t.test('an unknown country is rejected with 400', async () => {
    const res = await fetch(`${base}/api/games/${gameId}/guesses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guess: 'Wakanda' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'unknown_country');
  });

  await t.test('an empty guess is rejected with 400', async () => {
    const res = await fetch(`${base}/api/games/${gameId}/guesses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guess: '   ' }),
    });
    assert.equal(res.status, 400);
  });

  await t.test('guessing on a missing game returns 404', async () => {
    const res = await fetch(`${base}/api/games/does-not-exist/guesses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guess: 'France' }),
    });
    assert.equal(res.status, 404);
  });

  await t.test('give up reveals the answer', async () => {
    const res = await fetch(`${base}/api/games/${gameId}/giveup`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'gaveup');
    assert.ok(body.answer && body.answer.name);
  });
});
