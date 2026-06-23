// Thin client for the game backend. Each call returns parsed JSON and throws an
// Error (with a `.code` and `.status`) when the server reports a problem.

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty / non-JSON response */
  }

  if (!res.ok) {
    const err = new Error((data && data.message) || (data && data.error) || `HTTP ${res.status}`);
    err.code = data && data.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Fetch the list of guessable country names for autocomplete. */
export function fetchCountryNames() {
  return request('GET', '/api/countries').then((d) => d.names);
}

/** Start a new game; resolves to { gameId, status, guessCount }. */
export function createGame() {
  return request('POST', '/api/games');
}

/** Submit a guess; resolves to the scored result. */
export function submitGuess(gameId, guess) {
  return request('POST', `/api/games/${gameId}/guesses`, { guess });
}

/** Give up the current game; resolves with the revealed answer. */
export function giveUp(gameId) {
  return request('POST', `/api/games/${gameId}/giveup`);
}
