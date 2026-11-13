#!/usr/bin/env node
/**
 * Leo NFL data feed (HO-0063 part A, launch plan day 9, DEC-20261113-51).
 *
 *   node scripts/build-nfl-feed.js                 write the public sample and schema
 *   node scripts/build-nfl-feed.js --out=<path>    also write the full season file
 *                                                  (.csv or .json by extension); never
 *                                                  commit it, it is what a buyer pays for
 *
 * One row per graded game, Leo's own output only:
 *   - the read of record: the last row of data/nfl/prediction-history.csv saved
 *     strictly before kickoff (win chance, Leo's margin, Leo's total)
 *   - final score and overtime, Leo's three calls since Nov 2 with their result
 *     and units, whether Leo had the winner, and the miss reason, all from
 *     data/nfl/results-review.json (the source of /nfl/results/, so counts match)
 *   - which side each call took, from data/nfl/nfl-results-log.csv (leo_side only)
 * No sportsbook line, price, spread, total or market chance appears in any
 * column; props stay out of the feed.
 *
 * Writes data/feed/nfl/sample.csv, sample.json (the last 7 graded game days)
 * and schema.json.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const TEAMS = require("./lib/nfl-teams");
const VIEW = require("./lib/nfl-results-view");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "data/nfl");
const OUTDIR = path.join(ROOT, "data/feed/nfl");
const OUT = (process.argv.find(a => a.startsWith("--out=")) || "").slice(6);
const SAMPLE_DAYS = 7;

function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
const readCsv = f => fs.existsSync(f) ? parseCsv(fs.readFileSync(f, "utf8")) : [];
const num = v => v === "" || v == null || !Number.isFinite(+v) ? null : +v;
const r3 = x => x == null ? null : Math.round(x * 1000) / 1000;
const r1 = x => x == null ? null : Math.round(x * 10) / 10;
const strip = s => String(s || "").replace(/&rsquo;/g, "'").replace(/<[^>]+>/g, "");

// Columns in the order HO-0063 sets, with the schema text.
const COLS = [
  ["sport", "string", "", "Always NFL."],
  ["season", "integer", "year", "The season the game belongs to (the year it started)."],
  ["week", "integer", "week", "Regular season week number."],
  ["game_date", "date", "YYYY-MM-DD, Eastern time", "The day the game was played, Eastern time."],
  ["game_id", "string", "", "Game identifier (nflverse format: season_week_away_home), stable across files."],
  ["away_team", "string", "", "Full name of the away team."],
  ["home_team", "string", "", "Full name of the home team."],
  ["start_utc", "datetime", "ISO 8601 UTC", "Scheduled kickoff."],
  ["read_saved_utc", "datetime", "ISO 8601 UTC", "When Leo's read of record was saved: the last read before kickoff. Nothing in the row was written after it."],
  ["leo_win_prob_away", "number", "probability 0 to 1", "Leo's chance that the away team wins, at the read of record."],
  ["leo_win_prob_home", "number", "probability 0 to 1", "Leo's chance that the home team wins, at the read of record."],
  ["leo_margin_home", "number", "points", "Leo's expected margin: positive means the home team by that many, negative means the away team. It comes from Leo's margin model, separate from the win chance model, so the two can point to different winners in a close game."],
  ["leo_total", "number", "points", "Leo's projected total points for both teams."],
  ["final_away", "integer", "points", "Final score of the away team."],
  ["final_home", "integer", "points", "Final score of the home team."],
  ["overtime", "boolean", "", "True when the game went to overtime."],
  ["ml_side", "string", "team name", "Moneyline call: the team Leo took to win. Empty when Leo made no moneyline call or before the three calls began on 2026-11-02."],
  ["ml_result", "string", "W, L or P", "Result of the moneyline call. Empty when there was no call."],
  ["ml_units", "number", "units", "Units won or lost on the moneyline call, one unit risked, graded at the price when Leo made the call (the price is not in the file)."],
  ["spread_side", "string", "team name", "Spread call: the team Leo took against the spread. Empty when no call."],
  ["spread_result", "string", "W, L or P", "Result of the spread call. Empty when there was no call."],
  ["spread_units", "number", "units", "Units won or lost on the spread call, graded at standard -110."],
  ["total_side", "string", "Over or Under", "Total call: Over or Under. Empty when no call."],
  ["total_result", "string", "W, L or P", "Result of the total call. Empty when there was no call."],
  ["total_units", "number", "units", "Units won or lost on the total call, graded at standard -110."],
  ["leo_right_winner", "boolean", "", "True when the team Leo gave the higher win chance won. Empty for an exact 50% read or a tie."],
  ["miss_reason", "string", "", "When Leo missed (a lost call, the wrong winner, or the margin off by 14 or more), the reason as shown on ndhorizon.com/nfl/results/: Injury input, The market knew, Overtime, Blowout, Variance or Leo's error. Empty when there was no miss."],
  ["model_version", "string", "", "Version of Leo's win chance model that made the read."]
];
const NAMES = COLS.map(c => c[0]);

function readOfRecord() {
  const out = new Map();
  for (const r of readCsv(path.join(DIR, "prediction-history.csv"))) {
    if (!r.kickoff_utc || !r.captured_at || r.captured_at >= r.kickoff_utc) continue;
    const prev = out.get(r.game_id);
    if (!prev || r.captured_at > prev.captured_at) out.set(r.game_id, r);
  }
  return out;
}

// leo_side per game and market from the graded ledger (the side only).
function sides() {
  const out = new Map();
  for (const r of readCsv(path.join(DIR, "nfl-results-log.csv"))) {
    if (!r.game_id || !r.market) continue;
    const k = `${r.game_id}|${r.market}`;
    const prev = out.get(k);
    if (!prev || String(r.graded_at) > String(prev.graded_at)) out.set(k, r);
  }
  return out;
}

function rows() {
  const rv = JSON.parse(fs.readFileSync(path.join(DIR, "results-review.json"), "utf8"));
  const reads = readOfRecord(), S = sides();
  const out = [];
  for (const g of rv.games) {
    const gid = `${String(g.date).slice(0, 4)}_${String(g.week).padStart(2, "0")}_${g.away}_${g.home}`;
    const R = reads.get(gid);
    if (!R) { console.warn(`  NFL feed: no read of record for ${gid}, left out`); continue; }
    const p = num(R.model_prob), pHome = p == null ? null : (R.pick === g.home ? p : 1 - p);
    const call = mk => (g.three ? (g.calls || []).find(c => c.market === mk) : null);
    const side = (mk, key) => { const c = call(mk); if (!c) return ""; const s = (S.get(`${gid}|${key}`) || {}).leo_side || ""; return mk === "total" ? (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : "") : (s ? TEAMS.full(s) : ""); };
    const res = mk => (call(mk) || {}).result || "";
    const units = mk => { const c = call(mk); return c && c.units != null ? c.units : ""; };
    const winner = g.score.home > g.score.away ? g.home : g.score.away > g.score.home ? g.away : null;
    const right = winner && pHome != null && pHome !== 0.5 ? ((pHome > 0.5 ? g.home : g.away) === winner) : "";
    const row = {
      sport: "NFL", season: +String(g.date).slice(0, 4) - (+String(g.date).slice(5, 7) < 3 ? 1 : 0), week: +g.week,
      game_date: g.date, game_id: gid, away_team: TEAMS.full(g.away), home_team: TEAMS.full(g.home),
      start_utc: R.kickoff_utc, read_saved_utc: R.captured_at,
      leo_win_prob_away: pHome == null ? "" : r3(1 - pHome), leo_win_prob_home: pHome == null ? "" : r3(pHome),
      leo_margin_home: r1(num(R.exp_margin)) ?? "", leo_total: r1(num(R.proj_total)) ?? "",
      final_away: g.score.away, final_home: g.score.home, overtime: !!g.overtime,
      ml_side: (() => { const c = call("ml"); if (!c) return ""; const s = (S.get(`${gid}|moneyline`) || {}).leo_side || R.pick; return TEAMS.full(s); })(),
      ml_result: res("ml"), ml_units: units("ml"),
      spread_side: side("spread", "spread"), spread_result: res("spread"), spread_units: units("spread"),
      total_side: side("total", "total"), total_result: res("total"), total_units: units("total"),
      leo_right_winner: right, miss_reason: g.miss ? strip(VIEW.REASON[g.miss.reason] || g.miss.reason) : "",
      model_version: R.model_version
    };
    out.push(row);
  }
  return out.sort((a, b) => a.game_date.localeCompare(b.game_date) || a.start_utc.localeCompare(b.start_utc) || a.game_id.localeCompare(b.game_id));
}

const cell = v => { const s = v === true ? "true" : v === false ? "false" : v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = list => [NAMES.join(","), ...list.map(r => NAMES.map(n => cell(r[n])).join(","))].join("\n") + "\n";
const toJson = (list, extra) => JSON.stringify({ sport: "NFL", source: "Leo, ndhorizon.com", generated_at: new Date().toISOString(), ...extra, rows: list }, null, 1) + "\n";

function build() {
  const all = rows();
  const days = [...new Set(all.map(r => r.game_date))].sort().slice(-SAMPLE_DAYS);
  const sample = all.filter(r => days.includes(r.game_date));
  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.writeFileSync(path.join(OUTDIR, "sample.csv"), toCsv(sample));
  fs.writeFileSync(path.join(OUTDIR, "sample.json"), toJson(sample, { sample: `last ${days.length} graded game days`, from: days[0], through: days[days.length - 1] }));
  fs.writeFileSync(path.join(OUTDIR, "schema.json"), JSON.stringify({
    sport: "NFL", rows: "One row per graded game, Leo's read of record only (the last read saved before kickoff).",
    contains: "Leo's own output: win chances, margin and total, calls with result and units, miss reasons, plus final scores. No sportsbook line, price or market number in any column.",
    columns: COLS.map(([name, type, unit, meaning]) => ({ name, type, unit, meaning }))
  }, null, 1) + "\n");
  console.log(`NFL feed: ${all.length} graded games; sample ${sample.length} games over ${days.length} days (${days[0]} to ${days[days.length - 1]}) -> data/feed/nfl/`);
  if (OUT) {
    fs.writeFileSync(OUT, /\.json$/i.test(OUT) ? toJson(all, { full_season: true }) : toCsv(all));
    console.log(`NFL feed: full file (${all.length} rows) -> ${OUT}`);
  }
}

if (require.main === module) build();
module.exports = { rows, COLS };
