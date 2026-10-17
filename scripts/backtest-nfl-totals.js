#!/usr/bin/env node
/**
 * Game totals (leo-nfltot-v2): walk-forward backtest and trainer.
 *
 *   node scripts/backtest-nfl-totals.js           train <S, test S, S = 2023..2025
 *   node scripts/backtest-nfl-totals.js --train   fit on 2022-2025, write data/nfl/totals-model.json
 *
 * Strictly pregame inputs (see lib/nfl-totals-model.js). The closing total is
 * evaluation only: line MAE, and the over/under record when Leo takes a side
 * at each disagreement threshold, which is what sets the live floor.
 * Writes data/nfl/backtest-totals.json.
 */
const fs = require('fs');
const path = require('path');
const ML = require('./lib/nfl-moneyline');
const TOT = require('./lib/nfl-totals-model');
const { get, FEED, REL } = require('./backtest-nfl-td');

const ROOT = path.join(__dirname, '..');
const FIRST = 2022, LAST = 2025, TEST = [2023, 2024, 2025];
const LAMBDA = 50;   // 5 vs 50 tested 2026-10-17: 50 has the lower out-of-sample MAE (10.30 vs 10.37)
const THRESHOLDS = [0, 1.5, 3, 4, 5, 7];
const TRAIN = process.argv.includes('--train');
const num = v => { const x = Number.parseFloat(v); return Number.isFinite(x) ? x : null; };

function buildGames(games, stats) {
  const out = [];
  for (let season = FIRST; season <= LAST; season++) {
    const cur = stats[season], prior = (stats[season - 1] || []).filter(r => !r.season_type || r.season_type === 'REG');
    const sg = games.filter(g => Number(g.season) === season && g.game_type === 'REG' && g.home_score !== '');
    for (const week of [...new Set(sg.map(g => Number(g.week)))].sort((a, b) => a - b)) {
      const pre = cur.filter(r => Number(r.week) < week && (!r.season_type || r.season_type === 'REG'));
      const qbRatings = ML.buildQbRatings(pre, prior), teamRatings = ML.buildTeamRatings(pre, prior);
      const scoring = TOT.teamScoring(games, season, week);
      for (const g of sg.filter(x => Number(x.week) === week)) {
        const side = (team, opp, home, qb) => TOT.featureRow({ team, opp, home, qb, roof: g.roof, wind: g.wind,
                                                               scoring, qbRatings, teamRatings });
        out.push({
          season, week, game_id: g.game_id, total_line: num(g.total_line),
          home: { ...side(g.home_team, g.away_team, true, g.home_qb_name), y: num(g.home_score) },
          away: { ...side(g.away_team, g.home_team, false, g.away_qb_name), y: num(g.away_score) },
          actual: num(g.home_score) + num(g.away_score),
          v1: scoring(g.home_team).ppg / 2 + scoring(g.away_team).allowed / 2
            + scoring(g.away_team).ppg / 2 + scoring(g.home_team).allowed / 2 + (TOT.indoorOf(g.roof) ? 0.8 : 0)
            + (!TOT.indoorOf(g.roof) && num(g.wind) >= 15 ? -1.6 : 0)
        });
      }
    }
    console.log(`  ${season}: ${out.filter(r => r.season === season).length} games`);
  }
  return out;
}

const mae = (rows, k) => rows.reduce((s, r) => s + Math.abs(r[k] - r.actual), 0) / rows.length;
function sides(rows, key) {
  return THRESHOLDS.map(t => {
    let w = 0, l = 0, p = 0, ov = 0;
    for (const r of rows) {
      if (r.total_line == null) continue;
      const e = r[key] - r.total_line;
      if (Math.abs(e) < t || e === 0) continue;
      const res = r.actual - r.total_line;
      if (res === 0) { p++; continue; }
      if (e > 0) ov++;
      ((e > 0) === (res > 0)) ? w++ : l++;
    }
    return { threshold: t, w, l, p, win_pct: w + l ? +(100 * w / (w + l)).toFixed(1) : null,
             roi_at_110: w + l ? +(100 * (w * (100 / 110) - l) / (w + l + p)).toFixed(1) : null, overs: ov };
  });
}

function main() {
  const games = get(FEED);
  const stats = {};
  for (let s = FIRST - 1; s <= LAST; s++) stats[s] = get(`${REL}/stats_player/stats_player_week_${s}.csv`);
  const all = buildGames(games, stats);
  const teamRows = gs => gs.flatMap(g => [g.home, g.away]).filter(r => r.y != null);
  const oos = [], evidence = { generated_at: new Date().toISOString(), model_version: 'leo-nfltot-v2',
                               features: TOT.FEATURES, lambda: LAMBDA, folds: [] };
  for (const t of TEST) {
    const m = TOT.fitRidge(teamRows(all.filter(g => g.season < t)), TOT.FEATURES, LAMBDA);
    const test = all.filter(g => g.season === t).map(g => ({ ...g, proj: TOT.teamPoints(m, g.home) + TOT.teamPoints(m, g.away) }));
    const lined = test.filter(g => g.total_line != null);
    evidence.folds.push({ test_season: t, n: test.length,
      mae_v2: +mae(lined, 'proj').toFixed(2), mae_v1: +mae(lined, 'v1').toFixed(2), mae_line: +mae(lined, 'total_line').toFixed(2),
      bias_v2: +(lined.reduce((s, g) => s + g.proj - g.actual, 0) / lined.length).toFixed(2),
      sides_v2: sides(test, 'proj') });
    oos.push(...test);
  }
  const lined = oos.filter(g => g.total_line != null);
  evidence.oos = { n: lined.length, mae_v2: +mae(lined, 'proj').toFixed(2), mae_v1: +mae(lined, 'v1').toFixed(2),
                   mae_line: +mae(lined, 'total_line').toFixed(2),
                   sides_v2: sides(oos, 'proj'), sides_v1: sides(oos, 'v1') };
  console.log(JSON.stringify(evidence, null, 1));
  if (TRAIN) {
    const m = TOT.fitRidge(teamRows(all), TOT.FEATURES, LAMBDA);
    fs.writeFileSync(path.join(ROOT, 'data/nfl/totals-model.json'), JSON.stringify({
      model_version: 'leo-nfltot-v2', trained_at: new Date().toISOString(), trained_seasons: [FIRST, LAST],
      training_rows: teamRows(all).length, lambda: LAMBDA, ...m, evidence: 'data/nfl/backtest-totals.json' }, null, 2) + '\n');
    console.log('wrote data/nfl/totals-model.json', JSON.stringify(m.coefficients), 'intercept', m.intercept.toFixed(2));
  }
  fs.writeFileSync(path.join(ROOT, 'data/nfl/backtest-totals.json'), JSON.stringify(evidence, null, 2) + '\n');
}
if (require.main === module) main();
