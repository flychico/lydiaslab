#!/usr/bin/env node
/**
 * Public prediction files for outside trackers (The Prediction Tracker first).
 * Lynold, Manager chat, Nov 19: "Yes, build both", "Latest read, locked at kickoff".
 *
 *   node scripts/build-prediction-files.js nfl    writes data/predictions/nfl.csv (+ .json)
 *   node scripts/build-prediction-files.js nba    writes data/predictions/nba.csv (+ .json)
 *
 * The same columns every week, in this order (data/predictions/README.md):
 *   sport, season, week, game_date, start_utc, game_id, away_team, home_team,
 *   leo_win_prob_away, leo_win_prob_home, leo_margin_home, leo_total,
 *   status, model_version
 * status: "open" = Leo's latest read, can still change before the start;
 *         "frozen" = the game has started, this is Leo's final read (the one the site grades).
 * Only numbers already public on the game pages (DEC: trackers get only what is public).
 * No sportsbook number in any column.
 *
 * NFL: every game of the current week (the week of the next game to start; the
 * last week when none is left). NBA: the newest card on or before today (ET).
 * Each file is also kept per week or per date under data/predictions/<sport>/.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const sport = String(process.argv[2] || "").toLowerCase();
if (!["nfl", "nba"].includes(sport)) { console.log("usage: build-prediction-files.js <nfl|nba>"); process.exit(0); }
const NOW = Date.now();
const COLS = ["sport", "season", "week", "game_date", "start_utc", "game_id", "away_team", "home_team",
  "leo_win_prob_away", "leo_win_prob_home", "leo_margin_home", "leo_total", "status", "model_version"];

const r3 = x => (x == null || isNaN(+x) ? "" : (Math.round(+x * 1000) / 1000).toFixed(3));
const r1 = x => (x == null || isNaN(+x) ? "" : (Math.round(+x * 10) / 10).toFixed(1));
const csvCell = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const todayET = new Date(NOW).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

// "2026-11-22" + "13:00" Eastern -> ISO UTC (handles daylight time).
function etToUtc(date, hhmm) {
  if (!date || !/^\d{1,2}:\d{2}$/.test(String(hhmm || ""))) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const guess = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m);
  const etAtGuess = new Date(guess).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const [md, t] = etAtGuess.split(", ");
  const [mo, d, y] = md.split("/").map(Number), [hh, mm] = t.split(":").map(Number);
  const offset = Date.UTC(y, mo - 1, d, hh % 24, mm) - guess;   // ET minus UTC
  return new Date(guess - offset).toISOString().replace(".000Z", "Z");
}

function write(rows, archiveName) {
  const dir = path.join(ROOT, "data", "predictions");
  fs.mkdirSync(path.join(dir, sport), { recursive: true });
  const csv = [COLS.join(","), ...rows.map(r => COLS.map(c => csvCell(r[c])).join(","))].join("\n") + "\n";
  const json = JSON.stringify({ sport, updated_utc: new Date(NOW).toISOString().replace(/\.\d+Z$/, "Z"), columns: COLS, games: rows }, null, 1) + "\n";
  for (const base of [path.join(dir, sport), path.join(dir, sport, archiveName)]) {
    fs.writeFileSync(base + ".csv", csv);
    fs.writeFileSync(base + ".json", json);
  }
  console.log(`${sport}: ${rows.length} games -> data/predictions/${sport}.csv (and ${sport}/${archiveName}.csv)`);
}

if (sport === "nfl") {
  const T = require("./lib/nfl-teams");
  const files = fs.readdirSync(path.join(ROOT, "data", "nfl")).filter(f => /^picks-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const games = [];
  for (const f of files) {
    let list; try { list = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "nfl", f), "utf8")); } catch (e) { continue; }
    for (const g of Array.isArray(list) ? list : []) {
      if (!g || !g.game_id || g.model_prob == null) continue;
      const start = etToUtc(g.date, g.kickoff);
      const pHome = g.pick === g.home ? +g.model_prob : 1 - +g.model_prob;
      games.push({ g, start, pHome, season: String(g.game_id).slice(0, 4), week: +g.week });
    }
  }
  if (!games.length) { console.log("nfl: no picks files"); process.exit(0); }
  const future = games.filter(x => x.start && Date.parse(x.start) > NOW).sort((a, b) => a.start.localeCompare(b.start));
  const cur = future.length ? future[0] : games.sort((a, b) => (a.season + String(a.week).padStart(2, "0")).localeCompare(b.season + String(b.week).padStart(2, "0"))).pop();
  const wk = games.filter(x => x.season === cur.season && x.week === cur.week)
    .sort((a, b) => (a.start || "").localeCompare(b.start || "") || a.g.game_id.localeCompare(b.g.game_id));
  const rows = wk.map(({ g, start, pHome, season, week }) => ({
    sport: "nfl", season, week, game_date: g.date, start_utc: start, game_id: g.game_id,
    away_team: T.full(g.away) || g.away, home_team: T.full(g.home) || g.home,
    leo_win_prob_away: r3(1 - pHome), leo_win_prob_home: r3(pHome),
    leo_margin_home: r1(g.exp_margin), leo_total: r1(g.proj_total),
    status: start && Date.parse(start) <= NOW ? "frozen" : "open",
    model_version: g.model_version || "",
  }));
  write(rows, `${cur.season}-week-${cur.week}`);
} else {
  const dir = path.join(ROOT, "data", "nba");
  const dates = fs.readdirSync(dir).map(f => (/^picks-(\d{4}-\d{2}-\d{2})\.json$/.exec(f) || [])[1]).filter(Boolean).filter(d => d <= todayET).sort();
  if (!dates.length) { console.log("nba: no card"); process.exit(0); }
  const date = dates[dates.length - 1];
  const doc = JSON.parse(fs.readFileSync(path.join(dir, `picks-${date}.json`), "utf8"));
  const season = (() => { const y = +date.slice(0, 4), m = +date.slice(5, 7); return m >= 8 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`; })();
  const rows = (doc.games || []).filter(g => g.leo && g.leo.p_home != null)
    .sort((a, b) => String(a.tip_utc).localeCompare(String(b.tip_utc)))
    .map(g => ({
      sport: "nba", season, week: "", game_date: date, start_utc: String(g.tip_utc || "").replace(/\.\d+Z$/, "Z"), game_id: g.game_id,
      away_team: g.away_name || g.away, home_team: g.home_name || g.home,
      leo_win_prob_away: r3(g.leo.p_away != null ? g.leo.p_away : 1 - g.leo.p_home), leo_win_prob_home: r3(g.leo.p_home),
      leo_margin_home: r1(g.leo.home_margin), leo_total: g.leo.projected && g.leo.projected.total != null ? r1(g.leo.projected.total) : "",
      status: g.tip_utc && Date.parse(g.tip_utc) <= NOW ? "frozen" : "open",
      model_version: g.model_version || doc.model_version || "",
    }));
  write(rows, date);
}
