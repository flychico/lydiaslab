#!/usr/bin/env node
/*
  Variance Analysis Tool

  Separates "good picks that lost" from "bad picks that won" to understand
  whether performance is driven by skill or luck.

  Usage:
    node scripts/analyze-variance.js [--market <moneyline|pitcher_strikeouts>] [--since YYYY-MM-DD]

  Examples:
    node scripts/analyze-variance.js                              # All markets, all time
    node scripts/analyze-variance.js --market pitcher_strikeouts  # K-props only
    node scripts/analyze-variance.js --since 2026-09-01           # Since Sept 1
    node scripts/analyze-variance.js --market moneyline --since 2026-08-01  # Combined filters
*/

const fs = require("fs");
const path = require("path");
const { parseArgs } = require("util");

const ROOT = path.join(__dirname, "..");

// Parse CLI arguments
const args = parseArgs({
  options: {
    market: { type: "string" },
    since: { type: "string" }
  },
  allowPositionals: false
});

// Helper to parse CSV safely
function parseCSV(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const header = lines[0].split(",");

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

    const values = [];
    let current = "";
    let inQuotes = false;

    for (let j = 0; j < lines[i].length; j++) {
      const char = lines[i][j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        values.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    values.push(current);

    const row = {};
    for (let k = 0; k < header.length; k++) {
      row[header[k].trim()] = values[k] ? values[k].trim().replace(/^"|"$/g, "") : "";
    }
    rows.push(row);
  }

  return rows;
}

function dateToKey(dateStr) {
  // Normalize MM/DD/YYYY or YYYY-MM-DD to comparable key
  if (dateStr.includes("/")) {
    const [m, d, y] = dateStr.split("/");
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return dateStr;
}

function analyzeVariance() {
  const logPath = path.join(ROOT, "data", "calibration", "unified_official_picks_log.csv");

  console.log("Loading unified picks log...");
  let picks = parseCSV(logPath);

  // Filter by status
  picks = picks.filter(p => p.status === "official_pick");

  // Filter by market if specified
  if (args.values.market) {
    picks = picks.filter(p => p.market === args.values.market);
    console.log(`Filtered to market: ${args.values.market}`);
  }

  // Filter by date if specified
  if (args.values.since) {
    const sinceKey = dateToKey(args.values.since);
    picks = picks.filter(p => dateToKey(p.date) >= sinceKey);
    console.log(`Filtered to picks since: ${args.values.since}`);
  }

  console.log(`\nAnalyzing ${picks.length} official picks\n`);
  console.log("=" + "=".repeat(70));

  // Separate wins and losses
  const wins = picks.filter(p => p.result === "W");
  const losses = picks.filter(p => p.result === "L");
  const ungraded = picks.filter(p => p.result === "");

  const winPct = wins.length / (wins.length + losses.length) * 100;

  console.log(`OVERALL RECORD`);
  console.log(`  Wins: ${wins.length}`);
  console.log(`  Losses: ${losses.length}`);
  console.log(`  Ungraded: ${ungraded.length}`);
  console.log(`  Win %: ${winPct.toFixed(1)}%`);
  console.log();

  // Variance analysis: Separate good/bad/lucky picks
  function analyzeVarianceCategory(pickList, isWin) {
    const results = {
      skillful: [],  // Good logic, matched reality
      variance: [],  // Good logic, bad variance
      error: []      // Poor logic
    };

    for (const pick of pickList) {
      const modelVal = parseFloat(pick.model_value);
      const actualVal = parseFloat(pick.actual_value);
      const error = Math.abs(modelVal - actualVal);

      if (isWin) {
        // For wins, distinguish between skill and luck
        if (error <= 1.5) {
          results.skillful.push(pick);
        } else {
          results.variance.push(pick);
        }
      } else {
        // For losses, distinguish between "good decision, bad outcome" vs "poor decision"
        if (error >= 2.5) {
          results.skillful.push(pick);  // Labeled as "skillful loss" (good model)
        } else if (error >= 1.5) {
          results.variance.push(pick);  // Borderline
        } else {
          results.error.push(pick);  // Bad pick
        }
      }
    }

    return results;
  }

  console.log("=" + "=".repeat(70));
  console.log("VARIANCE ANALYSIS: WINS");
  console.log("=" + "=".repeat(70));

  const winVariance = analyzeVarianceCategory(wins, true);

  console.log(`Wins with tight prediction error (<=1.5K): ${winVariance.skillful.length} (${(100 * winVariance.skillful.length / wins.length).toFixed(1)}%)`);
  console.log(`  ➜ These are SKILL: Model was accurate, edge was real`);

  console.log(`\nWins with loose prediction error (>1.5K): ${winVariance.variance.length} (${(100 * winVariance.variance.length / wins.length).toFixed(1)}%)`);
  console.log(`  ➜ These are LUCK: Model had small edge, variance helped`);
  console.log(`  Avg edge: ${(winVariance.variance.reduce((s, p) => s + parseFloat(p.edge), 0) / winVariance.variance.length).toFixed(2)} (small targets)`);

  if (winVariance.variance.length > 0 && winVariance.variance.length / wins.length > 0.25) {
    console.log(`  ⚠️  WARNING: >${(100 * 0.25).toFixed(0)}% of wins are lucky — check edge thresholds`);
  }

  console.log();
  console.log("=" + "=".repeat(70));
  console.log("VARIANCE ANALYSIS: LOSSES");
  console.log("=" + "=".repeat(70));

  const lossVariance = analyzeVarianceCategory(losses, false);

  console.log(`Losses despite good model (error >= 2.5K): ${lossVariance.skillful.length} (${(100 * lossVariance.skillful.length / losses.length).toFixed(1)}%)`);
  console.log(`  ➜ Model was RIGHT, variance was WRONG — this is healthy`);

  console.log(`\nLosses with medium error (1.5–2.5K): ${lossVariance.variance.length} (${(100 * lossVariance.variance.length / losses.length).toFixed(1)}%)`);
  console.log(`  ➜ Borderline — model was slightly off, variance finished it`);

  console.log(`\nLosses with tight error (<1.5K): ${lossVariance.error.length} (${(100 * lossVariance.error.length / losses.length).toFixed(1)}%)`);
  console.log(`  ➜ Selection ERROR: Model's edge was weak or wrong`);

  if (lossVariance.error.length / losses.length > 0.3) {
    console.log(`  ⚠️  WARNING: >${(100 * 0.3).toFixed(0)}% of losses are selection errors — gate thresholds are loose`);
  }

  console.log();
  console.log("=" + "=".repeat(70));
  console.log("SUMMARY: SKILL VS LUCK");
  console.log("=" + "=".repeat(70));

  const goodOutcomes = winVariance.skillful.length + lossVariance.skillful.length;
  const luckyOutcomes = winVariance.variance.length;
  const errorOutcomes = lossVariance.error.length;

  const skillPct = 100 * goodOutcomes / picks.length;
  const luckPct = 100 * luckyOutcomes / picks.length;
  const errorPct = 100 * errorOutcomes / picks.length;

  console.log(`Picks with correct model (wins were tight OR good losses): ${skillPct.toFixed(1)}%`);
  console.log(`Picks with luck (wins with large errors): ${luckPct.toFixed(1)}%`);
  console.log(`Picks with selection error (tight losses): ${errorPct.toFixed(1)}%`);

  console.log();
  if (skillPct > 70) {
    console.log("✅ HEALTHY: >70% of picks reflect model quality, not luck");
  } else if (skillPct > 55) {
    console.log("⚠️  MIXED: 55–70% skill indicates room to improve gate thresholds");
  } else {
    console.log("❌ RISK: <55% skill suggests gates are too loose or model needs recalibration");
  }

  // Market breakdown if more than one market
  const byMarket = {};
  for (const pick of picks) {
    if (!byMarket[pick.market]) {
      byMarket[pick.market] = [];
    }
    byMarket[pick.market].push(pick);
  }

  if (Object.keys(byMarket).length > 1) {
    console.log();
    console.log("=" + "=".repeat(70));
    console.log("PERFORMANCE BY MARKET");
    console.log("=" + "=".repeat(70));

    for (const market of Object.keys(byMarket)) {
      const marketPicks = byMarket[market];
      const marketWins = marketPicks.filter(p => p.result === "W").length;
      const marketLosses = marketPicks.filter(p => p.result === "L").length;
      const marketTotal = marketWins + marketLosses;

      if (marketTotal === 0) continue;

      const mWinPct = (100 * marketWins / marketTotal).toFixed(1);
      console.log(`${market}: ${marketWins}–${marketLosses} (${mWinPct}%)`);
    }
  }
}

analyzeVariance();
