/*
  Hand-computed prop grading test. Stubs the nflverse weekly stats fetch so no
  network and no real data are touched.

  The thing being pinned: BEAT_LINE. "Our projection was close" is not
  evidence. "Our projection was closer than the closing line" is. If that
  comparison is ever inverted, every conclusion drawn from this ledger flips
  while still looking entirely reasonable.
*/
const fs = require("fs"), path = require("path");
const cp = require("child_process");

const DIR = path.join(__dirname, "..", "..", "data", "nfl");
const LEDGER = path.join(DIR, "nfl-props-graded.csv");
const DATE = "1999-01-02";

const STATS = [
  "season,week,team,player_display_name,player_name,position,attempts,passing_yards,passing_tds,carries,rushing_yards,rushing_tds,targets,receiving_yards,receiving_tds",
  // QB threw for 300
  "2026,2,KC,Patrick Mahomes,P.Mahomes,QB,35,300,2,3,10,0,0,0,0",
  // RB ran for 60, scored
  "2026,2,KC,Kenneth Walker III,K.Walker,RB,0,0,0,18,60,1,3,20,0",
  // WR had 40 yards, no TD
  "2026,2,KC,Rashee Rice,R.Rice,WR,0,0,0,0,0,0,7,40,0"
].join("\n");

const PROPS = [
  // Leo 280 vs line 265.5, actual 300 -> OVER hits. Leo err 20, line err 34.5 -> Leo closer
  { date: DATE, game_id: "2026_02_IND_KC", matchup: "IND @ KC", team: "KC", opponent: "IND",
    player: "Patrick Mahomes", position: "QB", depth: "QB1", market: "QB_PASS_YARDS",
    model_version: "test", projection: 280, line: 265.5, lean: "over" },
  // Leo 85 vs line 70.5, actual 60 -> OVER misses. Leo err 25, line err 10.5 -> line closer
  { date: DATE, game_id: "2026_02_IND_KC", matchup: "IND @ KC", team: "KC", opponent: "IND",
    player: "Kenneth Walker III", position: "RB", depth: "RB1", market: "RB_RUSH_YARDS",
    model_version: "test", projection: 85, line: 70.5, lean: "over" },
  // actual 40 lands EXACTLY on the line -> push
  { date: DATE, game_id: "2026_02_IND_KC", matchup: "IND @ KC", team: "KC", opponent: "IND",
    player: "Rashee Rice", position: "WR", depth: "WR1", market: "WR_REC_YARDS",
    model_version: "test", projection: 55, line: 40, lean: "over" },
  // TD: Leo 0.55, market 0.50, actual SCORED (1). Brier .2025 vs .25 -> Leo better
  { date: DATE, game_id: "2026_02_IND_KC", matchup: "IND @ KC", team: "KC", opponent: "IND",
    player: "Kenneth Walker III", position: "RB", depth: "RB1", market: "ANYTIME_TD",
    model_version: "test", projection: 0.55, market_prob: 0.50, lean: "over" },
  // sidelined -> must be excluded, never graded
  { date: DATE, game_id: "2026_02_IND_KC", matchup: "IND @ KC", team: "KC", opponent: "IND",
    player: "Rashee Rice", position: "WR", depth: "WR1", market: "ANYTIME_TD",
    model_version: "test", projection: 0.4, sidelined: true, injury_status: "Out" }
];

const realExec = cp.execFileSync;
cp.execFileSync = (f, a, o) => (f === "curl" ? STATS : realExec(f, a, o));

const propsFile = path.join(DIR, `props-${DATE}.json`);
fs.writeFileSync(propsFile, JSON.stringify(PROPS, null, 2));
const existed = fs.existsSync(LEDGER);
const backup = existed ? fs.readFileSync(LEDGER) : null;

process.argv = [process.argv[0], "script", `--date=${DATE}`, "--week=2", "--force"];
require(path.join(__dirname, "..", "grade-nfl-props.js"));

const { splitCsv } = require(path.join(__dirname, "..", "lib", "odds-history.js"));
const L = fs.readFileSync(LEDGER, "utf8").trim().split("\n");
const h = splitCsv(L[0]);
const rows = L.slice(1).map(l => { const c = splitCsv(l); const o = {}; h.forEach((x,i)=>o[x]=c[i]); return o; })
              .filter(r => r.date === DATE);

fs.unlinkSync(propsFile);
if (existed) fs.writeFileSync(LEDGER, backup); else fs.unlinkSync(LEDGER);
cp.execFileSync = realExec;

let pass = 0, fail = 0;
const ck = (l,c,d) => { c ? (pass++,console.log(`  PASS  ${l}`)) : (fail++,console.log(`  FAIL  ${l} -- ${d}`)); };
const g = (pl,mk) => rows.find(r => r.player === pl && r.market === mk);

console.log("\nNFL PROP GRADING MATH TEST\n" + "=".repeat(58));
{
  const r = g("Patrick Mahomes","QB_PASS_YARDS");
  ck("over hits when actual clears line", r && r.result === "W" && r.actual === "300", r && `${r.result}/${r.actual}`);
  ck("  beat_line=Y when Leo closer (20 vs 34.5)", r && r.beat_line === "Y", r && `got ${r.beat_line}`);
  ck("  abs_error 20, line_abs_error 34.5", r && r.abs_error === "20" && r.line_abs_error === "34.5",
     r && `${r.abs_error}/${r.line_abs_error}`);
}
{
  const r = g("Kenneth Walker III","RB_RUSH_YARDS");
  ck("over misses when actual below line", r && r.result === "L", r && `got ${r.result}`);
  ck("  beat_line=N when line closer (10.5 vs 25)", r && r.beat_line === "N", r && `got ${r.beat_line}`);
}
{
  const r = g("Rashee Rice","WR_REC_YARDS");
  ck("actual exactly on the line is a PUSH", r && r.result === "P", r && `got ${r.result}`);
}
{
  const r = g("Kenneth Walker III","ANYTIME_TD");
  ck("anytime TD hit recorded", r && r.result === "W" && r.actual === "1", r && `${r.result}/${r.actual}`);
  // 0.55-1 is -0.44999999999999996 in IEEE754, so the square is
  // 0.20249999999999996 and rounds DOWN to 0.202, not the 0.2025 -> 0.203 you
  // get by hand. The code is right; arithmetic on binary floats is the reason.
  ck("  brier = (0.55-1)^2 rounds to 0.202", r && r.brier === "0.202", r && `got ${r.brier}`);
  ck("  beat_line=Y (.2025 < market .25)", r && r.beat_line === "Y", r && `got ${r.beat_line}`);
}
{
  const r = g("Rashee Rice","ANYTIME_TD");
  ck("sidelined player excluded, never graded",
     r && r.excluded === "Y" && r.actual === "" && r.result === "",
     r && `excl=${r.excluded} actual=${r.actual}`);
  ck("  exclusion reason recorded", r && /Out/.test(r.exclude_reason), r && `got ${r.exclude_reason}`);
}
console.log("=".repeat(58));
console.log(`  ${pass} passed · ${fail} failed\n`);
process.exit(fail ? 1 : 0);
