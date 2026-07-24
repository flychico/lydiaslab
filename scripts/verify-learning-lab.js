#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");
const json = rel => JSON.parse(read(rel));
const fail = message => { throw new Error(message); };

const lab = read("lab-v3/index.html");
if (lab.includes("statsapi.mlb.com")) fail("Lab v3 must not recompute from live MLB data.");
if (lab.includes("v3 pick?") || lab.includes("live compute")) fail("Lab v3 still claims an unlocked shadow decision.");
if (!lab.includes("matchup-pages/${date}.json")) fail("Lab v3 must resolve matchup links from the canonical manifest.");

const brief = json("data/member-brief/today.json");
if (!brief.model_version) fail("Member brief is missing model_version.");
for (const game of brief.games || []) {
  if (!game.game_pk) fail("Member brief game is missing game_pk.");
  if (!game.model_source) fail(`Game ${game.game_pk} is missing model_source.`);
  if (!game.model_v3 || !Number.isFinite(game.model_v3.p_home) || !game.model_v3.version) {
    fail(`Game ${game.game_pk} is missing a locked, versioned shadow probability.`);
  }
}

const summary = json("data/learning-summary.json");
if (summary.status === "ready") {
  if (!summary.current_official_model || summary.current_official_model === "moneyline_only") {
    fail("Learning summary does not identify the official model version.");
  }
  for (const row of (summary.buckets && summary.buckets.strong_official) || []) {
    if (row.status !== "official_pick") fail("Verified official bucket contains a non-official row.");
    if (!(row.model_probability >= 0.72 && row.lab_score >= 80 && row.raw_edge >= 0.03)) {
      fail("Verified official bucket contains a gate failure.");
    }
    if (!row.date) fail("Historical review row is missing its date.");
  }
  for (const row of (summary.buckets && summary.buckets.protected_by_probability_gate) || []) {
    if (!["W", "L"].includes(row.result)) fail("Probability-gate bucket contains an ungraded row.");
    if (!row.date) fail("Historical review row is missing its date.");
  }
  if (summary.calibration && summary.calibration.status === "ready" && !summary.calibration.model_version) {
    fail("Calibration is ready without a model version.");
  }
}

const totals = json("data/totals/today.json");
const requireCurrentTotals = process.argv.includes("--require-current-totals");
if (totals.model_version || requireCurrentTotals) {
  if (totals.model_version !== "totals-runs-v3-pitching-plan") fail("Totals capture uses the wrong model version.");
  if (!totals.policy || totals.policy.research_min_edge !== 0.7 || totals.policy.research_min_setup !== 70) {
    fail("Totals research-lean policy is not synchronized.");
  }
  if (totals.policy.official_totals_enabled !== true) fail("Official totals must be enabled.");
  if (totals.policy.team_totals_official_enabled !== false) fail("Team totals must remain research-only.");
}

const totalsSource = read("scripts/update-totals.js");
if (!totalsSource.includes('const TOTALS_MODEL_VERSION = "totals-runs-v3-pitching-plan"')) {
  fail("Totals generator does not declare the synchronized model version.");
}
if (!totalsSource.includes("research_min_edge: 0.7") || !totalsSource.includes("research_min_setup: 70")) {
  fail("Totals generator thresholds disagree with the synchronized policy.");
}
if (!totalsSource.includes("official_totals_enabled: true")) {
  fail("Totals generator must enable official full-game totals.");
}
if (!totalsSource.includes("team_totals_official_enabled: false")) {
  fail("Totals generator must keep team totals research-only.");
}

const totalsTool = read("tools/totals-projections/index.html");
if (!totalsTool.includes("POLICY.research_min_edge") || !totalsTool.includes("POLICY.research_min_setup")) {
  fail("Totals tool is not using the synchronized policy.");
}

const headerChecks = [
  ["data/calibration/calibration_model_log.csv", "date,gamePk,model_version,"],
  ["data/calibration/attribution_model_log.csv", "date,gamePk,model_version,"],
  ["data/calibration/shadow_model_log.csv", "date,gamePk,official_model_version,shadow_model_version,"],
  ["data/calibration/totals_model_log.csv", "date,gamePk,model_version,line,over_price,under_price,projection,actual_total,ou_result,lean,lean_result,setup_rating,classification,matchup"]
];
for (const [rel, header] of headerChecks) {
  const full = path.join(ROOT, rel);
  if (fs.existsSync(full) && !fs.readFileSync(full, "utf8").startsWith(header)) {
    fail(`${rel} has an unexpected schema.`);
  }
}

console.log(`Learning/Lab verification passed for ${brief.date} (${brief.games.length} games, ${brief.model_version}).`);
