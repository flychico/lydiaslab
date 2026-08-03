#!/usr/bin/env node
"use strict";
/*
  LyDia — one-time ledger consolidation.

  THE PROBLEM THIS FIXES
  Four learning ledgers exist as old/new pairs. When each versioned ledger was
  introduced it started a fresh file instead of migrating the existing rows, so
  every one of these questions now has two answers:

      calibration_log.csv      07-09 .. 07-22   ->  calibration_model_log.csv   07-22 .. now
      totals_log.csv           07-18 .. 07-22   ->  totals_model_log.csv        07-23 .. 07-28
      attribution_log.csv      07-09 .. 07-22   ->  attribution_model_log.csv   07-22 .. now
      shadow_v3_log.csv        07-09 .. 07-22   ->  shadow_model_log.csv        07-22 .. now

  Anything reading the old name silently analyses a truncated history and
  anything reading the new name silently discards the first two weeks. Both
  failure modes are quiet, which is how a calibration review ran against 134
  games when 261 were available.

  WHAT THIS DOES
  Merges each pair into the versioned (new) filename, which becomes the single
  canonical ledger. Legacy rows are widened to the versioned schema and tagged
  model_version = "legacy-unversioned" — deliberately NOT a guessed version
  string, because we do not actually know which model build produced them, and
  inventing one would make the ledger lie with more confidence than before.

  Rows are keyed on date+gamePk. Where a key exists in both files the versioned
  row wins, since it carries real provenance.

  SAFETY
  Dry run by default: prints exactly what would happen and changes nothing.
    node scripts/consolidate-ledgers.js
    node scripts/consolidate-ledgers.js --write        (writes merged files)
    node scripts/consolidate-ledgers.js --write --delete-old   (also removes retired files)

  --write refuses to proceed if any key present in an input file is missing from
  the merged output. These are append-only evidence ledgers; losing a row is
  worse than leaving the split in place.

  A .backup copy of each destination is written before it is overwritten.
*/

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "data", "calibration");
const WRITE = process.argv.includes("--write");
const DELETE_OLD = process.argv.includes("--delete-old");
const LEGACY = "legacy-unversioned";

/* ---------- minimal CSV that respects quoted fields ---------- */
function splitCsvLine(line) {
  const out = [];
  let field = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(field); field = ""; }
    else field += c;
  }
  out.push(field);
  return out;
}
const csvField = s => {
  s = String(s == null ? "" : s);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function readCsv(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(l => l.trim() !== "");
  if (!lines.length) return null;
  return { header: splitCsvLine(lines[0]), rows: lines.slice(1).map(splitCsvLine) };
}

/*
  Each ledger declares how a legacy row becomes a versioned row. Written as an
  explicit column map rather than a positional splice so that a future schema
  change fails loudly here instead of silently shifting every field by one.
*/
const LEDGERS = [
  {
    name: "calibration",
    old: "calibration_log.csv",
    dest: "calibration_model_log.csv",
    header: "date,gamePk,model_version,matchup,model_side,status,model_prob,market_prob,lab_score,best_price,result,final_score",
    // old: date,gamePk,matchup,model_side,status,model_prob,market_prob,lab_score,best_price,result,final_score
    widen: r => [r[0], r[1], LEGACY, r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10]]
  },
  {
    name: "totals",
    old: "totals_log.csv",
    dest: "totals_model_log.csv",
    header: "date,gamePk,model_version,line,over_price,under_price,projection,actual_total,ou_result,lean,lean_result,setup_rating,classification,matchup",
    // old: date,gamePk,line,over_price,under_price,projection,actual_total,ou_result,lean,lean_result,lab_score,matchup
    // NOTE the old file is ragged: the earliest 18 rows stop after lean_result
    // (no lab_score, no matchup). r[10]/r[11] are simply undefined there and
    // become empty cells, which is the honest representation.
    // old lab_score maps to setup_rating; classification was not recorded then.
    widen: r => [r[0], r[1], LEGACY, r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10] ?? "", "", r[11] ?? ""]
  },
  {
    name: "attribution",
    old: "attribution_log.csv",
    dest: "attribution_model_log.csv",
    header: "date,gamePk,model_version,status,result,model_prob,lab,pitcher_gap,kbb_diff,gb_pick,babip_pick,off_delta_diff,bullpen_gap",
    // old: date,gamePk,status,result,model_prob,lab,pitcher_gap,kbb_diff,gb_pick,babip_pick,off_delta_diff,bullpen_gap
    widen: r => [r[0], r[1], LEGACY, r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11]]
  },
  {
    name: "shadow",
    old: "shadow_v3_log.csv",
    dest: "shadow_model_log.csv",
    header: "date,gamePk,official_model_version,shadow_model_version,p_home_official,p_home_shadow,home_won",
    // old: date,gamePk,p_home_v2,p_home_v3,home_won
    // Both version columns are legacy: the old file recorded neither the
    // official build nor which shadow revision (v3.0 vs v3.1) produced p_home_v3.
    widen: r => [r[0], r[1], LEGACY, LEGACY, r[2], r[3], r[4]]
  }
];

const key = r => `${r[0]}|${r[1]}`;
const pad = (s, n) => String(s).padEnd(n);

let anyFailure = false;
const plan = [];

for (const L of LEDGERS) {
  const oldPath = path.join(DIR, L.old);
  const destPath = path.join(DIR, L.dest);
  const oldCsv = readCsv(oldPath);
  const destCsv = readCsv(destPath);
  const expected = L.header.split(",");

  console.log(`\n=== ${L.name} ===`);

  if (!oldCsv && !destCsv) { console.log("  neither file present — nothing to do."); continue; }

  if (destCsv && destCsv.header.join(",") !== L.header) {
    console.log(`  ! destination header does not match the expected schema.`);
    console.log(`      found:    ${destCsv.header.join(",")}`);
    console.log(`      expected: ${L.header}`);
    console.log(`    Refusing to touch this ledger — the schema changed and the`);
    console.log(`    column map above needs updating before a merge is safe.`);
    anyFailure = true;
    continue;
  }

  const merged = new Map();
  let legacyCount = 0, versionedCount = 0, overlap = 0;

  // legacy first, so a versioned row with the same key overwrites it
  if (oldCsv) {
    for (const r of oldCsv.rows) {
      if (!r[0] || !r[1]) continue;
      const widened = L.widen(r);
      if (widened.length !== expected.length) {
        console.log(`  ! widened row has ${widened.length} columns, expected ${expected.length} — aborting this ledger.`);
        anyFailure = true;
        legacyCount = -1;
        break;
      }
      merged.set(key(r), widened);
      legacyCount++;
    }
  }
  if (legacyCount === -1) continue;

  if (destCsv) {
    for (const r of destCsv.rows) {
      if (!r[0] || !r[1]) continue;
      if (merged.has(key(r))) overlap++;
      merged.set(key(r), r);
      versionedCount++;
    }
  }

  // no row may vanish
  const lost = [];
  for (const src of [oldCsv, destCsv]) {
    if (!src) continue;
    for (const r of src.rows) {
      if (!r[0] || !r[1]) continue;
      if (!merged.has(key(r))) lost.push(key(r));
    }
  }

  const rows = [...merged.values()].sort((a, b) =>
    a[0] === b[0] ? String(a[1]).localeCompare(String(b[1])) : a[0].localeCompare(b[0]));

  const dates = rows.map(r => r[0]).filter(Boolean);
  console.log(`  ${pad(L.old, 26)} ${legacyCount} legacy row(s)`);
  console.log(`  ${pad(L.dest, 26)} ${versionedCount} versioned row(s)`);
  console.log(`  overlapping key(s):        ${overlap}  (versioned row kept)`);
  console.log(`  merged total:              ${rows.length}`);
  console.log(`  coverage:                  ${dates[0] || "-"} .. ${dates[dates.length - 1] || "-"}`);
  if (lost.length) {
    console.log(`  ! ${lost.length} key(s) would be LOST — refusing. First few: ${lost.slice(0, 5).join(", ")}`);
    anyFailure = true;
    continue;
  }
  console.log(`  row-loss check:            pass`);

  const body = L.header + "\n" + rows.map(r => r.map(csvField).join(",")).join("\n") + "\n";
  plan.push({ ledger: L, destPath, oldPath, body, hadOld: Boolean(oldCsv) });
}

console.log("");
if (anyFailure) {
  console.log("One or more ledgers failed their checks. Nothing was written.");
  process.exit(1);
}

if (!WRITE) {
  console.log("Dry run — no files changed. Re-run with --write to apply.");
  process.exit(0);
}

for (const p of plan) {
  if (fs.existsSync(p.destPath)) fs.copyFileSync(p.destPath, p.destPath + ".backup");
  fs.writeFileSync(p.destPath, p.body);
  console.log(`wrote ${path.basename(p.destPath)} (backup: ${path.basename(p.destPath)}.backup)`);
}

if (DELETE_OLD) {
  for (const p of plan) {
    if (p.hadOld && fs.existsSync(p.oldPath)) {
      fs.unlinkSync(p.oldPath);
      console.log(`removed ${path.basename(p.oldPath)}`);
    }
  }
} else {
  const stale = plan.filter(p => p.hadOld).map(p => path.basename(p.oldPath));
  if (stale.length) {
    console.log("\nRetired files still on disk (re-run with --delete-old, or delete by hand):");
    for (const s of stale) console.log(`  data/calibration/${s}`);
  }
}

console.log("\nDone. Every reader should now use the *_model_log.csv name.");
