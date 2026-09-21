/*
  Leo — append-only odds observation log.

  THE PROBLEM THIS SOLVES
  -----------------------
  Every gather run rewrites prop-odds-{date}.json in place. On an NFL Sunday
  that file is written at 10am, 2pm and 6pm ET -- so by the end of the day it
  holds the 6pm lines, which are AFTER the 1pm games have already finished.
  The line we actually predicted against is gone, overwritten by a line that
  postdates the result.

  That silently destroys two things we cannot reconstruct later:
    - the CLOSING LINE for any early game, and
    - CLV entirely, which is the single best early read on whether a model
      has edge, long before win/loss has a usable sample.

  So: snapshots stay as they are (they are the convenient "current" view), and
  every observation ALSO lands here, append-only, with the time it was seen and
  the kickoff it precedes. Closing line = the last observation before kickoff.

  APPEND-ON-CHANGE
  ----------------
  Six runs a week x ~260 prop lines would bloat this fast, and an unchanged
  line carries no information. A row is written only when the value actually
  MOVED (or on its first sighting). That makes this a line-movement history,
  which is what CLV needs, at a fraction of the size.

  Rows are IMMUTABLE once written. Nothing in this module updates or deletes.
*/
const fs = require("fs");
const path = require("path");

const q = v => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/*
  file        absolute path to the CSV
  columns     full ordered column list (header)
  rows        array of plain objects keyed by column name
  keyFields   columns identifying the THING being tracked (e.g. date, player, market)
  valueFields columns whose change constitutes a new observation (e.g. line, prices)

  Returns { appended, unchanged, created }.
*/
function appendObservations(file, columns, rows, keyFields, valueFields) {
  const created = !fs.existsSync(file);
  const lastByKey = new Map();

  if (!created) {
    // Read existing rows to find the most recent value per key. Parsed with a
    // real quote-aware splitter -- player names contain commas ("Smith, Jr.")
    // and a naive split would corrupt the comparison and re-append forever.
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length > 1) {
      const header = splitCsv(lines[0]);
      const idx = {}; header.forEach((h, i) => idx[h] = i);
      for (let i = 1; i < lines.length; i++) {
        const c = splitCsv(lines[i]);
        const k = keyFields.map(f => c[idx[f]] ?? "").join("\u0001");
        lastByKey.set(k, valueFields.map(f => c[idx[f]] ?? "").join("\u0001"));
      }
    }
  }

  const out = [];
  let unchanged = 0;
  for (const r of rows) {
    const k = keyFields.map(f => String(r[f] ?? "")).join("\u0001");
    const v = valueFields.map(f => String(r[f] ?? "")).join("\u0001");
    if (lastByKey.get(k) === v) { unchanged++; continue; }
    lastByKey.set(k, v);
    out.push(columns.map(c => q(r[c])).join(","));
  }

  if (created) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, columns.join(",") + "\n");
  }
  if (out.length) fs.appendFileSync(file, out.join("\n") + "\n");
  return { appended: out.length, unchanged, created };
}

// Minimal RFC4180-ish splitter: handles quoted fields and escaped quotes.
function splitCsv(line) {
  const out = []; let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/*
  Reconstruct CLOSING LINES from the observation history.

  WHY THIS IS NOT THE SNAPSHOT
  ----------------------------
  prop-odds-{date}.json holds the LATEST fetch, and as a Sunday progresses the
  books PULL lines for games that have started. By the 7:38pm capture on
  2026-09-20 the snapshot held 62 entries -- only the 8:20pm game -- because
  every earlier game's market had closed. Merging against it left 11 of 306
  projections with a line, the published page looked empty, and LINE-COVER
  (correctly) failed the publish.

  The snapshot also drifts the other way: the 1:14pm capture rewrote 387 lines
  for games that kicked at 1:02pm. Those are LIVE in-game prices. Grading a
  pre-game projection against them would be scoring it against a line that
  already knew part of the answer.

  So the closing line is defined per game, not per file:

      the last observation whose captured_at precedes THAT GAME's kickoff

  which is exactly what the append-on-change history preserves and what no
  single snapshot can.
*/
function closingLines(file, date) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = splitCsv(lines[0]);
  const idx = {}; header.forEach((h, i) => idx[h] = i);

  const best = new Map();   // key -> { row, capturedAt }
  let afterKick = 0, noKick = 0;

  for (let i = 1; i < lines.length; i++) {
    const c = splitCsv(lines[i]);
    const row = {}; header.forEach((h, j) => row[h] = c[j]);
    if (date && row.date !== date) continue;

    const cap = Date.parse(row.captured_at);
    const kick = Date.parse(row.kickoff);
    if (!Number.isFinite(kick)) { noKick++; continue; }
    // Strictly before kickoff. An observation at or after kickoff is a live
    // in-game price, never a closing line.
    if (!(cap < kick)) { afterKick++; continue; }

    const k = `${row.game}\u0001${row.market}\u0001${row.player}`;
    const prev = best.get(k);
    if (!prev || cap > prev.capturedAt) best.set(k, { row, capturedAt: cap });
  }

  const out = [...best.values()].map(({ row, capturedAt }) => ({
    date: row.date,
    market: row.market,
    name: row.player,
    game: row.game,
    kickoff: row.kickoff,
    captured_at: row.captured_at,
    minutes_before_kickoff: Math.round((Date.parse(row.kickoff) - capturedAt) / 60000),
    line: row.line === "" ? null : Number(row.line),
    over_price:  row.over_price  === "" ? null : Number(row.over_price),
    under_price: row.under_price === "" ? null : Number(row.under_price),
    implied_prob:     row.implied_prob     === "" ? null : Number(row.implied_prob),
    implied_prob_raw: row.implied_prob_raw === "" ? null : Number(row.implied_prob_raw),
    vig_removed: row.vig_removed === "true",
    books: row.books === "" ? null : Number(row.books)
  }));
  out._skippedAfterKickoff = afterKick;
  out._skippedNoKickoff = noKick;
  return out;
}

module.exports = { appendObservations, splitCsv, closingLines };
