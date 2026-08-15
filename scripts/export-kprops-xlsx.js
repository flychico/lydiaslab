#!/usr/bin/env node
/*
  LyDia — export a day's K-props capture to Excel.

  Reads data/k-props/<date>.json (written by update-k-props.js) and writes
  data/k-props/<date>.xlsx alongside it, same 43-column schema as
  kprops_log.csv / the 2026-08-09 review workbook. The JSON stays the source
  of truth — grade-calibration.js, update-k-props.js's self-cal reader, and
  everything else keep reading it exactly as before. This is purely an
  additive, human-readable export.

  Run right after update-k-props.js each time it captures (prepare-slate.yml).
  Pre-game, so actual_k / ou_result / lean_result / error columns are blank —
  grade-calibration.js overwrites this same file the next morning once the
  games are graded, filling those in.

  Usage: node scripts/export-kprops-xlsx.js [YYYY-MM-DD]   (defaults to today ET)
*/
const fs = require("fs");
const path = require("path");
const { buildRow, writeWorkbook } = require("./lib/kprops-xlsx");

const ROOT = path.join(__dirname, "..");

const DATE = (process.argv[2] || "").match(/^\d{4}-\d{2}-\d{2}$/)
  ? process.argv[2]
  : new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

// 2026-08-14, Lynold's explicit instruction: the date COLUMN written into
// every ledger/export standardizes on MM/DD/YYYY. DATE itself stays ISO --
// it's still what names the file (data/k-props/<date>.json/.xlsx) -- only
// the date value written INTO the row via buildRow() below changes.
function mmddyyyy(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
}
const DATE_OUT = mmddyyyy(DATE);

async function main() {
  const jsonPath = path.join(ROOT, "data", "k-props", `${DATE}.json`);
  if (!fs.existsSync(jsonPath)) {
    console.log(`No K-props capture for ${DATE} at ${jsonPath} — nothing to export.`);
    return;
  }
  let kp;
  try {
    kp = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch (e) {
    console.warn(`K-props export: could not parse ${jsonPath} — ${e.message}`);
    return;
  }
  if (!kp || !kp.pitchers) {
    console.log(`K-props capture for ${DATE} has no pitchers — nothing to export.`);
    return;
  }

  const rows = Object.values(kp.pitchers)
    .filter(rec => rec && rec.name)
    .map(rec => buildRow(DATE_OUT, rec, null)); // null = not graded yet

  const xlsxPath = path.join(ROOT, "data", "k-props", `${DATE}.xlsx`);
  await writeWorkbook(xlsxPath, rows);
  console.log(`K-props export: wrote ${rows.length} rows to data/k-props/${DATE}.xlsx`);
}

main().catch(e => {
  console.error("K-props export failed:", e.message);
  process.exitCode = 1;
});
