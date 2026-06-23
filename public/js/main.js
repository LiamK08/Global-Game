// App controller: loads data, drives the globe, handles guesses and UI state.

import { GlobeView } from './globe.js';
import { Autocomplete } from './autocomplete.js';
import { heatColor, rampGradient } from './colors.js';
import * as api from './api.js';
import { LocalBackend } from './engine.js';
import { loadStats, recordWin, recordGiveUp, resetStats, summarize } from './stats.js';

const $ = (sel) => document.querySelector(sel);
const THEME_KEY = 'globe-guesser:theme';
const SEEN_KEY = 'globe-guesser:seen-help';

const els = {
  globe: $('#globe'),
  status: $('#status'),
  form: $('#guess-form'),
  input: $('#guess-input'),
  guessBtn: $('#guess-btn'),
  message: $('#message'),
  panel: $('#guesses-panel'),
  count: $('#guesses-count'),
  list: $('#guesses-list'),
  giveup: $('#btn-giveup'),
  marker: $('#prox-marker'),
  flag: $('#prox-flag'),
  // modals + buttons
  modalRoot: $('#modal-root'),
  btnNew: $('#btn-new'),
  btnStats: $('#btn-stats'),
  btnHelp: $('#btn-help'),
  btnTheme: $('#btn-theme'),
  winCountry: $('#win-country'),
  winLine: $('#win-line'),
  winNew: $('#win-new'),
  winShare: $('#win-share'),
  loseCountry: $('#lose-country'),
  loseLine: $('#lose-line'),
  loseNew: $('#lose-new'),
  statsGrid: $('#stats-grid'),
  statsReset: $('#stats-reset'),
  helpGradient: $('#help-gradient'),
};

const game = {
  id: null,
  over: false,
  guesses: [], // { id, name, proximity, proximityPercent, correct, lat, lng, continent }
  closest: null, // best guess so far
  globe: null,
  ac: null, // autocomplete instance
  backend: null, // server API or local in-browser engine
};

/**
 * Pick a backend: use the server API when it's reachable (anti-cheat, hidden
 * target), otherwise fall back to the in-browser engine so the page works as a
 * fully static site (e.g. GitHub Pages).
 */
async function selectBackend(geojson) {
  // Standalone/offline single-file build: data is inlined, always play locally.
  if (window.__GEO__) return new LocalBackend(geojson);
  try {
    const res = await fetch('api/health', { cache: 'no-store' });
    if (res.ok) {
      return { getNames: api.getNames, createGame: api.createGame, submitGuess: api.submitGuess, giveUp: api.giveUp };
    }
  } catch {
    /* no server — fall through to local engine */
  }
  return new LocalBackend(geojson);
}

// ---------------------------------------------------------------- bootstrap

async function init() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'dark');
  els.helpGradient.style.background = rampGradient();
  setStatus('Loading the globe…');

  wireUi();

  let geojson = window.__GEO__ || null;
  if (!geojson) {
    try {
      const res = await fetch('countries.geojson');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      geojson = await res.json();
    } catch (err) {
      return fatal('Could not load map data. Please reload the page.');
    }
  }

  if (typeof window.Globe !== 'function') {
    return fatal('Could not load the globe library.');
  }
  game.globe = new GlobeView(els.globe, geojson, currentTheme());
  game.backend = await selectBackend(geojson);

  try {
    const names = await game.backend.getNames();
    game.ac = new Autocomplete({ input: els.input, list: $('#ac-list'), names, onSubmit: () => els.form.requestSubmit() });
  } catch {
    /* autocomplete is a nice-to-have; typing still works without it */
  }

  await startNewGame();

  if (!localStorage.getItem(SEEN_KEY)) {
    openModal('modal-help');
    localStorage.setItem(SEEN_KEY, '1');
  }
}

function fatal(msg) {
  els.status.textContent = msg;
  els.input.disabled = true;
  els.guessBtn.disabled = true;
}

// ---------------------------------------------------------------- game flow

async function startNewGame() {
  try {
    const { gameId } = await game.backend.createGame();
    game.id = gameId;
  } catch {
    return fatal('Could not start a new game. Please retry.');
  }
  game.over = false;
  game.guesses = [];
  game.closest = null;

  if (game.globe) game.globe.reset();
  els.list.innerHTML = '';
  els.panel.hidden = true;
  els.marker.hidden = true;
  els.message.textContent = '';
  els.input.disabled = false;
  els.guessBtn.disabled = false;
  els.input.value = '';
  setStatus('Guess the mystery country!');
  els.input.focus();
}

async function handleGuess(rawValue) {
  const raw = (rawValue ?? els.input.value).trim();
  if (!raw || game.over || !game.id) return;
  const gid = game.id; // guard against a new game starting mid-request

  els.message.textContent = '';
  let result;
  try {
    result = await game.backend.submitGuess(gid, raw);
  } catch (err) {
    if (game.id !== gid) return; // stale response — ignore
    if (err.code === 'unknown_country') showMessage(`"${raw}" isn't a country I know.`);
    else showMessage('Something went wrong — try again.');
    flash(els.input);
    return;
  }

  if (game.id !== gid || game.over) return; // stale response — ignore

  els.input.value = '';
  if (game.ac) game.ac.close();
  els.input.focus();

  if (result.duplicate) {
    showMessage(`Already guessed ${result.guess.name}.`);
    game.globe.flyTo(result.guess);
    return;
  }

  game.globe.stopAutoRotate();
  registerGuess(result.guess);
  game.globe.applyGuess(result.guess);
  game.globe.flyTo(result.guess);

  if (result.closest) game.closest = result.closest;
  updateClosestUi();

  if (result.won) onWin(result);
}

function registerGuess(guess) {
  game.guesses.push(guess);
  els.panel.hidden = false;
  renderGuessList();
  els.count.textContent = `${game.guesses.length} ${game.guesses.length === 1 ? 'guess' : 'guesses'}`;
}

function renderGuessList() {
  const sorted = [...game.guesses].sort((a, b) => b.proximity - a.proximity);
  els.list.innerHTML = '';
  for (const g of sorted) {
    const li = document.createElement('li');
    li.className = 'guess-row' + (g.correct ? ' correct' : '');
    li.title = `${g.name} — ${g.distanceKm.toLocaleString()} km away`;

    const swatch = document.createElement('span');
    swatch.className = 'guess-swatch';
    swatch.style.background = heatColor(g.proximity);

    const name = document.createElement('span');
    name.className = 'guess-name';
    name.textContent = g.name;

    const pct = document.createElement('span');
    pct.className = 'guess-pct';
    pct.textContent = `${g.proximityPercent}%`;

    li.append(swatch, name, pct);
    li.addEventListener('click', () => game.globe.flyTo(g));
    els.list.appendChild(li);
  }
}

function updateClosestUi() {
  if (!game.closest) return;
  const pct = game.closest.proximityPercent;
  els.marker.hidden = false;
  els.marker.style.left = `${Math.max(0, Math.min(100, pct))}%`;
  els.flag.textContent = `${game.closest.name} ${pct}%`;
  if (!game.over) {
    setStatus(
      `Guess #${game.guesses.length} · Closest: <span class="hl">${escapeHtml(game.closest.name)}</span> (${pct}%)`
    );
  }
}

function onWin(result) {
  game.over = true;
  els.input.disabled = true;
  els.guessBtn.disabled = true;
  game.globe.markWinner(result.guess.id);
  game.globe.flyTo(result.guess, 1100);
  const n = result.guessCount;
  setStatus(`🎉 Solved in ${n} ${n === 1 ? 'guess' : 'guesses'}!`);

  recordWin(n);
  els.winCountry.textContent = result.answer.name;
  els.winLine.textContent = `Solved in ${n} ${n === 1 ? 'guess' : 'guesses'}.`;
  setTimeout(() => openModal('modal-win'), 700);
}

async function handleGiveUp() {
  if (game.over || !game.id) return;
  const gid = game.id;
  let result;
  try {
    result = await game.backend.giveUp(gid);
  } catch {
    showMessage('Could not give up — try again.');
    return;
  }
  if (game.id !== gid || game.over) return; // stale response — ignore
  game.over = true;
  els.input.disabled = true;
  els.guessBtn.disabled = true;
  recordGiveUp();

  const ans = result.answer;
  game.globe.applyGuess({ id: ans.id, proximity: 1, correct: false });
  game.globe.markWinner(ans.id);
  game.globe.flyTo(ans, 1100);
  setStatus(`The country was ${ans.name}.`);

  els.loseCountry.textContent = ans.name;
  els.loseLine.textContent = game.guesses.length
    ? `You made ${game.guesses.length} ${game.guesses.length === 1 ? 'guess' : 'guesses'}.`
    : 'No guesses made.';
  openModal('modal-lose');
}

// ---------------------------------------------------------------- share

function buildShareText() {
  const answer = els.winCountry.textContent;
  const squares = game.guesses
    .map((g) => {
      if (g.correct) return '🟥';
      if (g.proximity >= 0.85) return '🟧';
      if (g.proximity >= 0.6) return '🟨';
      if (g.proximity >= 0.35) return '🟩';
      return '⬜';
    })
    .join('');
  return `🌍 Globe Guesser\nFound ${answer} in ${game.guesses.length} guesses!\n${squares}`;
}

async function share() {
  const text = buildShareText();
  try {
    if (navigator.share) {
      await navigator.share({ text });
    } else {
      await navigator.clipboard.writeText(text);
      flashButton(els.winShare, 'Copied!');
    }
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      flashButton(els.winShare, 'Copied!');
    } catch {
      flashButton(els.winShare, 'Copy failed');
    }
  }
}

// ---------------------------------------------------------------- modals + ui

function openModal(id) {
  els.modalRoot.hidden = false;
  for (const m of els.modalRoot.querySelectorAll('.modal')) m.hidden = m.id !== id;
  const modal = $(`#${id}`);
  const focusable = modal && modal.querySelector('button:not([data-close]), .btn-primary');
  if (focusable) focusable.focus();
}

function closeModal() {
  els.modalRoot.hidden = true;
  for (const m of els.modalRoot.querySelectorAll('.modal')) m.hidden = true;
}

function renderStats() {
  const s = summarize(loadStats());
  const cells = [
    [s.played, 'Played'],
    [`${s.winPct}%`, 'Win %'],
    [s.avg, 'Avg guesses'],
    [s.best, 'Best'],
    [s.streak, 'Streak'],
    [s.maxStreak, 'Max streak'],
  ];
  els.statsGrid.innerHTML = cells
    .map(([v, l]) => `<div class="stat"><div class="stat-value">${v}</div><div class="stat-label">${l}</div></div>`)
    .join('');
}

function wireUi() {
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    handleGuess();
  });
  els.giveup.addEventListener('click', handleGiveUp);
  els.btnNew.addEventListener('click', () => {
    closeModal();
    startNewGame();
  });
  els.winNew.addEventListener('click', () => {
    closeModal();
    startNewGame();
  });
  els.loseNew.addEventListener('click', () => {
    closeModal();
    startNewGame();
  });
  els.winShare.addEventListener('click', share);
  els.btnStats.addEventListener('click', () => {
    renderStats();
    openModal('modal-stats');
  });
  els.btnHelp.addEventListener('click', () => openModal('modal-help'));
  els.btnTheme.addEventListener('click', toggleTheme);
  els.statsReset.addEventListener('click', () => {
    resetStats();
    renderStats();
  });

  els.modalRoot.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.modalRoot.hidden) closeModal();
  });
}

// ---------------------------------------------------------------- theme

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem(THEME_KEY, next);
  if (game.globe) game.globe.setTheme(next);
}

// ---------------------------------------------------------------- helpers

function setStatus(html) {
  els.status.innerHTML = html;
}
function showMessage(msg) {
  els.message.textContent = msg;
}
function flash(el) {
  el.animate(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }],
    { duration: 240 }
  );
}
function flashButton(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1400);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

init();
