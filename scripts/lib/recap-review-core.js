/*
  LyDia — post-game recap review core.

  Purpose: compare what LyDia's pregame analysis actually claimed against what
  the game actually did, for every game that reaches Final — official pick,
  value watch, watchlist, or pass. A "W" or "L" tells you the side was right.
  It does not tell you whether the REASONS were right, and reasons are what
  the next model change has to be built on.

  Four things get checked, each independently, each only when the input to
  check it exists:
    1. Direction  — did the pick team actually win?
    2. Sub-model split — when the team-strength model and the run-projection
       model disagreed pregame, which one was closer to the actual winner?
    3. Starting pitcher — did the pitcher LyDia rated better actually pitch
       better, by the same categories LyDia used to grade the edge?
    4. Bullpen — did the bullpen LyDia flagged as risky actually get exposed,
       or did it hold? Unearned runs are called out explicitly, because a run
       that scores on an error is not evidence about pitching quality either
       way.

  Nothing here changes a pick, a rating, or a probability. This is read-only
  review, written once a game is Final, for a human (or a future learning
  pass) to read next to the pregame page.
*/

"use strict";

function isNum(n) { return typeof n === "number" && Number.isFinite(n); }
function round(n, dp = 1) {
  if (!isNum(n)) return null;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}
function pct(v, dp = 1) { return isNum(v) ? (v * 100).toFixed(dp) + "%" : "unknown"; }
// Innings pitched is stored here as a true decimal (6.667 for 6 and two
// thirds) so ERA math is correct. Display converts back to baseball's own
// notation (X.0 / X.1 / X.2 for zero, one, or two outs past a full inning).
function fmtIp(ip) {
  if (!isNum(ip)) return "0.0";
  let whole = Math.floor(ip + 1e-9);
  let outs = Math.round((ip - whole) * 3);
  if (outs >= 3) { whole += 1; outs = 0; }
  return `${whole}.${outs}`;
}
function fmtEra(era) { return isNum(era) ? era.toFixed(2) : "unknown"; }

/* Earned run average over however many innings were actually thrown. Not a
   season stat — a single-game rate, so treat small samples as exactly that. */
function eraOf(er, ip) {
  if (!isNum(er) || !isNum(ip) || ip <= 0) return null;
  return round((er * 9) / ip, 2);
}

/*
  1. Direction. Simple, but stated plainly and separately from "was the
  process good" — a win on a bad process and a loss on a good one are both
  real outcomes and neither should be silently absorbed into the other.
*/
function directionReview({ pickTeam, awayTeam, homeTeam, finalAwayScore, finalHomeScore }) {
  if (!isNum(finalAwayScore) || !isNum(finalHomeScore) || finalAwayScore === finalHomeScore) return null;
  const winner = finalAwayScore > finalHomeScore ? awayTeam : homeTeam;
  const correct = pickTeam ? winner === pickTeam : null;
  return { winner, correct };
}

/*
  2. Sub-model split. Only worth reporting when the two models actually
  disagreed pregame by a real margin — if they agreed, there is nothing to
  learn from the result about which one to trust more.
*/
const SUBMODEL_DISAGREEMENT_MIN = 0.05; // 5 points of win probability

function submodelReview({ pickTeam, oppTeam, strengthProbabilityPick, runModelProbabilityPick, direction }) {
  if (!isNum(strengthProbabilityPick) || !isNum(runModelProbabilityPick) || !direction) return null;
  const gap = Math.abs(strengthProbabilityPick - runModelProbabilityPick);
  if (gap < SUBMODEL_DISAGREEMENT_MIN) return null;

  const strengthFavored = strengthProbabilityPick >= 0.5 ? pickTeam : oppTeam;
  const runFavored = runModelProbabilityPick >= 0.5 ? pickTeam : oppTeam;
  if (strengthFavored === runFavored) return null; // both leaned the same way despite the point gap

  const strengthRight = strengthFavored === direction.winner;
  const runRight = runFavored === direction.winner;
  let verdict = "neither";
  if (strengthRight && !runRight) verdict = "strength";
  else if (runRight && !strengthRight) verdict = "runs";
  else if (strengthRight && runRight) verdict = "both"; // should not happen if favored teams differ, kept for safety

  return {
    gap: round(gap * 100, 1),
    strengthFavored, runFavored, verdict,
    strengthProbabilityPick, runModelProbabilityPick
  };
}

/*
  3. Starting pitcher. Compares the side LyDia's pitcher score favored against
  what that pitcher actually did, in the same units the edge was built from —
  earned runs allowed and innings, not a vibe.
*/
function starterReview({ pitcherEdgeTeam, pitcherGap, pickTeam, oppTeam,
  pickStarterName, oppStarterName, pickStarterActual, oppStarterActual }) {
  if (!pitcherEdgeTeam || pitcherEdgeTeam === "No clear SP edge") return null;
  if (!pickStarterActual && !oppStarterActual) return null;

  const favoredTeam = pitcherEdgeTeam;
  const favoredIsPick = favoredTeam === pickTeam;
  const favoredActual = favoredIsPick ? pickStarterActual : oppStarterActual;
  const otherActual = favoredIsPick ? oppStarterActual : pickStarterActual;
  const favoredName = favoredIsPick ? pickStarterName : oppStarterName;
  const otherName = favoredIsPick ? oppStarterName : pickStarterName;
  if (!favoredActual || !otherActual) return null;

  const favoredEra = eraOf(favoredActual.er, favoredActual.ip);
  const otherEra = eraOf(otherActual.er, otherActual.ip);
  const heldUp = isNum(favoredEra) && isNum(otherEra) ? favoredEra <= otherEra : null;

  return {
    favoredTeam, favoredName, otherName, pitcherGap,
    favored: { ...favoredActual, era: favoredEra },
    other: { ...otherActual, era: otherEra },
    heldUp
  };
}

/*
  4. Bullpen. Compares the pregame risk read against what the bullpen actually
  allowed, scoped to relief innings only — matching how Lab Rating itself only
  charges a bullpen for the innings it is actually assigned. Unearned runs are
  flagged rather than folded into the read, because they are not something a
  bullpen's stuff can be blamed for or credited for.
*/
const BULLPEN_RISK_FLAG = 70; // score (of 100) at or above which a bullpen was flagged as a real risk pregame

function bullpenReview({ team, oppTeam, bullpenLabel, bullpenScore, bullpenActual, teamRunsAllowedByOpposingOffense, teamEarnedRunsAllowedByOpposingOffense }) {
  if (!bullpenActual || !isNum(bullpenActual.ip) || bullpenActual.ip <= 0) return null;
  const era = eraOf(bullpenActual.er, bullpenActual.ip);
  const wasFlagged = isNum(bullpenScore) && bullpenScore >= BULLPEN_RISK_FLAG;
  const unearnedRuns = isNum(teamRunsAllowedByOpposingOffense) && isNum(teamEarnedRunsAllowedByOpposingOffense)
    ? Math.max(0, teamRunsAllowedByOpposingOffense - teamEarnedRunsAllowedByOpposingOffense)
    : null;
  return {
    team, oppTeam, bullpenLabel, bullpenScore, wasFlagged,
    actual: { ...bullpenActual, era },
    unearnedRuns
  };
}

/*
  5. Offense vs projection. Only meaningful across a standard 9-inning game —
  extra innings inflate both teams' run totals for reasons the projection was
  never trying to model, so the comparison is skipped rather than presented as
  a miss it is not.
*/
function offenseReview({ team, projectedRuns, actualRuns, actualInnings, deltaOpsPregame }) {
  if (!isNum(projectedRuns) || !isNum(actualRuns)) return null;
  if (isNum(actualInnings) && actualInnings !== 9) return { team, projectedRuns, actualRuns, skipped: true, actualInnings, deltaOpsPregame };
  return {
    team, projectedRuns, actualRuns, skipped: false,
    diff: round(actualRuns - projectedRuns, 1),
    deltaOpsPregame
  };
}

/* ---------------------------------------------------------------------------
   Plain-language narrative. Every sentence traces to one of the reviews
   above — nothing here adds an interpretation the data does not support.
--------------------------------------------------------------------------- */
function narrate({ direction, submodel, starter, awayBullpenReview, homeBullpenReview, offenseReviews, pickTeam }) {
  const paragraphs = [];

  if (direction) {
    paragraphs.push(
      direction.correct === null
        ? `${direction.winner} won.`
        : direction.correct
          ? `${direction.winner} won, the side LyDia's model favored.`
          : `${direction.winner} won. LyDia's model favored the other side.`
    );
  }

  if (submodel) {
    const sentence = submodel.verdict === "neither"
      ? `LyDia's two internal reads disagreed pregame — the team-strength model favored ${submodel.strengthFavored} `
        + `(${pct(submodel.strengthProbabilityPick)} for ${pickTeam}), the run-projection model favored ${submodel.runFavored} `
        + `(${pct(submodel.runModelProbabilityPick)} for ${pickTeam}). Neither actually had the winner.`
      : `LyDia's two internal reads disagreed pregame by ${submodel.gap} points — the team-strength model favored ${submodel.strengthFavored}, `
        + `the run-projection model favored ${submodel.runFavored}. The ${submodel.verdict === "strength" ? "team-strength" : "run-projection"} `
        + `model had the winner here.`;
    paragraphs.push(sentence);
  }

  if (starter && starter.heldUp !== null) {
    const { favoredTeam, favoredName, otherName, favored, other, heldUp } = starter;
    const line = heldUp
      ? `${favoredName} (${favoredTeam}), the starter LyDia's pitcher score favored, actually outpitched ${otherName}: `
        + `${fmtIp(favored.ip)} IP, ${favored.er} ER (${fmtEra(favored.era)} ERA) against ${fmtIp(other.ip)} IP, ${other.er} ER (${fmtEra(other.era)} ERA). The edge held up.`
      : `${favoredName} (${favoredTeam}) was LyDia's favored starter by pitcher score, but ${otherName} actually pitched better tonight: `
        + `${fmtIp(other.ip)} IP, ${other.er} ER (${fmtEra(other.era)} ERA) against ${fmtIp(favored.ip)} IP, ${favored.er} ER (${fmtEra(favored.era)} ERA). The edge did not show up in this game.`;
    paragraphs.push(line);
  }

  for (const review of [awayBullpenReview, homeBullpenReview]) {
    if (!review || !review.wasFlagged) continue;
    const { team, actual, unearnedRuns } = review;
    let line = `The ${team} bullpen was flagged as elevated risk pregame (${review.bullpenLabel}). `
      + `In relief it actually allowed ${actual.er} earned run${actual.er === 1 ? "" : "s"} over ${fmtIp(actual.ip)} innings (${fmtEra(actual.era)} ERA)`;
    line += actual.era !== null && actual.era <= 4.20 ? " — the risk read did not show up on the scoreboard tonight." : " — the risk read showed up.";
    if (isNum(unearnedRuns) && unearnedRuns > 0) {
      line += ` Note: ${unearnedRuns} of the runs charged to the ${team} pitching staff overall ${unearnedRuns === 1 ? "was" : "were"} unearned — not something the bullpen's stuff should be blamed for.`;
    }
    paragraphs.push(line);
  }

  for (const review of offenseReviews || []) {
    if (!review) continue;
    if (review.skipped) {
      paragraphs.push(`${review.team} scored ${review.actualRuns} in a game that went ${review.actualInnings} innings — not compared against the ${review.projectedRuns} pregame projection, which assumed nine.`);
      continue;
    }
    const dir = review.diff > 0 ? "more" : review.diff < 0 ? "fewer" : "exactly as many";
    if (Math.abs(review.diff) >= 1.5) {
      paragraphs.push(`${review.team} scored ${review.actualRuns}, ${Math.abs(review.diff)} ${dir} than the ${review.projectedRuns} pregame projection.`);
    }
  }

  return paragraphs;
}

function buildRecapReview(input) {
  const {
    pickTeam, awayTeam, homeTeam,
    finalAwayScore, finalHomeScore, actualInnings,
    strengthProbabilityPick, runModelProbabilityPick,
    pitcherEdgeTeam, pitcherGap,
    awayPitcherName, homePitcherName, awayStarterActual, homeStarterActual,
    awayBullpenLabel, homeBullpenLabel, awayBullpenScore, homeBullpenScore,
    awayBullpenActual, homeBullpenActual,
    awayRunsAllowedByOpposingOffense, awayEarnedRunsAllowedByOpposingOffense,
    homeRunsAllowedByOpposingOffense, homeEarnedRunsAllowedByOpposingOffense,
    projectedAwayRuns, projectedHomeRuns, awayDeltaOps, homeDeltaOps
  } = input || {};

  const oppTeam = pickTeam === awayTeam ? homeTeam : pickTeam === homeTeam ? awayTeam : null;

  const direction = directionReview({ pickTeam, awayTeam, homeTeam, finalAwayScore, finalHomeScore });
  const submodel = pickTeam ? submodelReview({
    pickTeam, oppTeam, strengthProbabilityPick, runModelProbabilityPick, direction
  }) : null;

  const pickIsAway = pickTeam === awayTeam;
  const starter = pickTeam ? starterReview({
    pitcherEdgeTeam, pitcherGap, pickTeam, oppTeam,
    pickStarterName: pickIsAway ? awayPitcherName : homePitcherName,
    oppStarterName: pickIsAway ? homePitcherName : awayPitcherName,
    pickStarterActual: pickIsAway ? awayStarterActual : homeStarterActual,
    oppStarterActual: pickIsAway ? homeStarterActual : awayStarterActual
  }) : starterReview({
    // No pick side at all (e.g. pass with no lean) — still compare on raw pitcher-edge team.
    pitcherEdgeTeam, pitcherGap, pickTeam: awayTeam, oppTeam: homeTeam,
    pickStarterName: awayPitcherName, oppStarterName: homePitcherName,
    pickStarterActual: awayStarterActual, oppStarterActual: homeStarterActual
  });

  const awayBullpen = bullpenReview({
    team: awayTeam, oppTeam: homeTeam, bullpenLabel: awayBullpenLabel, bullpenScore: awayBullpenScore,
    bullpenActual: awayBullpenActual,
    teamRunsAllowedByOpposingOffense: awayRunsAllowedByOpposingOffense,
    teamEarnedRunsAllowedByOpposingOffense: awayEarnedRunsAllowedByOpposingOffense
  });
  const homeBullpen = bullpenReview({
    team: homeTeam, oppTeam: awayTeam, bullpenLabel: homeBullpenLabel, bullpenScore: homeBullpenScore,
    bullpenActual: homeBullpenActual,
    teamRunsAllowedByOpposingOffense: homeRunsAllowedByOpposingOffense,
    teamEarnedRunsAllowedByOpposingOffense: homeEarnedRunsAllowedByOpposingOffense
  });

  const offenseReviews = [
    offenseReview({ team: awayTeam, projectedRuns: projectedAwayRuns, actualRuns: finalAwayScore, actualInnings, deltaOpsPregame: awayDeltaOps }),
    offenseReview({ team: homeTeam, projectedRuns: projectedHomeRuns, actualRuns: finalHomeScore, actualInnings, deltaOpsPregame: homeDeltaOps })
  ];

  const paragraphs = narrate({
    direction, submodel, starter,
    awayBullpenReview: awayBullpen, homeBullpenReview: homeBullpen,
    offenseReviews, pickTeam
  });

  return {
    data: { direction, submodel, starter, away_bullpen: awayBullpen, home_bullpen: homeBullpen, offense: offenseReviews },
    paragraphs: paragraphs.filter(Boolean)
  };
}

module.exports = {
  buildRecapReview,
  eraOf,
  SUBMODEL_DISAGREEMENT_MIN,
  BULLPEN_RISK_FLAG
};
