/*
  LyDia — Lab Rating core (v3, measured-components)

  Lab Rating answers one question only: how strong is LyDia's baseball
  analysis of this game? It is NOT win probability and it is NOT a price
  judgement. The sportsbook number never enters this file.

  The moneyline keeps veto power over an Official Pick, but it lives in the
  gate, not in the rating. A strong team at a garbage price is still a strong
  analysis — it just is not a bet.

  ---------------------------------------------------------------------------
  VERSION HISTORY

  v1 (retired) put 50 of its 100 points into market-derived terms
  (model-vs-market edge 35, market quality 15), which meant the rating rose
  and fell with the sportsbook and could not be read as analysis quality.

  v2 (retired 2026-08-02) redistributed all 100 points across internal model
  inputs. It was never checked against outcomes. When it finally was —
  scripts/grade-confidence.js over 107 graded games — the rating turned out to
  carry no outcome information at all: corr(lab_score, win) = -0.029, and the
  85-100 band won 44.4% while predicting 69.9%.

  Two components were the reason, and both are removed in v3:

    agreement (20 pts) — awarded when the team-strength model and the run
    model agreed. Games where they agreed LOST more often: 49.1% vs 57.4%,
    a lift of -8.3 points, the strongest single effect in the study and
    pointing the wrong way. The cause is now understood: the run model comes
    from the totals projection, which regresses against its own market at
    beta = +0.066 (95% CI [-0.46, +0.59]) — it is noise. Agreeing with noise
    is not evidence, so a fifth of the rating was actively anti-predictive.

    completeness (5 pts) — awarded for having all inputs present. Every game
    had them: the mean was 4.99 out of 5. It added five points to every score
    without separating any game from any other, which quietly lowered the
    real height of the 80-point official gate for everyone.

  The 25 points move to the components that measured non-negative:

                        v2      v3     measured lift (n=107)
      conviction        30      35      +2.9%
      pitching plan     20      20      -0.4%
      bullpen           15      20      +2.9%
      offense           10      25      +6.6%
      agreement         20       0      -8.3%   removed
      completeness       5       0      constant, removed

  Offense takes the largest share because it was the only component with a
  clearly positive relationship to winning, and it was the smallest real
  component in v2. Pitching plan is held flat rather than raised: it showed no
  signal, and paying it more for that would repeat the mistake this version
  exists to correct.

  HONEST CAVEAT ON THOSE WEIGHTS: n=107. The gap between +2.9% and +6.6% is
  well inside sampling noise at that size. This redistribution leans toward
  the evidence; it is not claimed to be the optimal weighting, and it should
  be revisited once grade-confidence.js has a few hundred more games. What IS
  solid at this n is the sign on agreement and the constancy of completeness —
  those are the two changes actually justified by data.

  Ratings produced by v2 and v3 are NOT comparable. v3 opens a new calibration
  series at the cutover date. grade-confidence.js does not need to be told
  this: it only analyses breakdowns whose components sum to their own score,
  so it segregates versions automatically.

  ---------------------------------------------------------------------------
  DIAGNOSTICS THAT NO LONGER SCORE

  The model-agreement gap and the data-completeness checks are still computed
  and still stored in the breakdown — they are genuinely useful for explaining
  a game and for spotting a broken input. They are simply worth zero points.
  Removing the measurement along with the score would have thrown away the
  only signal that told us the run model had gone wrong on 2026-07-29, when
  agreement collapsed to 0 while conviction sat maxed at 30.

  100 points:
     35  model conviction
     20  pitching-plan support (14 pitcher edge + 6 plan completeness)
     20  bullpen support, weighted by assigned bullpen innings only
     25  offensive matchup support
*/

"use strict";

const LAB_RATING_VERSION = "lab-rating-v3-measured-components";

// Conviction: a coin flip earns nothing. Credit starts at 55% and maxes at 80%.
const CONVICTION_FLOOR = 0.55;
const CONVICTION_CEIL = 0.80;
const CONVICTION_MAX = 35;

// Retained at 0 so any consumer reading these still gets a number rather than
// undefined, and so the arithmetic below stays readable. See the version note.
const AGREEMENT_MAX = 0;
const COMPLETENESS_MAX = 0;

// Thresholds still used to DESCRIBE agreement, now that it does not score.
const AGREEMENT_FREE = 0.02;
const AGREEMENT_ZERO = 0.15;

const PITCHER_MAX = 14;
const PITCHER_FULL_GAP = 20; // pitcher-score gap that earns full credit
const PLAN_COMPLETE_MAX = 6;
const BULLPEN_MAX = 20;
const OFFENSE_MAX = 25;
const OFFENSE_SPAN = 0.06; // delta-OPS differential for full / zero credit

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
  Agreement between the team-strength model and the run model — DIAGNOSTIC ONLY
  as of v3, worth zero points.

  Kept because the gap itself is informative: on 2026-07-29 it was the one
  number that noticed the run model had broken, collapsing to zero while
  conviction sat at its maximum. It is reported so a reader (and the copy
  layer) can still see when the two models disagree; it no longer moves the
  score, because when it did, it moved it the wrong way.
*/
function agreementDiagnostic(strengthProbPick, runProbPick) {
  if (!isNum(strengthProbPick) || !isNum(runProbPick)) {
    return { points: 0, gap: null, available: false, credit: null };
  }
  const gap = Math.abs(strengthProbPick - runProbPick);
  const span = AGREEMENT_ZERO - AGREEMENT_FREE;
  const credit = clamp(1 - (gap - AGREEMENT_FREE) / span, 0, 1);
  // credit is the 0-1 figure v2 would have scored on; exposed for explanation
  // and for anyone auditing what the old weighting would have produced.
  return { points: 0, gap, available: true, credit: round(credit, 3) };
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

  Now the largest non-conviction component: it was the only part of v2 that
  measured a clearly positive relationship with winning (+6.6% lift).
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
  Data completeness — DIAGNOSTIC ONLY as of v3, worth zero points.

  Every graded game passed every check (mean 4.99 of 5), so this separated
  nothing while raising every score by five. Still computed: a run where these
  start failing is a broken pipeline, and that is worth seeing even though it
  is not worth points.
*/
function completenessDiagnostic(flags) {
  const checks = [
    Boolean(flags.hasTeamStrength),
    Boolean(flags.hasBothPitchers),
    Boolean(flags.hasBothBullpens),
    Boolean(flags.hasRunProjection),
    Boolean(flags.planInningsBalanced)
  ];
  const passed = checks.filter(Boolean).length;
  return { points: 0, passed, total: checks.length, complete: passed === checks.length };
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
  Lab Rating v3. Every argument is internal to LyDia's model. There is
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
  const agreement = agreementDiagnostic(strengthProbPick, runProbPick);

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

  const completeness = completenessDiagnostic({
    hasTeamStrength,
    hasBothPitchers,
    hasBothBullpens: bullpen.available,
    hasRunProjection: hasRunProjection === null ? agreement.available : hasRunProjection,
    planInningsBalanced: pickPlanComplete && oppPlanComplete
  });

  // agreement and completeness contribute 0 by construction; they are included
  // in the sum so that adding a component back later is a one-line change and
  // so the arithmetic matches the breakdown a reader sees.
  const total = conviction + agreement.points + plan.points
    + bullpen.points + offense.points + completeness.points;
  const score = Math.round(clamp(total, 0, 100));

  return {
    score,
    version: LAB_RATING_VERSION,

    conviction_points: round(conviction),
    agreement_points: round(agreement.points),          // always 0 in v3
    pitching_plan_points: round(plan.points),
    bullpen_points: round(bullpen.points),
    offense_points: round(offense.points),
    completeness_points: round(completeness.points),    // always 0 in v3

    pitcher_edge_points: plan.pitcher_edge_points,
    plan_completeness_points: plan.plan_completeness_points,
    model_agreement_gap: agreement.gap === null ? null : round(agreement.gap, 4),
    model_agreement_credit: agreement.credit,           // what v2 would have scored on
    bullpen_innings_weight: bullpen.weight,
    assigned_bullpen_innings: penInnings === null ? null : round(penInnings, 1),
    offense_delta: offense.diff,
    completeness_checks_passed: completeness.passed,
    completeness_checks_total: completeness.total,
    data_complete: completeness.complete,

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
    + `pitching plan ${lab.pitching_plan_points}, bullpen ${lab.bullpen_points}, `
    + `offense ${lab.offense_points}.`;
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
  COMPLETENESS_MAX,
  // Exported so consumers (matchup-copy-core.js) can define "a real lean"
  // identically to how the rating itself defines conviction, instead of
  // carrying a second, independently-tuned threshold that can drift out of
  // sync with this one.
  CONVICTION_FLOOR,
  CONVICTION_CEIL
};
