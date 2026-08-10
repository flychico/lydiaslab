/*
  LyDia — data/results_log.csv: the flat, hand-editable results ledger.

  One row per graded market leg (a game can produce up to 3+ rows: one
  moneyline, one game_total, one per pitcher-strikeout prop). This is the
  file to open and fix if a result graded wrong — change `result` (and
  `actual` if the underlying stat was wrong), leave a `note` explaining why,
  then run `node scripts/rebuild-results.js` to regenerate data/results.json
  and results/index.html from it. No network access needed for a rebuild —
  everything a rebuild needs (final score, actual stat, price, result) is
  already in this file.

  `units` is deliberately NOT a stored column. It's always derived from
  `result` + `price` at rebuild time (see computeUnits below) so a hand-edit
  to `result` can never leave a stale unit figure behind — there is nothing
  to forget to also update.
*/

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const LOG_PATH = path.join(ROOT, "data", "results_log.csv");

const HEADERS = [
  "date", "game_pk", "matchup", "final_away", "final_home",
  "market", "pitcher", "pick", "line", "price", "actual", "result", "note"
];

function csvField(s) {
  s = String(s === null || s === undefined ? "" : s);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toRowString(r) {
  return HEADERS.map(h => csvField(r[h] === undefined ? "" : r[h])).join(",");
}

// Minimal CSV line parser — good enough for this file's own quoting (only
// `matchup` and `pick` ever contain a comma, and both get quoted by
// csvField on write). Not a general-purpose CSV parser.
function parseLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function readAllRows() {
  if (!fs.existsSync(LOG_PATH)) return [];
  const lines = fs.readFileSync(LOG_PATH, "utf8").trim().split("\n");
  if (lines.length < 2) return [];
  return lines.slice(1).filter(Boolean).map(line => {
    const vals = parseLine(line);
    const row = {};
    HEADERS.forEach((h, i) => { row[h] = vals[i] !== undefined ? vals[i] : ""; });
    return row;
  });
}

function readRowsForDate(date) {
  return readAllRows().filter(r => r.date === date);
}

// Dedup key mirrors kprops_log.csv's pattern elsewhere in this repo: a
// re-run for a date that's already logged should not duplicate rows.
function rowKey(r) {
  return [r.date, r.game_pk, r.market, r.pitcher || "", r.pick].join("|");
}

// Appends new rows only (skips anything already present for that date+leg).
// Never overwrites an existing row — if you hand-edited a row's `result`,
// re-running the grader for that same date must not stomp your edit.
function appendNewRows(rows) {
  if (!fs.existsSync(LOG_PATH)) {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.writeFileSync(LOG_PATH, HEADERS.join(",") + "\n");
  }
  const seen = new Set(readAllRows().map(rowKey));
  const toAdd = rows.filter(r => !seen.has(rowKey(r)));
  if (!toAdd.length) return 0;
  fs.appendFileSync(LOG_PATH, toAdd.map(toRowString).join("\n") + "\n");
  return toAdd.length;
}

const amToDec = am => am > 0 ? 1 + am / 100 : 1 + 100 / Math.abs(am);

// The ONE place the flat-1-unit staking formula is computed. Called at
// rebuild time from (result, price) — never stored, never hand-edited
// directly, so a corrected `result` always produces a correct `units`.
function computeUnits(result, price) {
  const p = Number(price);
  if (!Number.isFinite(p)) return null;
  if (result === "W") return Number((amToDec(p) - 1).toFixed(4));
  if (result === "L") return -1;
  return null; // PUSH, VOID, NG — no stake outcome
}

module.exports = { HEADERS, LOG_PATH, readAllRows, readRowsForDate, appendNewRows, computeUnits, csvField };
