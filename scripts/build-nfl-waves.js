#!/usr/bin/env node
/**
 * NFL game day waves (HO-0076 part A, DEC-20261115-52).
 *
 *   node scripts/build-nfl-waves.js [YYYY-MM-DD ...]     default: yesterday and today (ET)
 *
 * Writes data/nfl/waves/<date>.json in the shared contract (HO-0076): one entry
 * per kickoff window, appended once every game in that window is graded,
 * never rewritten. Windows by kickoff, Eastern time:
 *   early  before 1pm (London, Germany)
 *   1pm    1:00pm to 3:59pm
 *   late   4:00pm to 7:59pm (the 4:05 and 4:25 games)
 *   night  8:00pm on (Sunday, Monday and Thursday night)
 *
 * Game calls only, from the read of record, as /nfl/results/ shows them:
 * results and units from data/nfl/results-review.json (built from the graded
 * ledger), which side each call took from nfl-results-log.csv (leo_side), win
 * chances and kickoffs from the last prediction-history.csv capture before
 * kickoff. No sportsbook number in the file. Display only.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const TEAMS = require("./lib/nfl-teams");
const { frozenPredictions } = require("./lib/prediction-history");
const { splitCsv } = require("./lib/odds-history");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "data/nfl");
const OUT = path.join(DIR, "waves");
const etDate = d => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const MARKET = { ml: "moneyline", spread: "spread", total: "total" };

const WAVES = [
  { id: "early", from: 0, label: () => "Early game" },
  { id: "1pm", from: 13 * 60, label: () => "1pm games" },
  { id: "late", from: 16 * 60, label: () => "Late games" },
  { id: "night", from: 20 * 60, label: day => `${day} night` }
];
function waveOf(kickoffUtc) {
  const t = new Date(kickoffUtc);
  const [h, m] = t.toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).split(":").map(Number);
  const mins = h * 60 + m;
  let w = WAVES[0];
  for (const x of WAVES) if (mins >= x.from) w = x;
  return w;
}

function sides() {
  const f = path.join(DIR, "nfl-results-log.csv");
  const out = new Map();
  if (!fs.existsSync(f)) return out;
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean);
  const head = splitCsv(lines[0]);
  for (const l of lines.slice(1)) {
    const c = splitCsv(l); const r = {}; head.forEach((h, i) => r[h] = c[i]);
    out.set(`${r.game_id}|${r.market}`, r.leo_side || "");
  }
  return out;
}

function build(date, rv, S) {
  const reads = frozenPredictions(path.join(DIR, "prediction-history.csv"), date);
  if (!reads.length) { console.log(`NFL waves ${date}: no Leo reads.`); return null; }
  const file = path.join(OUT, `${date}.json`);
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { doc = null; }
  if (!doc) doc = { sport: "NFL", date, waves: [], season: {} };
  const have = new Set(doc.waves.map(w => w.id));
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const graded = new Map(rv.games.filter(g => g.date === date).map(g => [g.matchup, g]));

  // Group the day's reads into windows.
  const groups = new Map();
  for (const r of reads) {
    const w = waveOf(r.kickoff_utc);
    if (!groups.has(w.id)) groups.set(w.id, { w, reads: [] });
    groups.get(w.id).reads.push(r);
  }
  const added = [];
  for (const W of WAVES) {
    const grp = groups.get(W.id);
    if (!grp || have.has(W.id)) continue;
    if (!grp.reads.every(r => graded.has(r.matchup))) continue;   // every game in the window final and graded
    const games = grp.reads.sort((a, b) => a.kickoff_utc.localeCompare(b.kickoff_utc) || a.matchup.localeCompare(b.matchup)).map(r => {
      const g = graded.get(r.matchup);
      const pHome = r.model_prob == null ? null : (r.pick === r.home ? r.model_prob : 1 - r.model_prob);
      const calls = (g.three ? g.calls : []).filter(c => c.result).map(c => {
        const key = MARKET[c.market] || c.market;
        let side = S.get(`${r.game_id}|${key}`) || (c.market === "ml" ? r.pick : "");
        side = c.market === "total" ? (side ? side.charAt(0).toUpperCase() + side.slice(1).toLowerCase() : "") : (side ? TEAMS.full(side) : "");
        return { market: key, side, result: c.result, units: c.units ?? null };
      });
      return {
        away: TEAMS.full(r.away), home: TEAMS.full(r.home),
        final_away: g.score.away, final_home: g.score.home, overtime: !!g.overtime,
        leo_win_prob_away: pHome == null ? null : Math.round((1 - pHome) * 1000) / 1000,
        leo_win_prob_home: pHome == null ? null : Math.round(pHome * 1000) / 1000,
        leo_right_winner: g.leo_right_winner == null ? null : !!g.leo_right_winner,
        calls, url: g.url ? `https://ndhorizon.com${g.url}` : ""
      };
    });
    const totals = {};
    for (const mk of Object.values(MARKET)) {
      const cs = games.flatMap(g => g.calls.filter(c => c.market === mk));
      totals[mk] = { w: cs.filter(c => c.result === "W").length, l: cs.filter(c => c.result === "L").length, p: cs.filter(c => c.result === "P").length,
        units: Math.round(100 * cs.reduce((a, c) => a + (c.units || 0), 0)) / 100 };
    }
    doc.waves.push({ id: W.id, label: W.label(day), graded_at: new Date().toISOString(), games, totals });
    added.push(W.id);
  }
  // Season record of the three calls since they began, as /nfl/results/ shows it.
  const t = rv.three || {};
  doc.season = { from: t.from };
  for (const [k, mk] of Object.entries(MARKET)) {
    const x = t[k] || { w: 0, l: 0, p: 0, units: 0 };
    doc.season[mk] = { w: x.w, l: x.l, p: x.p, units: x.units, n: x.w + x.l + x.p };
  }
  doc.waves.sort((a, b) => WAVES.findIndex(w => w.id === a.id) - WAVES.findIndex(w => w.id === b.id));
  if (!added.length && fs.existsSync(file)) { console.log(`NFL waves ${date}: nothing new (${doc.waves.map(w => w.id).join(", ") || "none"} written).`); return doc; }
  if (!doc.waves.length) { console.log(`NFL waves ${date}: no window complete yet.`); return null; }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 1) + "\n");
  console.log(`NFL waves ${date}: added ${added.join(", ")} -> data/nfl/waves/${date}.json`);
  return doc;
}

if (require.main === module) {
  const rvFile = path.join(DIR, "results-review.json");
  if (!fs.existsSync(rvFile)) { console.log("NFL waves: no results review yet."); process.exit(0); }
  const rv = JSON.parse(fs.readFileSync(rvFile, "utf8"));
  const dates = process.argv.slice(2).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!dates.length) dates.push(etDate(new Date(Date.now() - 864e5)), etDate(new Date()));
  const S = sides();
  for (const d of [...new Set(dates)]) build(d, rv, S);
}
module.exports = { build, waveOf };
