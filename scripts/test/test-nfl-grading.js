/*
  Hand-computed grading test.

  The spread sign convention (NFL_WATCH_LIST #3) is explicitly listed as NOT
  mechanically checkable -- getting it backwards silently inverts every spread
  grade with no error anywhere. This file is that hand check, written down once
  so it stays checked.

  Convention under test: spread_line is stated from the HOME side.
  POSITIVE = home favoured by that many. margin = home_score - away_score.
  Home covers when margin > line.
*/
const fs = require("fs"), path = require("path"), os = require("os");
const cp = require("child_process");

const DIR = path.join(__dirname, "..", "..", "data", "nfl");
const LEDGER = path.join(DIR, "nfl-results-log.csv");
const DATE = "1999-01-01";                      // impossible date: never collides with real data

// Games CSV the script will "fetch".
const GAMES = [
  "game_id,season,week,gameday,away_team,home_team,away_score,home_score",
  // home ATL loses by 1 while getting +2.5 -> HOME COVERS
  "T_COVER,2026,2,1999-01-01,CAR,ATL,24,23",
  // home KC wins by 10 as a 6.5 favourite -> HOME COVERS, total 41 under 44.5
  "T_FAV,2026,2,1999-01-01,IND,KC,17,27"
].join("\n");

const PICKS = [
  { date: DATE, game_id: "T_COVER", matchup: "CAR @ ATL", away: "CAR", home: "ATL",
    week: "2", model_version: "test", status: "pass",
    pick: "ATL", model_prob: 0.70, market_prob: 0.60, edge: 0.10,
    total_status: "pass", total_side: "Over",  proj_total: 50, total_line: 43.5, total_edge: 6.5,
    spread_status: "pass", spread_side: "ATL", proj_spread: 3.0, spread_line: -2.5, spread_edge: 5.5 },
  { date: DATE, game_id: "T_FAV", matchup: "IND @ KC", away: "IND", home: "KC",
    week: "2", model_version: "test", status: "pass",
    pick: "KC", model_prob: 0.75, market_prob: 0.70, edge: 0.05,
    total_status: "pass", total_side: "Under", proj_total: 42, total_line: 44.5, total_edge: 2.5,
    spread_status: "pass", spread_side: "KC",  proj_spread: 7.0, spread_line: 6.5, spread_edge: 0.5 }
];

// --- sandbox: intercept the fetch, and keep every write out of data/ --------
const realExec = cp.execFileSync;
cp.execFileSync = (f, a, o) => (f === "curl" ? GAMES : realExec(f, a, o));

const picksFile = path.join(DIR, `picks-${DATE}.json`);
fs.writeFileSync(picksFile, JSON.stringify(PICKS, null, 2));
const ledgerExisted = fs.existsSync(LEDGER);
const ledgerBackup = ledgerExisted ? fs.readFileSync(LEDGER) : null;

process.argv = [process.argv[0], "script", `--date=${DATE}`, "--force"];
require(path.join(__dirname, "..", "grade-nfl-results.js"));

// --- assertions -----------------------------------------------------------
const { splitCsv } = require(path.join(__dirname, "..", "lib", "odds-history.js"));
const lines = fs.readFileSync(LEDGER, "utf8").trim().split("\n");
const head = splitCsv(lines[0]);
const rows = lines.slice(1).map(l => { const c = splitCsv(l); const o = {}; head.forEach((h,i)=>o[h]=c[i]); return o; })
                  .filter(r => r.date === DATE);

// restore BEFORE asserting, so a failure still cleans up
fs.unlinkSync(picksFile);
if (ledgerExisted) fs.writeFileSync(LEDGER, ledgerBackup); else fs.unlinkSync(LEDGER);
cp.execFileSync = realExec;

let pass = 0, fail = 0;
const ck = (l, c, d) => { c ? (pass++, console.log(`  PASS  ${l}`)) : (fail++, console.log(`  FAIL  ${l} -- ${d}`)); };
const get = (gid, mkt) => rows.find(r => r.game_id === gid && r.market === mkt);

console.log("\nNFL GRADING MATH TEST\n" + "=".repeat(58));

// SPREAD — the sign convention. ATL home, line -2.5 (home underdog), lost by 1.
{
  const r = get("T_COVER", "spread");
  ck("home dog losing by 1 with +2.5 COVERS", r && r.result === "W", r && `result=${r.result}`);
  ck("  actual margin recorded from home side (-1)", r && r.actual_value === "-1", r && `got ${r.actual_value}`);
  // Leo said home by 3.0, actual -1 -> error 4.0. Market said -2.5 -> error 1.5. Market closer.
  ck("  beat_market=N when the line was closer", r && r.beat_market === "N", r && `got ${r.beat_market}`);
  ck("  abs_error = |3.0 - (-1)| = 4", r && r.abs_error === "4", r && `got ${r.abs_error}`);
}
// SPREAD — favourite side. KC home -6.5 favourite, won by 10 -> covers.
{
  const r = get("T_FAV", "spread");
  ck("home favourite winning by 10 as -6.5 COVERS", r && r.result === "W", r && `result=${r.result}`);
  // Leo 7.0 vs actual 10 -> 3.0. Market 6.5 vs 10 -> 3.5. Leo closer.
  ck("  beat_market=Y when Leo was closer", r && r.beat_market === "Y", r && `got ${r.beat_market}`);
}
// MONEYLINE — Brier, from the HOME side.
{
  const r = get("T_COVER", "moneyline");
  // ATL (home) LOST, so home outcome = 0. Leo had home at 0.70 -> Brier 0.49.
  ck("moneyline loss recorded", r && r.result === "L", r && `result=${r.result}`);
  ck("  brier = (0.70-0)^2 = 0.49", r && r.brier === "0.49", r && `got ${r.brier}`);
  ck("  winner recorded as CAR", r && r.actual_value === "CAR", r && `got ${r.actual_value}`);
  ck("  beat_market=N (market had home lower at 0.60)", r && r.beat_market === "N", r && `got ${r.beat_market}`);
}
{
  const r = get("T_FAV", "moneyline");
  // KC (home) WON -> outcome 1. Leo 0.75 -> Brier 0.0625.
  ck("moneyline win recorded", r && r.result === "W", r && `result=${r.result}`);
  ck("  brier = (0.75-1)^2 = 0.0625", r && r.brier === "0.063", r && `got ${r.brier}`);
}
// TOTALS — both directions.
{
  const r = get("T_COVER", "total");   // actual 47, line 43.5, side Over -> W
  ck("Over hits when actual clears the line", r && r.result === "W" && r.actual_value === "47",
     r && `result=${r.result} actual=${r.actual_value}`);
  const r2 = get("T_FAV", "total");    // actual 44, line 44.5, side Under -> W
  ck("Under hits when actual is below the line", r2 && r2.result === "W" && r2.actual_value === "44",
     r2 && `result=${r2.result} actual=${r2.actual_value}`);
  // Leo 42 vs 44 -> 2. Market 44.5 vs 44 -> 0.5. Market closer.
  ck("  total beat_market=N when line was closer", r2 && r2.beat_market === "N", r2 && `got ${r2.beat_market}`);
}
// VARIANCE CLASSES
{
  const r = get("T_FAV", "spread");    // W, error 3.0 <= 7 -> skill
  ck("win with small error classed good_pick_won", r && r.variance_class === "good_pick_won", r && `got ${r.variance_class}`);
}

console.log("=".repeat(58));
console.log(`  ${pass} passed · ${fail} failed\n`);
process.exit(fail ? 1 : 0);
