#!/usr/bin/env node
/**
 * Public team rating files for rating aggregators (Massey Ratings composite,
 * The Power Rank and similar), next to the prediction files.
 * Lynold, 2026-11-25: Gemini's outreach plan pitches Leo's team ratings to
 * Massey; Massey's composite takes ratings and rankings, not game predictions.
 *
 *   node scripts/build-rating-files.js nfl   writes data/ratings/nfl.csv (+ .json)
 *   node scripts/build-rating-files.js nba   writes data/ratings/nba.csv (+ .json)
 *
 * NFL columns: rank, team, abbr, leo_overall (0 to 100, 50 is average), quarterback,
 *   offense, defense (0 to 100), games, as_of, model_version
 *   Leo's ratings from the newest read of each team's latest game page
 *   (data/nfl/matchups/<date>.json, ratings.this_season), the same numbers the game pages show.
 * NBA columns: rank, team, abbr, leo_rating (points better than an average team on a
 *   neutral floor), as_of, model_version
 *   From the newest NBA card each team appears on (data/nba/picks-<date>.json, leo.rating).
 * Leo's output only: no sportsbook number. Each day is also kept under data/ratings/<sport>/<date>.csv.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const sport = String(process.argv[2] || "").toLowerCase();
if (!["nfl", "nba"].includes(sport)) { console.log("usage: build-rating-files.js <nfl|nba>"); process.exit(0); }
const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const read = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };
const cell = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const r1 = x => x == null || !Number.isFinite(+x) ? "" : (Math.round(+x * 10) / 10).toFixed(1);

function nfl() {
  const TEAMS = require("./lib/nfl-teams");
  const dir = path.join(ROOT, "data/nfl/matchups"), latest = {};
  const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) <= addDays(todayET, 8)).sort();
  for (const f of files) for (const m of read(path.join(dir, f)) || []) {
    const R = m.ratings && m.ratings.this_season; if (!R) continue;
    for (const side of ["away", "home"]) if (R[side] && R[side].overall != null) latest[m[side]] = { ...R[side], date: m.date };
  }
  const rows = Object.entries(latest).map(([abbr, r]) => ({ team: TEAMS.full(abbr), abbr, leo_overall: r1(r.overall), quarterback: r1(r.qb_rating), offense: r1(r.off_rating), defense: r1(r.def_rating), games: r.games ?? "", as_of: todayET, model_version: "leo-nflml-v2" }))
    .sort((a, b) => b.leo_overall - a.leo_overall).map((r, i) => ({ rank: i + 1, ...r }));
  return { rows, cols: ["rank", "team", "abbr", "leo_overall", "quarterback", "offense", "defense", "games", "as_of", "model_version"] };
}

function nba() {
  const dir = path.join(ROOT, "data/nba"), latest = {};
  const files = fs.readdirSync(dir).filter(f => /^picks-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(6, 16) <= todayET).sort();
  let mv = "";
  for (const f of files) { const c = read(path.join(dir, f)); if (!c) continue; mv = c.model_version || mv;
    for (const g of c.games || []) { const r = g.leo && g.leo.rating; if (!r) continue;
      if (r.home != null) latest[g.home] = { name: g.home_name, rating: r.home };
      if (r.away != null) latest[g.away] = { name: g.away_name, rating: r.away }; } }
  const rows = Object.entries(latest).map(([abbr, r]) => ({ team: r.name, abbr, leo_rating: r1(r.rating), as_of: todayET, model_version: mv || "leo-nba-v2" }))
    .sort((a, b) => b.leo_rating - a.leo_rating).map((r, i) => ({ rank: i + 1, ...r }));
  return { rows, cols: ["rank", "team", "abbr", "leo_rating", "as_of", "model_version"] };
}

const { rows, cols } = sport === "nfl" ? nfl() : nba();
if (!rows.length) { console.log(`No ${sport} ratings found.`); process.exit(0); }
const csv = [cols.join(","), ...rows.map(r => cols.map(c => cell(r[c])).join(","))].join("\n") + "\n";
const out = path.join(ROOT, "data/ratings");
fs.mkdirSync(path.join(out, sport), { recursive: true });
fs.writeFileSync(path.join(out, `${sport}.csv`), csv);
fs.writeFileSync(path.join(out, `${sport}.json`), JSON.stringify({ sport, as_of: todayET, columns: cols, teams: rows }, null, 1) + "\n");
fs.writeFileSync(path.join(out, sport, `${todayET}.csv`), csv);
console.log(`data/ratings/${sport}.csv: ${rows.length} teams, top ${rows.slice(0, 3).map(r => r.abbr).join(", ")}`);
