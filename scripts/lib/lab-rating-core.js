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

  100 points (updated 2026-08-22, see version note below):
     10  model conviction
     20  pitching-plan support (pitcher edge only)
     20  bullpen support, weighted by assigned bullpen innings only
     50  offensive matchup support

  ---------------------------------------------------------------------------
  2026-08-12: PLAN-COMPLETENESS SCORING REMOVED

  Pitching-plan support used to split 20 points as 14 pitcher edge + 6 plan
  completeness (4.2 for the pick's own plan summing to 9 innings, 1.8 for both
  sides' plans doing so). Checked planAllocatesFullGame() against every
  team-side plan in every day of member-brief data on hand (410 plans,
  2026-07-07 through 2026-08-08): 0 were ever incomplete. The 6 points were
  unconditional — every game got them regardless of analysis quality, which is
  exactly the failure mode v2's completeness component had (see above).
  Folded the 6 points into pitcher edge instead of dropping the total:
  PITCHER_MAX 14 -> 20, so pitching-plan support still maxes at 20 and the
  score still maxes at 100. planAllocatesFullGame() itself is unchanged and
  still feeds the (already zero-point) data-completeness diagnostic below.

  ---------------------------------------------------------------------------
  2026-08-12: OFFENSE COMPONENT MOVED FROM OPS TO HEAD-TO-HEAD wOBA

  Offense support used to compare each side's own trailing-15-day OPS against
  its own season OPS (delta_ops) -- a "hot or cold vs itself" read. Lynold's
  2026-08-08 instruction (DEC-20260808-05) already moved the site's display
  labels and the shadow model's offense term off OPS and onto wOBA, compared
  head-to-head between the two teams rather than each team against its own
  history -- but Lab Rating's own scoring was missed in that pass and kept
  using delta_ops until now.

  This brings offense_points in line with the same head-to-head wOBA read the
  shadow model (v3.2-woba) already uses, now averaged across two windows
  (Lynold's call, 2026-08-12): each side's trailing-15-day wOBA gap and its
  trailing-30-day wOBA gap, versus the opponent, averaged together (whichever
  windows are available if one is missing). The +/-0.060 cap is the same
  OFFENSE_WOBA_CAP the shadow model already uses for its head-to-head gap --
  chosen there because full-season wOBA spread across all 30 teams runs
  ~0.07, so 0.060 sits close to a real best-to-worst gap rather than a fluke
  week. Reused here rather than re-deriving a new threshold.

  ---------------------------------------------------------------------------
  2026-08-16: WEIGHTS REBALANCED, LYNOLD'S EXPLICIT INSTRUCTION

  CONVICTION_MAX 35 -> 20, OFFENSE_MAX 25 -> 40. PITCHER_MAX and BULLPEN_MAX
  unchanged at 20 each. New split still sums to 100:

                        v3      v3.1 (this change)
      conviction        35      20
      pitching plan     20      20
      bullpen           20      20
      offense           25      40

  No new backtest was run to justify this split -- it is a deliberate policy
  call, not a data-driven update like the v3 rebalance above. Conviction
  (model confidence) now carries less weight relative to offense (head-to-head
  wOBA) than it did under v3. Revisit against grade-confidence.js once enough
  games have been graded under v3.1 to say anything about it empirically.

  ---------------------------------------------------------------------------
  2026-08-22: WEIGHTS REBALANCED AGAIN, LYNOLD'S EXPLICIT INSTRUCTION

  CONVICTION_MAX 20 -> 10, OFFENSE_MAX 40 -> 50. PITCHER_MAX and BULLPEN_MAX
  unchanged at 20 each. Also, CONVICTION_FLOOR 0.525 -> 0.55 and
  CONVICTION_CEIL 0.65 -> 0.75 -- both still on the calibrated probability
  scale established 2026-08-05, this narrows/shifts the band a game earns
  conviction credit across, independent of the point total it's worth. New
  split still sums to 100:

                        v3.1    v3.2 (this change)
      conviction        20      10
      pitching plan     20      20
      bullpen           20      20
      offense           40      50

  No new backtest was run to justify this split, same as the 08-16 change --
  a deliberate policy call. Conviction now carries the least weight of any
  component; offense carries half the total score. Revisit against
  grade-confidence.js once enough games have been graded under v3.2.

  ---------------------------------------------------------------------------
  2026-08-25: WEIGHTS REBALANCED AGAIN, LYNOLD'S EXPLICIT INSTRUCTION

  PITCHER_MAX 20 -> 30, BULLPEN_MAX 20 -> 10. CONVICTION_MAX and OFFENSE_MAX
  unchanged at 10 and 50. New split still sums to 100:

                        v3.2    v3.3 (this change)
      conviction        10      10
      pitching plan     20      30
      bullpen           20      10
      offense           50      50

  No new backtest was run to justify this split, same as the two prior
  rebalances -- a deliberate policy call. Pitching-plan support now carries
  three times the weight of bullpen support, versus an even split before.
  Revisit against grade-confidence.js once enough games have been graded
  under v3.3.

  ---------------------------------------------------------------------------
  2026-08-26: PITCHING-PLAN SUPPORT REDESIGNED, LYNOLD'S EXPLICIT INSTRUCTION

  Pitching-plan support used to score the GAP between the picked pitcher's
  score and the opponent's ("pitchGap", only credited when the gap favoured
  the pick). Lynold's words: "it should be more of an individualized calc of
  the pitcher rather than comparing one pitcher to the other." Two reasons
  this is a real fix, not just a preference:

  1. It is largely redundant with conviction_points. The model's win
     probability already prices this exact same pitcher-score gap in via
     exp(ERA_K * scoreGap) (see pitcher-boost-constants.js) -- so a big
     mismatch was earning credit twice, once through conviction and again
     through the pitching plan, for the same underlying fact.
  2. It rewarded facing a weak opponent pitcher, not pitching well. A great
     start against a great opposing starter (gap ~0) scored near zero here,
     while a mediocre start against a truly bad one (gap large) scored near
     the max -- backwards from "how strong is LyDia's own starter," which is
     what this component is supposed to be answering.

  New formula: the picked pitcher's own individualized pitcher_score (20-92
  scale, already opponent-free -- ERA/WHIP/K-BB/sample-size components
  computed for that one pitcher, see js/pitcher-matchup-core.js's
  scorePitcher()) is mapped directly onto 0-30 points between a floor and a
  ceiling: PITCHER_SCORE_FLOOR=50 (league-average start; the real
  pitcher_score distribution's median across 330 logged starts is 65, so 50
  sits below-average by design -- an average or below-average start earns
  0-6 points, not half credit) and PITCHER_SCORE_CEILING (originally 85, the
  ~95th percentile of real logged starts; lowered to 80 the same day, Lynold's
  explicit instruction -- "anything 80 and above should return the full
  points"). Checked against the real pitcher_data_log.csv distribution
  (n=330) at each ceiling before shipping: at 85, 15.2% of real starts land
  at 0 points, 2.7% max out at 30, mean/median ~13/30; at 80, the floor-end
  is unchanged (still 15.2% at 0) but 8.2% now max out at 30 and mean/median
  rise to ~15/30 -- full credit is reachable by a real above-average start,
  not only a near-best-of-the-season one.

  PITCHER_MAX is unchanged at 30 -- pitching-plan support still maxes the
  score out the same as every other component; only what earns those points
  changed. pitchGap itself is untouched everywhere else in the codebase (the
  official-pick pitcher-conflict gate and the "owns the starting pitcher
  edge by N points" matchup-page copy in generate-member-lab.js still read
  it directly) -- only Lab Rating's own scoring stopped using it.
*/

"use strict";

const LAB_RATING_VERSION = "lab-rating-v3-measured-components";

/*
  Conviction: a coin flip earns nothing.

  Expressed on the CALIBRATED probability scale as of 2026-08-05. The published
  moneyline probability is now shrunk toward 0.5 (p -> 0.5 + 0.5*(p-0.5)) because
  the raw model was measurably overconfident above 55%; see the calibration note
  in generate-member-lab.js. The old band was 0.55-0.80 on the raw scale, which
  is 0.525-0.65 after the same transform. Remapping it this way keeps every
  game's conviction points EXACTLY as they were -- this is a units change, not a
  scoring change, and it is deliberately not dressed up as an improvement.
*/
// 2026-08-22, Lynold's explicit instruction: 0.525 -> 0.55, 0.65 -> 0.75.
// Raised on the same calibrated probability scale as the 08-16 remap above --
// this narrows and shifts the band a coin-flip-to-strong-lean game earns
// conviction credit across, on top of (not instead of) that scale.
const CONVICTION_FLOOR = 0.55;
const CONVICTION_CEIL = 0.75;
// 2026-08-16, Lynold's explicit instruction: 35 -> 20. See version note above.
// 2026-08-22, Lynold's explicit instruction: 20 -> 10.
const CONVICTION_MAX = 10;

// Retained at 0 so any consumer reading these still gets a number rather than
// undefined, and so the arithmetic below stays readable. See the version note.
const AGREEMENT_MAX = 0;
const COMPLETENESS_MAX = 0;

// Thresholds still used to DESCRIBE agreement, now that it does not score.
const AGREEMENT_FREE = 0.02;
const AGREEMENT_ZERO = 0.15;

// 2026-08-12: absorbed the old 6-pt plan-completeness bonus (see version note
// above) -- was 14, then 20.
// 2026-08-25, Lynold's explicit instruction: 20 -> 30. See version note above.
const PITCHER_MAX = 30;
// 2026-08-26: replaced PITCHER_FULL_GAP (a comparative-gap threshold) with an
// individualized floor/ceiling on the picked pitcher's own pitcher_score
// (20-92 scale). See the 2026-08-26 version note above for how these two
// anchors were chosen against the real score distribution.
const PITCHER_SCORE_FLOOR = 50;   // pitcher_score at/below this earns 0 points
// 2026-08-26, Lynold's explicit instruction: 85 -> 80 ("anything 80 and
// above should return the full points"). Real distribution recheck at this
// ceiling (pitcher_data_log.csv, n=330): 15.2% of real starts still land at
// 0 (unchanged, floor didn't move), 8.2% now max out at 30 (was 2.7% at 85),
// mean/median points ~15/30 (was ~13/30) -- a slightly more generous curve,
// full credit reachable by a real above-average start rather than only a
// ~95th-percentile one.
const PITCHER_SCORE_CEILING = 80; // pitcher_score at/above this earns full PITCHER_MAX
// 2026-08-25, Lynold's explicit instruction: 20 -> 10. See version note above.
const BULLPEN_MAX = 10;
// 2026-08-16, Lynold's explicit instruction: 25 -> 40. See version note above.
// 2026-08-22, Lynold's explicit instruction: 40 -> 50.
const OFFENSE_MAX = 50;
// 2026-08-12: was OFFENSE_SPAN, a delta-OPS threshold. Now the cap on the
// averaged head-to-head wOBA gap (15-day and 30-day) -- reused from the
// shadow model's V3_OFF_WOBA_CAP. See the version note at the top of this file.
const OFFENSE_WOBA_CAP = 0.06;

// A plan must allocate the full nine innings to count as complete. Still used
// by the data-completeness diagnostic (zero points) even though it no longer
// scores pitching-plan support directly.
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
  Pitching-plan support: how strong is the picked pitcher's own start, on his
  own merits -- NOT how much better he grades than the pitcher he's facing.

  2026-08-26, Lynold's explicit instruction: redesigned from a comparative
  gap read to an individualized one. See the 2026-08-26 version note at the
  top of this file for why (redundant with conviction, and rewarded facing a
  weak opponent rather than pitching well).

  No opposing-pitcher input enters this function at all now -- pickPitcherScore
  is the picked pitcher's own individualized score (ERA/WHIP/K-BB/sample-size
  components, no cross-reference to the opponent; see
  js/pitcher-matchup-core.js's scorePitcher()). Missing score (pitcher TBD,
  or stats unavailable) falls back to half credit, the same "no signal isn't
  the same as a bad signal" convention bullpenPoints()/offensePoints() below
  already use -- not the old zero-point default a missing gap used to produce.

  2026-08-12: this used to also award up to 6 points for the plan simply
  summing to nine innings. Removed -- see the version note at the top of this
  file. Every plan in 410 checked always summed to nine innings, so that
  credit was unconditional.
*/
function pitchingPlanPoints({ pickPitcherScore }) {
  if (!isNum(pickPitcherScore)) {
    const neutral = PITCHER_MAX / 2;
    return { points: neutral, pitcher_edge_points: round(neutral), available: false };
  }
  const frac = clamp((pickPitcherScore - PITCHER_SCORE_FLOOR) / (PITCHER_SCORE_CEILING - PITCHER_SCORE_FLOOR), 0, 1);
  const points = frac * PITCHER_MAX;
  return {
    points,
    pitcher_edge_points: round(points),
    available: true
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
  Offensive matchup support: each side's current offense compared directly to
  the opponent's, not to its own history. Neutral form on both sides sits at
  half credit rather than zero, because "no offensive signal" is not the same
  as "the offence argues against this pick".

  Now the largest non-conviction component: it was the only part of v2 that
  measured a clearly positive relationship with winning (+6.6% lift), back
  when this was still an OPS-vs-own-season read. See the 2026-08-12 version
  note for why it is now a head-to-head wOBA read instead.
*/
function offensePoints({ pickWoba15, oppWoba15, pickWoba30, oppWoba30 }) {
  const gap15 = (isNum(pickWoba15) && isNum(oppWoba15)) ? (pickWoba15 - oppWoba15) : null;
  const gap30 = (isNum(pickWoba30) && isNum(oppWoba30)) ? (pickWoba30 - oppWoba30) : null;
  const gaps = [gap15, gap30].filter(isNum);
  if (!gaps.length) {
    return { points: OFFENSE_MAX / 2, diff: null, diff_15d: null, diff_30d: null, available: false };
  }
  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const credit = clamp((avgGap + OFFENSE_WOBA_CAP) / (OFFENSE_WOBA_CAP * 2), 0, 1);
  return {
    points: credit * OFFENSE_MAX,
    diff: round(avgGap, 4),
    diff_15d: gap15 === null ? null : round(gap15, 4),
    diff_30d: gap30 === null ? null : round(gap30, 4),
    available: true
  };
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
    pickPitcherScore = null,
    pickPlan = null,
    oppPlan = null,
    pickBullpenRisk = null,
    oppBullpenRisk = null,
    pickWoba15 = null,
    oppWoba15 = null,
    pickWoba30 = null,
    oppWoba30 = null,
    hasTeamStrength = true,
    hasBothPitchers = true,
    hasRunProjection = null
  } = input || {};

  const conviction = convictionPoints(modelProb);
  const agreement = agreementDiagnostic(strengthProbPick, runProbPick);

  const pickPlanComplete = planAllocatesFullGame(pickPlan);
  const oppPlanComplete = planAllocatesFullGame(oppPlan);
  // 2026-08-26: pickPitcherScore replaces pitchGap/pitchEdgeSupports here --
  // see pitchingPlanPoints()'s header comment and the 2026-08-26 version
  // note at the top of this file.
  const plan = pitchingPlanPoints({
    pickPitcherScore
  });

  const penInnings = assignedBullpenInnings(pickPlan);
  const bullpen = bullpenPoints({
    pickRisk: pickBullpenRisk,
    oppRisk: oppBullpenRisk,
    pickBullpenInnings: penInnings
  });

  const offense = offensePoints({ pickWoba15, oppWoba15, pickWoba30, oppWoba30 });

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
    model_agreement_gap: agreement.gap === null ? null : round(agreement.gap, 4),
    model_agreement_credit: agreement.credit,           // what v2 would have scored on
    bullpen_innings_weight: bullpen.weight,
    assigned_bullpen_innings: penInnings === null ? null : round(penInnings, 1),
    offense_delta: offense.diff,               // average of the 15d/30d wOBA gaps below
    offense_delta_15d: offense.diff_15d,
    offense_delta_30d: offense.diff_30d,
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
  PITCHER_SCORE_FLOOR,
  PITCHER_SCORE_CEILING,
  BULLPEN_MAX,
  OFFENSE_MAX,
  OFFENSE_WOBA_CAP,
  COMPLETENESS_MAX,
  // Exported so consumers (matchup-copy-core.js) can define "a real lean"
  // identically to how the rating itself defines conviction, instead of
  // carrying a second, independently-tuned threshold that can drift out of
  // sync with this one.
  CONVICTION_FLOOR,
  CONVICTION_CEIL
};
