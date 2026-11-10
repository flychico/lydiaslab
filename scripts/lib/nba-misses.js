/**
 * Leo NBA: why a game was missed, and which games were upsets
 * (HO-0031, business/RESULTS_DESIGN.md sections 2 and 3, DEC-20261110-30).
 *
 * Data based only. Everything here is read from files frozen before tip
 * (the card, the read of record in the ledger) or saved at grading (final
 * score, closing line, box score). Nothing feeds Leo's numbers.
 *
 * A game is a MISS when any of these is true:
 *   pick_lost     a Leo Pick lost (picks count from nba-picks TRACK_FROM)
 *   lean_lost     a lean lost
 *   wrong_winner  the team Leo gave 50%+ lost
 *   margin        Leo's margin missed the final margin by 10+ points
 *
 * One reason per miss, first matching rule wins:
 *   1 injury_input  a player Leo counted as out or day to day played, or a
 *                   regular (nba-model regulars: 10+ minutes a game, 3+ games)
 *                   sat without being on the report Leo read, or a player listed
 *                   out was left out of Leo's count because he had played
 *                   fewer than 3 games this season (NBA-H17). Counted only
 *                   when fixing it moves Leo's margin 1+ point AND toward the
 *                   result. cost_pts = that move (value x the model's lost_d).
 *   2 market_knew   the DraftKings line moved 1.5+ points away from Leo's
 *                   number between Leo's first read of the day and the close,
 *                   and the close was nearer the result than the first line.
 *   3 overtime      the game went to overtime (level after regulation) and
 *                   Leo's side was fine at that point: a wrong winner or lost
 *                   pick, a lost lean on the team getting points, or a margin
 *                   miss when Leo's own margin was under 10.
 *   4 blowout       decided by 20+ and the line missed about as badly
 *                   (line_miss >= 0.8 x leo_miss).
 *   5 variance      the line missed by about as much as Leo, within 3 points,
 *                   or more (line_miss >= leo_miss - 3; the band shared with
 *                   NFL and MLB, HO-0038), or no line was saved to compare.
 *   6 model_error   everything else: the line was closer than Leo by more than 3.
 *                   cost_pts = Leo's miss minus the line's miss.
 *
 * Upset: the team with the shorter DraftKings moneyline at the read of
 * record lost. Stored as { fav, fav_prob_market, leo_prob_winner, leo_saw_it }.
 */
(function () {
'use strict';

const MARGIN_MISS = 10, INJ_MIN_PTS = 1, MKT_MOVE = 1.5, BLOWOUT = 20, CLEAR = 3;
const LABEL = { injury_input: "Injury input", market_knew: "Market knew", overtime: "Overtime", blowout: "Blowout", variance: "Variance", model_error: "Model error" };
const ORDER = ["injury_input", "market_knew", "overtime", "blowout", "variance", "model_error"];
const num = v => v === "" || v == null || !Number.isFinite(+v) ? null : +v;
const r1 = v => Math.round(v * 10) / 10;
const sg = v => v === 0 ? "pick'em" : (v > 0 ? "+" : "") + v;

/** Did the game go to overtime? A regulation game has 240 team minutes; overtime adds 25 each. */
function wentToOvertime(box) {
  if (!box || !box.players) return false;
  const t = {};
  for (const p of box.players) t[p.team] = (t[p.team] || 0) + (p.minutes || 0);
  return Object.values(t).some(m => m >= 252);
}

/**
 * injury check for one game.
 *  row      ledger row; card  the card game (leo.missing); box  the saved box score
 *  regs     nba-model regulars as of the game date (or null when not available)
 *  lostCoef model.json coef.lost_d; nick(code) -> team nickname
 * -> { delta (points added to Leo's home margin), items: [sentence parts] }
 */
function injuryCheck(row, card, box, regs, lostCoef, nick, uncounted) {
  if (!box || !box.players || !card || !card.leo) return null;
  const played = new Map(box.players.map(p => [p.id, p])), items = [];
  let dHome = 0, dAway = 0;
  for (const side of ["home", "away"]) {
    const team = row[side], listed = (card.leo.missing && card.leo.missing[side]) || [], listedIds = new Set(listed.map(p => String(p.id)));
    for (const p of listed) {
      const b = played.get(String(p.id));
      if (b && !b.dnp && b.minutes > 0 && p.value * p.weight > 0) {
        const v = p.value * p.weight; if (side === "home") dHome -= v; else dAway -= v;
        items.push({ v, eff: lostCoef * (side === "home" ? -v : v), text: `${p.name} (${nick(team)}) was counted as ${p.weight >= 1 ? "out" : "day to day"} but played ${Math.round(b.minutes)} minutes` });
      }
    }
    // Listed out on the report Leo read, but not counted because he had played fewer than
    // 3 games this season (NBA-H17). ctx.uncounted: [{ name, team, value }] from this season's games.
    const listedNames = new Set(listed.map(p => p.name)), ctxInj = (card.context && card.context[side] && card.context[side].injuries) || [];
    for (const i of ctxInj) {
      if (i.status !== "out" || listedNames.has(i.name)) continue;
      const u = (uncounted || []).find(x => x.team === team && x.name === i.name);
      const b = u && [...played.values()].find(x => x.team === team && x.name === i.name);
      if (!u || !(u.value > 0) || (b && !b.dnp && b.minutes > 0)) continue;
      if (side === "home") dHome += u.value; else dAway += u.value;
      items.push({ v: u.value, eff: lostCoef * (side === "home" ? u.value : -u.value), text: `${i.name} (${nick(team)}) was out, but Leo did not count him because he had played fewer than 3 games this season` });
    }
    // A regular who sat without being on the report. Only when the box score covers the team.
    if (regs && box.players.some(p => p.team === team)) for (const r of regs) {
      if (r.team !== team || listedIds.has(String(r.id)) || !(r.value > 0)) continue;
      const b = played.get(String(r.id));
      if (b && b.team === team && (b.dnp || !(b.minutes > 0))) {
        if (side === "home") dHome += r.value; else dAway += r.value;
        items.push({ v: r.value, eff: lostCoef * (side === "home" ? r.value : -r.value), text: `${r.name} (${nick(team)}) sat without being on the injury report Leo read` });
      }
    }
  }
  if (!items.length) return null;
  return { delta: lostCoef * (dHome - dAway), items: items.sort((a, b) => b.v - a.v) };
}

/**
 * classify(row, ctx) -> { kinds, reason, label, evidence, cost_pts, overtime, upset } (reason null when not a miss)
 * ctx: { card, box, regs, lostCoef, nick, trackFrom }
 */
function classify(row, ctx) {
  const nick = ctx.nick || (c => c);
  const margin = +row.margin, m = +row.leo_home_margin, leoMiss = +row.leo_miss, lineMiss = num(row.line_miss);
  const ot = wentToOvertime(ctx.box);
  const kinds = [];
  if (row.pick_result === "loss" && row.date >= (ctx.trackFrom || "")) kinds.push("pick_lost");
  if (row.lean_result === "loss") kinds.push("lean_lost");
  if (+row.leo_winner_correct === 0) kinds.push("wrong_winner");
  if (leoMiss >= MARGIN_MISS) kinds.push("margin");

  // Upset: the moneyline favourite at the read of record lost.
  let upset = null;
  const hml = num(row.home_ml), aml = num(row.away_ml), mp = num(row.mkt_p_home);
  if (hml != null && aml != null && hml !== aml && mp != null) {
    const favSide = hml < aml ? "home" : "away", winSide = margin > 0 ? "home" : "away";
    if (favSide !== winSide) {
      const ph = +row.leo_p_home, pw = winSide === "home" ? ph : 1 - ph;
      upset = { fav: row[favSide], winner: row[winSide], fav_prob_market: +(favSide === "home" ? mp : 1 - mp).toFixed(3), leo_prob_winner: +pw.toFixed(3), leo_saw_it: pw >= 0.5 };
    }
  }
  const out = { kinds, reason: null, label: "", evidence: "", cost_pts: null, overtime: ot, upset };
  if (!kinds.length) return out;
  const set = (reason, evidence, cost) => Object.assign(out, { reason, label: LABEL[reason], evidence, cost_pts: cost == null ? null : r1(cost) });
  const side = d => nick(d > 0 ? row.home : row.away);

  // 1 injury input
  const inj = injuryCheck(row, ctx.card, ctx.box, ctx.regs, ctx.lostCoef, nick, ctx.uncounted);
  if (inj && Math.abs(inj.delta) >= INJ_MIN_PTS && Math.abs(m + inj.delta - margin) < Math.abs(m - margin)) {
    const same = inj.items.filter(i => i.eff * inj.delta > 0);
    const names = same.slice(0, 2).map(i => i.text).join(", and ") + (same.length > 2 ? `, plus ${same.length - 2} more` : "");
    return set("injury_input", `${names}. With that corrected Leo moves ${Math.abs(inj.delta).toFixed(1)} points toward the ${side(inj.delta)}.`, Math.abs(inj.delta));
  }
  // 2 market knew
  const open = num(row.open_home_spread), close = num(row.close_home_spread);
  if (open != null && close != null) {
    const away = Math.abs(-close - m) - Math.abs(-open - m);
    if (away >= MKT_MOVE && Math.abs(-close - margin) < Math.abs(-open - margin))
      return set("market_knew", `The DraftKings line moved ${away.toFixed(1)} points away from Leo before tip: the ${nick(row.home)} were ${sg(open)} at Leo's first read and ${sg(close)} at the close.`, away);
  }
  // 3 overtime
  if (ot) {
    const leanOnDog = kinds.includes("lean_lost") && num(row.lean_line) > 0;
    const fine = (kinds.includes("wrong_winner") || kinds.includes("pick_lost") || leanOnDog || (kinds.length === 1 && kinds[0] === "margin" && Math.abs(m) < MARGIN_MISS))
      && !(kinds.includes("lean_lost") && !leanOnDog);
    if (fine) return set("overtime", "The game went to overtime, so it was level after regulation and settled in the extra period.", null);
  }
  // 4 blowout, 5 variance, 6 model error
  const am = Math.abs(margin);
  if (lineMiss == null) {
    if (am >= BLOWOUT) return set("blowout", `Decided by ${am}. No DraftKings line was saved at Leo's read to compare against; Leo missed the margin by ${leoMiss.toFixed(1)}.`, null);
    return set("variance", `No DraftKings line was saved at Leo's read, so there is nothing to show the market was closer. Leo missed the margin by ${leoMiss.toFixed(1)}.`, null);
  }
  const cmp = `The DraftKings line missed the margin by ${lineMiss.toFixed(1)}, Leo by ${leoMiss.toFixed(1)}.`;
  if (am >= BLOWOUT && lineMiss >= 0.8 * leoMiss) return set("blowout", `Decided by ${am}. ${cmp}`, null);
  if (lineMiss >= leoMiss - CLEAR) return set("variance", `${cmp} The line was not clearly closer.`, null);
  return set("model_error", `${cmp} The line was ${(leoMiss - lineMiss).toFixed(1)} points closer.`, leoMiss - lineMiss);
}

const api = { classify, wentToOvertime, injuryCheck, LABEL, ORDER, MARGIN_MISS };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else if (typeof window !== "undefined") window.NBA_MISSES = api;
})();
