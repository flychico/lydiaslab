#!/usr/bin/env node
/**
 * Leo's frozen anytime touchdown chances for one NFL game day, for the live
 * touchdown tracker on /nfl/scoreboard/ (DEC-20261115-51).
 *
 *   node scripts/build-nfl-td-reads.js YYYY-MM-DD
 *
 * Writes data/nfl/td-reads-<date>.json. For each player: the last ANYTIME_TD
 * capture in data/nfl/prop-prediction-history.csv saved strictly before his
 * game's kickoff (the read of record, the same one grading uses). Games not
 * started yet carry their latest capture and are marked frozen: false.
 * props-<date>.json is not used: a gather after kickoff rewrites it.
 * Display only; nothing here feeds Leo.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "data/nfl");
const DATE = process.argv.slice(2).find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (!DATE) { console.log("td reads: no date given, skipped."); process.exit(0); }

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

function build(date) {
  const f = path.join(DIR, "prop-prediction-history.csv");
  if (!fs.existsSync(f)) { console.log("td reads: no prop history, skipped."); return null; }
  const now = Date.now();
  const best = new Map();
  for (const r of parseCsv(fs.readFileSync(f, "utf8"))) {
    if (r.date !== date || r.market !== "ANYTIME_TD") continue;
    const cap = Date.parse(r.captured_at), kick = Date.parse(r.kickoff_utc);
    if (!Number.isFinite(cap) || !Number.isFinite(kick) || !(cap < kick)) continue;
    const k = `${r.game_id}|${r.team}|${r.player}`;
    const prev = best.get(k);
    if (!prev || cap > prev._cap) best.set(k, { ...r, _cap: cap, _kick: kick });
  }
  const games = {};
  for (const r of best.values()) {
    const p = +r.projection;
    if (!Number.isFinite(p)) continue;
    (games[r.matchup] = games[r.matchup] || { game_id: r.game_id, kickoff_utc: r.kickoff_utc, frozen: r._kick <= now, players: [] })
      .players.push({ player: r.player, team: r.team, position: r.position, chance: Math.round(p * 1000) / 1000, captured_at: r.captured_at });
  }
  for (const g of Object.values(games)) g.players.sort((a, b) => b.chance - a.chance || a.player.localeCompare(b.player));
  const out = { date, built_at: new Date(now).toISOString(), source: "prop-prediction-history.csv, last ANYTIME_TD capture before kickoff", games };
  const file = path.join(DIR, `td-reads-${date}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
  const n = Object.values(games).reduce((s, g) => s + g.players.length, 0);
  console.log(`td reads ${date}: ${Object.keys(games).length} games, ${n} players -> ${path.relative(ROOT, file)}`);
  return out;
}

if (require.main === module) build(DATE);
module.exports = { build };
