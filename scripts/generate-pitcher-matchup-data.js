#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const PitcherCore = require("../js/pitcher-matchup-core.js");
const PitchingPlan = require("./lib/pitching-plan-core.js");

const ROOT = path.join(__dirname, "..");
const DATE = process.argv[2] || easternDate();

if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error(`Invalid date: ${DATE}. Expected YYYY-MM-DD.`);
  process.exit(1);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

async function main() {
  const schedule = await getJson(
    `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}&hydrate=probablePitcher`
  );
  const games = ((((schedule.dates || [])[0]) || {}).games || [])
    .filter(game => game.gameType === "R" || game.gameType === undefined)
    .sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate));

  if (!games.length) throw new Error(`No MLB games found for ${DATE}.`);
  const reportedPlans = PitchingPlan.load(ROOT, DATE);

  const source = await PitcherCore.buildSource({
    date: DATE,
    games,
    getJson,
    generatedAt: new Date().toISOString()
  });
  const extraIds = PitchingPlan.participantIds(reportedPlans)
    .filter(id => !source.pitchers_by_id[String(id)]);
  if (extraIds.length) {
    Object.assign(source.pitchers_by_id, await PitcherCore.fetchPitchers(extraIds, DATE, getJson));
  }
  const bulkRoleStats = await PitchingPlan.fetchBulkRoleStats(reportedPlans, DATE, getJson);
  for (const game of games) {
    const row = source.games[String(game.gamePk)];
    if (!row) continue;
    const plans = {};
    for (const side of ["away", "home"]) {
      const plan = PitchingPlan.getSidePlan(reportedPlans, game.gamePk, side);
      if (!plan) continue;
      plans[side] = {
        ...plan,
        reported: true,
        description: PitchingPlan.describe(plan),
        segments: plan.segments.map(segment => ({
          ...segment,
          stats: segment.pitcher_id ? source.pitchers_by_id[String(segment.pitcher_id)] || null : null,
          role_stats: segment.role === "bulk" ? bulkRoleStats[Number(segment.pitcher_id)] || null : null
        }))
      };
    }
    if (Object.keys(plans).length) {
      row.pitching_plan = plans;
      row.bullpen_game = true;
      row.pitching_plan_confidence = "reported";
    }
  }
  source.pitching_plan_version = PitchingPlan.VERSION;

  writeJson(`data/pitcher-matchups/${DATE}.json`, source);
  if (DATE === easternDate()) writeJson("data/pitcher-matchups/today.json", source);

  console.log(
    `Generated canonical pitcher data for ${DATE}: ` +
    `${Object.keys(source.games).length} games, ${Object.keys(source.pitchers_by_id).length} pitchers.`
  );
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "LyDia pitcher matchup source generator" }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

function writeJson(relativePath, value) {
  const target = path.join(ROOT, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function easternDate() {
  const date = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  return (
    `${date.getFullYear()}-` +
    `${String(date.getMonth() + 1).padStart(2, "0")}-` +
    `${String(date.getDate()).padStart(2, "0")}`
  );
}
