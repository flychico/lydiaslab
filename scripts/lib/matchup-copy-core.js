/*
  LyDia — matchup page explanation copy.

  Every sentence here is written from data the page already has. Nothing in this
  file invents a narrative: when the data does not support a claim, the copy says
  so plainly instead of reaching for a story.

  Four defects this replaces:
   1. "That gap is the entire reason this game is on the board" was printed even
      when LyDia had no lean at all (50.0%). Conviction language on a coin flip.
   2. Bullpen case read as raw model output: "4.7/10 risk against 7.7/10".
   3. Pitcher edge was a bare score gap with no reason attached.
   4. Recent form had a table but no headline anyone would actually read.
*/

const Correlation = require("./coach-correlation-core");

"use strict";

// AGREEMENT_MAX and COMPLETENESS_MAX are deliberately not imported: Lab Rating
// v3 sets both to 0, and this file divides component points by their max to
// decide whether to explain them. Dividing by zero would have produced NaN or
// Infinity in a comparison and either silently dropped every explanation or
// emitted one on every game. Their explanation blocks are removed below.
const {
  CONVICTION_FLOOR, CONVICTION_MAX, PITCHER_MAX,
  BULLPEN_MAX, OFFENSE_MAX
} = require("./lab-rating-core");

// Below this, LyDia has no directional lean worth describing as conviction.
// Single source of truth: this is the same floor Lab Rating's own conviction
// component uses (scripts/lib/lab-rating-core.js). A market-mispricing case
// used to fire down to 52% while the rating itself credited zero conviction
// below 55% — two systems disagreeing about where a real lean starts. Aligned
// here so the copy never claims more conviction than the rating would credit.
const LEAN_MIN = CONVICTION_FLOOR;
// A team-quality gap in runs per game worth calling out.
const RUNDIFF_NOTABLE = 0.35;
// Recent-vs-season OPS swing that counts as genuinely hot or cold.
const OPS_HOT = 0.030;

function isNum(n) { return typeof n === "number" && Number.isFinite(n); }
function pct(v, dp = 1) { return (v * 100).toFixed(dp) + "%"; }
function signedPct(v, dp = 1) { return (v >= 0 ? "+" : "") + (v * 100).toFixed(dp) + "%"; }
function one(v) { return Number(v).toFixed(1); }
function two(v) { return Number(v).toFixed(2); }
function wins(rec) {
  const m = /^(\d+)-(\d+)$/.exec(String(rec || "").trim());
  return m ? { w: Number(m[1]), l: Number(m[2]) } : null;
}

/* ---------------------------------------------------------------------------
   1. Market mispricing

   Only frames the edge as a directional case when LyDia actually leans that way.
   At a coin flip the value lives in the price, not in a read on the game, and
   the copy now says exactly that.
--------------------------------------------------------------------------- */
function marketMispricingCase({ pickTeam, modelProb, marketProb, edge, minEdge = 0.03 }) {
  if (!isNum(edge) || !isNum(modelProb) || !isNum(marketProb)) return null;
  if (edge < minEdge) return null;

  // The model must lean toward the side being argued for. Without that, the
  // "case for" framing is not honest.
  if (modelProb < LEAN_MIN) {
    return {
      title: `Priced above LyDia's read: ${signedPct(edge)}`,
      detail: `LyDia has this closer to a coin flip than the market does — ${pct(modelProb)} for ${pickTeam}, `
        + `against a no-vig market price of ${pct(marketProb)}. The value here is in the price, not in a strong `
        + `lean toward either side, so treat it as a pricing observation rather than a read on the game.`
    };
  }

  return {
    title: `Market mispricing: ${signedPct(edge)}`,
    detail: `LyDia makes ${pickTeam} ${pct(modelProb)} to win while the no-vig market says ${pct(marketProb)}. `
      + `LyDia rates this side ${signedPct(edge)} better than the price implies.`
  };
}

/* ---------------------------------------------------------------------------
   2. Bullpen advantage, in plain language

   Leads with what the pens have actually done (recent ERA) rather than the
   internal risk index, and only cites numbers that exist.
--------------------------------------------------------------------------- */
function bullpenCase({ pickTeam, oppTeam, pickPen, oppPen, minRiskGap = 15 }) {
  const riskOf = p => (p ? (p.risk_index ?? p.score ?? null) : null);
  const pickRisk = riskOf(pickPen);
  const oppRisk = riskOf(oppPen);
  if (!isNum(pickRisk) || !isNum(oppRisk)) return null;
  if (oppRisk - pickRisk < minRiskGap) return null;

  const pickEra = pickPen && isNum(pickPen.era7) ? pickPen.era7 : null;
  const oppEra = oppPen && isNum(oppPen.era7) ? oppPen.era7 : null;

  // Team names are plural and often already end in "s", so the copy is written
  // to avoid possessives entirely rather than emit "the Giants's".
  let evidence;
  if (isNum(pickEra) && isNum(oppEra)) {
    evidence = `${oppTeam} relievers have a ${two(oppEra)} ERA over the last 7 days; ${pickTeam} relievers have a ${two(pickEra)}.`;
  } else if (pickPen && oppPen && pickPen.efficiency_label && oppPen.efficiency_label) {
    evidence = `LyDia currently grades the ${pickTeam} bullpen ${String(pickPen.efficiency_label).toLowerCase()} and the ${oppTeam} bullpen ${String(oppPen.efficiency_label).toLowerCase()}.`;
  } else {
    evidence = `The ${oppTeam} bullpen carries materially more late-inning risk than the ${pickTeam} bullpen.`;
  }

  // Workload only gets mentioned when it is genuinely lopsided.
  let workload = "";
  const pb = pickPen && isNum(pickPen.b2b_arms) ? pickPen.b2b_arms : null;
  const ob = oppPen && isNum(oppPen.b2b_arms) ? oppPen.b2b_arms : null;
  if (isNum(pb) && isNum(ob) && ob - pb >= 2) {
    workload = ` ${oppTeam} also have ${ob} arms pitching on back-to-back days, against ${pb} for ${pickTeam}.`;
  }

  return {
    title: `Late-inning bullpen advantage`,
    detail: `${evidence}${workload} If this is still close after six innings, that gap favors ${pickTeam}.`
  };
}

/* ---------------------------------------------------------------------------
   3. Pitcher edge, with the reason attached

   Ranks the actual stat gaps so the copy names what is driving the score
   difference instead of defaulting to ERA. Only stats that genuinely favour the
   better-rated pitcher are cited — a stat pointing the other way is never
   presented as support.

   `scale` is the gap size that counts as a full-strength difference for that
   stat, used purely to rank dissimilar stats against each other.
--------------------------------------------------------------------------- */
const PITCHER_DRIVERS = [
  { key: "era", label: "ERA", scale: 2.0, lowerIsBetter: true, fmt: two },
  { key: "whip", label: "WHIP", scale: 0.35, lowerIsBetter: true, fmt: v => Number(v).toFixed(2) },
  { key: "kbb_pct", label: "K-BB%", scale: 8.0, lowerIsBetter: false, fmt: v => Number(v).toFixed(1) + "%" },
  { key: "k9", label: "K/9", scale: 2.5, lowerIsBetter: false, fmt: one },
  { key: "hr9", label: "HR/9", scale: 0.8, lowerIsBetter: true, fmt: two },
  { key: "bb9", label: "BB/9", scale: 1.5, lowerIsBetter: true, fmt: one },
  { key: "expected_innings", label: "expected innings", scale: 1.2, lowerIsBetter: false, fmt: one }
];

function rankPitcherDrivers(betterStats, worseStats) {
  const out = [];
  for (const d of PITCHER_DRIVERS) {
    const a = betterStats ? betterStats[d.key] : null;
    const b = worseStats ? worseStats[d.key] : null;
    if (!isNum(a) || !isNum(b)) continue;
    const raw = d.lowerIsBetter ? b - a : a - b;
    if (raw <= 0) continue; // this stat does not favour the better pitcher
    out.push({ ...d, better: a, worse: b, strength: raw / d.scale });
  }
  return out.sort((x, y) => y.strength - x.strength);
}

function pitcherEdgeSentence({ edgeTeam, gap, betterPitcher, worsePitcher, betterStats, worseStats, maxDrivers = 2 }) {
  if (!edgeTeam) return "No clear starting pitcher edge.";
  if (!betterPitcher || !worsePitcher) {
    return `${edgeTeam} holds the starting pitcher edge${isNum(gap) ? ` by ${gap} points` : ""}.`;
  }
  const drivers = rankPitcherDrivers(betterStats, worseStats).slice(0, maxDrivers);
  const head = `LyDia gives ${betterPitcher} a ${isNum(gap) ? gap + "-point " : ""}edge over ${worsePitcher}`;
  if (!drivers.length) return `${head}.`;

  const parts = drivers.map(d => `${d.label} (${d.fmt(d.better)} vs ${d.fmt(d.worse)})`);
  const joined = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
  return `${head}, driven mainly by ${joined}.`;
}

/* ---------------------------------------------------------------------------
   4. Recent form headline

   Says who is actually playing well. When neither team is, it says that rather
   than inventing a contrast.
--------------------------------------------------------------------------- */
function joinClauses(list) {
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return list.slice(0, -1).join(", ") + ", and " + list[list.length - 1];
}

function describeForm(team, l10, rpg15, deltaOps) {
  const rec = wins(l10);
  const bits = [];
  if (rec) bits.push(`${rec.w}-${rec.l} in their last 10`);
  if (isNum(rpg15)) bits.push(`averaging ${one(rpg15)} runs per game over the last 15 days`);
  if (isNum(deltaOps)) {
    if (deltaOps >= OPS_HOT) bits.push("swinging above their season form");
    else if (deltaOps <= -OPS_HOT) bits.push("hitting below their season form");
  }
  if (!bits.length) return null;
  return `${team} are ${joinClauses(bits)}`;
}

function recentFormSentence({ awayTeam, homeTeam, awayL10, homeL10, awayRunDiff, homeRunDiff, awayRpg15, homeRpg15, awayDeltaOps, homeDeltaOps }) {
  const a = describeForm(awayTeam, awayL10, awayRpg15, awayDeltaOps);
  const h = describeForm(homeTeam, homeL10, homeRpg15, homeDeltaOps);
  if (!a && !h) return "";

  let lead = "";
  const aRec = wins(awayL10), hRec = wins(homeL10);
  const bothPoor = aRec && hRec && aRec.w <= 4 && hRec.w <= 4;
  const sameRec = aRec && hRec && aRec.w === hRec.w;

  if (bothPoor && sameRec) lead = "Neither side is playing well. ";
  else if (sameRec) lead = "Both sides arrive in similar form. ";

  let tail = "";
  if (isNum(awayRunDiff) && isNum(homeRunDiff)) {
    const gap = Math.abs(awayRunDiff - homeRunDiff);
    if (gap >= RUNDIFF_NOTABLE) {
      const better = awayRunDiff > homeRunDiff ? awayTeam : homeTeam;
      const bv = Math.max(awayRunDiff, homeRunDiff), wv = Math.min(awayRunDiff, homeRunDiff);
      tail = ` On the season ${better} carry the better run differential per game (${(bv >= 0 ? "+" : "") + two(bv)} against ${(wv >= 0 ? "+" : "") + two(wv)}).`;
    } else {
      tail = ` Season run differential separates them by almost nothing (${(awayRunDiff >= 0 ? "+" : "") + two(awayRunDiff)} against ${(homeRunDiff >= 0 ? "+" : "") + two(homeRunDiff)}).`;
    }
  }
  return `${lead}${[a, h].filter(Boolean).join("; ")}.${tail}`;
}

/* ---------------------------------------------------------------------------
   5. Lab Rating, explained component by component

   Lab Rating v2 (scripts/lib/lab-rating-core.js) already computes exactly why
   a game scored what it scored — conviction, model agreement, pitching plan,
   bullpen, offense, data completeness — and stores every sub-value in
   lab_score_breakdown. Nothing here recomputes the rating; this only reads
   the breakdown that already exists and turns each component below its own
   "this is a real strength" threshold into a plain sentence. A component that
   already earned most of its points is not a story and is left out, so the
   page reads as a list of actual gaps, not a recap of everything that went
   fine.
--------------------------------------------------------------------------- */
// 2026-08-25, Lynold's explicit instruction: this used to read
// `PITCHER_MAX + 6` -- a leftover from before 2026-08-12, when pitching-plan
// support really did split into 14 pts pitcher-edge + 6 pts plan-completeness
// (see lab-rating-core.js's version note). That 6-pt piece was folded into
// PITCHER_MAX itself that day (14 -> 20) and PITCHER_MAX is the WHOLE
// pitching-plan max on its own since then -- but this file's own copy of the
// max was never updated to match, so every matchup page has been displaying
// "20/26" (and now would have shown "30/36") instead of the real max ever
// since. Caught when Lynold flagged the wrong number on a live page.
const LAB_MAX = {
  conviction: CONVICTION_MAX,
  pitching_plan: PITCHER_MAX,
  bullpen: BULLPEN_MAX,
  offense: OFFENSE_MAX
};
// A component earning less than this fraction of its max is treated as a real
// gap worth explaining. At or above, it is a strength and stays out of the list.
const LAB_WEAK_FRACTION = 0.5;

function labRatingReasons({
  breakdown, pickTeam, oppTeam, modelProb,
  strengthProbPick, runProbPick,
  pitcherEdgeTeam, pitcherGap, betterPitcher, worsePitcher,
  bullpenPickLabel, bullpenOppLabel
}) {
  if (!breakdown) return [];
  const reasons = [];

  if ((breakdown.conviction_points / LAB_MAX.conviction) < LAB_WEAK_FRACTION) {
    reasons.push({
      title: `Conviction: ${breakdown.conviction_points}/${LAB_MAX.conviction}`,
      detail: isNum(modelProb) && modelProb < CONVICTION_FLOOR
        ? `LyDia's own win probability for ${pickTeam} (${pct(modelProb)}) is close enough to a coin flip that the rating credits no conviction at all — credit only starts above ${pct(CONVICTION_FLOOR, 0)}.`
        : `LyDia leans toward ${pickTeam}, but not strongly enough to earn full conviction credit.`
    });
  }

  /*
    The model-agreement explanation is gone with the component that produced
    it. It is not simply that the points moved: the sentence it wrote was
    wrong. It told readers the published number was "a blend between two
    methods that do not agree" — but the run model's weight is now 0, so there
    is no blend, and the run model was found to carry no predictive information
    anyway (beta = +0.066 against its own market). Describing a disagreement
    with a noise source as a weakness in the analysis misleads.

    breakdown.model_agreement_gap is still recorded for diagnostics, and is the
    right place to look if the two reads ever need comparing again.
  */

  if ((breakdown.pitching_plan_points / LAB_MAX.pitching_plan) < LAB_WEAK_FRACTION) {
    if (pitcherEdgeTeam && pitcherEdgeTeam === pickTeam && isNum(pitcherGap)) {
      reasons.push({
        title: `Pitching plan: ${breakdown.pitching_plan_points}/${LAB_MAX.pitching_plan}`,
        detail: `${betterPitcher || pitcherEdgeTeam} rates ${pitcherGap} points better than ${worsePitcher || "the opposing starter"} on LyDia's pitcher score — `
          + `a real edge, but well short of the gap that earns full credit here.`
      });
    } else {
      reasons.push({
        title: `Pitching plan: ${breakdown.pitching_plan_points}/${LAB_MAX.pitching_plan}`,
        detail: `No meaningful starting-pitcher edge favors ${pickTeam} in this matchup.`
      });
    }
  }

  if ((breakdown.bullpen_points / LAB_MAX.bullpen) < LAB_WEAK_FRACTION) {
    reasons.push({
      title: `Bullpen: ${breakdown.bullpen_points}/${LAB_MAX.bullpen}`,
      detail: bullpenPickLabel && bullpenOppLabel && bullpenPickLabel === bullpenOppLabel
        ? `Both bullpens are rated ${String(bullpenPickLabel).toLowerCase()} — this is close to a wash, not an advantage either way.`
        : `LyDia does not see a meaningful bullpen edge for ${pickTeam} once assigned innings are weighted.`
    });
  }

  if ((breakdown.offense_points / LAB_MAX.offense) < LAB_WEAK_FRACTION) {
    reasons.push({
      title: `Offense: ${breakdown.offense_points}/${LAB_MAX.offense}`,
      detail: `${pickTeam}'s recent form does not clearly outpace ${oppTeam || "the opponent"}'s.`
    });
  }

  /*
    Data completeness no longer scores, but a genuinely incomplete rating is
    still worth disclosing — that is information about how much to trust the
    read, independent of how many points it is worth. Driven off the recorded
    check counts rather than a points total, and it only fires when something
    is actually missing, which in practice is almost never.
  */
  if (isNum(breakdown.completeness_checks_passed)
    && isNum(breakdown.completeness_checks_total)
    && breakdown.completeness_checks_passed < breakdown.completeness_checks_total) {
    reasons.push({
      title: "Incomplete inputs",
      detail: `${breakdown.completeness_checks_passed} of ${breakdown.completeness_checks_total} required inputs were available when this was rated, `
        + `so this read rests on less than the full picture.`
    });
  }

  return reasons;
}

/*
  2026-08-16, Lynold's explicit instruction: always show all four Lab Rating
  buckets on every matchup page, not just the weak ones. labRatingReasons()
  above is deliberately weakness-only (see its header comment) and stays that
  way for wherever it is still useful; this is a separate, always-on sibling
  used for the new un-gated "Why the setup score is what it is" section.
  Every bucket gets a sentence -- strong buckets get credit, not silence.

  2026-08-25: this function was part of the intended 2026-08-16 delivery but
  never actually made it into this file on the live branch -- generate-matchup-
  pages.js has been calling MatchupCopy.labRatingBreakdown() this whole time
  with no matching export here, crashing both publish-picks.yml and
  daily-recap.yml ("MatchupCopy.labRatingBreakdown is not a function"). Adding
  it now, using the exact same LAB_MAX already defined above (shared with
  labRatingReasons, so the two can never disagree about what a component's max
  is) and the exact argument shape generate-matchup-pages.js already passes.
*/
function labRatingBreakdown({
  breakdown, pickTeam, oppTeam, modelProb,
  pitcherEdgeTeam, pitcherGap, betterPitcher, worsePitcher,
  bullpenPickLabel, bullpenOppLabel
}) {
  if (!breakdown) return [];
  const strong = frac => frac >= LAB_WEAK_FRACTION;

  const convFrac = breakdown.conviction_points / LAB_MAX.conviction;
  const convDetail = strong(convFrac)
    ? `LyDia's win probability for ${pickTeam} (${isNum(modelProb) ? pct(modelProb) : "n/a"}) is well clear of a coin flip -- this is a real, stated lean, not a guess.`
    : (isNum(modelProb) && modelProb < CONVICTION_FLOOR
        ? `LyDia's own win probability for ${pickTeam} (${pct(modelProb)}) is close enough to a coin flip that the rating credits little or no conviction -- credit only starts above ${pct(CONVICTION_FLOOR, 0)}.`
        : `LyDia leans toward ${pickTeam}, but not strongly enough to earn full conviction credit.`);

  const planFrac = breakdown.pitching_plan_points / LAB_MAX.pitching_plan;
  const planDetail = (pitcherEdgeTeam && pitcherEdgeTeam === pickTeam && isNum(pitcherGap))
    ? `${betterPitcher || pitcherEdgeTeam} rates ${pitcherGap} points better than ${worsePitcher || "the opposing starter"} on LyDia's pitcher score.`
      + (strong(planFrac) ? " That is a real edge, and it earns most or all of the available credit here." : " A real edge, but well short of the gap that earns full credit here.")
    : `No meaningful starting-pitcher edge favors ${pickTeam} in this matchup.`;

  const bpFrac = breakdown.bullpen_points / LAB_MAX.bullpen;
  const bpDetail = strong(bpFrac)
    ? `${pickTeam}'s bullpen carries a real edge over ${oppTeam || "the opponent"}'s tonight.`
    : (bullpenPickLabel && bullpenOppLabel && bullpenPickLabel === bullpenOppLabel
        ? `Both bullpens are rated ${String(bullpenPickLabel).toLowerCase()} -- this is close to a wash, not an advantage either way.`
        : `LyDia does not see a meaningful bullpen edge for ${pickTeam} here.`);

  const offFrac = breakdown.offense_points / LAB_MAX.offense;
  const offDetail = strong(offFrac)
    ? `${pickTeam}'s recent offensive form clearly outpaces ${oppTeam || "the opponent"}'s over the tracked windows.`
    : `${pickTeam}'s recent form does not clearly outpace ${oppTeam || "the opponent"}'s.`;

  return [
    { title: `Conviction: ${breakdown.conviction_points}/${LAB_MAX.conviction}`, detail: convDetail },
    { title: `Pitching plan: ${breakdown.pitching_plan_points}/${LAB_MAX.pitching_plan}`, detail: planDetail },
    { title: `Bullpen: ${breakdown.bullpen_points}/${LAB_MAX.bullpen}`, detail: bpDetail },
    { title: `Offense: ${breakdown.offense_points}/${LAB_MAX.offense}`, detail: offDetail }
  ];
}

/*
  2026-08-16, Lynold's explicit instruction: a breakdown of the moneyline
  price itself -- team strength, the pitcher-score gap driving pitcher_boost,
  and the bullpen adjustment -- distinct from the Lab Rating breakdown above.
  Lab Rating grades LyDia's analysis quality; this explains the PRICE, which
  is a different question (see lab-rating-core.js's header: "It is NOT win
  probability and it is NOT a price judgement"). All values are read directly
  off fields generate-member-lab.js already writes to the brief -- nothing
  here recomputes the moneyline formula, so this cannot drift out of sync
  with what the model actually priced.

  2026-08-25: same situation as labRatingBreakdown above -- generate-matchup-
  pages.js already calls MatchupCopy.moneyLineReasons(), this export was
  simply never present in this file. Added now, matching the exact argument
  shape the caller passes.
*/
function moneyLineReasons({
  pickTeam, oppTeam, teamStrengthProbPick, pitcherGapSigned,
  bullpenLogOddsAdj, finalProbPick
}) {
  // 2026-08-16 fix: finalProbPick must be game.model_probability (the same,
  // post-calibration number shown as "Model Lean" elsewhere on the page).
  // It previously received game.legacy_strength_probability, a pre-calibration
  // number -- that mismatch is what showed two different probabilities for
  // the same game (e.g. 56.5% vs 62.9%). Do not pass legacy_strength_probability
  // here again.
  const reasons = [];

  if (isNum(teamStrengthProbPick)) {
    reasons.push({
      title: `Team strength: ${pct(teamStrengthProbPick)}`,
      detail: `Before any pitcher or bullpen adjustment, LyDia's team-strength model alone makes ${pickTeam} ${pct(teamStrengthProbPick)} to win. Everything below moves the price from this starting point.`
    });
  }

  if (isNum(pitcherGapSigned)) {
    const favored = pitcherGapSigned > 0 ? pickTeam : (pitcherGapSigned < 0 ? oppTeam : null);
    reasons.push({
      title: `Pitcher score gap: ${Math.abs(pitcherGapSigned)} points`,
      detail: favored
        ? `The pitcher-score gap favors ${favored} by ${Math.abs(pitcherGapSigned)} points. This is the biggest single mover of the price -- a large gap moves it a lot, a small gap barely moves it.`
        : `The two starters grade essentially even on pitcher score -- this term does little to move the price either way.`
    });
  }

  if (isNum(bullpenLogOddsAdj) && Math.abs(bullpenLogOddsAdj) > 0.001) {
    const favored = bullpenLogOddsAdj > 0 ? pickTeam : oppTeam;
    reasons.push({
      title: `Bullpen adjustment: ${bullpenLogOddsAdj > 0 ? "+" : ""}${bullpenLogOddsAdj}`,
      detail: `The bullpen-fatigue gap between the two pens nudges the price toward ${favored}. This moves the price less than the starting pitchers do, since a starter covers more of the game than the bullpen.`
    });
  }

  if (isNum(teamStrengthProbPick) && isNum(finalProbPick)) {
    reasons.push({
      title: `Net effect: ${pct(teamStrengthProbPick)} -> ${pct(finalProbPick)}`,
      detail: `Team strength alone had ${pickTeam} at ${pct(teamStrengthProbPick)}. After the pitcher and bullpen terms, the price is ${pct(finalProbPick)} -- the same number shown as Model Lean above.`
    });
  }

  return reasons;
}

/*
  2026-08-26, Lynold's explicit instruction -- full rewrite: the old
  coachConsistencyNotes() checked a pick against 4 fixed, pre-chosen splits
  (win-probability median, 3 Lab Rating tiers, pitcher-edge agreement,
  bullpen caution) over ~22 current-model official picks. That was never
  "look at all the games we have an analysis for... look at the
  correlations" -- it was 4 numbers someone picked in advance, over a small
  slice of the real history. Replaced entirely by coachEvidenceNotes(),
  which compares today's own game numbers against
  scripts/lib/coach-correlation-core.js's real correlation findings over
  the FULL analyzed history (every tier, every date -- currently 300+
  games, not 22). See that module's evidenceForGame() for the exact method:
  it only ever reports a pattern whose correlation clears a minimum
  strength floor, so a weak/noisy input silently produces no note rather
  than a note dressed up to look meaningful.
*/
/*
  gameFeatures: this game's own pick-relative numbers, built by
  generate-matchup-pages.js the same way coach-correlation-core.js's
  loadHistoricalRows() builds them from the historical ledgers (same field
  names, same sign convention -- see that module's header for the proof).
  coachHistory: data/learning-summary.json's coach.history (null until
  generate-coach.js has enough graded games -- see its own MIN_HISTORY_N).
  Missing input on either side just means fewer (or zero) notes, never a
  guess.
*/
function coachEvidenceNotes({ gameFeatures, coachHistory }) {
  if (!gameFeatures || !coachHistory || !coachHistory.ready || !coachHistory.correlations) return [];
  return Correlation.evidenceForGame(gameFeatures, coachHistory.correlations, { topK: 3 });
}

module.exports = {
  marketMispricingCase,
  bullpenCase,
  pitcherEdgeSentence,
  rankPitcherDrivers,
  recentFormSentence,
  labRatingReasons,
  labRatingBreakdown,
  moneyLineReasons,
  coachEvidenceNotes,
  LEAN_MIN
};
