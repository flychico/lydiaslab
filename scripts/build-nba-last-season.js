#!/usr/bin/env node
/**
 * Last season's NBA finals, for the head to head box on the game pages.
 *
 *   node scripts/build-nba-last-season.js [season]   default: model season - 1
 *
 * Writes data/nba/last-season-games.json: every regular season final of that
 * season (date, home, away, scores) from the sportsdataverse schedule release.
 * Run once a season. Display only, nothing here feeds Leo's numbers.
 */
const fs = require("fs");
const path = require("path");
const M = require("./lib/nba-model");
const DIR = path.join(__dirname, "..", "data", "nba");
const nyDate = iso => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));
(async () => {
  const season = +(process.argv[2] || (JSON.parse(fs.readFileSync(path.join(DIR, "model.json"), "utf8")).season - 1));
  const rows = M.parseCsv(await M.download("schedule", season, { maxAgeHours: 24 * 365 }),
    ["id", "start_date", "date", "season_type", "status_type_completed", "home_abbreviation", "away_abbreviation", "home_score", "away_score"]);
  const games = rows.filter(r => r.season_type === "2" && r.status_type_completed === "true" && r.home_abbreviation && r.away_abbreviation)
    .map(r => ({ date: nyDate(new Date(r.start_date || r.date).toISOString()), home: r.home_abbreviation, away: r.away_abbreviation, hs: +r.home_score, as: +r.away_score }))
    .sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(path.join(DIR, "last-season-games.json"), JSON.stringify({ season, source: "ESPN schedule via the open sportsdataverse release files", games }) + "\n");
  console.log(`last-season-games.json: ${games.length} finals, season ${season}`);
})().catch(e => { console.error(e.message); process.exit(1); });
