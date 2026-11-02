/**
 * Leo NBA: Leo's read in plain words (DEC-20261031-10).
 *
 * One copy, used by the nightly card (/nba/scoreboard/, in the browser) and
 * the matchup pages (scripts/render-nba-matchup-pages.js), so both say the
 * same thing. Reads only what the slate already froze: leo.home_margin,
 * leo.parts (each input's points on the home margin), leo.missing,
 * leo.edge_pts, leo.lean and the DraftKings spread. Nothing is recomputed.
 *
 *   why(g, { lostCoef, leanPts }) -> {
 *     leo, market,        "POR by 4.5", "POR by 7.5"
 *     compare             plain words: same winner or not, and Leo's side of the spread"
 *     drivers: [{ key, pts, team, text }],   biggest first, |pts| >= 0.5
 *     lean: { status: "lean" | "none" | "no_line", text },
 *     swing: [text],      what a day-to-day player would change
 *     summary             one sentence for the card
 *   }
 *
 * lostCoef is the model's points per unit of missing value (data/nba/model.json
 * coef.lost_d, about -0.22). Pass it when you have it; the default matches the
 * 2026-10-31 fit.
 *
 * Pure. No network, filesystem or clock reads.
 */
(function () {
'use strict';

const r1 = x => Math.round(x * 10) / 10;
const f1 = x => (Math.round(Math.abs(x) * 10) / 10).toFixed(1);
const half = x => Math.round(Math.abs(x) * 2) / 2;

function by(g, homeMargin) {
  if (homeMargin == null || !Number.isFinite(+homeMargin)) return null;
  const m = +homeMargin;
  if (half(m) === 0) return "a pick'em";
  return `${m > 0 ? g.home : g.away} by ${half(m)}`;
}

/**
 * Leo's number as shown to readers (DEC-20261102-03): on the .5 grid the
 * books use, rounded TOWARD the DraftKings spread (Leo ATL by 9.8 against
 * ATL -5.5 shows ATL by 9.5). Because the line is always on that grid, the
 * gap readers see is never bigger than the real one, and it is 4 or more
 * exactly when the game is a lean. Display only: grading and the lean rule
 * use Leo's unrounded margin. Returns the HOME spread (negative = home
 * favoured), or null.
 */
function leoLine(g) {
  const L = g.leo || {}, mk = g.market || {};
  if (L.home_margin == null || !Number.isFinite(+L.home_margin)) return L.home_spread ?? null;
  const s = -L.home_margin, m = mk.home_spread;
  const v = m == null ? Math.round(s * 2) / 2 : s > m ? Math.floor(s * 2) / 2 : Math.ceil(s * 2) / 2;
  return v === 0 ? 0 : v;   // no -0
}
/**
 * Projected score that matches the shown spread (DEC-20261102-31): the
 * winning margin is Leo's shown number rounded to a whole point (scores are
 * whole numbers), split around the projected total. Display only.
 * -> { home, away, total } or null
 */
function projScore(g) {
  const P = (g.leo || {}).projected, v = leoLine(g);
  if (!P || P.total == null || v == null) return P || null;
  // Whole-point margin: a .5 spread uses whichever neighbour keeps the projected total.
  const a = Math.abs(v), lo = Math.floor(a), hi = Math.ceil(a);
  const w = lo === hi ? a : ((P.total + lo) % 2 === 0 ? lo : hi);
  const d = Math.sign(-v) * w;                             // home margin, whole points
  const home = Math.round((P.total + d) / 2), away = home - d;
  return { home, away, total: home + away };
}

/** Points between Leo's shown number and DraftKings, or null. */
function gapShown(g) {
  const v = leoLine(g), m = (g.market || {}).home_spread;
  return v == null || m == null ? null : Math.abs(v - m);
}

/** One sentence: do Leo and DraftKings have the same winner, by how much, and Leo's side. */
function compare(g, leanPts = 4) {
  const L = g.leo || {}, mk = g.market || {};
  const v = leoLine(g);
  if (v == null) return "";
  const leoTxt = v === 0 ? "a pick'em" : `${v < 0 ? g.home : g.away} by ${Math.abs(v)}`;
  if (mk.home_spread == null) return `Leo has ${leoTxt}. No DraftKings line yet.`;
  const m = mk.home_spread, gap = Math.abs(v - m);
  const leoWin = v < 0 ? g.home : v > 0 ? g.away : null, mkWin = m < 0 ? g.home : m > 0 ? g.away : null;
  const sgn = x => (x > 0 ? "+" : "") + x;
  const pts = x => `${x} ${x === 1 ? "pt" : "pts"}`;
  const side = L.lean ? `${L.lean.team} ${sgn(L.lean.line)}` : null;
  let head;
  if (leoWin && leoWin === mkWin) head = `Both have ${leoWin} winning: Leo by ${Math.abs(v)}, DraftKings by ${Math.abs(m)}.`;
  else if (!leoWin && !mkWin) head = `Leo and DraftKings both call it a pick'em.`;
  else if (!leoWin) head = `Leo calls it even; DraftKings has ${mkWin} by ${Math.abs(m)}.`;
  else if (!mkWin) head = `Leo has ${leoWin} by ${Math.abs(v)}; DraftKings calls it a pick'em.`;
  else head = `Different winners: Leo has ${leoWin} by ${Math.abs(v)}; DraftKings has ${mkWin} by ${Math.abs(m)}.`;
  return side
    ? `${head} They are ${pts(gap)} apart, so Leo's side of the spread is ${side}. A tracked test, not a bet.`
    : gap === 0 ? `${head} Same number, so no lean.`
    : `${head} They are ${pts(gap)} apart, under the ${leanPts} pt bar, so no lean.`;
}

function why(g, opts = {}) {
  const L = g.leo || {}, P = L.parts || {}, mk = g.market || {};
  const lostCoef = Math.abs(opts.lostCoef ?? 0.2209), leanPts = opts.leanPts ?? 4;
  const H = g.home, A = g.away;
  const toward = v => (v > 0 ? H : A);
  const out = { leo: leoLine(g) == null ? null : by(g, -leoLine(g)), compare: compare(g, opts.leanPts ?? 4), market: mk.home_spread == null ? null : by(g, -mk.home_spread), drivers: [], swing: [] };

  const add = (key, pts, text, short) => { if (pts != null && Math.abs(pts) >= 0.5) out.drivers.push({ key, pts: r1(pts), team: toward(pts), text, short }); };
  if (P.ratings != null) {
    const better = P.ratings > 0 ? H : A, worse = P.ratings > 0 ? A : H;
    add("ratings", P.ratings, `Team strength: ${better} rates ${f1(P.ratings)} pts better than ${worse} on results so far`, `${better} the stronger team by ${f1(P.ratings)}`);
  }
  if (P.home_court != null) add("home_court", P.home_court, `Home court: worth ${f1(P.home_court)} pts to ${H}`, `${H} home court +${f1(P.home_court)}`);
  if (P.back_to_back) {
    const tired = L.back_to_back && L.back_to_back.home && !L.back_to_back.away ? H
      : L.back_to_back && L.back_to_back.away && !L.back_to_back.home ? A : null;
    add("back_to_back", P.back_to_back, tired ? `Back to back: ${tired} played last night, ${f1(P.back_to_back)} pts toward ${toward(P.back_to_back)}` : `Back to back: ${f1(P.back_to_back)} pts toward ${toward(P.back_to_back)}`, tired ? `${tired} on a back to back (+${f1(P.back_to_back)} ${toward(P.back_to_back)})` : `back to back (+${f1(P.back_to_back)} ${toward(P.back_to_back)})`);
  }
  if (P.rest) add("rest", P.rest, `Rest: ${f1(P.rest)} pts toward ${toward(P.rest)}`, `rest (+${f1(P.rest)} ${toward(P.rest)})`);
  if (P.missing_players) {
    const hurt = P.missing_players > 0 ? A : H;
    add("missing_players", P.missing_players, `Injuries: ${hurt} is missing more, ${f1(P.missing_players)} pts toward ${toward(P.missing_players)}`, `${hurt} missing more players (+${f1(P.missing_players)} ${toward(P.missing_players)})`);
  }
  out.drivers.sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts));

  // What an uncertain player would do to the number, both ways.
  for (const side of ["home", "away"]) {
    for (const p of ((L.missing || {})[side] || [])) {
      const w = p.weight ?? (p.status === "out" ? 1 : null);
      if (w == null || w >= 1 || !p.value) continue;
      const sits = r1(p.value * (1 - w) * lostCoef), plays = r1(p.value * w * lostCoef);
      if (sits < 0.3 && plays < 0.3) continue;
      const team = g[side], other = side === "home" ? A : H;
      out.swing.push(`${p.name} (${team}, ${p.status === "day-to-day" ? "day to day" : p.status}) is counted at ${Math.round(w * 100)}%. If he sits, Leo's number moves ${sits.toFixed(1)} toward ${other}; if he plays, ${plays.toFixed(1)} toward ${team}.`);
    }
  }

  const edge = L.edge_pts;
  if (mk.home_spread == null || edge == null) {
    out.lean = { status: "no_line", text: "No DraftKings line yet, so no comparison." };
  } else if (L.lean) {
    out.lean = { status: "lean", text: out.compare };
  } else {
    out.lean = { status: "none", text: out.compare };
  }

  const top = out.drivers.slice(0, 3).map(d => d.short).join(", ");
  out.summary = top ? `Why: ${top}.` : "";
  return out;
}

const api = { why, by, leoLine, gapShown, compare, projScore };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else if (typeof window !== "undefined") window.NBA_WHY = api;
})();
