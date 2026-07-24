#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const DATE = (process.argv[2] || "").match(/^\d{4}-\d{2}-\d{2}$/)
  ? process.argv[2]
  : new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");
const json = rel => JSON.parse(read(rel));
const fail = msg => { throw new Error(msg); };

const totals = json(`data/totals/${DATE}.json`);
if (totals.model_version !== "totals-runs-v3-pitching-plan") fail("Wrong totals model version.");
if (!totals.policy || totals.policy.official_totals_enabled !== true) fail("Official game totals are not enabled.");
if (totals.policy.team_totals_official_enabled !== false) fail("Team totals must remain research-only.");
for (const [pk, game] of Object.entries(totals.games || {})) {
  if (!game.team_totals || !game.team_totals.away || !game.team_totals.home) fail(`Game ${pk} is missing team-total records.`);
  for (const side of ["away", "home"]) {
    const t = game.team_totals[side];
    if (!Number.isFinite(t.projection)) fail(`Game ${pk} ${side} team total is missing its projection.`);
    if (t.classification === "official_pick") fail(`Game ${pk} ${side} team total was incorrectly made official.`);
  }
  if (game.official_eligible) {
    const edge = game.projection - game.line;
    if (Math.abs(edge) < 1 || game.lab < 80) fail(`Game ${pk} bypassed the official totals gates.`);
    const price = edge > 0 ? game.over : game.under;
    if (!Number.isFinite(price)) fail(`Game ${pk} official total is missing its selected price.`);
  }
}

const picks = json(`data/published-picks/${DATE}.json`);
if (picks.current_official_model !== "multi_market_v1") fail("Published picks are not using the multi-market schema.");
for (const group of picks.picks || []) {
  if (group.total) {
    if (Math.abs(group.total.edge) < 1 || group.total.labScore < 80 || !Number.isFinite(group.total.bestAm)) {
      fail(`Game ${group.gamePk} has an invalid official total.`);
    }
  }
  for (const k of group.strikeouts || []) {
    if (Math.abs(k.edge) < 0.7 || k.expectedInnings < 4 || k.books < 2 || !Number.isFinite(k.bestAm)) {
      fail(`Game ${group.gamePk} has an invalid official K pick for ${k.pitcher}.`);
    }
  }
}

const grader = read("scripts/grade-results.js");
if (grader.includes("voided_starter_scratched")) fail("Results grader still voids team markets for starter changes.");
if (!grader.includes("pitcher_strikeouts")) fail("Results grader does not grade official K props.");
if (!read("tools/totals-projections/index.html").includes("Team total")) fail("Totals tool does not render team totals.");
if (!read("scripts/generate-matchup-pages.js").includes("team_totals")) fail("Matchup pages do not render team totals.");

console.log(`Official-market verification passed for ${DATE}: ${(picks.picks || []).length} pick group(s), ${Object.keys(totals.games || {}).length} totals games.`);
