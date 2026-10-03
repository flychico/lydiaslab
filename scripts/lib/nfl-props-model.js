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
  // RB v2 (share of the backfield), measured on the live population -- each
  // team's top two backs, injury skip applied, 2025 walk-forward n=857:
  // projections ran 1.4 yds low. The old +3.4 came from every back who
  // touched the ball, a population Leo never projects.
  RB_RUSH_YARDS: 1.4,
  // WR: the 2025 backtest said +1.2 high; 78 graded rows of live 2026 say
  // 9.8 LOW (standard error 3.7). Moved halfway rather than all the way --
  // one season of 78 rows is not enough to overwrite the backtest. Re-check
  // at n=150. (2026-10-03)
  WR_REC_YARDS: 3.6,
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

/*
 * RB RUSHING YARDS (leo-nflprop-v2 for RB, DEC-20261003-01)
 *   carries = share of team carries x expected team carries, the same shape
 *   that worked for receivers. A back's share of the backfield holds up far
 *   better week to week than his raw carry count, which swings with the
 *   score. Rate is yards per carry over his own history, shrunk toward the
 *   league back (RB_RATE_PRIOR_CARRIES carries of evidence).
 *
 *   BACKFIELD-MATE OUT. Unlike receivers, a backfield is two or three men
 *   deep and the carries genuinely transfer. 2025: backs whose mate was
 *   newly out ran 15.9 yds BELOW projection. Half-strength redistribution
 *   cuts that to 6.1 and lowers their miss (25.8 -> 25.0), so here the boost
 *   is applied where the receiver version was rejected.
 *
 *   Tested on 2025 walk-forward, top-2 backs, each with its own calibration:
 *   average miss 25.73 (old blend) -> 24.95. Settings tuned out of sample.
 */
const RB_SHARE_PRIOR_GAMES = 1;      // last season's share = 1 game of evidence
const RB_RATE_PRIOR_CARRIES = 80;    // shrink yards per carry toward the league back
const TEAM_CARRIES_PRIOR_GAMES = 2;
const RB_ROLE_MIN_CARRIES = 8;       // a prior game counts as a real role at 8+
const RB_MATE_OUT_STRENGTH = 0.5;    // half of an absent mate's share transfers

/**
 * games/prior: [{car, ryds, team_car}] this season / last season (REG).
 * teamGames: this team's carries per game this season. teamPriorAvg: last
 * season's team average. shareOut: combined share of backfield mates newly
 * listed Out or Doubtful; shareAvailable: combined share of those playing.
 * leagueRate: league yards per carry among real-role backs.
 * Returns {share, team_carries, carries, rate}.
 */
function rbCarries(games, prior, teamGames, teamPriorAvg, leagueRate, shareOut = 0, shareAvailable = 0) {
  const tMean = teamGames.length ? mean(teamGames) : teamPriorAvg;
  const car = sum(games.map(g => g.car)), tt = sum(games.map(g => g.team_car));
  const ptt = sum(prior.map(g => g.team_car));
  const pShare = ptt > 0 ? sum(prior.map(g => g.car)) / ptt : null;
  const K = RB_SHARE_PRIOR_GAMES;
  let share = pShare != null ? (car + K * pShare * tMean) / (tt + K * tMean) : (tt > 0 ? car / tt : 0);
  if (shareOut > 0 && shareAvailable > 0) share *= 1 + RB_MATE_OUT_STRENGTH * (shareOut / shareAvailable);

  const KT = TEAM_CARRIES_PRIOR_GAMES;
  const team_carries = (sum(teamGames) + KT * teamPriorAvg) / (teamGames.length + KT);

  const real = prior.filter(g => g.car >= RB_ROLE_MIN_CARRIES);
  const kR = RB_RATE_PRIOR_CARRIES;
  const yards = sum(games.map(g => g.ryds)) + sum(real.map(g => g.ryds));
  const carries = car + sum(real.map(g => g.car));
  const rate = (yards + kR * leagueRate) / (carries + kR);

  return { share, team_carries, carries: share * team_carries, rate };
}

/** League yards per carry among real-role backs, from last season's games. */
function rbLeagueRate(priorGames) {
  const real = priorGames.filter(g => g.car >= RB_ROLE_MIN_CARRIES);
  const c = sum(real.map(g => g.car));
  return c ? sum(real.map(g => g.ryds)) / c : 4.2;
}

const api = { CALIBRATION, RB_SHARE_PRIOR_GAMES, RB_RATE_PRIOR_CARRIES, TEAM_CARRIES_PRIOR_GAMES, RB_ROLE_MIN_CARRIES, RB_MATE_OUT_STRENGTH, rbCarries, rbLeagueRate, WR_SHARE_PRIOR_GAMES, TEAM_TARGETS_PRIOR_GAMES, wrTargets, SIDELINED, QB_PRIOR_GAMES, QB_REAL_START_ATT, QB_MIN_PRIOR_STARTS, qbLeagueBaseline, qbProjection };
if (typeof module === 'object' && module.exports) module.exports = api;
else (typeof window !== 'undefined' ? window : this).LeoProps = api;
})();
