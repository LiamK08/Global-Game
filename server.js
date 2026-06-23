// Express backend for the unlimited Globle-style country guessing game.
//
// Responsibilities:
//   * serve the static front-end and the country GeoJSON
//   * create games with a hidden, randomly chosen target country
//   * score guesses by proximity without ever leaking the target early
//
// Run directly (`npm start`) to listen; import { createApp } for tests.

import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCountryIndex } from './lib/countries.js';
import { GameStore } from './lib/game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'countries.geojson');

/**
 * Build the Express app.
 * @param {object} [opts]
 * @param {ReturnType<import('./lib/countries.js').buildCountryIndex>} [opts.index]
 * @param {GameStore} [opts.store]
 */
export function createApp(opts = {}) {
  const index = opts.index || loadCountryIndex(DATA_FILE);
  const store = opts.store || new GameStore(index);

  const app = express();
  app.disable('x-powered-by');
  app.use(compression()); // gzip responses (notably the globe bundle + GeoJSON)
  app.use(express.json({ limit: '16kb' }));

  // --- Static assets ---
  app.use(
    express.static(path.join(ROOT, 'public'), {
      extensions: ['html'],
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}vendor${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        }
      },
    })
  );

  // The country geometry, served once and cached by the browser.
  app.get('/countries.geojson', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(DATA_FILE);
  });

  // --- API ---
  const api = express.Router();

  api.get('/health', (_req, res) => {
    res.json({
      ok: true,
      countries: index.all.length,
      guessable: index.guessable.length,
      activeGames: store.games.size,
    });
  });

  // Names for the client's autocomplete.
  api.get('/countries', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json({ count: index.names.length, names: index.names });
  });

  // Start a new game.
  api.post('/games', (_req, res) => {
    const game = store.createGame();
    res.status(201).json({ gameId: game.id, status: game.status, guessCount: 0 });
  });

  // Inspect a game's public state.
  api.get('/games/:id', (req, res) => {
    const game = store.getGame(req.params.id);
    if (!game) return res.status(404).json({ error: 'game_not_found' });
    res.json(store.publicState(game));
  });

  // Make a guess.
  api.post('/games/:id/guesses', (req, res) => {
    const game = store.getGame(req.params.id);
    if (!game) return res.status(404).json({ error: 'game_not_found' });

    const raw = req.body && typeof req.body.guess === 'string' ? req.body.guess : '';
    if (!raw.trim()) return res.status(400).json({ error: 'empty_guess' });

    const result = store.guess(game, raw);
    if (!result.ok && result.error === 'unknown_country') {
      return res.status(400).json({ error: 'unknown_country', message: `"${raw.trim()}" is not in the country list.` });
    }
    if (!result.ok && result.error === 'game_over') {
      return res.status(409).json({ error: 'game_over', status: result.status });
    }
    res.json(result);
  });

  // Give up: reveal the answer.
  api.post('/games/:id/giveup', (req, res) => {
    const game = store.getGame(req.params.id);
    if (!game) return res.status(404).json({ error: 'game_not_found' });
    res.json(store.giveUp(game));
  });

  app.use('/api', api);

  // JSON 404 for unknown API routes; everything else falls through to static.
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  });

  return app;
}

// Start listening only when run directly.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp();
  app.listen(port, () => {
    console.log(`🌍  My Globle running at http://localhost:${port}`);
  });
}
