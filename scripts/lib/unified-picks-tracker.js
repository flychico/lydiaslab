/*
  Unified Official Picks Tracker

  Single source of truth for all official picks across markets (moneyline,
  pitcher_strikeouts, game_total, etc.). Replaces fragmented tracking in
  separate calibration_model_log.csv and kprops_log.csv files.

  Schema: unified_official_picks_log.csv

  One row per official pick, with market-specific columns populated only for
  that market. This enables:
  - Single audit trail for all official picks
  - Performance comparison across markets
  - Variance analysis: separate "good picks that lost" from "bad picks that won"
  - Model improvement tracking: see what changed and why

  Date: 2026-09-14, Lynold's decision to unify tracking.
*/
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// CSV header for unified picks log
const UNIFIED_HEADER = [
  "date",
  "game_pk",
  "matchup",
  "market",
  "model_version",
  "status",
  "model_pick",
  "model_value",
  "market_value",
  "edge",
  "best_price",
  "books",
  "lab_score",
  "result",
  "actual_value",
  // Moneyline-specific columns
  "ml_pick_team",
  "ml_pick_prob",
  "ml_market_prob",
  // K-props specific columns
  "kp_pitcher",
  "kp_role",
  "kp_expected_innings",
  "kp_projection_raw",
  "kp_calibration_bias",
  "kp_k_rate_used",
  "kp_opp_k_adjustment",
  "kp_bullpen_game",
  "kp_lineup_source",
  // Shared diagnostic columns
  "note"
].join(",");

function escapeCSV(val) {
  if (val === null || val === undefined || val === "") return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function recordMoneylinePickForUnifiedLog(pick, date) {
  /*
    Unified record for a moneyline official pick.

    Input: pick object from generate-member-lab.js containing:
      - gamePk, matchup, model_source, model_probability, best_price,
        lab_score, pick_team, side, market_prob, etc.

    Returns: CSV row string (no newline)
  */
  if (!pick || pick.status !== "official_pick") return null;

  const row = [
    escapeCSV(date),
    escapeCSV(pick.gamePk),
    escapeCSV(pick.matchup),
    escapeCSV("moneyline"),
    escapeCSV(pick.model_source || "leo"),
    escapeCSV(pick.status),
    escapeCSV(pick.pick_team),
    escapeCSV(pick.model_probability),
    escapeCSV(pick.market_prob || ""),
    escapeCSV(pick.edge || ""),
    escapeCSV(pick.best_price || ""),
    escapeCSV(""),  // books (N/A for moneyline)
    escapeCSV(pick.lab_score),
    escapeCSV(""),  // result (populated during grading)
    escapeCSV(""),  // actual_value (populated during grading)
    escapeCSV(pick.pick_team),  // ml_pick_team
    escapeCSV(pick.model_probability),  // ml_pick_prob
    escapeCSV(pick.market_prob || ""),  // ml_market_prob
    // K-props columns (empty for moneyline)
    "", "", "", "", "", "", "", "", "", "",
    escapeCSV(`Moneyline pick: ${pick.pick_team} vs ${pick.matchup.split(" @ ")[0]}`)
  ];

  return row.join(",");
}

function recordKPropsPickForUnifiedLog(kpropPick, date, gamePk, matchup) {
  /*
    Unified record for a K-props official pick.

    Input: kpropPick object from generate-member-lab.js containing:
      - pitcher, pick, line, projection, edge, books, bestAm,
        expectedInnings, pitcherRole, lineupSource, bullpen_game,
        calibration_bias, k_rate_used, opp_k_adjustment, etc.

    gamePk: the game ID
    matchup: e.g. "Away @ Home"
    date: YYYY-MM-DD or MM/DD/YYYY

    Returns: CSV row string (no newline)
  */
  if (!kpropPick || kpropPick.valueTag !== "OFFICIAL PICK") return null;

  const row = [
    escapeCSV(date),
    escapeCSV(gamePk),
    escapeCSV(matchup),
    escapeCSV("pitcher_strikeouts"),
    escapeCSV("leo-kprop"),
    escapeCSV("official_pick"),
    escapeCSV(kpropPick.pick),  // Over/Under
    escapeCSV(kpropPick.projection),
    escapeCSV(kpropPick.line),
    escapeCSV(kpropPick.edge),
    escapeCSV(kpropPick.bestAm),
    escapeCSV(kpropPick.books),
    escapeCSV(""),  // lab_score (N/A for K-props)
    escapeCSV(""),  // result (populated during grading)
    escapeCSV(""),  // actual_value (populated during grading)
    // Moneyline columns (empty for K-props)
    "", "", "",
    // K-props columns
    escapeCSV(kpropPick.pitcher),
    escapeCSV(kpropPick.pitcherRole || ""),
    escapeCSV(kpropPick.expectedInnings),
    escapeCSV(""),  // projection_raw (need to add to kprop data)
    escapeCSV(""),  // calibration_bias (need to add to kprop data)
    escapeCSV(""),  // k_rate_used (need to add to kprop data)
    escapeCSV(""),  // opp_k_adjustment (need to add to kprop data)
    escapeCSV(""),  // bullpen_game (need to verify)
    escapeCSV(kpropPick.lineupSource || ""),
    escapeCSV(`K-props: ${kpropPick.pitcher} ${kpropPick.pick} ${kpropPick.line}`)
  ];

  return row.join(",");
}

function ensureUnifiedLogFileExists() {
  const filePath = path.join(ROOT, "data", "calibration", "unified_official_picks_log.csv");

  // Create directory if needed
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Create file with header if it doesn't exist
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, UNIFIED_HEADER + "\n", "utf8");
    console.log(`Created unified picks log: ${filePath}`);
  }

  return filePath;
}

function appendPickToUnifiedLog(csvRow, date) {
  /*
    Append a unified pick record to the log file.
    Date is used to find/create the correct file location.
  */
  if (!csvRow) return;  // Skip null entries

  const filePath = ensureUnifiedLogFileExists();
  fs.appendFileSync(filePath, csvRow + "\n", "utf8");
}

module.exports = {
  UNIFIED_HEADER,
  recordMoneylinePickForUnifiedLog,
  recordKPropsPickForUnifiedLog,
  ensureUnifiedLogFileExists,
  appendPickToUnifiedLog
};
