#!/usr/bin/env node
/*
  LyDia — ONE-TIME migration: convert the existing (pre-CSV) data/results.json
  into data/results_log.csv rows, so switching to the new CSV-driven
  grade-results.js / rebuild-results.js doesn't lose the 31 days of history
  already graded under the old system.

  Run this ONCE, before the new grade-results.js runs for the first time.
  Safe to re-run: appendNewRows() skips rows that already exist (same dedup
  key as live grading), so running it twice is a no-op the second time.

  After running this, `node scripts/rebuild-results.js` should reproduce
  data/results.json content-equivalent to what's live today.

  Usage: node scripts/backfill-results-log.js
*/
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const { appendNewRows } = require("./lib/results-log");

const OLD_RESULTS_PATH = path.join(ROOT, "data", "results.json");

function main() {
  if (!fs.existsSync(OLD_RESULTS_PATH)) {
    console.log("No existing data/results.json found — nothing to backfill.");
    return;
  }
  const old = JSON.parse(fs.readFileSync(OLD_RESULTS_PATH, "utf8"));
  const days = old.days || {};
  const rows = [];

  for (const date of Object.keys(days)) {
    const picks = days[date].picks || [];
    for (const p of picks) {
      const matchup = `${p.away} @ ${p.home}`;
      const base = { date, game_pk: p.gamePk, matchup, final_away: p.finalAway ?? "", final_home: p.finalHome ?? "", note: "backfilled from pre-2026-08-09 results.json" };

      // Ungraded game: no mlResult key at all is how the old schema marked
      // "not final yet" (see p.result === "NG" with mlResult absent).
      if (!("mlResult" in p)) {
        rows.push({ ...base, market: "NG", pitcher: "", pick: "", line: "", price: "", actual: "", result: "NG" });
        continue;
      }

      if (p.moneyline && p.moneyline.pick && !p.moneyline.isPass && p.mlResult && p.mlResult !== "NG") {
        rows.push({ ...base, market: "moneyline", pitcher: "", pick: p.moneyline.pick, line: "", price: p.moneyline.bestAm ?? "", actual: "", result: p.mlResult });
      }

      if (p.total && p.total.pick && p.totResult && p.totResult !== "NG") {
        const totalRuns = (Number.isFinite(p.finalAway) && Number.isFinite(p.finalHome)) ? p.finalAway + p.finalHome : "";
        rows.push({ ...base, market: "game_total", pitcher: "", pick: p.total.pick, line: p.total.line ?? "", price: p.total.bestAm ?? "", actual: totalRuns, result: p.totResult });
      }

      const kList = Array.isArray(p.kResults) ? p.kResults : [];
      for (const k of kList) {
        rows.push({ ...base, market: "pitcher_strikeouts", pitcher: k.pitcher, pick: k.pick, line: k.line ?? "", price: Number.isFinite(k.bestAm) ? k.bestAm : "", actual: k.actual ?? "", result: k.result });
      }

      if (p.runLine && p.runLine.pick && p.rlResult && p.rlResult !== "NG") {
        const pickLabel = `${p.runLine.pick} ${p.runLine.point > 0 ? "+" : ""}${p.runLine.point ?? ""}`;
        rows.push({ ...base, market: "run_line", pitcher: "", pick: pickLabel, line: p.runLine.point ?? "", price: p.runLine.bestAm ?? "", actual: "", result: p.rlResult });
      }
    }
  }

  const added = appendNewRows(rows);
  console.log(`Backfilled ${added} row(s) into data/results_log.csv from ${Object.keys(days).length} day(s) in the old results.json (${rows.length} rows built, ${rows.length - added} already present).`);
}

main();
