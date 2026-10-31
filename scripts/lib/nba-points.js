/**
 * Leo NBA projected score (NBA-H08). Display only: no over/under leans.
 *
 *   possessions  = FGA - OREB + TOV + 0.44 x FTA, per team; game pace is the
 *                  average of the two teams
 *   pace         = league pace + home team pace effect + away team pace effect
 *   points / 100 = league + own offence - opponent defence (+ home court)
 *   projected    = pace x points per 100 / 100, for each team
 *
 * Offence, defence and pace are ridge fits on this season's games, each team
 * pulled toward 60% of its end-of-last-season value (worth 8 games). The
 * priors live in data/nba/points-model.json, written by
 * scripts/train-nba-points.js. Injuries are not in the total yet. On the
 * page the total is split by Leo's own margin, so the projected score always
 * agrees with Leo's spread. The betting total is never an input.
 */
const M = require("./nba-model");

const LG_EFF = 112, LG_PACE = 99, PRIOR_GAMES = 8, REGRESS = 0.6;

/** Regular-season games with both teams' points and possessions. */
async function loadTeamGames(season, opts) {
  const t = M.parseCsv(await M.download("team", season, opts), ["game_id", "season_type", "game_date", "team_home_away", "team_abbreviation", "team_score",
    "field_goals_attempted", "offensive_rebounds", "total_turnovers", "turnovers", "free_throws_attempted"]);
  const g = new Map();
  for (const r of t) {
    if (r.season_type !== "2") continue;
    const o = g.get(r.game_id) || { game_id: r.game_id, date: r.game_date };
    const poss = +r.field_goals_attempted - +r.offensive_rebounds + (+r.total_turnovers || +r.turnovers) + 0.44 * +r.free_throws_attempted;
    o[r.team_home_away] = { team: r.team_abbreviation, pts: +r.team_score, poss };
    g.set(r.game_id, o);
  }
  return [...g.values()].filter(x => x.home && x.away && x.home.poss > 50 && x.away.poss > 50)
    .map(x => ({ ...x, pace: (x.home.poss + x.away.poss) / 2 })).sort((a, b) => a.date.localeCompare(b.date));
}

function ridge(obs, k, prior, lam, fixedIdx) {
  const A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (const o of obs) { const x = [...o.x, [k - 1, 1]]; for (const [i, xi] of x) { b[i] += xi * o.y; for (const [j, xj] of x) A[i][j] += xi * xj; } }
  for (let i = 0; i < k - 1; i++) { const l = i === fixedIdx ? 20 : lam; A[i][i] += l; b[i] += l * (prior[i] || 0); }
  for (let i = 0; i < k; i++) A[i][i] += 1e-6;
  return M.solve(A, b);
}

/** Ratings from games played; priors = { off, def, pace } keyed by team. */
function rate(games, teams, priors = {}) {
  const n = teams.length, ix = Object.fromEntries(teams.map((t, i) => [t, i]));
  const P = priors, eo = [], po = [];
  for (const g of games) {
    const h = ix[g.home.team], a = ix[g.away.team]; if (h == null || a == null) continue;
    eo.push({ x: [[h, 1], [n + a, -1], [2 * n, 1]], y: 100 * g.home.pts / g.home.poss - LG_EFF });
    eo.push({ x: [[a, 1], [n + h, -1]], y: 100 * g.away.pts / g.away.poss - LG_EFF });
    po.push({ x: [[h, 1], [a, 1]], y: g.pace - LG_PACE });
  }
  const ePrior = [...teams.map(t => (P.off || {})[t] || 0), ...teams.map(t => (P.def || {})[t] || 0), 1.5];
  const E = ridge(eo, 2 * n + 2, ePrior, PRIOR_GAMES, 2 * n);
  const W = ridge(po, n + 1, teams.map(t => (P.pace || {})[t] || 0), PRIOR_GAMES, -1);
  const pick = (arr, off) => Object.fromEntries(teams.map((t, i) => [t, arr[off + i]]));
  return { off: pick(E, 0), def: pick(E, n), home_eff: E[2 * n], lg_eff: LG_EFF + E[2 * n + 1], pace: pick(W, 0), lg_pace: LG_PACE + W[n] };
}

/** Projected points for each side; unknown teams count as league average. */
function project(R, home, away) {
  const v = (o, t) => (o[t] || 0);
  const pace = R.lg_pace + v(R.pace, home) + v(R.pace, away);
  const effH = R.lg_eff + v(R.off, home) - v(R.def, away) + R.home_eff, effA = R.lg_eff + v(R.off, away) - v(R.def, home);
  return { pace, home: pace * effH / 100, away: pace * effA / 100, total: pace * (effH + effA) / 100 };
}

/** Next season's priors from final ratings. */
const toPriors = R => Object.fromEntries(["off", "def", "pace"].map(k => [k, Object.fromEntries(Object.entries(R[k]).map(([t, x]) => [t, +(REGRESS * x).toFixed(3)]))]));

module.exports = { loadTeamGames, rate, project, toPriors };
