#!/usr/bin/env node
"use strict";

/*
  Adds the real LyDia Coach object to the current learning summary.
  It never changes model weights, thresholds, picks, or results.

  2026-08-26, Lynold's explicit instruction -- full rewrite: "I do not think
  the coach is working how I would like it to be working... I want the
  coach to look at all the games that we have an analysis for, look at the
  inputs, look at the correlations, see what we predicted, look at what
  happened, what are some patterns that we keep noticing... give real time
  inputs for today's matchup based on the evidence we have collected."

  Before this rewrite, Coach only looked at ~22 current-model official picks
  and checked 4 pre-chosen splits (probability median, 3 fixed Lab Rating
  tiers, pitcher support, bullpen caution) -- a fixed list someone picked in
  advance, not a discovery process, and it never touched the ~318-game full
  analyzed history sitting in data/calibration/*.csv.

  Now: two separate things, kept distinct on purpose.
    1. The OFFICIAL RECORD (current_model_days/current_model_picks/game_log,
       unchanged from the 2026-08-26 coach-record-fix session) -- what
       LyDia has actually published and how it's actually done. Small
       sample, but it's the real public record.
    2. HISTORY (new) -- the full analyzed history, every tier, every date,
       run through scripts/lib/coach-correlation-core.js's real correlation
       engine. This is where "what patterns predict right vs. wrong picks"
       actually gets answered, and it's what now feeds the matchup-page
       evidence notes (see matchup-copy-core.js's coachEvidenceNotes,
       replacing the old fixed-bucket coachConsistencyNotes).
*/

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const RESULTS = path.join(ROOT, "data", "results.json");
const SUMMARY = path.join(ROOT, "data", "learning-summary.json");
const MIN_DAYS = 7;
const MIN_PICKS = 20;
const MIN_HISTORY_N = 20; // coach-correlation-core.js's own per-feature floor; used here for the overall "is there enough to report" gate

const Correlation = require("./lib/coach-correlation-core");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
function num(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }
function first(...values) { return values.find(v => num(v) !== null) ?? null; }
function isCurrentModelPick(p, day) {
  const learning = p.learning || {};
  const version = String(learning.model_version || p.modelVersion || p.model_version || "");
  const source = String(day.source || learning.result_source || "");
  return source === "published-picks" || version.includes("moneyline-v2-strict-probability-gate");
}
function normalizePick(p, day) {
  const ml = p.moneyline || {};
  const learning = p.learning || {};
  const result = p.mlResult || p.result || learning.result || "NG";
  return {
    gamePk: p.gamePk || null,
    matchup: (p.away && p.home) ? `${p.away} @ ${p.home}` : null,
    pick: ml.pick || p.pick || null,
    result,
    model_probability: first(learning.model_probability, ml.prob, p.model_probability),
    lab_score: first(learning.lab_score, p.labScore, p.lab_score, ml.edgeScore)
  };
}
function record(rows) {
  const wins = rows.filter(x => x.result === "W").length;
  const losses = rows.filter(x => x.result === "L").length;
  return { wins, losses, total: wins + losses, rate: wins + losses ? wins / (wins + losses) : null };
}
function pct(v) { return typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "-"; }

function main() {
  if (!fs.existsSync(RESULTS) || !fs.existsSync(SUMMARY)) {
    throw new Error("Results or learning summary is missing. Run grading and generate-learning-summary first.");
  }

  const results = readJson(RESULTS);
  const summary = readJson(SUMMARY);
  const days = results.days || {};
  const currentDays = [];
  const currentRows = [];

  for (const [date, day] of Object.entries(days)) {
    const picks = Array.isArray(day.picks) ? day.picks : [];
    const rows = picks
      .filter(p => isCurrentModelPick(p, day))
      .map(p => normalizePick(p, day))
      .filter(p => p.pick && p.result !== "NG");

    if (rows.length) {
      currentDays.push(date);
      for (const row of rows) currentRows.push({ ...row, date });
    }
  }

  const dayCount = new Set(currentDays).size;
  const pickCount = currentRows.length;
  const ready = dayCount >= MIN_DAYS && pickCount >= MIN_PICKS;

  // --- HISTORY: the full analyzed record, every tier, every date ---
  const historyRows = Correlation.loadHistoricalRows(ROOT);
  const historyReady = historyRows.length >= MIN_HISTORY_N;
  const historyRecord = record(historyRows.map(r => ({ result: r.pickWon === 1 ? "W" : "L" })));
  let correlations = null, historyRecommendations = [];
  if (historyReady) {
    correlations = Correlation.computeCorrelations(historyRows);
    historyRecommendations = Correlation.buildProseRecommendations(correlations, {
      n: historyRows.length, w: historyRecord.wins, l: historyRecord.losses, rate: historyRecord.rate
    });
  }

  summary.coach = {
    status: ready ? "review_ready" : "collecting",
    title: ready ? "First evidence-based model review is ready" : "Collecting a trustworthy current-model sample",
    summary: ready
      ? `LyDia has ${dayCount} current-model graded days and ${pickCount} current-model official picks. The coach can now identify review questions, but it cannot change the model automatically.`
      : `LyDia has ${dayCount} of ${MIN_DAYS} required current-model days and ${pickCount} of ${MIN_PICKS} required current-model official picks. Recommendations remain paused until both minimums are reached.`,
    current_model_days: dayCount,
    current_model_picks: pickCount,
    minimum_days: MIN_DAYS,
    minimum_picks: MIN_PICKS,
    bullpen_model_owner: "bullpen-fatigue-v3-runs-aware",
    // 2026-08-26 (coach-record-fix session): the specific games behind the
    // official-record tally above, so a number here can be checked against
    // another ledger game by game.
    game_log: [...currentRows].sort((a, b) => String(b.date).localeCompare(String(a.date))).map(r => ({
      date: r.date, gamePk: r.gamePk, matchup: r.matchup, pick: r.pick, result: r.result,
      model_probability: r.model_probability, lab_score: r.lab_score
    })),

    // 2026-08-26: the real correlation engine over the FULL analyzed
    // history (every tier, every date -- not just current-model official
    // picks). This is what "look at all the games we have an analysis
    // for... look at the correlations" actually means; see
    // scripts/lib/coach-correlation-core.js for the full method and every
    // sign-convention note.
    history: {
      n: historyRows.length,
      ready: historyReady,
      minimum_n: MIN_HISTORY_N,
      record: { wins: historyRecord.wins, losses: historyRecord.losses, rate: historyRecord.rate },
      recommendations: historyRecommendations,
      // Raw correlation findings (numeric + categorical), consumed directly
      // by generate-matchup-pages.js/matchup-copy-core.js's
      // coachEvidenceNotes() to compare today's specific game against real
      // historical patterns -- this replaces the old fixed 4-bucket
      // coach.buckets entirely.
      correlations
    },

    hard_stop: "Coach findings are review prompts only. No automatic threshold, weight, formula, publishing, or betting change is permitted."
  };

  writeJson(SUMMARY, summary);
  if (summary.latest_date) {
    writeJson(path.join(ROOT, "data", "learning", `${summary.latest_date}.json`), summary);
  }

  console.log(`Coach status: ${summary.coach.status}. Official record: ${dayCount}/${MIN_DAYS} days, ${pickCount}/${MIN_PICKS} picks. Full history: ${historyRows.length} games (${historyReady ? "ready" : "below " + MIN_HISTORY_N}).`);
}
main();
