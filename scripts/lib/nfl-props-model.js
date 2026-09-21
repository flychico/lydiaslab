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
  // Measured on the players the live model projects (2025 walk-forward):
  // QB = each team's top passer not listed Out/Doubtful (n=445, raw +7.2 high);
  // WR = top 3 by targets, same rule, v2 target-share volume (n=1310, +1.2 high).
  // The old +8.4 / +1.1 came from every player incl. backups and pushed
  // starters high (QB about 15 yds, WR about 2).
  QB_PASS_YARDS: -7.2,
  // RB is still measured on every back who touched the ball, not the live
  // top two. Re-measure on starters before trusting (open item).
  RB_RUSH_YARDS: 3.4,    // 2025 bias -3.4 yds over n=1221
  WR_REC_YARDS: -1.2,
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

/*
 * WR TARGETS (leo-nflprop-v2 for WR, DEC-20260921-13)
 *   targets = share of team targets x expected team targets
 *   share: this season's targets / team targets in his games, with last
 *     season's share counted as WR_SHARE_PRIOR_GAMES games of evidence.
 *   team targets: this season's team targets per game, with last season's
 *     team average counted as TEAM_TARGETS_PRIOR_GAMES games.
 *   Tested on 2025 walk-forward (top-3 WRs): average miss 26.7 -> 26.4,
 *   weeks 2-4 24.6 -> 23.8. Rate (yards per target) is unchanged.
 *   Redistributing an injured teammate's targets was tested and REJECTED:
 *   it fixed the average (-7 yds low) but made each player's miss worse.
 */
const WR_SHARE_PRIOR_GAMES = 3;
const TEAM_TARGETS_PRIOR_GAMES = 3;

/**
 * games: this season [{tgt, team_tgt}], prior: last season (REG) [{tgt, team_tgt}],
 * teamGames: this team's targets per game this season [n], teamPriorAvg: the
 * team's (or league's) last-season targets per game. Returns {share, team_targets, targets}.
 */
function wrTargets(games, prior, teamGames, teamPriorAvg) {
  const tMean = teamGames.length ? mean(teamGames) : teamPriorAvg;
  const tg = sum(games.map(g => g.tgt)), tt = sum(games.map(g => g.team_tgt));
  const ptt = sum(prior.map(g => g.team_tgt));
  const pShare = ptt > 0 ? sum(prior.map(g => g.tgt)) / ptt : null;
  const K = WR_SHARE_PRIOR_GAMES;
  const share = pShare != null ? (tg + K * pShare * tMean) / (tt + K * tMean) : (tt > 0 ? tg / tt : 0);
  const KT = TEAM_TARGETS_PRIOR_GAMES;
  const team_targets = (sum(teamGames) + KT * teamPriorAvg) / (teamGames.length + KT);
  return { share, team_targets, targets: share * team_targets };
}

/** Statuses that mean "will not play": never project, never pick as a starter. */
const SIDELINED = /^(out|doubtful)$/i;

const api = { CALIBRATION, WR_SHARE_PRIOR_GAMES, TEAM_TARGETS_PRIOR_GAMES, wrTargets, SIDELINED, QB_PRIOR_GAMES, QB_REAL_START_ATT, QB_MIN_PRIOR_STARTS, qbLeagueBaseline, qbProjection };
if (typeof module === 'object' && module.exports) module.exports = api;
else (typeof window !== 'undefined' ? window : this).LeoProps = api;
})();
