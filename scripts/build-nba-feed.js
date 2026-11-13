#!/usr/bin/env node
/**
 * Leo NBA data feed (HO-0063 part B, launch plan day 9).
 *
 *   node scripts/build-nba-feed.js                 write data/feed/nba/sample.csv, sample.json, schema.json
 *                                                  (the last 7 graded days)
 *   node scripts/build-nba-feed.js --out=<path>    also write the full season to <path> (.csv or .json).
 *                                                  Never commit that file: it is what a buyer pays for.
 *
 * Leo's own output only: the read of record (the last read saved before tip),
 * Leo Picks and their grades, and the results page's miss reason. No
 * sportsbook number of any kind (no line, spread, total or price) appears in
 * any column; pick units are Leo's graded units, the price itself is left out.
 * Final scores are facts and are included. Leans never appear (HO-0056).
 *
 * Sources: data/nba/results-ledger.csv (read of record, finals, picks),
 * data/nba/misses/<date>.json (miss reason and overtime, the same labels as
 * /nba/results/), data/nba/picks-<date>.json (Leo's projected total, used only
 * when the card's margin matches the read of record) and team names from the
 * cards and data/nba/schedule.json.
 */
const fs = require("fs");
const path = require("path");
const PK = require("./lib/nba-picks");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "data/feed/nba");
const OUT = (process.argv.find(a => a.startsWith("--out=")) || "").slice(6);
const SAMPLE_DAYS = 7;

const COLUMNS = [
  ["sport", "string", "", "Always NBA."],
  ["season", "string", "", "The NBA season, for example 2026-27."],
  ["game_date", "date", "YYYY-MM-DD, US Eastern", "The day the game was played, in Eastern time."],
  ["game_id", "string", "", "ESPN's game id."],
  ["away_team", "string", "", "The visiting team's full name."],
  ["home_team", "string", "", "The home team's full name."],
  ["start_utc", "datetime", "ISO 8601, UTC", "Scheduled tip time."],
  ["read_saved_utc", "datetime", "ISO 8601, UTC", "When Leo saved the read this row uses: the last read saved before tip. Nothing written after tip is used."],
  ["leo_win_prob_away", "number", "probability 0 to 1, three decimals", "Leo's chance that the away team wins."],
  ["leo_win_prob_home", "number", "probability 0 to 1, three decimals", "Leo's chance that the home team wins."],
  ["leo_margin_home", "number", "points, one decimal", "Leo's own margin: positive means Leo has the home team winning by that many, negative the away team."],
  ["leo_total", "number", "points", "Leo's projected combined score. Empty when the saved card does not match the read of record."],
  ["final_away", "integer", "points", "The away team's final score."],
  ["final_home", "integer", "points", "The home team's final score."],
  ["overtime", "boolean", "true or false", "Whether the game went to overtime."],
  ["pick_side", "string", "", "The team Leo picked to win (a Leo Pick: 60% or more with Leo at a price better than -230). Empty when there was no pick."],
  ["pick_result", "string", "W, L, P or empty", "The Leo Pick's result. Empty when there was no pick."],
  ["pick_units", "number", "units, three decimals", "Units won or lost on a one unit Leo Pick at the price it was graded on. The price itself is not in the file."],
  ["leo_right_winner", "boolean", "true or false", "Whether the team Leo gave 50% or more won."],
  ["miss_reason", "string", "injury_input, market_knew, overtime, blowout, variance, model_error or empty", "Why the game counts as a miss, the same reason the results page shows (ndhorizon.com/nba/results/). Empty when the game is not a miss."],
  ["model_version", "string", "", "The Leo model that made the read."]
];

/* ---------- small helpers ---------- */
function parseCsv(txt) {
  const lines = txt.replace(/\r/g, "").split("\n").filter(Boolean), head = lines.shift().split(",");
  return lines.map(l => { const v = l.split(","), o = {}; head.forEach((h, i) => { o[h] = v[i] ?? ""; }); return o; });
}
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };
const num = v => v === "" || v == null || !Number.isFinite(+v) ? null : +v;
const r = (v, d) => v == null ? "" : (+v).toFixed(d);
const seasonOf = d => { const y = +d.slice(0, 4), m = +d.slice(5, 7); return m >= 8 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`; };
const csvCell = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** Full team names from the cards and the schedule. */
function teamNames() {
  const names = {};
  const walk = o => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    for (const s of ["home", "away"]) if (typeof o[s] === "string" && typeof o[s + "_name"] === "string" && o[s + "_name"]) names[o[s]] = o[s + "_name"];
    Object.values(o).forEach(v => { if (v && typeof v === "object") walk(v); });
  };
  walk(readJson(path.join(ROOT, "data/nba/schedule.json")));
  for (const f of fs.readdirSync(path.join(ROOT, "data/nba")).filter(f => /^picks-\d{4}-\d{2}-\d{2}\.json$/.test(f))) walk(readJson(path.join(ROOT, "data/nba", f)));
  return names;
}

function build() {
  const ledger = parseCsv(fs.readFileSync(path.join(ROOT, "data/nba/results-ledger.csv"), "utf8"))
    .filter(x => x.date && x.away_score !== "" && x.home_score !== "");
  const names = teamNames(), name = c => names[c] || c;
  const missesBy = {}, cardsBy = {};
  const missOf = (date, id) => {
    if (!(date in missesBy)) { const d = readJson(path.join(ROOT, "data/nba/misses", `${date}.json`)); missesBy[date] = new Map(((d && d.games) || []).map(g => [String(g.game_id), g])); }
    return missesBy[date].get(String(id)) || null;
  };
  const cardOf = (date, id) => {
    if (!(date in cardsBy)) { const d = readJson(path.join(ROOT, "data/nba", `picks-${date}.json`)); cardsBy[date] = new Map(((d && d.games) || []).map(g => [String(g.game_id), g])); }
    return cardsBy[date].get(String(id)) || null;
  };
  const rows = ledger.map(x => {
    const m = missOf(x.date, x.game_id), card = cardOf(x.date, x.game_id);
    const margin = num(x.leo_home_margin), ph = num(x.leo_p_home);
    // Leo's projected total only when the card holds the same read as the ledger's read of record.
    const L = card && card.leo, total = L && L.projected && margin != null && num(L.home_margin) != null && Math.abs(+L.home_margin - margin) < 0.06 ? L.projected.total : null;
    const pickOn = x.pick_result && x.date >= PK.TRACK_FROM && x.pick_team;
    const res = { win: "W", loss: "L", push: "P" }[x.pick_result] || "";
    return {
      sport: "NBA", season: seasonOf(x.date), game_date: x.date, game_id: x.game_id,
      away_team: name(x.away), home_team: name(x.home), start_utc: x.kickoff_utc, read_saved_utc: x.captured_at,
      leo_win_prob_away: ph == null ? "" : r(1 - ph, 3), leo_win_prob_home: ph == null ? "" : r(ph, 3),
      leo_margin_home: r(margin, 1), leo_total: total == null ? "" : total,
      final_away: +x.away_score, final_home: +x.home_score, overtime: m ? !!m.overtime : false,
      pick_side: pickOn ? name(x.pick_team) : "", pick_result: pickOn ? res : "", pick_units: pickOn && x.pick_units !== "" ? r(x.pick_units, 3) : "",
      leo_right_winner: x.leo_winner_correct === "1",
      miss_reason: m && m.miss && m.miss.reason ? m.miss.reason : "",
      model_version: x.model_version
    };
  }).sort((a, b) => a.game_date.localeCompare(b.game_date) || a.start_utc.localeCompare(b.start_utc) || a.game_id.localeCompare(b.game_id));
  return rows;
}

function toCsv(rows) { return [COLUMNS.map(c => c[0]).join(","), ...rows.map(o => COLUMNS.map(c => csvCell(o[c[0]])).join(","))].join("\n") + "\n"; }
function toJson(rows, extra) { return JSON.stringify({ ...extra, columns: COLUMNS.map(c => c[0]), rows }, null, 1) + "\n"; }

function main() {
  const rows = build();
  if (!rows.length) { console.log("NBA feed: no graded games yet."); return; }
  const days = [...new Set(rows.map(o => o.game_date))].sort().slice(-SAMPLE_DAYS), keep = new Set(days);
  const sample = rows.filter(o => keep.has(o.game_date));
  const meta = { source: "Leo (ndhorizon.com)", sport: "NBA", built_at: new Date().toISOString(), from: days[0], through: days[days.length - 1],
    note: "Sample: the last 7 graded days. Leo's own output only, read of record before tip; no sportsbook numbers. Not betting advice." };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "sample.csv"), toCsv(sample));
  fs.writeFileSync(path.join(OUT_DIR, "sample.json"), toJson(sample, meta));
  fs.writeFileSync(path.join(OUT_DIR, "schema.json"), JSON.stringify({ sport: "NBA", file: "One row per graded game. Read of record only: the last read Leo saved before tip.",
    columns: COLUMNS.map(([name, type, unit, meaning]) => ({ name, type, unit, meaning })) }, null, 1) + "\n");
  console.log(`NBA feed sample: ${sample.length} games, ${days[0]} to ${days[days.length - 1]} (data/feed/nba/).`);
  if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(OUT, OUT.endsWith(".json") ? toJson(rows, { ...meta, note: "Full season. Leo's own output only, read of record before tip; no sportsbook numbers. Not betting advice." }) : toCsv(rows));
    console.log(`NBA feed full season: ${rows.length} games written to ${OUT}. Do not commit it.`);
  }
}
main();
