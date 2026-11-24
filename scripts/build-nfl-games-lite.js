#!/usr/bin/env node
/**
 * NFL games, small, for the head to head and rest boxes on the game pages.
 *
 *   node scripts/build-nfl-games-lite.js
 *
 * Writes data/nfl/games-lite.json from nflverse games.csv: every game from
 * 2016 on (finals with scores, this season's schedule without), with each
 * team's days of rest. Display only, nothing here feeds Leo's numbers.
 * Runs before the matchup pages are rendered; keeps the old file if the
 * download fails.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const OUT = path.join(__dirname, "..", "data", "nfl", "games-lite.json");
const FEED = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";
function parseCsv(t) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; } else if (c !== "\r") cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [h, ...r] = rows; return r.filter(x => x.length === h.length).map(x => Object.fromEntries(h.map((k, i) => [k, x[i]])));
}
let csv;
try { csv = execFileSync("curl", ["-sSfL", "--max-time", "60", FEED], { maxBuffer: 64 << 20 }).toString(); }
catch (e) { console.log(`games.csv unavailable (${String(e.message).split("\n")[0]}); games-lite.json left as it was`); process.exit(0); }
const n = v => v === "" || v == null ? null : +v;
const games = parseCsv(csv).filter(r => +r.season >= 2016).map(r => ({
  id: r.game_id, season: +r.season, type: r.game_type, week: +r.week, date: r.gameday,
  away: r.away_team, home: r.home_team, as: n(r.away_score), hs: n(r.home_score), ot: r.overtime === "1",
  ar: n(r.away_rest), hr: n(r.home_rest), loc: r.location
}));
fs.writeFileSync(OUT, JSON.stringify({ source: "nflverse games.csv", updated_at: new Date().toISOString(), games }) + "\n");
console.log(`games-lite.json: ${games.length} games`);
