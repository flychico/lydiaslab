#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const PitchingPlan = require("./lib/pitching-plan-core.js");

const ROOT = path.join(__dirname, "..");
const DATE = process.argv[2] || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

function read(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), "utf8"));
}

function fail(message) {
  throw new Error(message);
}

function sameAllocation(expected, actual, label) {
  if (!actual || !Array.isArray(actual.segments)) fail(`${label} is missing the pitching-plan segments.`);
  const wanted = expected.segments.map(segment => [segment.role, segment.pitcher || null, Number(segment.expected_innings)]);
  const found = actual.segments.map(segment => [segment.role, segment.pitcher || null, Number(segment.expected_innings)]);
  if (JSON.stringify(wanted) !== JSON.stringify(found)) {
    fail(`${label} does not match the canonical pitching-plan allocation.`);
  }
}

function main() {
  const plans = PitchingPlan.load(ROOT, DATE);
  const entries = Object.entries(plans.games || {});
  if (!entries.length) {
    console.log(`Pitching plans: no reported opener/bulk plans for ${DATE}.`);
    return;
  }

  const totals = read(`data/totals/${DATE}.json`);
  const brief = read(`data/member-brief/${DATE}.json`);
  const pitchers = read(`data/pitcher-matchups/${DATE}.json`);
  const kprops = read(`data/k-props/${DATE}.json`);
  const manifest = read(`data/matchup-pages/${DATE}.json`);
  const preview = fs.readFileSync(path.join(ROOT, "previews", `${DATE}.html`), "utf8");

  for (const [gamePk, gamePlan] of entries) {
    const totalGame = totals.games && totals.games[gamePk];
    const briefGame = (brief.games || []).find(game => String(game.game_pk) === String(gamePk));
    const pitcherGame = pitchers.games && pitchers.games[gamePk];
    if (!totalGame || !briefGame || !pitcherGame) fail(`Pitching plan ${gamePk} is missing from a downstream game source.`);

    for (const side of ["away", "home"]) {
      const expected = gamePlan[side];
      if (!expected) continue;
      sameAllocation(expected, totalGame.pitching_plan && totalGame.pitching_plan[side], `Totals ${gamePk}/${side}`);
      sameAllocation(expected, briefGame.pitching_plan && briefGame.pitching_plan[side], `Member brief ${gamePk}/${side}`);
      sameAllocation(expected, pitcherGame.pitching_plan && pitcherGame.pitching_plan[side], `Pitcher tool ${gamePk}/${side}`);

      for (const segment of expected.segments) {
        if (segment.role === "bullpen") continue;
        if (!preview.includes(segment.pitcher)) fail(`Preview is missing ${segment.pitcher} from pitching plan ${gamePk}.`);
        if (segment.role === "bulk") {
          const prop = kprops.pitchers && kprops.pitchers[String(segment.pitcher).toLowerCase()];
          if (!prop) fail(`K-prop source is missing bulk pitcher ${segment.pitcher}.`);
          if (Number(prop.expected_innings) !== Number(segment.expected_innings) || prop.pitcher_role !== "bulk") {
            fail(`K-prop source has the wrong bulk workload for ${segment.pitcher}.`);
          }
        }
      }
    }

    const page = (manifest.pages || []).find(item => String(item.game_pk) === String(gamePk));
    if (!page) fail(`Matchup manifest is missing pitching-plan game ${gamePk}.`);
    const html = fs.readFileSync(path.join(ROOT, page.output), "utf8");
    for (const sidePlan of [gamePlan.away, gamePlan.home].filter(Boolean)) {
      for (const segment of sidePlan.segments.filter(segment => segment.pitcher)) {
        if (!html.includes(segment.pitcher)) fail(`Matchup page is missing ${segment.pitcher}.`);
      }
    }
  }

  console.log(`Verified ${entries.length} reported pitching plan(s) across totals, moneyline, pitcher, K-prop, preview, and matchup-page outputs.`);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
