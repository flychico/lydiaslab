#!/usr/bin/env node
"use strict";
/*
  LyDia — one-time backfill of projection_raw into kprops_log.csv.

  WHY
  The banded self-calibration in update-k-props.js needs each graded start's
  PRE-correction projection to decide which band it belongs to. Banding on the
  corrected number measures the residual left over from an earlier correction
  rather than the model's own error — that is how the sub-6K band appeared
  unbiased at -0.09 when its true error was -0.48.

  New rows carry projection_raw from 2026-08-02 onward. Every daily capture in
  data/k-props/*.json already recorded projection_raw at the time, so the
  history can be recovered exactly instead of waiting for the window to roll
  over. Joins on (date, pitcher name, lowercased).

  Rows with no matching capture keep an empty projection_raw and fall back to
  the corrected value, which is what update-k-props.js already does.

  SAFETY
  Dry run by default. --write makes a .backup first. Idempotent: a row that
  already has projection_raw is left alone.

    node scripts/backfill-kprops-raw.js
    node scripts/backfill-kprops-raw.js --write
*/

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LOG = path.join(ROOT, "data", "calibration", "kprops_log.csv");
const CAPTURE_DIR = path.join(ROOT, "data", "k-props");
const WRITE = process.argv.includes("--write");

const HEADER = "date,pitcher,line,over_price,under_price,projection,actual_k,ou_result,lean,lean_result,projection_raw,calibration_band";
const RAW_IDX = 10, BAND_IDX = 11;

// Must match K_BANDS in update-k-props.js. Kept as a literal rather than an
// import because this is a one-time script that should still run correctly if
// the bands are retuned later — it records what the bands were at backfill time.
const bandFor = p => (p < 6 ? "<6" : p < 7 ? "6-7" : ">=7");

if (!fs.existsSync(LOG)) { console.error(`No ledger at ${LOG}`); process.exit(1); }

/* ---- collect projection_raw from every daily capture ---- */
const raw = new Map();
let captureFiles = 0;
for (const f of fs.readdirSync(CAPTURE_DIR)) {
  if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;   // skip today.json
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(CAPTURE_DIR, f), "utf8")); } catch (e) { continue; }
  if (!d || !d.date || !d.pitchers) continue;
  captureFiles++;
  for (const p of Object.values(d.pitchers)) {
    if (!p || typeof p !== "object") continue;
    if (!p.name || !Number.isFinite(Number(p.projection_raw))) continue;
    raw.set(`${d.date}|${String(p.name).trim().toLowerCase()}`, Number(p.projection_raw));
  }
}
console.log(`Read ${captureFiles} daily capture(s); ${raw.size} pitcher-start(s) carry projection_raw.`);

/* ---- walk the ledger ---- */
const lines = fs.readFileSync(LOG, "utf8").split("\n");
const bodyIn = lines.slice(1).filter(l => l.trim() !== "");
let filled = 0, already = 0, missed = 0;
const missedSamples = [];

const bodyOut = bodyIn.map(line => {
  const c = line.split(",");
  while (c.length < BAND_IDX + 1) c.push("");
  if (c[RAW_IDX] !== "" && isFinite(Number(c[RAW_IDX]))) { already++; return c.join(","); }
  const key = `${c[0]}|${String(c[1] || "").trim().toLowerCase()}`;
  if (raw.has(key)) {
    const v = raw.get(key);
    c[RAW_IDX] = String(v);
    c[BAND_IDX] = bandFor(v);
    filled++;
  } else {
    missed++;
    if (missedSamples.length < 8) missedSamples.push(`${c[0]} ${c[1]}`);
  }
  return c.join(",");
});

console.log(`\nLedger rows: ${bodyIn.length}`);
console.log(`  already had projection_raw: ${already}`);
console.log(`  backfilled:                 ${filled}`);
console.log(`  no matching capture:        ${missed}`);
if (missedSamples.length) console.log(`    e.g. ${missedSamples.join("; ")}`);

/* ---- what the bands look like after the backfill ---- */
const bands = {};
for (const line of bodyOut) {
  const c = line.split(",");
  const r = Number(c[RAW_IDX]), a = Number(c[6]);
  if (!isFinite(r) || !isFinite(a) || c[RAW_IDX] === "" || c[6] === "") continue;
  (bands[bandFor(r)] = bands[bandFor(r)] || []).push(a - r);
}
console.log(`\nBias by band on backfilled raw projections:`);
for (const b of ["<6", "6-7", ">=7"]) {
  const v = bands[b] || [];
  if (!v.length) { console.log(`  ${b.padEnd(5)} no rows`); continue; }
  const m = v.reduce((x, y) => x + y, 0) / v.length;
  console.log(`  ${b.padEnd(5)} n=${String(v.length).padStart(3)}  bias ${m >= 0 ? "+" : ""}${m.toFixed(2)}`);
}

if (!WRITE) {
  console.log(`\nDry run — nothing written. Re-run with --write to apply.`);
  process.exit(0);
}

fs.copyFileSync(LOG, LOG + ".backup");
fs.writeFileSync(LOG, HEADER + "\n" + bodyOut.join("\n") + "\n");
console.log(`\nWrote ${path.basename(LOG)} (backup: ${path.basename(LOG)}.backup)`);
