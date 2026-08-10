#!/usr/bin/env node
/* LyDia — grade published picks against final scores, log to
   data/results_log.csv, then rebuild data/results.json and
   results/index.html from that log.
   Usage: node scripts/grade-results.js [YYYY-MM-DD]  (default: yesterday in US Eastern)
   Reads first: data/published-picks/<date>.json
   Fallback:    data/picks/<date>.json for pre-lock historical days
   Writes:      data/results_log.csv, data/results.json, results/index.html,
                data/clv/clv_log.csv

   2026-08-09: previously this script computed wins/losses/units and wrote
   data/results.json directly in one pass — there was nowhere to correct a
   mis-graded pick except hand-editing that nested JSON. Now grading only
   APPENDS flat rows to data/results_log.csv (one row per market leg); a
   separate rebuild step (shared with scripts/rebuild-results.js, see
   scripts/lib/results-rebuild.js) turns that log into results.json and the
   HTML page. To correct a result: edit the row in results_log.csv, then run
   `node scripts/rebuild-results.js` — no need to re-run grading, no network
   call, and nothing here will overwrite your edit (grading only appends new
   rows, never rewrites existing ones).
*/
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const { appendNewRows, computeUnits, csvField } = require("./lib/results-log");
const {
  normPick, loadPicksForDate, loadMarketMap, pickId, buildLearning, clvResult,
  rebuildAll, rebuildResultsPage
} = require("./lib/results-rebuild");

function etYesterday() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  et.setDate(et.getDate() - 1);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}
const DATE = process.argv[2] || etYesterday();

const CLV_PATH = path.join(ROOT, "data", "clv", "clv_log.csv");

async function gradeDay() {
  const loaded = loadPicksForDate(DATE);
  if (!loaded) { console.log(`No published picks file for ${DATE} — nothing to grade.`); return 0; }
  const { picks } = loaded.data;
  if (!Array.isArray(picks)) throw new Error(`${loaded.file} does not contain a picks array.`);
  console.log(`Grading ${DATE} from ${loaded.source}: ${path.relative(ROOT, loaded.file)}`);

  const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}`);
  if (!res.ok) throw new Error("Schedule HTTP " + res.status);
  const sched = await res.json();
  const finals = {};
  for (const g of (((sched.dates || [])[0]) || {}).games || []) {
    if (g.status.abstractGameState === "Final" && g.teams.away.score !== undefined) {
      finals[g.gamePk] = { awayScore: g.teams.away.score, homeScore: g.teams.home.score };
    }
  }

  const marketMap = loadMarketMap(DATE);

  const boxCache = {};
  async function getBox(gamePk) {
    if (boxCache[gamePk] !== undefined) return boxCache[gamePk];
    try {
      const res = await fetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`);
      boxCache[gamePk] = res.ok ? await res.json() : null;
    } catch (e) { boxCache[gamePk] = null; }
    return boxCache[gamePk];
  }

  const csvRows = [];
  const clvRows = [];

  for (const raw of picks) {
    const p = normPick(raw);
    const f = finals[p.gamePk];

    if (!f || f.awayScore === f.homeScore) {
      // Not final yet (or a tie edge case) — log one NG placeholder row so
      // rebuild can tell "not gradeable yet" apart from "never attempted".
      csvRows.push({ date: DATE, game_pk: p.gamePk, matchup: `${p.away} @ ${p.home}`, final_away: "", final_home: "", market: "NG", pitcher: "", pick: "", line: "", price: "", actual: "", result: "NG", note: "" });
      continue;
    }

    const homeWon = f.homeScore > f.awayScore;
    const totalRuns = f.awayScore + f.homeScore;
    const margin = f.homeScore - f.awayScore;
    const matchup = `${p.away} @ ${p.home}`;
    const base = { date: DATE, game_pk: p.gamePk, matchup, final_away: f.awayScore, final_home: f.homeScore, note: "" };

    if (p.moneyline && p.moneyline.pick && !p.moneyline.isPass) {
      const won = (p.moneyline.side === "home") === homeWon;
      const mlResult = won ? "W" : "L";
      csvRows.push({ ...base, market: "moneyline", pitcher: "", pick: p.moneyline.pick, line: "", price: p.moneyline.bestAm ?? "", actual: "", result: mlResult });
      const learning = buildLearning(p, mlResult, marketMap.get(pickId(p, DATE)) || marketMap.get(`${p.away} @ ${p.home}|${p.moneyline.pick}`), loaded.source);
      clvRows.push({ date: DATE, market: "moneyline", matchup, pick: p.moneyline.pick, priceTaken: learning.posted_price, closingPrice: learning.closing_price, clv: learning.clv_result, labScore: learning.lab_score, modelProb: learning.model_probability, rawEdge: learning.raw_edge, result: mlResult, lesson: learning.lesson_tag });
    }

    if (p.total && p.total.pick) {
      const won = p.total.pick === "Over" ? totalRuns > p.total.line : totalRuns < p.total.line;
      const totResult = totalRuns === p.total.line ? "PUSH" : (won ? "W" : "L");
      csvRows.push({ ...base, market: "game_total", pitcher: "", pick: p.total.pick, line: p.total.line, price: p.total.bestAm ?? "", actual: totalRuns, result: totResult });
      clvRows.push({ date: DATE, market: "game_total", matchup, pick: `${p.total.pick} ${p.total.line}`, priceTaken: p.total.bestAm, closingPrice: "", clv: "not_tracked", labScore: p.total.labScore || "", modelProb: "", rawEdge: p.total.edge ?? "", result: totResult, lesson: "official_total" });
    }

    if (p.strikeouts.length) {
      const box = await getBox(p.gamePk);
      for (const k of p.strikeouts) {
        let actual = null;
        if (box) for (const side of ["away", "home"]) {
          const players = (box.teams && box.teams[side] && box.teams[side].players) || {};
          for (const player of Object.values(players)) {
            if (player.person && player.person.fullName === k.pitcher && player.stats && player.stats.pitching && player.stats.pitching.inningsPitched !== undefined) {
              actual = Number(player.stats.pitching.strikeOuts) || 0;
            }
          }
        }
        let result;
        if (actual === null) result = "VOID";
        else if (actual === k.line) result = "PUSH";
        else result = (k.pick === "Over" ? actual > k.line : actual < k.line) ? "W" : "L";
        csvRows.push({ ...base, market: "pitcher_strikeouts", pitcher: k.pitcher, pick: k.pick, line: k.line, price: Number.isFinite(k.bestAm) ? k.bestAm : "", actual: actual ?? "", result });
        clvRows.push({ date: DATE, market: "pitcher_strikeouts", matchup, pick: `${k.pitcher} ${k.pick} ${k.line}`, priceTaken: k.bestAm, closingPrice: "", clv: "not_tracked", labScore: "", modelProb: "", rawEdge: k.edge ?? "", result, lesson: result === "VOID" ? "pitcher_did_not_appear" : "official_k" });
      }
    }

    if (p.runLine && p.runLine.pick) {
      const pickedHome = p.runLine.pick === p.home;
      const adjMargin = pickedHome ? margin + p.runLine.point : -margin + p.runLine.point;
      const rlResult = adjMargin === 0 ? "PUSH" : (adjMargin > 0 ? "W" : "L");
      csvRows.push({ ...base, market: "run_line", pitcher: "", pick: `${p.runLine.pick} ${p.runLine.point > 0 ? "+" : ""}${p.runLine.point}`, line: p.runLine.point, price: p.runLine.bestAm ?? "", actual: "", result: rlResult });
      clvRows.push({ date: DATE, market: "run_line", matchup, pick: `${p.runLine.pick} ${p.runLine.point > 0 ? "+" : ""}${p.runLine.point}`, priceTaken: p.runLine.bestAm, closingPrice: "", clv: "legacy_not_tracked", labScore: p.labScore || "", modelProb: "", rawEdge: p.runLine.edge ?? "", result: rlResult, lesson: "legacy_market" });
    }
  }

  const added = appendNewRows(csvRows);

  if (clvRows.length) {
    fs.mkdirSync(path.dirname(CLV_PATH), { recursive: true });
    const header = "date,market,matchup,pick,price_taken,closing_price,clv_result,lab_score,model_probability,raw_edge,result,lesson_tag\n";
    if (!fs.existsSync(CLV_PATH)) fs.writeFileSync(CLV_PATH, header);
    const lines = clvRows.map(r => `${r.date},${r.market},${csvField(r.matchup)},${csvField(r.pick)},${r.priceTaken ?? ""},${r.closingPrice ?? ""},${r.clv ?? ""},${r.labScore ?? ""},${r.modelProb ?? ""},${r.rawEdge ?? ""},${r.result ?? ""},${r.lesson ?? ""}`).join("\n") + "\n";
    fs.appendFileSync(CLV_PATH, lines);
  }

  return added;
}

async function main() {
  const added = await gradeDay();
  console.log(`results_log.csv: ${added} new row(s) for ${DATE}.`);

  const results = rebuildAll();
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "results.json"), JSON.stringify(results, null, 2) + "\n");
  const today = results.days[DATE];
  if (today) console.log(`graded ${DATE}: ${today.wins}-${today.losses}${today.units !== null ? `, ${today.units > 0 ? "+" : ""}${today.units}u` : ""}`);

  fs.mkdirSync(path.join(ROOT, "results"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "results", "index.html"), rebuildResultsPage(results));
  console.log("data/results.json and results/index.html rebuilt from results_log.csv");
}

main().catch(e => { console.error(e); process.exit(1); });
