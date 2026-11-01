#!/usr/bin/env node
/**
 * Leo NBA season schedule for the scoreboard's date picker.
 *
 *   node scripts/build-nba-schedule.js        writes data/nba/schedule.json
 *
 * Every regular-season game from the sportsdataverse schedule release (ESPN
 * data), grouped by Eastern date, with tip time, venue and the final score
 * once a game is complete. Display only: no Leo numbers live here. Leo's read
 * for a game still exists only on game day, in picks-<date>.json, frozen
 * before tip. Days before the first card show finals only.
 */
const fs = require("fs");
const path = require("path");
const M = require("./lib/nba-model");

const DIR = path.join(__dirname, "..", "data", "nba");
const nyDate = iso => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));

(async () => {
  const model = JSON.parse(fs.readFileSync(path.join(DIR, "model.json"), "utf8"));
  const season = model.season;
  const rows = M.parseCsv(await M.download("schedule", season, { maxAgeHours: 6 }),
    ["id", "start_date", "date", "season_type", "status_type_completed", "venue_full_name", "home_abbreviation", "home_display_name",
      "away_abbreviation", "away_display_name", "home_score", "away_score"]);
  const byDay = new Map();
  for (const r of rows) {
    if (r.season_type !== "2" || !r.home_abbreviation || !r.away_abbreviation) continue;
    const tip = new Date(r.start_date || r.date).toISOString(), final = r.status_type_completed === "true";
    const d = nyDate(tip);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push({
      game_id: String(r.id), tip_utc: tip, home: r.home_abbreviation, away: r.away_abbreviation,
      home_name: r.home_display_name, away_name: r.away_display_name, venue: r.venue_full_name || "",
      final, hs: final ? +r.home_score : null, as: final ? +r.away_score : null
    });
  }
  const days = [...byDay.keys()].sort().map(date => ({ date, games: byDay.get(date).sort((a, b) => a.tip_utc.localeCompare(b.tip_utc)) }));
  if (!days.length) { console.log("NBA schedule: no games in the release file; nothing written."); return; }
  fs.writeFileSync(path.join(DIR, "schedule.json"), JSON.stringify({
    season, updated_at: new Date().toISOString(),
    source: "ESPN schedule via the open sportsdataverse release files",
    games: days.reduce((s, d) => s + d.games.length, 0), days
  }) + "\n");
  console.log(`NBA schedule ${season}: ${days.length} days, ${days.reduce((s, d) => s + d.games.length, 0)} games, ${days[0].date} to ${days[days.length - 1].date}.`);
})().catch(e => { console.error(e); process.exit(1); });
