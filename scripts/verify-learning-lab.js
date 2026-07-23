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

const headerChecks = [
  ["data/calibration/calibration_model_log.csv", "date,gamePk,model_version,"],
  ["data/calibration/attribution_model_log.csv", "date,gamePk,model_version,"],
  ["data/calibration/shadow_model_log.csv", "date,gamePk,official_model_version,shadow_model_version,"],
  ["data/calibration/totals_log.csv", "date,gamePk,line,over_price,under_price,projection,actual_total,ou_result,lean,lean_result,lab_score,matchup"]
];
for (const [rel, header] of headerChecks) {
  const full = path.join(ROOT, rel);
  if (fs.existsSync(full) && !fs.readFileSync(full, "utf8").startsWith(header)) {
    fail(`${rel} has an unexpected schema.`);
  }
}

console.log(`Learning/Lab verification passed for ${brief.date} (${brief.games.length} games, ${brief.model_version}).`);
