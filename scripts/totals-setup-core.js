/*
  LyDia — Totals Setup Rating core (v2, market-independent)

  This rating answers one question only: how much do we actually know about
  this game's total-runs inputs? It is NOT an edge, NOT a probability, and
  the market total line never enters this file.

  The market keeps veto power over an Official Pick through the edge gates
  in update-totals.js (research_min_edge / strong_min_edge), which still
  compare the projection to the line. That comparison belongs in the gate,
  not in this rating — exactly the split Lab Rating v2 drew for moneylines.

  v1 (retired 2026-07-29) put 65 of its 100 points into the size of the
  disagreement with the market (40 edge + up to 20 alignment, both keyed off
  `projection - line`), on top of a 40-point floor from base + data-presence
  alone. That made `OFFICIAL_TOTAL_LAB = 80` reachable by disagreement alone:
  at n=71 the gate was shown to select for confident-and-wrong over
  humble-and-right (LyDia MAE 5.22 vs line MAE 2.83 in the 90+ band). See
  EXP-20260727-01 in the vault for the full diagnosis.

  v2 redistributes all 100 points across internal inputs only:

     30  recent-form reliability   (does the blended offense rate lean on a
                                     small-sample hot/cold streak, or track
                                     the season rate?)
     30  pitching-data confidence  (is the facing pitcher/plan sampled
                                     enough to trust, on both sides)
     25  bullpen-data reliability  (do we have a real risk read for the
                                     bullpen innings each side actually owns)
     15  league-data completeness  (is the park factor a known team, is the
                                     league sample deep enough to trust lgRPG)

  Ratings produced by v1 and v2 are NOT comparable. v2 opens a new
  calibration series at the cutover date; v1 ratings stay in the closed
  series. Because this rating no longer contains an edge term, a v2 score
  is not expected to predict projection accuracy on its own — the projection
  itself carries very little signal beyond the line (EXP-20260727-01). This
  rating only certifies how much real data backs the projection, the same
  restrained claim Lab Rating v2 makes for moneylines.
*/

"use strict";

const TOTALS_SETUP_VERSION = "totals-setup-v2-market-independent";

// Recent-form reliability: how far the blended rpg (season + last-15 +
// last-7) has been pulled from the season rate, as a fraction of league
// average runs/game. A pull at or beyond this fraction earns zero credit.
const FORM_PULL_ZERO = 0.20;
const FORM_MAX = 30; // 15 per side

// Pitching-data confidence: both flags are already internal-only booleans
// computed in update-totals.js (sp_sample_ok, pitching_plan_confident).
const SP_SAMPLE_PTS = 7.5;
const PLAN_CONFIDENT_PTS = 7.5;
const PITCHING_MAX = 30; // 15 per side

// Bullpen-data reliability, weighted by how many innings that side's
// bullpen actually owns — a 4+ inning bullpen game should need real risk
// data more than a traditional start needs it for its half-inning of mop-up.
const BULLPEN_MAX = 25; // 12.5 per side
const BULLPEN_FULL_INNINGS = 4.0;

// League-data completeness: a known park factor and an adequately deep
// standings sample (average games played per team this season).
const PARK_KNOWN_PTS = 7.5;
const SAMPLE_DEPTH_PTS = 7.5;
const SAMPLE_DEPTH_FULL_GAMES = 20; // average team games played for full credit
const COMPLETENESS_MAX = 15;

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function round(n, dp = 2) { const f = Math.pow(10, dp); return Math.round(n * f) / f; }
function isNum(n) { return typeof n === "number" && Number.isFinite(n); }

/*
  Recent-form reliability for one batting side. `rpg` is the model's already-
  blended season/last-15/last-7 rate; `seasonRpg` is the pure season rate.
  The further the blend has moved from the season number relative to league
  scoring, the more this side's offense factor is leaning on a short window
  that the offense-matchup tool itself would flag as unlikely to hold.

  Missing data scores a neutral half-credit rather than zero or full — we
  cannot confirm reliability, so we should not assume the best or the worst.
*/
function formReliability(side, lgRPG) {
  if (!side || !isNum(side.rpg) || !isNum(side.season_rpg) || !isNum(lgRPG) || lgRPG <= 0) {
    return { credit: 0.5, pull: null, available: false };
  }
  const pull = Math.abs(side.rpg - side.season_rpg) / lgRPG;
  const credit = clamp(1 - pull / FORM_PULL_ZERO, 0, 1);
  return { credit, pull: round(pull, 3), available: true };
}

/*
  Pitching-data confidence for one side (the side's own model of the pitcher
  it is facing). Both flags are computed once in update-totals.js and passed
  straight through:
    - sp_sample_ok: the facing starter/primary arm has an innings sample big
      enough that fipLite() is not leaning on the league-average fallback.
    - pitching_plan_confident: the innings allocation for that side is either
      a manually reported plan or a high-confidence automatic read.
*/
function pitchingConfidence(side) {
  if (!side) return { points: 0, sp_sample_ok: false, plan_confident: false };
  const spOk = Boolean(side.sp_sample_ok);
  const planOk = Boolean(side.pitching_plan_confident);
  return {
    points: (spOk ? SP_SAMPLE_PTS : 0) + (planOk ? PLAN_CONFIDENT_PTS : 0),
    sp_sample_ok: spOk,
    plan_confident: planOk
  };
}

/*
  Bullpen-data reliability for one side, weighted by the innings that side's
  bullpen is actually projected to cover. Missing risk data scores zero
  rather than a neutral value — the pitching factor is already leaning on a
  fallback of penF = 1 for that side, and this should read as reduced
  confidence, not an assumption that the fallback is fine.
*/
function bullpenReliability(side) {
  if (!side || !isNum(side.opp_pen_risk)) {
    return { points: 0, weight: null, available: false };
  }
  const innings = isNum(side.opp_bullpen_ip) ? side.opp_bullpen_ip : 0;
  const weight = clamp(innings / BULLPEN_FULL_INNINGS, 0, 1);
  return { points: weight * (BULLPEN_MAX / 2), weight: round(weight), available: true };
}

/*
  League-data completeness. Shared across both sides of one game:
    - is the home team's park factor a known entry, not a 1.0 default from a
      name that failed to match (the D-backs alias bug is the cautionary
      example already on record)
    - is the league-wide runs/game rate built from a deep enough standings
      sample that lgRPG itself is not still an early-season guess
*/
function completenessPoints({ parkKnown, avgGamesPlayed }) {
  const parkPts = parkKnown ? PARK_KNOWN_PTS : 0;
  const depth = isNum(avgGamesPlayed) ? clamp(avgGamesPlayed / SAMPLE_DEPTH_FULL_GAMES, 0, 1) : 0;
  const depthPts = depth * SAMPLE_DEPTH_PTS;
  return { points: parkPts + depthPts, park_known: Boolean(parkKnown), sample_depth: round(depth, 2) };
}

/*
  Totals Setup Rating v2. Every argument is internal to LyDia's model —
  there is deliberately no market/line parameter. Adding one is a regression.

  Inputs:
    away, home        the per-side objects produced by update-totals.js's
                       side() function (rpg, season_rpg, sp_sample_ok,
                       pitching_plan_confident, opp_pen_risk, opp_bullpen_ip)
    lgRPG              league runs-per-game used for this game's projection
    parkKnown          true if the home team's park factor came from the
                       PARKS table rather than a 1.0 fallback
    avgGamesPlayed     average team games played this season, at capture time
*/
function calcTotalsSetup({ away, home, lgRPG, parkKnown, avgGamesPlayed }) {
  const formAway = formReliability(away, lgRPG);
  const formHome = formReliability(home, lgRPG);
  const formPoints = (formAway.credit + formHome.credit) * (FORM_MAX / 2);

  const pitchAway = pitchingConfidence(away);
  const pitchHome = pitchingConfidence(home);
  const pitchingPoints = pitchAway.points + pitchHome.points;

  const penAway = bullpenReliability(away);
  const penHome = bullpenReliability(home);
  const bullpenPoints = penAway.points + penHome.points;

  const completeness = completenessPoints({ parkKnown, avgGamesPlayed });

  const total = formPoints + pitchingPoints + bullpenPoints + completeness.points;
  const score = Math.round(clamp(total, 0, 100));

  return {
    score,
    version: TOTALS_SETUP_VERSION,

    form_points: round(formPoints),
    pitching_points: round(pitchingPoints),
    bullpen_points: round(bullpenPoints),
    completeness_points: round(completeness.points),

    form_pull_away: formAway.pull,
    form_pull_home: formHome.pull,
    sp_sample_ok_away: pitchAway.sp_sample_ok,
    sp_sample_ok_home: pitchHome.sp_sample_ok,
    plan_confident_away: pitchAway.plan_confident,
    plan_confident_home: pitchHome.plan_confident,
    bullpen_weight_away: penAway.weight,
    bullpen_weight_home: penHome.weight,
    park_known: completeness.park_known,
    sample_depth: completeness.sample_depth,

    // v1 compatibility: any consumer still reading these sees an honest
    // zero. The market contributes nothing to this rating by design.
    edge_points: 0,
    alignment_points: 0,
    base_points: 0,

    note: "Totals Setup Rating grades how much real data backs this projection. It contains no market or edge input."
  };
}

/* One-line public breakdown. Never mentions the market. */
function totalsSetupSentence(setup) {
  return `Setup ${(setup.score / 10).toFixed(1)}/10: recent-form reliability ${setup.form_points}, `
    + `pitching data ${setup.pitching_points}, bullpen data ${setup.bullpen_points}, `
    + `league data ${setup.completeness_points}.`;
}

module.exports = {
  TOTALS_SETUP_VERSION,
  calcTotalsSetup,
  totalsSetupSentence,
  FORM_MAX,
  PITCHING_MAX,
  BULLPEN_MAX,
  COMPLETENESS_MAX
};
