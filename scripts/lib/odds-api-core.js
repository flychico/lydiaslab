/*
  Leo — the-odds-api.com key rotation.

  Every script that calls api.the-odds-api.com used to read a single
  ODDS_API_KEY and build its own request URL. When that one key ran out of
  quota, the call failed (or the caller silently skipped odds for the day)
  even though other keys were sitting unused. This module lets up to four
  keys back each other up automatically.

  Reads ODDS_API_KEY, ODDS_API_KEY_2, ODDS_API_KEY_3, ODDS_API_KEY_4 from the
  environment (any missing ones are just skipped -- one key still works fine,
  same as before). fetchOddsApi() tries the current key; if the-odds-api
  responds 401 (invalid/revoked) or 429 (rate-limited / out of calls), it
  moves to the next key and retries the SAME request. Any other HTTP error
  (400, 5xx, etc.) is not a "key is dry" situation, so it's thrown immediately
  instead of burning through all four keys for a problem rotating won't fix.

  Remembers which key last worked in data/.odds-api-key-state.json (a normal
  file, committed by each workflow's own `git add -A` step) so tomorrow's run
  starts from that key instead of wasting a call re-trying one already known
  to be dry. If key 1 gets refilled/rotated later, nothing moves it back to
  key 1 automatically -- it just keeps using whichever key last worked. That's
  fine: the goal is "never get stuck," not "always prefer key 1."
*/
const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "..", "..", "data", ".odds-api-key-state.json");
const KEY_ENV_NAMES = ["ODDS_API_KEY", "ODDS_API_KEY_2", "ODDS_API_KEY_3", "ODDS_API_KEY_4"];
const KEY_EXHAUSTED_STATUSES = new Set([401, 429]);

let lastQuota = null;
// Quota from the most recent successful call: { remaining, used, keyName, at }.
function getLastQuota() { return lastQuota; }

function loadKeys() {
  const keys = [];
  for (const name of KEY_ENV_NAMES) {
    const v = (process.env[name] || "").trim();
    if (v) keys.push({ name, value: v });
  }
  return keys;
}

function loadStartIndex(keyCount) {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (Number.isInteger(s.lastGoodIndex) && s.lastGoodIndex >= 0 && s.lastGoodIndex < keyCount) return s.lastGoodIndex;
  } catch (e) { /* no state yet, or keyCount shrank since it was written -- start at 0 */ }
  return 0;
}

function saveGoodIndex(i, name) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastGoodIndex: i, lastGoodKeyName: name, updated: new Date().toISOString() }, null, 2));
  } catch (e) {
    // Non-fatal -- rotation still works for the rest of this run even if the
    // state file can't be written (e.g. read-only checkout).
  }
}

// urlWithoutKey: a the-odds-api.com URL with every query param EXCEPT apiKey
// already attached. This function appends "apiKey=..." itself, so callers
// never handle a raw key value.
async function fetchOddsApi(urlWithoutKey, fetchOpts) {
  const keys = loadKeys();
  if (!keys.length) throw new Error("No ODDS_API_KEY, ODDS_API_KEY_2, ODDS_API_KEY_3, or ODDS_API_KEY_4 is set.");
  const sep = urlWithoutKey.includes("?") ? "&" : "?";
  const startIndex = loadStartIndex(keys.length);

  let lastStatus = null;
  for (let offset = 0; offset < keys.length; offset++) {
    const i = (startIndex + offset) % keys.length;
    const key = keys[i];
    const url = `${urlWithoutKey}${sep}apiKey=${encodeURIComponent(key.value)}`;
    const res = await fetch(url, fetchOpts);
    if (res.ok) {
      saveGoodIndex(i, key.name);
      // Capture the provider's quota headers so callers can report burn.
      // Player-prop endpoints are per-event and cost [markets] x [regions]
      // credits EACH, so a silent quota drain is a real risk.
      const rem = Number(res.headers.get("x-requests-remaining"));
      const used = Number(res.headers.get("x-requests-used"));
      lastQuota = {
        remaining: Number.isFinite(rem) ? rem : null,
        used: Number.isFinite(used) ? used : null,
        keyName: key.name,
        at: new Date().toISOString()
      };
      return await res.json();
    }
    if (!KEY_EXHAUSTED_STATUSES.has(res.status)) {
      throw new Error(`HTTP ${res.status}: ${urlWithoutKey}`);
    }
    console.warn(`odds-api-core: ${key.name} returned HTTP ${res.status} (exhausted/invalid) -- trying next key.`);
    lastStatus = res.status;
  }
  throw new Error(`All ${keys.length} configured odds-api key(s) returned ${lastStatus} -- every key is out of quota or invalid.`);
}

module.exports = { fetchOddsApi, loadKeys, getLastQuota };
