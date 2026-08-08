// Local statistics, persisted in localStorage. Because play is unlimited, a
// "streak" counts consecutive solved games (giving up resets it).

const KEY = 'globe-guesser:stats:v1';

const EMPTY = {
  played: 0, // finished games (won or gave up)
  wins: 0,
  totalWinGuesses: 0, // sum of guesses over won games (for average)
  best: 0, // fewest guesses in a win (0 = none yet)
  streak: 0,
  maxStreak: 0,
};

export function loadStats() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    return { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    return { ...EMPTY };
  }
}

function save(stats) {
  try {
    localStorage.setItem(KEY, JSON.stringify(stats));
  } catch {
    /* storage unavailable (private mode) — ignore */
  }
}

/** Record a win solved in `guessCount` guesses. */
export function recordWin(guessCount) {
  const s = loadStats();
  s.played += 1;
  s.wins += 1;
  s.totalWinGuesses += guessCount;
  s.best = s.best === 0 ? guessCount : Math.min(s.best, guessCount);
  s.streak += 1;
  s.maxStreak = Math.max(s.maxStreak, s.streak);
  save(s);
  return s;
}

/** Record a given-up game (breaks the streak). */
export function recordGiveUp() {
  const s = loadStats();
  s.played += 1;
  s.streak = 0;
  save(s);
  return s;
}

export function resetStats() {
  save({ ...EMPTY });
  return { ...EMPTY };
}

/** Derived, display-ready values. */
export function summarize(s = loadStats()) {
  const winPct = s.played ? Math.round((s.wins / s.played) * 100) : 0;
  const avg = s.wins ? (s.totalWinGuesses / s.wins).toFixed(1) : '—';
  return {
    played: s.played,
    winPct,
    avg,
    best: s.best || '—',
    streak: s.streak,
    maxStreak: s.maxStreak,
  };
}
