/**
 * Leo NBA picks and units (DEC-20261102-30). One rule book for the slate,
 * the grader, the pages and the email, in Node and the browser.
 *
 * Leo Pick: the team Leo gives 60% or more to win, when the DraftKings
 * moneyline on that team is better than -230 (Lynold's limit, same as NFL;
 * -230 or dearer is a PASS). Graded on the moneyline at the DraftKings price
 * stored at Leo's read of record (the last capture before tip): 1 unit, a win
 * pays 100/|price| for a favourite or price/100 for an underdog, a loss -1.
 *
 * Leans (Leo 4+ points off the spread) ENDED after the 2026-11-10 games
 * (LEANS_UNTIL; Lynold, 2026-11-11: 5-7 and -2.44 units, and past seasons
 * show a gap from the spread covers about 51 to 52%). Leans already on the
 * record stay there as history. They were graded in units too, at the
 * DraftKings spread price on Leo's side at the read of record; -110 is
 * assumed (price_source "assumed") where no spread price was stored.
 *
 * Backtest when the rule was set (scripts/train-nba.js walk-forward, 1,055
 * games 2025-26 + 2026-27, injury input = regulars who sat the previous
 * game): 60%+ priced better than -230 went 118-76 (60.8%), +3.4 units; all
 * 60%+ with no limit 531-172 (75.5%), -3.5 units. An early read: no edge yet.
 *
 * The line is never an input to Leo's numbers; the price only decides
 * whether a 60% call is tracked and how it is paid.
 */
(function () {
'use strict';

const PICK_P = 0.60, PRICE_LIMIT = -230, TRACK_FROM = "2026-11-02", LEANS_UNTIL = "2026-11-10";
/** Leans were recorded for games through LEANS_UNTIL and not after. */
const leansOn = date => !!date && String(date).slice(0, 10) <= LEANS_UNTIL;
const num = v => v === "" || v == null || !Number.isFinite(+v) || +v === 0 ? null : +v;

/** Units for one 1-unit bet: result "win" | "loss" | "push", American price. */
function payout(price) { return price < 0 ? 100 / -price : price / 100; }
function units(result, price) {
  if (price == null) return null;
  return result === "win" ? payout(price) : result === "loss" ? -1 : result === "push" ? 0 : null;
}

/**
 * pick({ p_home, home_ml, away_ml, home, away })
 *   -> null when no side reaches 60%
 *   -> { side, team, p, price, ok, why }   ok = a tracked Leo Pick
 */
function pick(x) {
  const ph = num(x.p_home);
  if (ph == null) return null;
  const side = ph >= 0.5 ? "home" : "away", p = side === "home" ? ph : 1 - ph;
  // Just under the bar (rounds to 60% on the card): say so, with the exact chance (DEC-20261102-31).
  if (p < PICK_P) return Math.round(p * 100) >= PICK_P * 100
    ? { side, team: x[side], p, price: num(side === "home" ? x.home_ml : x.away_ml), ok: false, why: "just under 60%", under: true } : null;
  const price = num(side === "home" ? x.home_ml : x.away_ml), team = x[side];
  if (price == null) return { side, team, p, price: null, ok: false, why: "no moneyline yet" };
  if (price <= PRICE_LIMIT) return { side, team, p, price, ok: false, why: `priced ${price}, -230 or dearer` };
  return { side, team, p, price, ok: true, why: "" };
}

/** From a card game (g.leo, g.market). */
function pickForGame(g) {
  const L = g.leo || {}, mk = g.market || {};
  return pick({ p_home: L.p_home, home_ml: mk.home_ml, away_ml: mk.away_ml, home: g.home, away: g.away });
}

const fmtPrice = p => p == null ? "" : (p > 0 ? "+" : "") + p;

/** Card words: { badge, line } or null. Uses the pick frozen on the card, else works it out. */
function pickText(g) {
  const pk = (g.leo && g.leo.pick !== undefined) ? g.leo.pick : pickForGame(g);
  if (!pk) return null;
  const pct = Math.round(pk.p * 100) + "%";
  if (pk.under || pk.p < PICK_P) return { ok: false, badge: "", line: `No pick: Leo has ${pk.team} ${(pk.p * 100).toFixed(1)}%, just under the 60% bar.` };
  if (pk.ok) return { ok: true, badge: `Pick ${pk.team} ${fmtPrice(pk.price)}`,
    line: `Leo Pick: ${pk.team} to win at ${fmtPrice(pk.price)} (Leo ${pct}). Tracked in units, not a bet.` };
  return { ok: false, badge: "", line: `No pick: Leo has ${pk.team} ${pct}, but ${pk.price == null ? "there is no moneyline yet" : `the price is ${fmtPrice(pk.price)}, -230 or dearer`}.` };
}

/**
 * The Call box on cards and pages (replaces the Gap box, DEC-20261102-31):
 * { value, sub, on } - what Leo is tracking on this game, or why nothing.
 */
function callBox(g) {
  const L = g.leo || {}, pk = (L.pick !== undefined) ? L.pick : pickForGame(g);
  const sg = v => (v > 0 ? "+" : "") + v;
  if (pk && pk.ok) return { on: true, value: `${pk.team} ${fmtPrice(pk.price)}`, sub: "Leo Pick, to win" };
  let why = "Under 60%, close to DraftKings";
  if (pk && (pk.under || pk.p < PICK_P)) why = `${pk.team} ${(pk.p * 100).toFixed(1)}%, under 60%`;
  else if (pk && pk.price == null) why = "No moneyline yet";
  else if (pk) why = `${fmtPrice(pk.price)} is past -230`;
  return { on: false, value: "No call", sub: why };
}

const imp = p => p < 0 ? -p / (-p + 100) : 100 / (p + 100);

/**
 * Result of the Leo Pick for one game (DEC-20261102-33).
 *  res  = the graded row from results.json (pick_result, pick_units), or null
 *  live = { state, hs, as } from ESPN's scoreboard, or null
 * -> null (no pick), or { team, price, result: "win"|"loss"|null, units, graded }
 * A final that is not graded yet is worked out from the score and the price
 * frozen on the card (graded: false); the morning grade is the record.
 */
function settle(g, res, live) {
  const pk = (g.leo && g.leo.pick !== undefined) ? g.leo.pick : pickForGame(g);
  if (res && res.pick_result) return { team: res.pick_team, price: res.pick_price, result: res.pick_result, units: res.pick_units, graded: true };
  if (!pk || !pk.ok) return null;
  const fin = live && live.state === "post" && live.hs != null && live.as != null ? live
    : (g.completed && g.hs != null && g.as != null ? { hs: g.hs, as: g.as } : null);
  if (!fin) return { team: pk.team, price: pk.price, result: null, units: null, graded: false };
  const won = pk.side === "home" ? fin.hs > fin.as : fin.as > fin.hs;
  return { team: pk.team, price: pk.price, result: won ? "win" : "loss", units: +units(won ? "win" : "loss", pk.price).toFixed(2), graded: false };
}

/** DraftKings moneylines from one ESPN scoreboard competition (browser live fetch). */
function espnMoneyline(c) {
  const o = ((c && c.odds) || []).find(x => /draftkings/i.test((x.provider && x.provider.name) || "")) || ((c && c.odds) || [])[0];
  if (!o) return null;
  const ml = o.moneyline || {}, n = v => { const x = parseFloat(String(v == null ? "" : v).replace(/^\+/, "")); return Number.isFinite(x) ? x : null; };
  const pickOdds = s => s ? (n(s.current && s.current.odds) ?? n(s.close && s.close.odds)) : null;
  const home = pickOdds(ml.home) ?? n(o.homeTeamOdds && o.homeTeamOdds.moneyLine), away = pickOdds(ml.away) ?? n(o.awayTeamOdds && o.awayTeamOdds.moneyLine);
  return home == null && away == null ? null : { home_ml: home, away_ml: away };
}

/**
 * How the price on Leo's pick moved since Leo's read: { from, to, toward, text } or null.
 * toward = the market moved to Leo's side (the pick got more expensive). A benchmark, never an input.
 */
function priceMove(g, nowMl) {
  const pk = (g.leo && g.leo.pick !== undefined) ? g.leo.pick : pickForGame(g);
  if (!pk || !pk.ok || !nowMl) return null;
  const to = pk.side === "home" ? nowMl.home_ml : nowMl.away_ml;
  if (to == null || pk.price == null) return null;
  const d = imp(to) - imp(pk.price);
  const toward = d > 0.004 ? true : d < -0.004 ? false : null;
  return { from: pk.price, to, toward,
    text: `Price: ${fmtPrice(pk.price)} at Leo's read, ${fmtPrice(to)} now${toward === true ? " (moved toward Leo)" : toward === false ? " (moved against Leo)" : " (no real move)"}` };
}

const api = { PICK_P, PRICE_LIMIT, TRACK_FROM, LEANS_UNTIL, leansOn, payout, units, pick, pickForGame, fmtPrice, pickText, callBox, settle, espnMoneyline, priceMove, imp };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else if (typeof window !== "undefined") window.NBA_PICKS = api;
})();
