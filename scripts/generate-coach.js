#!/usr/bin/env node
"use strict";

/*
  Adds the real LyDia Coach object to the current learning summary.
  It never changes model weights, thresholds, picks, or results.
  Readiness requires BOTH:
  - at least 7 current-model graded days
  - at least 20 current-model official moneyline picks
*/

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const RESULTS = path.join(ROOT, "data", "results.json");
const SUMMARY = path.join(ROOT, "data", "learning-summary.json");
const MIN_DAYS = 7;
const MIN_PICKS = 20;

// 2026-08-25, Lynold's explicit instruction: this file's probability/rating
// split boundaries (0.72/0.78 probability, 85 lab rating) were never wired to
// the real official-pick gate -- they were copied once and then went stale
// when the live gate moved to 0.61 / 72 (see scripts/lib/gate-constants.js,
// which generate-member-lab.js and generate-learning-summary.js already both
// use as their single source of truth; this file was the one place still
// carrying its own disconnected copy). Importing here so Coach's own
// "official_gate" reference values can never drift from the live gate again.
const { OFFICIAL_MODEL_PROB, OFFICIAL_LAB_SCORE } = require("./lib/gate-constants");
// 2026-08-25, Lynold's explicit instruction: probability bucket split moves
// from a fixed 0.78 threshold to the median of the current-model sample's own
// model_probability values, recomputed every run. A fixed threshold sitting
// outside the model's actual output range silently starves one bucket -- a
// median split guarantees both halves stay populated as the sample grows.
// Lab Rating instead moves to fixed three-tier bands (under 67 / 67-69.9 /
// 70+), Lynold's explicit choice over a median split for this dimension.
function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
const LAB_TIER_LOW_MAX = 67;
const LAB_TIER_MID_MAX = 70;

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
    pick: ml.pick || p.pick || null,
    result,
    model_probability: first(learning.model_probability, ml.prob, p.model_probability),
    lab_score: first(learning.lab_score, p.labScore, p.lab_score, ml.edgeScore),
    raw_edge: first(learning.raw_edge, ml.rawEdge, p.raw_edge),
    clv_result: learning.clv_result || p.clv_result || "not_tracked",
    pitcher_edge_team: learning.pitcher_edge_team || (p.pitcherEdge && p.pitcherEdge.team) || null,
    pitcher_gap: first(learning.pitcher_gap, p.pitcherEdge && p.pitcherEdge.gap),
    bullpen_label: learning.bullpen_label || (p.bullpen && p.bullpen.label) || null,
    bullpen_model_version: learning.bullpen_model_version ||
      (p.bullpen && p.bullpen.pick_team && p.bullpen.pick_team.source_version) ||
      "bullpen-fatigue-v3-runs-aware"
  };
}
function record(rows) {
  const wins = rows.filter(x => x.result === "W").length;
  const losses = rows.filter(x => x.result === "L").length;
  return { wins, losses, total: wins + losses, rate: wins + losses ? wins / (wins + losses) : null };
}
function pct(v) { return typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "-"; }

// 2026-08-24, Lynold's explicit instruction: split out of buildRecommendations
// so both the prose recommendations AND the new structured coach.buckets
// (below, for matchup-page consumption) come from the exact same numbers --
// two functions independently re-filtering the same rows was exactly the
// "one place changed, the other went stale" bug pattern this project's own
// ERRORS.md already documents more than once elsewhere in this codebase.
// lowRating/pitcherUnsupported/bullpenNoCaution are the complement side of
// splits that used to only compute one side, because the only consumer was
// prose ("8.5+ official picks are W-L"). A machine-readable comparison needs
// both sides of the same split so a downstream reader can ask "is THIS
// pick's bucket the weaker one" without re-deriving the complement itself.
function computeSplits(rows) {
  const probValues = rows.map(x => num(x.model_probability)).filter(v => v !== null);
  const probMedian = median(probValues);
  return {
    overall: record(rows),
    probMedian,
    highProb: probMedian === null ? record([]) : record(rows.filter(x => num(x.model_probability) !== null && x.model_probability >= probMedian)),
    baseProb: probMedian === null ? record([]) : record(rows.filter(x => num(x.model_probability) !== null && x.model_probability < probMedian)),
    lowRating: record(rows.filter(x => num(x.lab_score) !== null && x.lab_score < LAB_TIER_LOW_MAX)),
    midRating: record(rows.filter(x => num(x.lab_score) !== null && x.lab_score >= LAB_TIER_LOW_MAX && x.lab_score < LAB_TIER_MID_MAX)),
    highRating: record(rows.filter(x => num(x.lab_score) !== null && x.lab_score >= LAB_TIER_MID_MAX)),
    pitcherSupported: record(rows.filter(x => x.pitcher_edge_team && x.pitcher_edge_team === x.pick)),
    pitcherUnsupported: record(rows.filter(x => x.pitcher_edge_team && x.pitcher_edge_team !== x.pick)),
    bullpenCaution: record(rows.filter(x => x.bullpen_label === "Adds caution" || x.bullpen_label === "Both bullpens stressed")),
    bullpenNoCaution: record(rows.filter(x => !(x.bullpen_label === "Adds caution" || x.bullpen_label === "Both bullpens stressed"))),
    beatClose: rows.filter(x => x.clv_result === "beat_close").length,
    lostClose: rows.filter(x => x.clv_result === "lost_close").length
  };
}

function buildRecommendations(rows) {
  const recs = [];
  const {
    overall, probMedian, highProb, baseProb, lowRating, midRating, highRating, pitcherSupported, bullpenCaution, beatClose, lostClose
  } = computeSplits(rows);

  recs.push(`Current-model official record: ${overall.wins}-${overall.losses}${overall.rate !== null ? ` (${pct(overall.rate)})` : ""}.`);

  if (probMedian !== null && highProb.total >= 5 && baseProb.total >= 5) {
    recs.push(`Probability review: this sample's median win probability is ${pct(probMedian)}. At-or-above-median picks are ${highProb.wins}-${highProb.losses}; below-median picks are ${baseProb.wins}-${baseProb.losses}. This is a self-adjusting split of the current sample, not the official ${pct(OFFICIAL_MODEL_PROB)} gate -- review the gap, but do not change the gate from this report alone.`);
  } else {
    recs.push("Probability review: the above/below-median split still needs more samples before a comparison is meaningful.");
  }

  if (lowRating.total >= 5 || midRating.total >= 5 || highRating.total >= 5) {
    const parts = [
      `under 67 picks are ${lowRating.wins}-${lowRating.losses}`,
      `67 to 69.9 picks are ${midRating.wins}-${midRating.losses}`,
      `70+ picks are ${highRating.wins}-${highRating.losses}`
    ];
    recs.push(`Lab Rating review: ${parts.join("; ")}. The official gate is ${OFFICIAL_LAB_SCORE / 10}/10. Compare tiers before considering a rating-gate change.`);
  } else {
    recs.push("Lab Rating review: none of the three tiers (under 67 / 67-69.9 / 70+) has enough graded picks yet for a comparison.");
  }

  if (pitcherSupported.total >= 5) {
    recs.push(`Pitcher support review: pitcher-supported official picks are ${pitcherSupported.wins}-${pitcherSupported.losses}.`);
  }

  if (bullpenCaution.total) {
    recs.push(`Bullpen v3 review: ${bullpenCaution.total} official pick${bullpenCaution.total === 1 ? "" : "s"} carried material bullpen caution. Review these separately before changing the runs-aware formula.`);
  } else {
    recs.push("Bullpen v3 review: no current-model official picks with major bullpen caution are in the graded sample.");
  }

  if (beatClose + lostClose >= 5) {
    recs.push(`Market review: ${beatClose} tracked picks beat the close and ${lostClose} lost to the close.`);
  } else {
    recs.push("Market review: closing-price coverage is still too small for a useful CLV conclusion.");
  }

  recs.push("Human approval remains required for every model or threshold change.");
  return recs;
}

// 2026-08-24, Lynold's explicit instruction: structured counterpart to
// buildRecommendations' prose, meant for a not-yet-played game to be checked
// against -- e.g. generate-matchup-pages.js can ask "does today's pick fall
// in the weaker side of any of these splits" without parsing English
// sentences.
//
// 2026-08-25 revision, Lynold's explicit instruction: the probability and
// lab_rating splits below used to be fixed thresholds (0.78 probability,
// 85 lab rating) copied once from an old gate and left to go stale --
// generate-member-lab.js's and generate-learning-summary.js's real gate had
// already moved to 0.61 / 72 (scripts/lib/gate-constants.js) while this file
// kept its own disconnected numbers. Fixed:
// - probability.split_at is now the current sample's own median
//   (method: "median_of_current_sample"), recomputed every run.
// - lab_rating is now three fixed tiers (under 67 / 67-69.9 / 70+),
//   Lynold's explicit choice over a median split for this dimension.
// - official_gate on both now reads from gate-constants.js so it can never
//   drift from the live gate again.
// Only populated when `ready` (same MIN_DAYS/MIN_PICKS gate recommendations
// already uses) -- an under-sample bucket comparison would be noise, not
// signal.
function buildBuckets(rows) {
  const s = computeSplits(rows);
  return {
    probability: {
      method: "median_of_current_sample",
      split_at: s.probMedian,
      official_gate: OFFICIAL_MODEL_PROB,
      above: { label: s.probMedian === null ? "at or above sample median" : `${pct(s.probMedian)}+ (sample median or above)`, ...s.highProb },
      below: { label: s.probMedian === null ? "below sample median" : `below ${pct(s.probMedian)} (sample median)`, ...s.baseProb }
    },
    lab_rating: {
      method: "fixed_tiers",
      official_gate: OFFICIAL_LAB_SCORE,
      tiers: [
        { key: "low", label: "under 67", ...s.lowRating },
        { key: "mid", label: "67 to 69.9", ...s.midRating },
        { key: "high", label: "70+", ...s.highRating }
      ]
    },
    pitcher_support: { supported: { label: "pitcher edge favors the pick", ...s.pitcherSupported }, unsupported: { label: "pitcher edge favors the opponent", ...s.pitcherUnsupported } },
    bullpen_caution: { flagged: { label: "flagged bullpen caution", ...s.bullpenCaution }, clear: { label: "no bullpen caution", ...s.bullpenNoCaution } }
  };
}

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
    recommendations: ready ? buildRecommendations(currentRows) : [],
    buckets: ready ? buildBuckets(currentRows) : null,
    hard_stop: "Coach findings are review prompts only. No automatic threshold, weight, formula, publishing, or betting change is permitted."
  };

  writeJson(SUMMARY, summary);
  if (summary.latest_date) {
    writeJson(path.join(ROOT, "data", "learning", `${summary.latest_date}.json`), summary);
  }

  console.log(`Coach status: ${summary.coach.status}. Days: ${dayCount}/${MIN_DAYS}. Picks: ${pickCount}/${MIN_PICKS}.`);
}
main();
