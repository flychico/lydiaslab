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

module.exports = { appendObservations, splitCsv };
