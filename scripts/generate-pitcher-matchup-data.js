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

function loadTotalsPitchingPlan(date) {
  // update-totals.js runs before this script in the publish pipeline and
  // already computes an innings-weighted "effective_era" per side that
  // folds in the actual bullpen's recent ERA for whatever innings are not
  // covered by a named starter/opener. Reused here so that a reported
  // opener/bulk-bullpen plan's pitching score is not just the opener's own
  // line for the ~2 innings he throws, silently ignoring the ~7 innings the
  // bullpen throws behind him.
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "totals", `${date}.json`), "utf8"));
    return (raw && raw.games) || {};
  } catch (_) {
    return {};
  }
}

// Same era->score curve PitcherCore.scorePitcher() uses (40% weight on ERA
// in that formula), so an effective-era-derived score sits on the same 20-92
// scale as a directly-scored individual pitcher and the two remain
// comparable.
function eraToScore(era) {
  if (!Number.isFinite(era)) return null;
  return Math.round(Math.max(20, Math.min(92, 100 - (era - 2.0) * 16)));
}

async function main() {
  const totalsPitchingPlan = loadTotalsPitchingPlan(DATE);
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
      row.pitching_plan = plans;
      row.bullpen_game = true;
      row.pitching_plan_confidence = Object.values(plans).some(plan => plan.confidence === "manual") ? "manual" : "reported";
    }

    // Score every game -- reported opener/bulk plans AND ordinary two-starter
    // games alike -- on the same innings-weighted effective ERA the
    // win-probability model itself uses (starter/opener FIP blended with the
    // bullpen's actual recent ERA for the remaining innings), not just
    // reported plans. A ordinary starter still only throws ~5 of 9 innings;
    // scoring him alone on his own individual line and ignoring the other
    // ~4 has the same blind spot the opener case had, just smaller -- and
    // leaving ordinary games on the old method while reported-plan games
    // use the new one meant Lab Rating (which reads update-totals.js's
    // pitcher_score, fixed for every game) and this page's own pitcher
    // table/edge copy (which read this file) could show two different,
    // disagreeing "pitcher edge" numbers for the same game. update-totals.js
    // runs for every game unconditionally, so totals data is available here
    // regardless of whether a plan was manually reported.
    const totalsGameRecord = totalsPitchingPlan[String(game.gamePk)];
    const totalsSideFor = side => totalsGameRecord && totalsGameRecord.pitching_plan && totalsGameRecord.pitching_plan[side];
    for (const side of ["away", "home"]) {
      if (!row[side]) continue;
      const totalsSide = totalsSideFor(side);
      if (typeof row[side].effectiveEra === "undefined") {
        row[side].effectiveEra = totalsSide && Number.isFinite(totalsSide.effective_era) ? totalsSide.effective_era : null;
      }
    }
    const planScore = (side, fallback) => {
      const plan = plans[side];
      const totalsSide = totalsSideFor(side);
      const effScore = totalsSide && eraToScore(totalsSide.effective_era);
      if (effScore !== null && effScore !== undefined) return effScore;
      const arms = ((plan && plan.segments) || []).filter(segment => segment.role !== "bullpen" && segment.stats);
      const innings = arms.reduce((sum, segment) => sum + Number(segment.expected_innings), 0);
      return innings > 0
        ? Math.round(arms.reduce((sum, segment) =>
            sum + PitcherCore.scorePitcher(segment.stats).score * Number(segment.expected_innings), 0
          ) / innings)
        : fallback;
    };
    if (row.away && row.home) {
      row.away_plan_score = planScore("away", row.away.score);
      row.home_plan_score = planScore("home", row.home.score);
      row.gap = Math.abs(row.home_plan_score - row.away_plan_score);
      row.strength = row.gap >= 14 ? "Strong" : row.gap >= 8 ? "Moderate" : row.gap >= 4 ? "Slight" : "No clear edge";
      row.edge_team = row.gap < 4
        ? "No clear pitching-plan edge"
        : row.home_plan_score > row.away_plan_score ? row.home_team : row.away_team;
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
