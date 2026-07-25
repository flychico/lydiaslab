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

"use strict";

// Below this, LyDia has no directional lean worth describing as conviction.
const LEAN_MIN = 0.52;
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
      + `LyDia rates this side ${signedPct(edge)} better than the price implies, and that gap is why the game is on the board.`
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

  const pickEra = pickPen && isNum(pickPen.era3) ? pickPen.era3 : null;
  const oppEra = oppPen && isNum(oppPen.era3) ? oppPen.era3 : null;

  // Team names are plural and often already end in "s", so the copy is written
  // to avoid possessives entirely rather than emit "the Giants's".
  let evidence;
  if (isNum(pickEra) && isNum(oppEra)) {
    evidence = `${oppTeam} relievers have a ${two(oppEra)} ERA over the last three days; ${pickTeam} relievers have a ${two(pickEra)}.`;
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

module.exports = {
  marketMispricingCase,
  bullpenCase,
  pitcherEdgeSentence,
  rankPitcherDrivers,
  recentFormSentence,
  LEAN_MIN
};
