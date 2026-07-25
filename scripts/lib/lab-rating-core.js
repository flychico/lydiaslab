/*
  LyDia — Lab Rating core (v2, market-independent)

  Lab Rating answers one question only: how strong is LyDia's baseball
  analysis of this game? It is NOT win probability and it is NOT a price
  judgement. The sportsbook number never enters this file.

  The moneyline keeps veto power over an Official Pick, but it lives in the
  gate, not in the rating. A strong team at a garbage price is still a strong
  analysis — it just is not a bet.

  v1 (retired) put 50 of its 100 points into market-derived terms
  (model-vs-market edge 35, market quality 15), which meant the rating rose
  and fell with the sportsbook and could not be read as analysis quality.
  v2 redistributes all 100 points across internal model inputs.

  Ratings produced by v1 and v2 are NOT comparable. v2 opens a new calibration
  series at the cutover date; v1 ratings stay frozen in the closed series.

  100 points:
     30  model conviction
     20  agreement between the strength model and the projected-runs model
     20  pitching-plan support (14 pitcher edge + 6 plan completeness)
     15  bullpen support, weighted by assigned bullpen innings only
     10  offensive matchup support
      5  data completeness and synchronization
*/

"use strict";

const LAB_RATING_VERSION = "lab-rating-v2-market-independent";

// Conviction: a coin flip earns nothing. Credit starts at 55% and maxes at 80%.
const CONVICTION_FLOOR = 0.55;
const CONVICTION_CEIL = 0.80;
const CONVICTION_MAX = 30;

// Agreement: the two models are allowed to disagree by 2 points for free;
// credit decays to zero by a 15-point disagreement.
const AGREEMENT_FREE = 0.02;
const AGREEMENT_ZERO = 0.15;
const AGREEMENT_MAX = 20;

const PITCHER_MAX = 14;
const PITCHER_FULL_GAP = 20; // pitcher-score gap that earns full credit
const PLAN_COMPLETE_MAX = 6;
const BULLPEN_MAX = 15;
const OFFENSE_MAX = 10;
const OFFENSE_SPAN = 0.06; // delta-OPS differential for full / zero credit
const COMPLETENESS_MAX = 5;

// A plan must allocate the full nine innings to count as complete.
const FULL_GAME_INNINGS = 9;
const INNINGS_TOLERANCE = 0.05;
// Bullpen differential is judged against the same 45-point spread v1 used, so
// the bullpen read itself does not silently change meaning between versions.
const BULLPEN_RISK_SPAN = 45;
// A pen owning ~4 innings carries full weight; a 2-inning pen carries less.
const BULLPEN_FULL_INNINGS = 4.0;
const BULLPEN_MIN_WEIGHT = 0.5;

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function round(n, dp = 2) {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}
function isNum(n) { return typeof n === "number" && Number.isFinite(n); }

/*
  Model conviction. How far above a coin flip LyDia actually is. This replaces
  model-vs-market edge as the primary driver: conviction is a property of the
  model, edge is a property of the sportsbook.
*/
function convictionPoints(modelProb) {
  if (!isNum(modelProb)) return 0;
  const span = CONVICTION_CEIL - CONVICTION_FLOOR;
  return clamp((modelProb - CONVICTION_FLOOR) / span, 0, 1) * CONVICTION_MAX;
}

/*
  Agreement between the established team-strength model and the projected-runs
  model, measured on the pick side. Two independent methods landing on the same
  answer is real evidence; a split is a reason for less confidence.

  When the run model is unavailable we cannot confirm agreement, so this scores
  zero rather than assuming the best. Data completeness records the same gap.
*/
function agreementPoints(strengthProbPick, runProbPick) {
  if (!isNum(strengthProbPick) || !isNum(runProbPick)) {
    return { points: 0, gap: null, available: false };
  }
  const gap = Math.abs(strengthProbPick - runProbPick);
  const span = AGREEMENT_ZERO - AGREEMENT_FREE;
  const credit = clamp(1 - (gap - AGREEMENT_FREE) / span, 0, 1);
  return { points: credit * AGREEMENT_MAX, gap, available: true };
}

/*
  Pitching-plan support. Two independent things:
    - does the projected pitching favour the side LyDia picked, and by how much
    - is the plan actually complete (all nine innings allocated on both sides)

  An opposing pitcher edge scores zero here. It does not go negative: a hard
  pitcher conflict is a separate official-pick gate, not a rating penalty.
*/
function pitchingPlanPoints({ pitchGap, pitchEdgeSupports, planComplete, bothSidesPlanned }) {
  const gap = isNum(pitchGap) ? pitchGap : 0;
  const edgePts = pitchEdgeSupports
    ? clamp(gap / PITCHER_FULL_GAP, 0, 1) * PITCHER_MAX
    : 0;
  let completePts = 0;
  if (planComplete) completePts += PLAN_COMPLETE_MAX * 0.7;
  if (bothSidesPlanned) completePts += PLAN_COMPLETE_MAX * 0.3;
  return {
    points: edgePts + completePts,
    pitcher_edge_points: round(edgePts),
    plan_completeness_points: round(completePts)
  };
}

/*
  Bullpen support, scoped to assigned bullpen innings only. A pen that owns 2.0
  innings behind a bulk pitcher should not swing the rating as hard as one that
  owns 4.5 innings behind a short opener.
*/
function bullpenPoints({ pickRisk, oppRisk, pickBullpenInnings }) {
  const neutral = BULLPEN_MAX / 2;
  if (!isNum(pickRisk) || !isNum(oppRisk)) {
    return { points: neutral, weight: null, available: false };
  }
  const diff = clamp((oppRisk - pickRisk) / BULLPEN_RISK_SPAN, -1, 1);
  const weight = isNum(pickBullpenInnings)
    ? clamp(pickBullpenInnings / BULLPEN_FULL_INNINGS, BULLPEN_MIN_WEIGHT, 1)
    : 1;
  const points = clamp(neutral + diff * neutral * weight, 0, BULLPEN_MAX);
  return { points, weight: round(weight), available: true };
}

/*
  Offensive matchup support from recent form, as a differential. Neutral form on
  both sides sits at half credit rather than zero, because "no offensive signal"
  is not the same as "the offence argues against this pick".
*/
function offensePoints(pickDeltaOps, oppDeltaOps) {
  if (!isNum(pickDeltaOps) || !isNum(oppDeltaOps)) {
    return { points: OFFENSE_MAX / 2, diff: null, available: false };
  }
  const diff = pickDeltaOps - oppDeltaOps;
  const credit = clamp((diff + OFFENSE_SPAN) / (OFFENSE_SPAN * 2), 0, 1);
  return { points: credit * OFFENSE_MAX, diff: round(diff, 3), available: true };
}

/*
  Data completeness and synchronization. Every input the rest of the rating
  leans on, present and agreeing. Missing inputs must lower confidence rather
  than silently scoring as neutral.
*/
function completenessPoints(flags) {
  const checks = [
    Boolean(flags.hasTeamStrength),
    Boolean(flags.hasBothPitchers),
    Boolean(flags.hasBothBullpens),
    Boolean(flags.hasRunProjection),
    Boolean(flags.planInningsBalanced)
  ];
  const passed = checks.filter(Boolean).length;
  return {
    points: (passed / checks.length) * COMPLETENESS_MAX,
    passed,
    total: checks.length
  };
}

/*
  Does a pitching plan allocate the whole game?
  Accepts either an explicit segment list or a traditional starter classified
  with expected + bullpen innings.
*/
function planAllocatesFullGame(plan) {
  if (!plan) return false;
  if (Array.isArray(plan.segments) && plan.segments.length) {
    const total = plan.segments.reduce((sum, s) => sum + (Number(s.expected_innings) || 0), 0);
    return Math.abs(total - FULL_GAME_INNINGS) <= INNINGS_TOLERANCE;
  }
  const expected = Number(plan.expected_innings);
  const bullpen = Number(plan.bullpen_innings);
  if (!Number.isFinite(expected) || !Number.isFinite(bullpen)) return false;
  return Math.abs(expected + bullpen - FULL_GAME_INNINGS) <= INNINGS_TOLERANCE;
}

/* Innings the pick side's bullpen is actually responsible for. */
function assignedBullpenInnings(plan) {
  if (!plan) return null;
  if (Array.isArray(plan.segments) && plan.segments.length) {
    const pen = plan.segments.filter(s => s.role === "bullpen");
    if (!pen.length) return null;
    return pen.reduce((sum, s) => sum + (Number(s.expected_innings) || 0), 0);
  }
  return Number.isFinite(Number(plan.bullpen_innings)) ? Number(plan.bullpen_innings) : null;
}

/*
  Lab Rating v2. Every argument is internal to LyDia's model. There is
  deliberately no market parameter — adding one is a regression.
*/
function calcLabRating(input) {
  const {
    modelProb,
    strengthProbPick = null,
    runProbPick = null,
    pitchGap = null,
    pitchEdgeSupports = false,
    pickPlan = null,
    oppPlan = null,
    pickBullpenRisk = null,
    oppBullpenRisk = null,
    pickDeltaOps = null,
    oppDeltaOps = null,
    hasTeamStrength = true,
    hasBothPitchers = true,
    hasRunProjection = null
  } = input || {};

  const conviction = convictionPoints(modelProb);
  const agreement = agreementPoints(strengthProbPick, runProbPick);

  const pickPlanComplete = planAllocatesFullGame(pickPlan);
  const oppPlanComplete = planAllocatesFullGame(oppPlan);
  const plan = pitchingPlanPoints({
    pitchGap,
    pitchEdgeSupports,
    planComplete: pickPlanComplete,
    bothSidesPlanned: pickPlanComplete && oppPlanComplete
  });

  const penInnings = assignedBullpenInnings(pickPlan);
  const bullpen = bullpenPoints({
    pickRisk: pickBullpenRisk,
    oppRisk: oppBullpenRisk,
    pickBullpenInnings: penInnings
  });

  const offense = offensePoints(pickDeltaOps, oppDeltaOps);

  const completeness = completenessPoints({
    hasTeamStrength,
    hasBothPitchers,
    hasBothBullpens: bullpen.available,
    hasRunProjection: hasRunProjection === null ? agreement.available : hasRunProjection,
    planInningsBalanced: pickPlanComplete && oppPlanComplete
  });

  const total = conviction + agreement.points + plan.points
    + bullpen.points + offense.points + completeness.points;
  const score = Math.round(clamp(total, 0, 100));

  return {
    score,
    version: LAB_RATING_VERSION,

    conviction_points: round(conviction),
    agreement_points: round(agreement.points),
    pitching_plan_points: round(plan.points),
    bullpen_points: round(bullpen.points),
    offense_points: round(offense.points),
    completeness_points: round(completeness.points),

    pitcher_edge_points: plan.pitcher_edge_points,
    plan_completeness_points: plan.plan_completeness_points,
    model_agreement_gap: agreement.gap === null ? null : round(agreement.gap, 4),
    bullpen_innings_weight: bullpen.weight,
    assigned_bullpen_innings: penInnings === null ? null : round(penInnings, 1),
    offense_delta: offense.diff,
    completeness_checks_passed: completeness.passed,
    completeness_checks_total: completeness.total,

    // v1 compatibility: any consumer still reading these sees an honest zero.
    // The market contributes nothing to the rating by design.
    market_points: 0,
    model_edge_points: 0,
    base_points: 0,

    note: "Lab Rating grades LyDia's analysis quality only. It contains no market or price input."
  };
}

/* One-line public breakdown. Never mentions the market. */
function labRatingSentence(lab) {
  return `Lab Rating ${(lab.score / 10).toFixed(1)}/10: conviction ${lab.conviction_points}, `
    + `model agreement ${lab.agreement_points}, pitching plan ${lab.pitching_plan_points}, `
    + `bullpen ${lab.bullpen_points}, offense ${lab.offense_points}, `
    + `data completeness ${lab.completeness_points}.`;
}

module.exports = {
  LAB_RATING_VERSION,
  calcLabRating,
  labRatingSentence,
  planAllocatesFullGame,
  assignedBullpenInnings,
  CONVICTION_MAX,
  AGREEMENT_MAX,
  PITCHER_MAX,
  PLAN_COMPLETE_MAX,
  BULLPEN_MAX,
  OFFENSE_MAX,
  COMPLETENESS_MAX
};
