#!/usr/bin/env node
/**
 * Last season's player values, for the Pick Safety Gate (scripts/lib/nba-pick-gate.js; Lynold, 2026-11-23).
 * NBA lane, built by the Manager on Lynold's named instruction. Run once a season (or by hand):
 *   node scripts/build-nba-prior-players.js [season]     default: the season before the current one
 * Writes data/nba/prior-players.json { season, built_at, values: { athlete_id: { name, value } } }: each player's
 * value over his last 10 lines of that season (regulars only, as scripts/lib/nba-model.js regulars()).
 */
"use strict";
const fs = require("fs"), path = require("path");
const M = require("./lib/nba-model");
(async () => {
  const model = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "nba", "model.json"), "utf8"));
  const season = +(process.argv[2] || (model.season - 1));
  const { players } = await M.loadSeason(season, { maxAgeHours: 24 * 30 });
  const values = {};
  for (const r of M.regulars(players, "9999-12-31")) if (!values[r.id] || r.value > values[r.id].value) values[r.id] = { name: r.name, value: +r.value.toFixed(2) };
  const out = path.join(__dirname, "..", "data", "nba", "prior-players.json");
  fs.writeFileSync(out, JSON.stringify({ season, built_at: new Date().toISOString(), values }, null, 1) + "\n");
  console.log(`prior-players.json: season ${season}, ${Object.keys(values).length} players`);
})().catch(e => { console.error(e); process.exit(1); });
