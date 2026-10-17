/**
 * Leo game-totals model, leo-nfltot-v2 (DEC-20261017).
 *
 * ONE COPY, shared by generate-nfl-model.js and backtest-nfl-totals.js.
 *
 * Each team's expected points come from a fitted linear model, and the
 * projected total is the two added together. Per team, every input is pregame:
 *   off_ppg      points this team scores per game (shrunk toward last season)
 *   opp_allowed  points the opponent allows per game (shrunk the same way)
 *   qb_z         the expected starting QB's rating (lib/nfl-moneyline.js)
 *   off_z        supporting offense rating (rushing EPA, first downs, explosives)
 *   opp_def_z    opponent defense rating
 *   home         1 at home
 *   indoor       1 under a dome or closed roof
 *   wind         mph, outdoors only (0 indoors)
 * No sportsbook number is an input. v1 was a plain average of points for and
 * points against plus a roof bump: no QB, no defense quality, a 15mph wind step.
 */
const { teamScoring } = require('./nfl-td-model');

const FEATURES = ['off_ppg', 'opp_allowed', 'qb_z', 'off_z', 'opp_def_z', 'home', 'indoor', 'wind'];
const num = v => { const x = Number.parseFloat(v); return Number.isFinite(x) ? x : 0; };

function indoorOf(roof) { const r = String(roof || '').toLowerCase(); return r === 'dome' || r === 'closed' ? 1 : 0; }

/** Input row for one team in one game. */
function featureRow({ team, opp, home, qb, roof, wind, scoring, qbRatings, teamRatings }) {
  const s = scoring(team), o = scoring(opp);
  const q = qbRatings[qb], t = teamRatings[team], d = teamRatings[opp];
  const indoor = indoorOf(roof);
  return {
    off_ppg: s.ppg, opp_allowed: o.allowed,
    qb_z: q ? q.z : 0, off_z: t ? t.off_z : 0, opp_def_z: d ? d.def_z : 0,
    home: home ? 1 : 0, indoor, wind: indoor ? 0 : num(wind)
  };
}

/** Ridge regression, closed form. rows need `y`; returns {intercept, beta, features}. */
function fitRidge(rows, features, lambda = 1) {
  const k = features.length + 1;
  const A = Array.from({ length: k }, () => Array(k).fill(0)), b = Array(k).fill(0);
  for (const r of rows) {
    const x = [1, ...features.map(f => num(r[f]))];
    for (let i = 0; i < k; i++) { b[i] += x[i] * r.y; for (let j = 0; j < k; j++) A[i][j] += x[i] * x[j]; }
  }
  for (let i = 1; i < k; i++) A[i][i] += lambda;            // no penalty on the intercept
  // Gauss-Jordan
  for (let c = 0; c < k; c++) {
    let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue; const f = A[r][c] / A[c][c];
      for (let j = c; j < k; j++) A[r][j] -= f * A[c][j]; b[r] -= f * b[c];
    }
  }
  const w = b.map((v, i) => v / A[i][i]);
  return { intercept: w[0], beta: w.slice(1), features: [...features],
           coefficients: Object.fromEntries(features.map((f, i) => [f, w[i + 1]])) };
}

function teamPoints(model, row) {
  return model.intercept + model.features.reduce((s, f, j) => s + model.beta[j] * num(row[f]), 0);
}

module.exports = { FEATURES, featureRow, fitRidge, teamPoints, teamScoring, indoorOf };
