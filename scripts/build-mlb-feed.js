#!/usr/bin/env node
/*
  Leo data feed, MLB (launch plan day 9, HO-0063 part C; DEC-20261113 MLB).

  One clean file of Leo's own MLB output for other sites and creators.
  Leo's output only: the read of record (the last read saved before first
  pitch), the official calls that were frozen before first pitch
  (DEC-20261031-13), the grades and the miss reasons. NO sportsbook numbers
  anywhere: no lines, prices, odds or market probabilities, in any column.
  Final scores are facts and are included.

  Writes (committed, public):
    data/feed/mlb/sample.csv              games, the last 7 graded days of the season
    data/feed/mlb/sample-strikeouts.csv   frozen strikeout calls in the same days
    data/feed/mlb/sample.json             both, with the window
    data/feed/mlb/schema.json             every column: name, type, unit, meaning
  Full season, only with --out=<path> (never committed; the full file is what
  a buyer pays for and the repo is public):
    <path>                    games (CSV, or JSON when <path> ends in .json)
    <path stem>-strikeouts.<ext>

  Sources, read only: data/review/mlb-<season>/game_review.csv (Leo's read of
  record per game), freeze_audit.csv (official picks, when first published,
  graded result and the price used for units), kprop_review.csv (strikeout
  projection of record); final scores from data/calibration/calibration_model_log.csv
  (final_score, away-home) with data/calibration/recap_components.csv as a
  fallback. Miss reasons use the same rule as /results/ (build-mlb-results-page.js
  reasonFor).

  Usage: node scripts/build-mlb-feed.js [--season 2026] [--out=/tmp/leo-mlb-2026.csv]
*/
"use strict";
const fs = require("fs");
const path = require("path");
const { reasonFor } = require("./build-mlb-results-page");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const argVal = (name) => {
  const eq = args.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const SEASON = argVal("season") || "2026";
const OUT = argVal("out");
const REVIEW = path.join(ROOT, "data", "review", `mlb-${SEASON}`);
const FEED = path.join(ROOT, "data", "feed", "mlb");
const SAMPLE_DAYS = 7;
const ML_MODEL = "leo-mlb-moneyline";   // prefix for model_version; the review's model_source follows it
const K_MODEL = "leo-kprop";

function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f.replace(/\r$/, "")); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f.replace(/\r$/, "")); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
const readCsv = p => fs.existsSync(p) ? parseCsv(fs.readFileSync(p, "utf8")) : [];
const num = v => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const r3 = v => v == null ? null : Math.round(v * 1000) / 1000;
const r2 = v => v == null ? null : Math.round(v * 100) / 100;
function isoDate(s) {
  s = String(s || "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}
const isoUtc = s => { if (!s) return ""; const d = new Date(s); return isNaN(d) ? "" : d.toISOString().replace(".000Z", "Z"); };
// Units at the price the pick was graded on. The price stays out of the file.
function units(result, price) {
  if (result === "W") return price == null ? null : r2(price < 0 ? 100 / -price : price / 100);
  if (result === "L") return -1;
  if (result === "P") return 0;
  return null;
}
// W, L, P (push or void: stake returned), or empty.
const resultCode = r => (r === "W" || r === "L") ? r : (r === "P" || r === "PUSH" || r === "VOID") ? "P" : "";

function finalScores() {
  const out = new Map();
  for (const r of readCsv(path.join(ROOT, "data", "calibration", "recap_components.csv"))) {
    const a = num(r.away_actual_runs), h = num(r.home_actual_runs);
    if (a != null && h != null) out.set(`${isoDate(r.date)}|${r.game_pk}`, [a, h]);
  }
  // calibration_model_log final_score is "away-home"; it wins over the recap.
  for (const r of readCsv(path.join(ROOT, "data", "calibration", "calibration_model_log.csv"))) {
    const m = String(r.final_score || "").match(/^(\d+)-(\d+)$/);
    if (m) out.set(`${isoDate(r.date)}|${r.gamePk}`, [Number(m[1]), Number(m[2])]);
  }
  return out;
}

function build() {
  const games = readCsv(path.join(REVIEW, "game_review.csv")).filter(g => g.leo_side_won === "0" || g.leo_side_won === "1");
  const audit = readCsv(path.join(REVIEW, "freeze_audit.csv")).filter(p => p.status === "frozen");
  const kproj = new Map(readCsv(path.join(REVIEW, "kprop_review.csv")).map(k => [`${k.date}|${k.pitcher}`, k]));
  const scores = finalScores();
  const gameByKey = new Map(games.map(g => [`${g.date}|${g.game_pk}`, g]));

  const mlPick = new Map();
  for (const p of audit.filter(p => p.market === "moneyline")) mlPick.set(`${p.date}|${p.game_pk}`, p);

  const rows = games.map(g => {
    const [away, home] = String(g.matchup).split(" @ ");
    const p = num(g.leo_prob);
    const pAway = g.leo_side === "away" ? p : 1 - p;
    const sc = scores.get(`${g.date}|${g.game_pk}`);
    // Only keep a score that agrees with the graded winner.
    const scoreOk = sc && ((sc[0] > sc[1]) === (g.winner_side === "away"));
    const pick = mlPick.get(`${g.date}|${g.game_pk}`);
    const res = pick ? resultCode(pick.result) : "";
    return {
      sport: "MLB", season: Number(SEASON), game_date: g.date, game_id: g.game_pk,
      away_team: away, home_team: home,
      start_utc: isoUtc(g.start_utc), read_saved_utc: isoUtc(g.captured_utc),
      leo_win_prob_away: r3(pAway), leo_win_prob_home: r3(1 - r3(pAway)),
      final_away: scoreOk ? sc[0] : null, final_home: scoreOk ? sc[1] : null,
      ml_side: pick ? pick.pick : "", ml_result: res, ml_units: pick ? units(res, num(pick.price)) : null,
      leo_right_winner: g.leo_side_won === "1",
      miss_reason: g.leo_side_won === "0" ? reasonFor(g).reason : "",
      model_version: `${ML_MODEL}:${g.model_source || "unlabelled"}`,
    };
  }).sort((a, b) => a.game_date.localeCompare(b.game_date) || String(a.start_utc).localeCompare(String(b.start_utc)) || String(a.game_id).localeCompare(String(b.game_id)));

  const kRows = audit.filter(p => p.market === "pitcher_strikeouts" && resultCode(p.result)).map(p => {
    const g = gameByKey.get(`${p.date}|${p.game_pk}`);
    const k = kproj.get(`${p.date}|${p.pitcher}`);
    const [away, home] = g ? String(g.matchup).split(" @ ") : (k ? String(k.game).split(" @ ") : ["", ""]);
    let team = "";
    if (g) team = g.leo_side_pitcher === p.pitcher ? g.leo_side_team : g.opp_pitcher === p.pitcher ? (g.leo_side_team === home ? away : home) : "";
    const res = resultCode(p.result);
    // Projection of record: the last read saved before first pitch.
    const proj = k && k.captured_utc && p.scheduled_start_utc && new Date(k.captured_utc) < new Date(p.scheduled_start_utc) ? num(k.projection) : null;
    return {
      sport: "MLB", season: Number(SEASON), game_date: p.date, game_id: p.game_pk,
      away_team: away || "", home_team: home || "",
      start_utc: isoUtc(p.scheduled_start_utc), read_saved_utc: isoUtc(k && proj != null ? k.captured_utc : p.first_published_utc),
      pitcher: p.pitcher, team, leo_projection: proj == null ? null : r2(proj),
      side: String(p.pick).toLowerCase(), result: res, units: units(res, num(p.price)),
      model_version: K_MODEL,
    };
  }).sort((a, b) => a.game_date.localeCompare(b.game_date) || String(a.start_utc).localeCompare(String(b.start_utc)) || a.pitcher.localeCompare(b.pitcher));
  return { rows, kRows };
}

const GAME_COLS = ["sport", "season", "game_date", "game_id", "away_team", "home_team", "start_utc", "read_saved_utc", "leo_win_prob_away", "leo_win_prob_home", "final_away", "final_home", "ml_side", "ml_result", "ml_units", "leo_right_winner", "miss_reason", "model_version"];
const K_COLS = ["sport", "season", "game_date", "game_id", "away_team", "home_team", "start_utc", "read_saved_utc", "pitcher", "team", "leo_projection", "side", "result", "units", "model_version"];

const SCHEMA = {
  sport: "MLB",
  season: Number(SEASON),
  description: "Leo's own MLB output: the read of record for every graded game, the official calls frozen before first pitch, their grades and the reason for every game Leo's side lost. No sportsbook number appears in any column.",
  rules: [
    "One row per graded game. Only the read of record is used: the last read Leo saved before the scheduled first pitch. Nothing written after first pitch is in the file.",
    "Official calls count only if they were published before first pitch. Calls added after the start are not in the file.",
    "Units are Leo's result at the price the call was graded on (1 unit risked per call). The price itself is not in the file.",
    "Team names are full names, never abbreviations. Dates are Eastern time; timestamps are UTC.",
  ],
  files: {
    "sample.csv": { columns: GAME_COLS },
    "sample-strikeouts.csv": { columns: K_COLS },
  },
  columns: {
    sport: { type: "string", unit: "", meaning: "Always MLB." },
    season: { type: "integer", unit: "year", meaning: "The MLB season." },
    game_date: { type: "date", unit: "YYYY-MM-DD, Eastern time", meaning: "The date the game was scheduled to start." },
    game_id: { type: "string", unit: "", meaning: "MLB's game id (gamePk)." },
    away_team: { type: "string", unit: "", meaning: "Full name of the away team." },
    home_team: { type: "string", unit: "", meaning: "Full name of the home team." },
    start_utc: { type: "datetime", unit: "ISO 8601, UTC", meaning: "Scheduled first pitch." },
    read_saved_utc: { type: "datetime", unit: "ISO 8601, UTC", meaning: "When Leo saved the read used in this row; always before start_utc." },
    leo_win_prob_away: { type: "number", unit: "probability 0 to 1, three decimals", meaning: "Leo's chance that the away team wins." },
    leo_win_prob_home: { type: "number", unit: "probability 0 to 1, three decimals", meaning: "Leo's chance that the home team wins." },
    final_away: { type: "integer", unit: "runs", meaning: "Away team's final runs. Empty when the score is not in Leo's files." },
    final_home: { type: "integer", unit: "runs", meaning: "Home team's final runs. Empty when the score is not in Leo's files." },
    ml_side: { type: "string", unit: "", meaning: "The team Leo's official moneyline call took. Empty when there was no call." },
    ml_result: { type: "string", unit: "W, L, P or empty", meaning: "Result of the moneyline call: W won, L lost, P stake returned (push or void), empty when there was no call." },
    ml_units: { type: "number", unit: "units, 1 risked", meaning: "Units won or lost by the moneyline call. Empty when there was no call." },
    leo_right_winner: { type: "boolean", unit: "", meaning: "True when the team Leo gave the higher win chance won." },
    miss_reason: { type: "string", unit: "label", meaning: "Why Leo's side lost, the same label as Leo's results page: starter_changed (the starter in Leo's read did not start), starter (Leo's side's starter did not hold up), bullpen (Leo's side's bullpen gave up the game), model_error (Leo disagreed with the consensus and lost), variance (the favorite lost). Empty when Leo's side won." },
    model_version: { type: "string", unit: "", meaning: "The model that produced the read. Games file: leo-mlb-moneyline followed by the model generation (leo is the model used from August 2026; earlier generations ran in July). Strikeouts file: leo-kprop." },
    pitcher: { type: "string", unit: "", meaning: "Starting pitcher the strikeout call is on." },
    team: { type: "string", unit: "", meaning: "Full name of the pitcher's team. Empty when it could not be matched." },
    leo_projection: { type: "number", unit: "strikeouts, two decimals", meaning: "Leo's projected strikeouts for the pitcher from its last read before first pitch. Empty when no read before first pitch was saved." },
    side: { type: "string", unit: "over or under", meaning: "The side of the strikeout call. The line it was made against is not in the file." },
    result: { type: "string", unit: "W, L or P", meaning: "Result of the strikeout call: W won, L lost, P stake returned (push or void)." },
    units: { type: "number", unit: "units, 1 risked", meaning: "Units won or lost by the strikeout call." },
  },
};

function toCsv(rows, cols) {
  const cell = v => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map(r => cols.map(c => cell(r[c])).join(","))].join("\n") + "\n";
}
const pickCols = (rows, cols) => rows.map(r => Object.fromEntries(cols.map(c => [c, r[c] ?? null])));

function main() {
  if (!fs.existsSync(path.join(REVIEW, "game_review.csv"))) { console.log(`No ${path.relative(ROOT, REVIEW)}; run scripts/build-mlb-season-review.js first.`); return; }
  const { rows, kRows } = build();
  const days = [...new Set(rows.map(r => r.game_date))].sort();
  const window = days.slice(-SAMPLE_DAYS);
  const inWin = r => window.includes(r.game_date);
  const sample = rows.filter(inWin), kSample = kRows.filter(inWin);

  fs.mkdirSync(FEED, { recursive: true });
  fs.writeFileSync(path.join(FEED, "sample.csv"), toCsv(sample, GAME_COLS));
  fs.writeFileSync(path.join(FEED, "sample-strikeouts.csv"), toCsv(kSample, K_COLS));
  fs.writeFileSync(path.join(FEED, "sample.json"), JSON.stringify({
    sport: "MLB", season: Number(SEASON), window: { from: window[0], to: window[window.length - 1], game_days: window.length },
    note: "Sample: the last 7 graded game days of the season. The full season file is available on request.",
    games: pickCols(sample, GAME_COLS), strikeouts: pickCols(kSample, K_COLS),
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(FEED, "schema.json"), JSON.stringify(SCHEMA, null, 2) + "\n");
  console.log(`MLB feed sample: ${sample.length} games, ${kSample.length} strikeout calls, ${window[0]} to ${window[window.length - 1]} -> data/feed/mlb/`);

  if (OUT) {
    const json = OUT.endsWith(".json");
    const kOut = OUT.replace(/(\.[a-z]+)?$/i, m => `-strikeouts${m || ""}`);
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(OUT, json ? JSON.stringify(pickCols(rows, GAME_COLS), null, 2) + "\n" : toCsv(rows, GAME_COLS));
    fs.writeFileSync(kOut, json ? JSON.stringify(pickCols(kRows, K_COLS), null, 2) + "\n" : toCsv(kRows, K_COLS));
    const noScore = rows.filter(r => r.final_away == null).length;
    console.log(`Full season: ${rows.length} games (${noScore} without a final score in Leo's files) -> ${OUT}; ${kRows.length} strikeout calls -> ${kOut}`);
  }
}
if (require.main === module) main();
module.exports = { build, GAME_COLS, K_COLS };
