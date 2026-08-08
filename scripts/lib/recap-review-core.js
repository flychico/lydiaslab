/*
  LyDia — post-game recap review core.

  Purpose: compare what LyDia's pregame analysis actually claimed against what
  the game actually did, for every game that reaches Final — official pick,
  value watch, watchlist, or pass. A "W" or "L" tells you the side was right.
  It does not tell you whether the REASONS were right, and reasons are what
  the next model change has to be built on.

  Five things get checked, each independently, each only when the input to
  check it exists:
    1. Direction  — did the pick team actually win?
    2. Sub-model split — when the team-strength model and the run-projection
       model disagreed pregame, which one was closer to the actual winner?
    3. Starting pitcher — did the pitcher LyDia rated better actually pitch
       better, by the same categories LyDia used to grade the edge?
    4. Bullpen — did the bullpen LyDia flagged as risky actually get exposed,
       or did it hold? Unearned runs are called out explicitly, because a run
       that scores on an error is not evidence about pitching quality either
       way. 2026-08-08: this now also reports a bullpen's actual performance
       when it WASN'T flagged pregame but turned in a night far from league
       average -- a quiet shutdown or a quiet collapse is exactly the kind of
       thing "what made the analysis wrong" needs, and the old version only
       ever spoke about bullpens LyDia had already called out.
    5. Offense vs projection — did a team's bats over- or under-perform the
       pregame run projection.

  2026-08-08, Lynold: a sixth pass was added -- "likely driver" -- specifically
  for games the direction call got WRONG. The four checks above each describe
  one piece in isolation ("the starter beat his projection," "the bullpen held").
  They did not, before this, say which piece actually explains the miss. This
  pass ranks the pieces by how far each one moved from what was expected and
  states the one or two largest movers as a single explicit sentence, so a
  wrong pick reads as a diagnosis, not just a description.

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

  2026-08-08: "heldUp" is a relative comparison (favoredEra <= otherEra) and
  stays that way -- it is answering "which pitcher was better," which is a
  relative question. But a relative win can still be a bad process (both
  starters got hit hard, one just got hit less hard), so `bothRough` and
  `bothSharp` are now flagged separately and the narrative below qualifies the
  sentence instead of letting "the edge held up" imply the favored starter
  actually pitched well when he did not.
*/
const STARTER_ROUGH_ERA = 5.00;  // at/above this, a starter had a bad night regardless of the comparison
const STARTER_SHARP_ERA = 2.50;  // at/below this, a starter had a good night regardless of the comparison

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
  const bothRough = isNum(favoredEra) && isNum(otherEra) && favoredEra >= STARTER_ROUGH_ERA && otherEra >= STARTER_ROUGH_ERA;
  const bothSharp = isNum(favoredEra) && isNum(otherEra) && favoredEra <= STARTER_SHARP_ERA && otherEra <= STARTER_SHARP_ERA;

  return {
    favoredTeam, favoredName, otherName, pitcherGap,
    favored: { ...favoredActual, era: favoredEra },
    other: { ...otherActual, era: otherEra },
    heldUp, bothRough, bothSharp
  };
}

/*
  4. Bullpen. Compares the pregame risk read against what the bullpen actually
  allowed, scoped to relief innings only — matching how Lab Rating itself only
  charges a bullpen for the innings it is actually assigned. Unearned runs are
  flagged rather than folded into the read, because they are not something a
  bullpen's stuff can be blamed for or credited for.

  Always computed regardless of whether the bullpen was flagged pregame —
  narrate() below decides which ones are worth a sentence.
*/
const BULLPEN_RISK_FLAG = 70; // score (of 100) at or above which a bullpen was flagged as a real risk pregame
const BULLPEN_LEAGUE_ERA = 4.20; // matches Leo's own LEAGUE_ERA constant
const BULLPEN_NOTABLE_GAP = 2.00; // ERA points from league average that count as notable even when not flagged

function bullpenReview({ team, oppTeam, bullpenLabel, bullpenScore, bullpenActual, teamRunsAllowedByOpposingOffense, teamEarnedRunsAllowedByOpposingOffense }) {
  if (!bullpenActual || !isNum(bullpenActual.ip) || bullpenActual.ip <= 0) return null;
  const era = eraOf(bullpenActual.er, bullpenActual.ip);
  const wasFlagged = isNum(bullpenScore) && bullpenScore >= BULLPEN_RISK_FLAG;
  const notableUnflagged = !wasFlagged && isNum(era) && Math.abs(era - BULLPEN_LEAGUE_ERA) >= BULLPEN_NOTABLE_GAP;
  const unearnedRuns = isNum(teamRunsAllowedByOpposingOffense) && isNum(teamEarnedRunsAllowedByOpposingOffense)
    ? Math.max(0, teamRunsAllowedByOpposingOffense - teamEarnedRunsAllowedByOpposingOffense)
    : null;
  return {
    team, oppTeam, bullpenLabel, bullpenScore, wasFlagged, notableUnflagged,
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
const OFFENSE_NOTABLE_DIFF = 1.5;

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
   6. Likely driver — only for games the direction call got wrong.

   Pulls together whatever pieces above actually moved and ranks them by how
   far each one moved from what was expected, in comparable "this mattered a
   lot / a little" terms rather than raw stat units. States the top mover(s)
   as one plain sentence. This is the piece that used to be missing entirely:
   the old narrate() described each input in isolation and left it to the
   reader to work out which one actually explains the loss.

   Every factor here is scored 0-3 (how much it plausibly explains the miss)
   using thresholds already defined above, so "likely driver" never invents a
   new bar different from what the rest of the review already uses.
--------------------------------------------------------------------------- */
function rankMissDrivers({ pickTeam, oppTeam, starter, awayBullpenReview, homeBullpenReview, offenseReviews, pickIsAway }) {
  const factors = [];

  // Starter: the pick's own starter getting rocked, or the opponent's starter
  // shutting the pick down, are both direct causes of a loss.
  if (starter && isNum(starter.favored?.era) && isNum(starter.other?.era)) {
    const pickIsFavored = starter.favoredTeam === pickTeam;
    const pickStarterEra = pickIsFavored ? starter.favored.era : starter.other.era;
    const oppStarterEra = pickIsFavored ? starter.other.era : starter.favored.era;
    if (isNum(pickStarterEra) && pickStarterEra >= STARTER_ROUGH_ERA) {
      factors.push({ weight: pickStarterEra, clause: `${pickIsFavored ? starter.favoredName : starter.otherName}, the pick's own starter, was rocked for a ${fmtEra(pickStarterEra)} ERA` });
    }
    if (isNum(oppStarterEra) && oppStarterEra <= STARTER_SHARP_ERA) {
      factors.push({ weight: STARTER_SHARP_ERA - oppStarterEra + 3, clause: `the opposing starter (${fmtEra(oppStarterEra)} ERA) was sharp when the read expected an edge the other way` });
    }
  }

  // Bullpen: either side's pen swinging hard from expectation, flagged or not.
  for (const [side, review] of [["pick", pickIsAway ? awayBullpenReview : homeBullpenReview], ["opp", pickIsAway ? homeBullpenReview : awayBullpenReview]]) {
    if (!review || !isNum(review.actual?.era)) continue;
    const gapFromLeague = Math.abs(review.actual.era - BULLPEN_LEAGUE_ERA);
    if (gapFromLeague < BULLPEN_NOTABLE_GAP) continue;
    if (side === "pick" && review.actual.era >= BULLPEN_LEAGUE_ERA) {
      factors.push({ weight: gapFromLeague + (review.wasFlagged ? 1 : 0), clause: `the ${review.team} bullpen allowed ${review.actual.er} earned run${review.actual.er === 1 ? "" : "s"} over ${fmtIp(review.actual.ip)} relief innings (${fmtEra(review.actual.era)} ERA)${review.wasFlagged ? ", which is exactly the risk flagged pregame" : ", which was not flagged pregame but showed up anyway"}` });
    } else if (side === "opp" && review.actual.era <= BULLPEN_LEAGUE_ERA) {
      factors.push({ weight: gapFromLeague, clause: `the ${review.team} bullpen quietly shut the game down (${fmtEra(review.actual.era)} ERA over ${fmtIp(review.actual.ip)} innings)${review.wasFlagged ? "" : ", unflagged pregame"}` });
    }
  }

  // Offense: the pick's bats going cold, or the opponent's bats getting hot,
  // beyond what either projection called for.
  for (const rev of offenseReviews || []) {
    if (!rev || rev.skipped || !isNum(rev.diff)) continue;
    if (Math.abs(rev.diff) < OFFENSE_NOTABLE_DIFF) continue;
    if (rev.team === pickTeam && rev.diff < 0) {
      factors.push({ weight: Math.abs(rev.diff), clause: `${pickTeam}'s offense scored ${Math.abs(rev.diff)} fewer runs than projected` });
    } else if (rev.team === oppTeam && rev.diff > 0) {
      factors.push({ weight: rev.diff, clause: `${oppTeam}'s offense scored ${rev.diff} more runs than projected` });
    }
  }

  return factors.sort((a, b) => b.weight - a.weight);
}

function likelyDriverSentence({ pickTeam, oppTeam, starter, awayBullpenReview, homeBullpenReview, offenseReviews, pickIsAway }) {
  const ranked = rankMissDrivers({ pickTeam, oppTeam, starter, awayBullpenReview, homeBullpenReview, offenseReviews, pickIsAway });
  if (!ranked.length) {
    return `Likely driver: no single input moved far enough from its pregame read to point at one clear cause — this one looks like ordinary game-to-game variance rather than an analysis miss.`;
  }
  const top = ranked.slice(0, 2).map(f => f.clause);
  const joined = top.length === 1 ? top[0] : `${top[0]}, and ${top[1]}`;
  return `Likely driver: ${joined}.`;
}

/* ---------------------------------------------------------------------------
   Plain-language narrative. Every sentence traces to one of the reviews
   above — nothing here adds an interpretation the data does not support.
--------------------------------------------------------------------------- */
function narrate({ direction, submodel, starter, awayBullpenReview, homeBullpenReview, offenseReviews, pickTeam, oppTeam, pickIsAway }) {
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
    const { favoredTeam, favoredName, otherName, favored, other, heldUp, bothRough, bothSharp } = starter;
    let qualifier = "";
    if (heldUp && bothRough) qualifier = " Neither starter actually pitched well tonight, though — this is a smaller-of-two-bads comparison, not a starter who dealt.";
    else if (heldUp && bothSharp) qualifier = " Both starters were sharp; the edge is a narrow one between two good outings.";
    else if (!heldUp && bothRough) qualifier = " Both starters struggled; this was not a case of one clean outing beating one bad one.";
    const line = heldUp
      ? `${favoredName} (${favoredTeam}), the starter LyDia's pitcher score favored, actually outpitched ${otherName}: `
        + `${fmtIp(favored.ip)} IP, ${favored.er} ER (${fmtEra(favored.era)} ERA) against ${fmtIp(other.ip)} IP, ${other.er} ER (${fmtEra(other.era)} ERA). The edge held up.${qualifier}`
      : `${favoredName} (${favoredTeam}) was LyDia's favored starter by pitcher score, but ${otherName} actually pitched better tonight: `
        + `${fmtIp(other.ip)} IP, ${other.er} ER (${fmtEra(other.era)} ERA) against ${fmtIp(favored.ip)} IP, ${favored.er} ER (${fmtEra(favored.era)} ERA). The edge did not show up in this game.${qualifier}`;
    paragraphs.push(line);
  }

  // 2026-08-08: report a bullpen's actual outing whenever it was flagged
  // pregame OR turned in a night far enough from league average to matter,
  // not only when LyDia had already called it out. A pen that quietly shuts
  // a hot offense down for six scoreless, unflagged, used to be invisible
  // here even though it is often exactly why an offense missed its projection.
  for (const review of [awayBullpenReview, homeBullpenReview]) {
    if (!review || !(review.wasFlagged || review.notableUnflagged)) continue;
    const { team, actual, unearnedRuns, wasFlagged } = review;
    let line = wasFlagged
      ? `The ${team} bullpen was flagged as elevated risk pregame (${review.bullpenLabel}). `
        + `In relief it actually allowed ${actual.er} earned run${actual.er === 1 ? "" : "s"} over ${fmtIp(actual.ip)} innings (${fmtEra(actual.era)} ERA)`
      : `The ${team} bullpen was not flagged pregame, but it had a night worth noting: ${actual.er} earned run${actual.er === 1 ? "" : "s"} allowed over ${fmtIp(actual.ip)} relief innings (${fmtEra(actual.era)} ERA)`;
    if (wasFlagged) line += actual.era !== null && actual.era <= 4.20 ? " — the risk read did not show up on the scoreboard tonight." : " — the risk read showed up.";
    else line += actual.era !== null && actual.era <= 4.20 ? " — quietly better than the pregame read implied." : " — quietly worse than the pregame read implied.";
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

  // Likely driver — only when there is a wrong pick to diagnose. A correct
  // pick or a no-lean pass game does not need a "why it went wrong" sentence.
  if (direction && direction.correct === false && pickTeam) {
    paragraphs.push(likelyDriverSentence({ pickTeam, oppTeam, starter, awayBullpenReview, homeBullpenReview, offenseReviews, pickIsAway }));
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
  const pickIsAway = pickTeam === awayTeam;

  const direction = directionReview({ pickTeam, awayTeam, homeTeam, finalAwayScore, finalHomeScore });
  const submodel = pickTeam ? submodelReview({
    pickTeam, oppTeam, strengthProbabilityPick, runModelProbabilityPick, direction
  }) : null;

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
    offenseReviews, pickTeam, oppTeam, pickIsAway
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
