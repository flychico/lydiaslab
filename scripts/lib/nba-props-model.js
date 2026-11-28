/**
 * Leo NBA player projections: points, rebounds, assists and PRA (points + rebounds + assists).
 * Private test (DEC-20261126-03 step 2; Lynold, 2026-11-28: "So when are we going to build the player projections").
 * Not on the site, not in posts or emails, not a Leo Pick. The sportsbook line is never an input: it is only what
 * the projection is graded against.
 *
 * BAR, written before any comparison against sportsbook lines (2026-11-28):
 *   1. Walk-forward on 2025-26 and on 2026-27 to date, the projection's mean absolute error must beat the player's
 *      season average to date in every market (pts, reb, ast, pra) in both seasons.
 *   2. Against the saved DraftKings lines (from 2026-11-27), over at least 3 weeks of graded games, the projection's
 *      mean absolute error must be no worse than the line's in a market before that market is considered for leans.
 *   3. Leans (over or under when the projection is off the line) are graded privately only after (2) holds; a lean
 *      market must then reach 55% or better over 300+ graded leans with positive closing line value before anything
 *      is shown to members. Break-even at -110 is 52.4%.
 *
 * Model: expected minutes x per-minute rates.
 *   Minutes: recency-weighted average of the player's played games this season (half-life MIN_HALF_LIFE games),
 *     shrunk toward last season's minutes for a short sample (worth MIN_PRIOR_GAMES games); lowered on the second
 *     night of a back to back (B2B_MIN_CUT, only if it helps walk-forward); raised when rotation teammates sit
 *     (TEAMMATE_SHARE of the missing minutes, spread in proportion to minutes).
 *   Rates: this season's per-minute rate, recency weighted (RATE_HALF_LIFE games), shrunk toward last season's rate
 *     (RATE_PRIOR_MIN minutes) or the league rate for a new player.
 *   Opponent: what the opponent allows per game in each stat against the league, to the power OPP_EXP (0 = off).
 * Every switch above was tested walk-forward (scripts/backtest-nba-props.js, 2026-11-28); only those that beat the
 * simpler version are on: rate prior 120 minutes, opponent 0.5, teammates 0.3 of new absences, back to back 4%.
 * Off: the teammate per-minute bump. Results: /home/claude/mgr/nba-props/RESULTS.md.
 */
"use strict";

const P = {
  MIN_HALF_LIFE: 6,       // games
  MIN_PRIOR_GAMES: 4,     // last season's minutes are worth this many games early in the season
  RATE_HALF_LIFE: 20,     // games
  RATE_PRIOR_MIN: 120,    // minutes of last season's (or the league's) rate (250 and 500 tested worse, 60 mixed)
  B2B_MIN_CUT: 0.04,      // share of minutes cut on the second night of a back to back (small gain in all 8 cells)
  TEAMMATE_SHARE: 0.3,    // share of new absent rotation minutes handed to the players who play (0.6 and 1.0 worse)
  TEAMMATE_RATE: 0,       // per-minute scoring bump per 48 absent rotation minutes (tested worse, off)
  OPP_EXP: 0.5,           // opponent allowed factor exponent (1.0 tested worse)
  ROTATION_MPG: 20,       // a "rotation" player for absences: 20+ minutes a game over 5+ games
};
const STATS = ["pts", "reb", "ast"];

/** Recency-weighted mean of xs (newest last), half-life h items. */
function ewMean(xs, h) {
  if (!xs.length) return null;
  const a = Math.pow(0.5, 1 / h); let w = 1, s = 0, ws = 0;
  for (let i = xs.length - 1; i >= 0; i--) { s += w * xs[i]; ws += w; w *= a; }
  return s / ws;
}

/**
 * Tracker: feed it games in date order (addGame), ask for projections before each date (project).
 * prior: Map player id -> { gp, min, pts, reb, ast } from last season (played games only).
 */
class Tracker {
  constructor(prior, params = {}) {
    this.P = { ...P, ...params };
    this.prior = prior || new Map();
    this.pl = new Map();            // id -> { team, games: [{ date, min, pts, reb, ast }] } played games this season
    this.teamDates = new Map();     // team -> sorted dates played
    this.opp = new Map();           // team -> { g, pts, reb, ast } allowed (opponents' totals)
    this.lg = { min: 0, pts: 0, reb: 0, ast: 0, tg: 0, tpts: 0, treb: 0, tast: 0 };
    this.lgPrior = null;            // league per-minute rates from last season (set by setLeaguePrior)
  }
  setLeaguePrior(rates) { this.lgPrior = rates; }
  leagueRate(k) {
    if (this.lg.min > 20000) return this.lg[k] / this.lg.min;
    return this.lgPrior ? this.lgPrior[k] : { pts: 0.48, reb: 0.19, ast: 0.11 }[k];
  }
  /** rows: one game's player rows { id, team, min, pts, reb, ast, played }. */
  addGame(date, home, away, rows) {
    const tot = { [home]: { pts: 0, reb: 0, ast: 0 }, [away]: { pts: 0, reb: 0, ast: 0 } };
    for (const r of rows) {
      if (!tot[r.team]) continue;
      for (const k of STATS) tot[r.team][k] += r[k] || 0;
      if (!r.played || !(r.min > 0)) continue;
      const p = this.pl.get(r.id) || { team: r.team, games: [] };
      p.team = r.team; p.games.push({ date, min: r.min, pts: r.pts, reb: r.reb, ast: r.ast });
      this.pl.set(r.id, p);
      this.lg.min += r.min; for (const k of STATS) this.lg[k] += r[k] || 0;
    }
    for (const [t, o] of [[home, away], [away, home]]) {
      const a = this.opp.get(t) || { g: 0, pts: 0, reb: 0, ast: 0 };
      a.g++; for (const k of STATS) a[k] += tot[o][k];
      this.opp.set(t, a);
      const ds = this.teamDates.get(t) || []; ds.push(date); this.teamDates.set(t, ds);
    }
    this.lg.tg += 2; this.lg.tpts += tot[home].pts + tot[away].pts; this.lg.treb += tot[home].reb + tot[away].reb; this.lg.tast += tot[home].ast + tot[away].ast;
  }
  /** Rotation players of a team (season minutes per game, played games). */
  rotation(team) {
    // Only players who played in one of the team's last two games: a long absence is already in his teammates'
    // recent minutes, so only a new absence moves minutes.
    const ds = this.teamDates.get(team) || [], recent = new Set(ds.slice(-2));
    const out = [];
    for (const [id, p] of this.pl) if (p.team === team && p.games.length >= 5 && recent.has(p.games[p.games.length - 1].date)) {
      const mpg = p.games.reduce((s, g) => s + g.min, 0) / p.games.length;
      if (mpg >= this.P.ROTATION_MPG) out.push({ id, mpg });
    }
    return out;
  }
  isB2B(team, date) {
    const ds = this.teamDates.get(team) || []; if (!ds.length) return false;
    const prev = new Date(date + "T12:00:00Z"); prev.setUTCDate(prev.getUTCDate() - 1);
    return ds[ds.length - 1] === prev.toISOString().slice(0, 10);
  }
  /**
   * Projection for player id on `date` against `opp`.
   * ctx: { b2b, absentMinutes (rotation minutes per game missing for his team), teamMinutesPresent }
   */
  project(id, team, opp, date, ctx = {}) {
    const P_ = this.P, p = this.pl.get(id), pr = this.prior.get(id);
    const games = p ? p.games : [];
    if (!games.length && !pr) return null;
    // Minutes
    const recent = games.length ? ewMean(games.map(g => g.min), P_.MIN_HALF_LIFE) : null;
    const priorMin = pr && pr.gp ? pr.min / pr.gp : null;
    let min;
    if (recent == null) min = priorMin;
    else if (priorMin == null) min = recent;
    else min = (recent * games.length + priorMin * P_.MIN_PRIOR_GAMES) / (games.length + P_.MIN_PRIOR_GAMES);
    if (ctx.b2b) min *= 1 - P_.B2B_MIN_CUT;
    if (ctx.absentMinutes > 0 && ctx.teamMinutesPresent > 0) min += P_.TEAMMATE_SHARE * ctx.absentMinutes * (min / ctx.teamMinutesPresent);
    min = Math.max(0, Math.min(44, min));
    // Rates
    const out = { min };
    const a = Math.pow(0.5, 1 / P_.RATE_HALF_LIFE);
    for (const k of STATS) {
      let s = 0, m = 0, w = 1;
      for (let i = games.length - 1; i >= 0; i--) { s += w * games[i][k]; m += w * games[i].min; w *= a; }
      const priorRate = pr && pr.min > 0 ? pr[k] / pr.min : this.leagueRate(k);
      let rate = (s + P_.RATE_PRIOR_MIN * priorRate) / (m + P_.RATE_PRIOR_MIN);
      if (P_.OPP_EXP && opp) {
        const o = this.opp.get(opp);
        if (o && o.g >= 5 && this.lg.tg > 20) {
          const lgPer = this.lg["t" + k] / this.lg.tg, oPer = o[k] / o.g;
          rate *= Math.pow(oPer / lgPer, P_.OPP_EXP);
        }
      }
      if (P_.TEAMMATE_RATE && ctx.absentMinutes > 0 && k !== "reb") rate *= 1 + P_.TEAMMATE_RATE * ctx.absentMinutes / 48;
      out[k] = rate * min;
    }
    out.pra = out.pts + out.reb + out.ast;
    out.games = games.length;
    return out;
  }
  /** Season average to date (played games), the benchmark the bar names. */
  seasonAvg(id) {
    const p = this.pl.get(id); if (!p || !p.games.length) return null;
    const n = p.games.length, o = { games: n };
    for (const k of STATS) o[k] = p.games.reduce((s, g) => s + g[k], 0) / n;
    o.pra = o.pts + o.reb + o.ast; return o;
  }
}

/**
 * One season's games and player rows, normalized: { games: [{ game_id, date, home, away }], rows: [{ game_id, date,
 * id, team, min, pts, reb, ast, played }] }. The sportsdataverse release file (scripts/lib/nba-model.js loadSeason),
 * plus for the current season the ESPN box scores saved in data/nba/boxscores/ that the release does not have yet.
 */
async function seasonRows(season, root, { current = false } = {}) {
  const fs = require("fs"), path = require("path"), M = require("./nba-model");
  const x = await M.loadSeason(season);
  const games = x.games.map(g => ({ game_id: String(g.game_id), date: g.date, home: g.home, away: g.away }));
  const rows = x.players.map(p => ({ game_id: String(p.game_id), date: p.date, id: String(p.id), team: p.team, min: p.minutes,
    pts: p.pts, reb: p.reb, ast: p.ast, played: !!p.played && p.minutes > 0 }));
  if (current) {
    const have = new Set(games.map(g => g.game_id)), dir = path.join(root, "data/nba/boxscores");
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)) : [];
    for (const f of files) {
      let day; try { day = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { continue; }
      for (const g of day.games || []) {
        if (have.has(String(g.game_id)) || !g.players) continue;
        games.push({ game_id: String(g.game_id), date: day.date, home: g.home, away: g.away }); have.add(String(g.game_id));
        for (const p of g.players) rows.push({ game_id: String(g.game_id), date: day.date, id: String(p.id), team: p.team, min: +p.minutes || 0,
          pts: +(p.stats && p.stats.points) || 0, reb: +(p.stats && p.stats.rebounds) || 0, ast: +(p.stats && p.stats.assists) || 0,
          played: !p.dnp && +p.minutes > 0 });
      }
    }
  }
  games.sort((a, b) => a.date.localeCompare(b.date) || a.game_id.localeCompare(b.game_id));
  return { games, rows };
}

/** Last season's totals per player (played games only) and the league per-minute rates. */
function priorFrom(rows) {
  const m = new Map(); const lg = { min: 0, pts: 0, reb: 0, ast: 0 };
  for (const r of rows) {
    if (!r.played || !(r.min > 0)) continue;
    const p = m.get(r.id) || { gp: 0, min: 0, pts: 0, reb: 0, ast: 0 };
    p.gp++; p.min += r.min; for (const k of STATS) p[k] += r[k] || 0; m.set(r.id, p);
    lg.min += r.min; for (const k of STATS) lg[k] += r[k] || 0;
  }
  return { prior: m, league: { pts: lg.pts / lg.min, reb: lg.reb / lg.min, ast: lg.ast / lg.min } };
}

module.exports = { P, STATS, Tracker, priorFrom, ewMean, seasonRows };
