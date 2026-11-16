#!/usr/bin/env node
/**
 * Leo NBA grading waves (HO-0076 part B): one file per game day,
 * data/nba/waves/<date>.json, that the share image and the post text are made
 * from while people are still talking about the games.
 *
 *   node scripts/build-nba-waves.js [YYYY-MM-DD]     default: today, New York
 *
 * Waves: "early" (tips before 9pm ET) and "late" (9pm ET and after). A wave
 * is appended once every game in it with a Leo read is graded in
 * data/nba/results-ledger.csv; a wave already in the file is never rewritten.
 * The top level "season" block is refreshed on every write.
 *
 * Game calls only (Leo Picks), from the read of record the grader stored.
 * No sportsbook number is written: a call's side is the team, as in the data
 * feed. Safe to run any number of times; it only appends.
 */
const fs = require("fs");
const path = require("path");
const PK = require("./lib/nba-picks");

const ROOT = path.join(__dirname, ".."), DIR = path.join(ROOT, "data", "nba"), WDIR = path.join(DIR, "waves");
const nyDate = d => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const nyHour = iso => +new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(new Date(iso));
const DATE = process.argv.slice(2).find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || nyDate(new Date());
const LATE_FROM = 21;   // 9pm ET
const WAVES = [{ id: "early", label: "Early games (tips before 9pm ET)" }, { id: "late", label: "Late games (9pm ET and after)" }];
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const [head, ...lines] = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const h = head.split(",");
  return lines.map(l => { const c = l.split(","); return Object.fromEntries(h.map((k, i) => [k, c[i] ?? ""])); });
}
const R = { win: "W", loss: "L", push: "P" };
const u3 = x => +(+x).toFixed(3);

function tally(rows) {
  const t = { w: 0, l: 0, p: 0, units: 0 };
  for (const r of rows) { if (!r.pick_result) continue; t[{ win: "w", loss: "l", push: "p" }[r.pick_result]]++; t.units += +r.pick_units || 0; }
  t.units = u3(t.units); return t;
}

function main() {
  const card = readJson(path.join(DIR, `picks-${DATE}.json`), null);
  if (!card) { console.log(`NBA waves ${DATE}: no card.`); return; }
  const ledger = readCsv(path.join(DIR, "results-ledger.csv"));
  const byId = new Map(ledger.filter(r => r.date === DATE).map(r => [String(r.game_id), r]));
  // Games with a Leo read on the card; the read graded is the one the grader stored (captured before tip).
  const games = (card.games || []).filter(g => g.leo && g.tip_utc);
  const file = path.join(WDIR, `${DATE}.json`);
  const doc = readJson(file, null) || { sport: "nba", date: DATE, waves: [], season: {} };
  const have = new Set(doc.waves.map(w => w.id));
  let added = 0;
  for (const W of WAVES) {
    if (have.has(W.id)) continue;
    const inWave = games.filter(g => (nyHour(g.tip_utc) >= LATE_FROM) === (W.id === "late"));
    if (!inWave.length) continue;
    const waiting = inWave.filter(g => !byId.has(String(g.game_id)));
    if (waiting.length) { console.log(`NBA waves ${DATE}: ${W.id} waits for ${waiting.length} of ${inWave.length} games.`); continue; }
    const rows = inWave.map(g => byId.get(String(g.game_id)));
    doc.waves.push({
      id: W.id, label: W.label, graded_at: new Date().toISOString(),
      games: inWave.map(g => {
        const r = byId.get(String(g.game_id)), ph = +r.leo_p_home;
        const calls = r.pick_result ? [{ market: "pick", side: r.pick_side === "home" ? g.home_name : g.away_name, result: R[r.pick_result], units: u3(r.pick_units) }] : [];
        return { away: g.away_name, home: g.home_name, final_away: +r.away_score, final_home: +r.home_score,
          leo_win_prob_away: +(1 - ph).toFixed(3), leo_win_prob_home: +ph.toFixed(3), leo_right_winner: r.leo_winner_correct === "1",
          calls, url: g.url ? "https://ndhorizon.com" + g.url : "" };
      }),
      totals: { pick: tally(rows) }
    });
    have.add(W.id); added++;
  }
  if (!added) { if (!fs.existsSync(file)) return; console.log(`NBA waves ${DATE}: nothing new.`); return; }
  // Season to date, Leo Picks from the day they were first counted (DEC-20261102-30).
  const season = ledger.filter(r => r.pick_result && r.date >= PK.TRACK_FROM && r.date <= DATE);
  doc.season = { pick: { ...tally(season), n: season.length } };
  doc.waves.sort((a, b) => WAVES.findIndex(w => w.id === a.id) - WAVES.findIndex(w => w.id === b.id));
  fs.mkdirSync(WDIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 1) + "\n");
  const last = doc.waves[doc.waves.length - 1];
  console.log(`NBA waves ${DATE}: wrote ${doc.waves.map(w => w.id).join(", ")}. Last: ${last.games.length} games, picks ${last.totals.pick.w}-${last.totals.pick.l} (${last.totals.pick.units}u). Season ${doc.season.pick.w}-${doc.season.pick.l} (${doc.season.pick.units}u).`);
}
main();
