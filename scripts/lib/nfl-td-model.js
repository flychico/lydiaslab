/**
 * Leo anytime-touchdown model, leo-nfltd-v2 (DEC-20261017).
 *
 * ONE COPY. The live generator (generate-nfl-props.js), the trainer
 * (train-nfl-td.js) and the backtest (backtest-nfl-td.js) all build features
 * here, so they can never disagree about what a feature means.
 *
 * What it predicts: the chance a player scores a rushing or receiving TD in
 * this game (passing TDs do not count; a QB's own rushing TD does). That is
 * exactly what grade-nfl-props.js grades.
 *
 * Inputs, in order of strength on 2023-25 nflverse data:
 *   1. usage per game (RB carries + targets, WR/TE targets, QB carries)
 *   2. TD rate per game, shrunk toward the position baseline
 *   3. how many points his team scores, and how many the opponent allows
 *   4. his rank on his own team at the position (RB1, RB2, ...)
 * No sportsbook number enters the probability (standing rule: borrow the
 * market's discipline, never its number). Team scoring comes from scores.
 *
 * Who is projected: per team, RB1-3, WR1-4, TE1-2 and QB1 by usage this
 * season. v1 projected only RB1-2 (rushing TDs) and WR1-3 (receiving TDs),
 * which left tight ends and QB runs, about a quarter of all TDs, unpriced.
 */

const POSITIONS = ['RB', 'WR', 'TE', 'QB'];
const DEPTH = { RB: 3, WR: 4, TE: 2, QB: 1 };
// Rough per-game scoring rate by position, the prior for a thin TD history.
const POS_BASE = { RB: 0.30, WR: 0.22, TE: 0.15, QB: 0.12 };
const PRIOR_MIN_GAMES = 4;   // a prior season counts only with 4+ games
const USE_PRIOR_GAMES = 3;   // last season's usage counts as 3 games
const TD_PRIOR_GAMES = 4;    // last season's (shrunk) TD rate counts as 4 games
const TD_BASE_GAMES = 6;     // the position baseline counts as 6 games of last season
const TEAM_PRIOR_GAMES = 4;  // last season's points per game count as 4 games
const LEAGUE_PPG = 22.5;
const CEILING = 0.72;        // no anytime-TD price implies more than ~72%

const FEATURES = ['is_wr', 'is_te', 'is_qb', 'use_rb', 'use_wr', 'use_te', 'use_qb',
                  'td_rate', 'team_ppg', 'opp_allowed', 'home', 'depth_n'];

const num = v => { const x = Number.parseFloat(v); return Number.isFinite(x) ? x : 0; };
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

/** Usage measure for a position from one player-game {car, tgt}. */
function usageOf(pos, g) {
  if (pos === 'RB') return num(g.car) + num(g.tgt);
  if (pos === 'QB') return num(g.car);
  return num(g.tgt);
}
const tdsOf = g => num(g.rtd) + num(g.rectd);

/**
 * Player features from his game logs.
 *   cur   = this season's games before the slate, [{car,tgt,rtd,rectd}]
 *   prior = last regular season's games
 */
function playerFeatures(pos, cur, prior) {
  const g = cur.length;
  const usePrior = prior.length >= PRIOR_MIN_GAMES ? mean(prior.map(x => usageOf(pos, x))) : null;
  const useCur = g ? mean(cur.map(x => usageOf(pos, x))) : 0;
  const use = usePrior == null ? useCur : (g * useCur + USE_PRIOR_GAMES * usePrior) / (g + USE_PRIOR_GAMES);

  const base = POS_BASE[pos];
  let tdPrior = base;
  if (prior.length >= PRIOR_MIN_GAMES) {
    const pn = prior.length;
    tdPrior = (pn * mean(prior.map(tdsOf)) + TD_BASE_GAMES * base) / (pn + TD_BASE_GAMES);
  }
  const tdCur = g ? mean(cur.map(tdsOf)) : 0;
  const td = (g * tdCur + TD_PRIOR_GAMES * tdPrior) / (g + TD_PRIOR_GAMES);
  return { use, td_rate: td, games: g };
}

/**
 * Points scored and allowed per game for every team, from completed games
 * before `beforeWeek` this season, shrunk toward last season.
 *   games = nflverse games.csv rows (all seasons are fine; filtered here)
 */
function teamScoring(games, season, beforeWeek) {
  const done = (g, s) => Number(g.season) === s && g.game_type === 'REG' && g.home_score !== '' && g.away_score !== '';
  const acc = s => {
    const m = new Map();
    const add = (t, pf, pa) => { const e = m.get(t) || { pf: 0, pa: 0, n: 0 }; e.pf += pf; e.pa += pa; e.n++; m.set(t, e); };
    return { m, add };
  };
  const cur = acc(), prior = acc();
  for (const g of games) {
    if (done(g, season) && Number(g.week) < beforeWeek) {
      cur.add(g.home_team, num(g.home_score), num(g.away_score));
      cur.add(g.away_team, num(g.away_score), num(g.home_score));
    } else if (done(g, season - 1)) {
      prior.add(g.home_team, num(g.home_score), num(g.away_score));
      prior.add(g.away_team, num(g.away_score), num(g.home_score));
    }
  }
  return team => {
    const c = cur.m.get(team) || { pf: 0, pa: 0, n: 0 };
    const p = prior.m.get(team);
    const pPf = p && p.n ? p.pf / p.n : LEAGUE_PPG;
    const pPa = p && p.n ? p.pa / p.n : LEAGUE_PPG;
    const k = TEAM_PRIOR_GAMES;
    return {
      ppg: (c.pf + k * pPf) / (c.n + k),
      allowed: (c.pa + k * pPa) / (c.n + k)
    };
  };
}

/** The model's input row for one player in one game. */
function featureRow({ pos, cur, prior, team, opp, home, scoring, depth }) {
  const f = playerFeatures(pos, cur, prior);
  const t = scoring(team), o = scoring(opp);
  return {
    is_wr: pos === 'WR' ? 1 : 0, is_te: pos === 'TE' ? 1 : 0, is_qb: pos === 'QB' ? 1 : 0,
    use_rb: pos === 'RB' ? f.use : 0, use_wr: pos === 'WR' ? f.use : 0,
    use_te: pos === 'TE' ? f.use : 0, use_qb: pos === 'QB' ? f.use : 0,
    td_rate: f.td_rate, team_ppg: t.ppg, opp_allowed: o.allowed, home: home ? 1 : 0,
    // Rank on his own team (RB1 = 1). Usage alone under-rated leads and
    // over-rated RB3/WR4; adding the rank cut 2023-25 Brier 0.1517 -> 0.1508.
    depth_n: Number(String(depth || '').replace(/\D/g, '')) || 1,
    _use: f.use, _games: f.games
  };
}

/**
 * Who gets a projection: per position, the top N by usage this season.
 * players = [{name, pos, cur, ...}] already filtered to active, not Out/Doubtful.
 */
function candidates(players) {
  const out = [];
  for (const pos of POSITIONS) {
    players.filter(p => p.pos === pos && p.cur.length)
      .map(p => ({ ...p, _u: mean(p.cur.map(x => usageOf(pos, x))) }))
      .filter(p => p._u > 0)
      .sort((a, b) => b._u - a._u)
      .slice(0, DEPTH[pos])
      .forEach((p, i) => out.push({ ...p, depth: `${pos}${i + 1}` }));
  }
  return out;
}

/** Probability from a trained model file (data/nfl/td-model.json). */
function probability(model, row) {
  let eta = model.intercept;
  // Same standardisation as fitLogistic/predict in lib/nfl-moneyline.js.
  model.features.forEach((f, j) => {
    eta += model.beta[j] * ((num(row[f]) - model.scaler.mean[f]) / (model.scaler.sd[f] || 1));
  });
  const p = eta >= 0 ? 1 / (1 + Math.exp(-eta)) : Math.exp(eta) / (1 + Math.exp(eta));
  return Math.min(CEILING, p);
}

module.exports = {
  FEATURES, POSITIONS, DEPTH, POS_BASE, CEILING,
  usageOf, tdsOf, playerFeatures, teamScoring, featureRow, candidates, probability
};
