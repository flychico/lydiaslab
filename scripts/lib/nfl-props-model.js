/**
 * Leo NFL player-prop model: shared constants and the QB method.
 *
 * ONE COPY. generate-nfl-props.js (live), backtest-nfl-props.js and the
 * public Model Tuner (/nfl/tools/model-tuner/) all load this file, so a
 * change here reaches all three at once. Do not re-type these numbers
 * anywhere else.
 *
 * QB PASSING YARDS (leo-nflprop-v2, DEC-20260921-12)
 *   Last season is worth QB_PRIOR_GAMES games of evidence. With k = 2, one
 *   game this season counts 1/3, two games 1/2, four games 2/3.
 *   The old 50/50 early-season blend let one game be half the projection
 *   (Bryce Young, Week 2: 361 yds in Week 1 pulled a 188-yd QB to 277).
 *   Tested on 2025 walk-forward: average miss 68.7 -> 63.7 yds; Week 2 2026
 *   against real lines: closer than the book 8/28 -> 11/28.
 *   "Last season" = regular-season games with 15+ attempts (real starts).
 *   A QB with fewer than 4 real starts falls back to the league average
 *   starter line from last season.
 *
 * Pure: no network, filesystem or clock reads.
 */
(function () {
'use strict';

// Measured, not hand-tuned. Re-derive with scripts/backtest-nfl-props.js.
const CALIBRATION = {
  // v2 method, 2025 walk-forward on STARTERS only (the population the live
  // model projects), n=422: raw bias +9.5 yds high. The old +8.4 was measured
  // on every QB incl. backups' cameo games and pushed starters ~15 yds high.
  QB_PASS_YARDS: -9.5,
  // RB and WR were measured on every player who touched the ball, not the
  // live starters only. Re-measure on starters before trusting (open item).
  RB_RUSH_YARDS: 3.4,    // 2025 bias -3.4 yds over n=1221
  WR_REC_YARDS:  1.1,    // 2025 bias -1.1 yds over n=2017
  ANYTIME_TD:    0.0
};

const QB_PRIOR_GAMES = 2;       // one game this season counts 1/3
const QB_REAL_START_ATT = 15;   // a prior game counts only if he threw 15+
const QB_MIN_PRIOR_STARTS = 4;  // fewer than this -> league starter average

const sum = a => a.reduce((s, x) => s + x, 0);
const mean = a => a.length ? sum(a) / a.length : 0;

/** League-average QB start from last season: {yds, att}. games: [{att,pyds}] */
function qbLeagueBaseline(priorGames) {
  const real = priorGames.filter(g => g.att >= QB_REAL_START_ATT);
  return { yds: mean(real.map(g => g.pyds)), att: mean(real.map(g => g.att)) };
}

/**
 * cur: this season's games [{att,pyds}], prior: last season's regular-season
 * games, league: qbLeagueBaseline(). Returns {yds, att, rate} before the
 * opponent adjustment and calibration. rate x att === yds, so the frozen
 * rate_used / expected_volume columns still multiply back to the projection.
 */
function qbProjection(cur, prior, league) {
  const real = prior.filter(g => g.att >= QB_REAL_START_ATT);
  const base = real.length >= QB_MIN_PRIOR_STARTS
    ? { yds: mean(real.map(g => g.pyds)), att: mean(real.map(g => g.att)) }
    : league;
  const k = QB_PRIOR_GAMES, n = cur.length;
  const yds = (k * base.yds + sum(cur.map(g => g.pyds))) / (k + n);
  const att = (k * base.att + sum(cur.map(g => g.att))) / (k + n);
  return { yds, att, rate: att ? yds / att : 0, prior_source: real.length >= QB_MIN_PRIOR_STARTS ? "player" : "league" };
}

const api = { CALIBRATION, QB_PRIOR_GAMES, QB_REAL_START_ATT, QB_MIN_PRIOR_STARTS, qbLeagueBaseline, qbProjection };
if (typeof module === 'object' && module.exports) module.exports = api;
else (typeof window !== 'undefined' ? window : this).LeoProps = api;
})();
