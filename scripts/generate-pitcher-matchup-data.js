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
      row.schedule_probable = {};
      for (const side of ["away", "home"]) {
        const plan = plans[side];
        if (!plan) continue;
        const scheduled = game.teams[side].probablePitcher || null;
        row.schedule_probable[side] = scheduled
          ? { id: scheduled.id, name: scheduled.fullName }
          : null;
        const opener = plan.segments.find(segment => segment.role === "opener");
        if (opener && opener.stats) {
          const scored = PitcherCore.scorePitcher(opener.stats);
          row[side] = {
            ...scored,
            roleKey: "opener",
            roleLabel: "Reported opener",
            expectedInnings: Number(opener.expected_innings),
            bullpenInnings: Number((9 - Number(opener.expected_innings)).toFixed(1)),
            roleConfidence: plan.confidence || "manual",
            bullpenGame: true,
            note: `${opener.pitcher} is the reported opener; see the full pitching plan below.`
          };
        }
      }
      const planScore = (side, fallback) => {
        const plan = plans[side];
        const arms = ((plan && plan.segments) || []).filter(segment => segment.role !== "bullpen" && segment.stats);
        const innings = arms.reduce((sum, segment) => sum + Number(segment.expected_innings), 0);
        return innings > 0
          ? Math.round(arms.reduce((sum, segment) =>
              sum + PitcherCore.scorePitcher(segment.stats).score * Number(segment.expected_innings), 0
            ) / innings)
          : fallback;
      };
      row.away_plan_score = planScore("away", row.away.score);
      row.home_plan_score = planScore("home", row.home.score);
      row.gap = Math.abs(row.home_plan_score - row.away_plan_score);
      row.strength = row.gap >= 14 ? "Strong" : row.gap >= 8 ? "Moderate" : row.gap >= 4 ? "Slight" : "No clear edge";
      row.edge_team = row.gap < 4
        ? "No clear pitching-plan edge"
        : row.home_plan_score > row.away_plan_score ? row.home_team : row.away_team;
      row.pitching_plan = plans;
      row.bullpen_game = true;
      row.pitching_plan_confidence = Object.values(plans).some(plan => plan.confidence === "manual") ? "manual" : "reported";
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
