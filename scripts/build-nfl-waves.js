#!/usr/bin/env node
/**
 * NFL game day waves (HO-0076 part A, DEC-20261115-52; rolling waves HO-0082, DEC-20261115-54).
 *
 *   node scripts/build-nfl-waves.js [YYYY-MM-DD ...]     default: yesterday and today (ET)
 *
 * Writes data/nfl/waves/<date>.json in the shared contract (HO-0076). Each run
 * appends at most one wave: every game of that date graded since the last
 * wave (ids wave-1, wave-2, ...), so a 1pm game that ends at 4pm is posted
 * then instead of waiting for the slowest game of its window. Label from the
 * kickoff times ("Games that kicked off at 1pm ET", "Games that kicked off
 * 1pm to 4:25pm ET", ", the last of the day" when nothing is left);
 * still_playing = games of the date with a Leo read not graded yet. A wave is
 * never rewritten, each game appears once, and a run with nothing new writes
 * nothing. A game belongs to its kickoff date (ET), even when it ends after
 * midnight.
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
// Graded public markets only (totals are information only from Nov 19, DEC-20261119-01).
const MARKET = Object.fromEntries(Object.entries({ ml: "moneyline", spread: "spread", total: "total" }).filter(([k]) => require("./lib/nfl-calls").MARKETS.includes(k)));

// "1pm", "4:25pm", "9:30am", Eastern.
function kickET(kickoffUtc) {
  const t = new Date(kickoffUtc).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  const [hm, ap] = t.split(" ");
  return hm.replace(/:00$/, "") + ap.toLowerCase();
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
  const graded = new Map(rv.games.filter(g => g.date === date).map(g => [g.matchup, g]));
  // Games already posted, by game_id (and by matchup for any older wave entry).
  const posted = new Set();
  for (const w of doc.waves) for (const g of w.games || []) { if (g.game_id) posted.add(g.game_id); posted.add(`${g.away}|${g.home}`); }
  const fresh = reads.filter(r => graded.has(r.matchup) && !posted.has(r.game_id) && !posted.has(`${TEAMS.full(r.away)}|${TEAMS.full(r.home)}`))
    .sort((a, b) => a.kickoff_utc.localeCompare(b.kickoff_utc) || a.matchup.localeCompare(b.matchup));
  if (!fresh.length) { console.log(`NFL waves ${date}: nothing new (${doc.waves.length} wave(s) written).`); return doc; }

  const games = fresh.map(r => {
    const g = graded.get(r.matchup);
    const pHome = r.model_prob == null ? null : (r.pick === r.home ? r.model_prob : 1 - r.model_prob);
    const calls = (g.three ? g.calls : []).filter(c => c.result).map(c => {
      const key = MARKET[c.market] || c.market;
      let side = S.get(`${r.game_id}|${key}`) || (c.market === "ml" ? r.pick : "");
      side = c.market === "total" ? (side ? side.charAt(0).toUpperCase() + side.slice(1).toLowerCase() : "") : (side ? TEAMS.full(side) : "");
      return { market: key, side, result: c.result, units: c.units ?? null };
    });
    return {
      game_id: r.game_id, away: TEAMS.full(r.away), home: TEAMS.full(r.home),
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
  const t0 = kickET(fresh[0].kickoff_utc), t1 = kickET(fresh[fresh.length - 1].kickoff_utc);
  const left = reads.filter(r => !graded.has(r.matchup)).length;
  const one = fresh.length === 1;
  const label = (t0 === t1 ? `${one ? "Game" : "Games"} that kicked off at ${t0} ET` : `Games that kicked off ${t0} to ${t1} ET`) + (left ? "" : ", the last of the day");
  const id = `wave-${doc.waves.length + 1}`;
  doc.waves.push({ id, label, graded_at: new Date().toISOString(), games, totals, still_playing: left });
  // Season record of the three calls since they began, as /nfl/results/ shows it.
  const t = rv.three || {};
  doc.season = { from: t.from };
  for (const [k, mk] of Object.entries(MARKET)) {
    const x = t[k] || { w: 0, l: 0, p: 0, units: 0 };
    doc.season[mk] = { w: x.w, l: x.l, p: x.p, units: x.units, n: x.w + x.l + x.p };
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 1) + "\n");
  const rec = Object.values(totals).reduce((a, x) => [a[0] + x.w, a[1] + x.l, a[2] + x.units], [0, 0, 0]);
  console.log(`NFL waves ${date}: wrote ${id} (${label}): ${games.length} games, ${left} still playing, calls ${rec[0]}-${rec[1]} (${Math.round(rec[2] * 100) / 100}u) -> data/nfl/waves/${date}.json`);
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
module.exports = { build, kickET };
