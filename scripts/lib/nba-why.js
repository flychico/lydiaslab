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

function why(g, opts = {}) {
  const L = g.leo || {}, P = L.parts || {}, mk = g.market || {};
  const lostCoef = Math.abs(opts.lostCoef ?? 0.2209), leanPts = opts.leanPts ?? 4;
  const H = g.home, A = g.away;
  const toward = v => (v > 0 ? H : A);
  const out = { leo: by(g, L.home_margin), market: mk.home_spread == null ? null : by(g, -mk.home_spread), drivers: [], swing: [] };

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
    out.lean = { status: "lean", text: `Lean ${L.lean.team} ${L.lean.line > 0 ? "+" : ""}${L.lean.line}: Leo is ${f1(edge)} pts off DraftKings, past the ${leanPts} pt bar. A tracked test, not a bet.` };
  } else {
    out.lean = { status: "none", text: `No lean. Leo is ${f1(edge)} pts off DraftKings, under the ${leanPts} pt bar, so this game is not a call.` };
  }

  const top = out.drivers.slice(0, 3).map(d => d.short).join(", ");
  out.summary = top ? `Why: ${top}.` : "";
  return out;
}

const api = { why, by };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else if (typeof window !== "undefined") window.NBA_WHY = api;
})();
