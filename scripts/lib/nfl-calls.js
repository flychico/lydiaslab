/**
 * Leo NFL calls: one rule book for every page, email and the grader
 * (DEC-20261102-01). Each game gets exactly three verdicts, each a call or
 * PASS, and only calls are graded:
 *
 *   Moneyline  a team Leo gives MORE than 60%, priced better than -230.
 *              -230 or more expensive is a PASS (Lynold: too much at stake).
 *   Spread     Leo's margin 1.0+ point off the line, on the side his margin
 *              favours. PASS when the margin model and the win-chance model
 *              pick different winners (they are separate models; when they
 *              disagree neither is trusted).
 *   Total      Leo's total 1.5+ points off the line: Over or Under. PASS past
 *              7 points (the model is wrong, not the market).
 *
 * Inputs are the frozen pre-kickoff read (prediction-history.csv or a
 * picks-<date>.json row): away, home, pick, model_prob, price, exp_margin
 * (or proj_spread), spread_line (home side, positive = home favoured),
 * proj_total, total_line. Nothing here reads the line into a projection;
 * the line only decides whether Leo's own number is far enough from it.
 *
 * In force from the 2026-11-05 slate. Earlier slates keep the rules they
 * were graded under.
 *
 * Pure. Works in Node and the browser (window.NFL_CALLS).
 */
(function () {
'use strict';

const RULES = {
  FROM: "2026-11-05",
  ML_MIN_PROB: 0.60,       // strictly above
  ML_PRICE_LIMIT: -230,    // -230 and more expensive: PASS
  SPREAD_FLOOR: 1.0,
  TOTAL_FLOOR: 1.5,
  TOTAL_CAP: 7.0
};

const num = v => { const x = typeof v === "number" ? v : parseFloat(v); return Number.isFinite(x) ? x : null; };
const r1 = x => Math.round(x * 10) / 10;
const am = v => v == null ? "" : (v > 0 ? "+" : "") + v;
const teamLine = (team, home, homeLine) => {
  // homeLine: home favoured by homeLine. The home team's number is -homeLine.
  const v = team === home ? -homeLine : homeLine;
  return v === 0 ? "PK" : (v > 0 ? "+" : "") + r1(v);
};

function calls(g) {
  const away = g.away, home = g.home;
  const prob = num(g.model_prob), price = num(g.price);
  const margin = num(g.exp_margin != null && g.exp_margin !== "" ? g.exp_margin : g.proj_spread);
  const sLine = num(g.spread_line), proj = num(g.proj_total), tLine = num(g.total_line);
  const out = {};

  // ---- moneyline ----------------------------------------------------------
  if (prob == null || !g.pick) out.ml = { call: null, pass: "No read yet" };
  else if (!(prob > RULES.ML_MIN_PROB)) out.ml = { call: null, team: g.pick, prob, price, pass: `${g.pick} ${Math.round(prob * 100)}%, under 60%`, short: "under 60%" };
  else if (price == null) out.ml = { call: null, team: g.pick, prob, price, pass: `${g.pick} ${Math.round(prob * 100)}%, no price yet`, short: "no price yet" };
  else if (price <= RULES.ML_PRICE_LIMIT) out.ml = { call: null, team: g.pick, prob, price, pass: `${g.pick} ${am(price)}, too expensive (limit -230)`, short: `${g.pick} ${am(price)}, past -230` };
  else out.ml = { call: g.pick, team: g.pick, prob, price, label: `${g.pick} ${am(price)}` };

  // ---- spread ---------------------------------------------------------------
  if (margin == null || sLine == null) out.spread = { call: null, pass: "No line yet" };
  else {
    const gap = margin - sLine;
    const side = gap > 0 ? home : away;
    const marginWinner = margin > 0 ? home : margin < 0 ? away : null;
    if (Math.abs(gap) < RULES.SPREAD_FLOOR) out.spread = { call: null, gap: r1(gap), pass: `Leo within ${RULES.SPREAD_FLOOR} point of the line`, short: "too close to the line" };
    else if (g.pick && marginWinner && marginWinner !== g.pick) out.spread = { call: null, gap: r1(gap), pass: `Leo's models disagree on the winner`, short: "models disagree" };
    else out.spread = { call: side, gap: r1(gap), line: teamLine(side, home, sLine), label: `${side} ${teamLine(side, home, sLine)}` };
  }

  // ---- total ----------------------------------------------------------------
  if (proj == null || tLine == null) out.total = { call: null, pass: "No line yet" };
  else {
    const gap = proj - tLine;
    if (Math.abs(gap) < RULES.TOTAL_FLOOR) out.total = { call: null, gap: r1(gap), pass: `Leo within ${RULES.TOTAL_FLOOR} points of the line`, short: "too close to the line" };
    else if (Math.abs(gap) > RULES.TOTAL_CAP) out.total = { call: null, gap: r1(gap), pass: `Leo ${r1(Math.abs(gap))} off the line, too far to trust`, short: "too far off to trust" };
    else { const side = gap > 0 ? "Over" : "Under"; out.total = { call: side, gap: r1(gap), line: tLine, label: `${side} ${tLine}` }; }
  }
  out.count = [out.ml, out.spread, out.total].filter(c => c.call).length;
  return out;
}

/** Grade one call against the final. Returns "W", "L", "P" or "". */
function grade(c, g, final) {
  const hs = num(final.home_score), as = num(final.away_score);
  if (hs == null || as == null) return "";
  if (c === "ml") { const x = calls(g).ml; if (!x.call) return ""; return hs === as ? "P" : ((hs > as ? g.home : g.away) === x.call ? "W" : "L"); }
  if (c === "spread") { const x = calls(g).spread; if (!x.call) return ""; const m = hs - as, l = num(g.spread_line); return m === l ? "P" : ((x.call === g.home) === (m > l) ? "W" : "L"); }
  if (c === "total") { const x = calls(g).total; if (!x.call) return ""; const t = hs + as, l = num(g.total_line); return t === l ? "P" : ((t > l) === (x.call === "Over") ? "W" : "L"); }
  return "";
}

const api = { RULES, calls, grade };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else if (typeof window !== "undefined") window.NFL_CALLS = api;
})();
