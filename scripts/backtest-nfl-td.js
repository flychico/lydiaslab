#!/usr/bin/env node
/**
 * Anytime-TD model (leo-nfltd-v2): walk-forward backtest and trainer.
 *
 *   node scripts/backtest-nfl-td.js            backtest: train <S, test S, S = 2023..2025
 *   node scripts/backtest-nfl-td.js --train    fit on 2022-2025, write data/nfl/td-model.json
 *
 * Every row is strictly pregame: a player's usage, TD rate and his team's
 * scoring come only from weeks before the game. The label is whether he
 * scored a rushing or receiving TD (what grade-nfl-props.js grades).
 * Only players who actually played that week are rows, mirroring the live
 * rule that Out and Doubtful players are never projected.
 *
 * Writes data/nfl/backtest-td.json (evidence) in both modes.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const TD = require('./lib/nfl-td-model');
const { fitLogistic } = require('./lib/nfl-moneyline');

const ROOT = path.join(__dirname, '..');
const FEED = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const REL = 'https://github.com/nflverse/nflverse-data/releases/download';
const FIRST = 2022, LAST = 2025, TEST = [2023, 2024, 2025];
const LAMBDA = 1;
const TRAIN = process.argv.includes('--train');

function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift().map(x => x.trim());
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
const get = url => parseCSV(execFileSync('curl', ['-sSL', '--fail', '--max-time', '180', url],
  { maxBuffer: 1024 * 1024 * 512, encoding: 'utf8' }));
const num = v => { const x = Number.parseFloat(v); return Number.isFinite(x) ? x : 0; };

function logsBySeason(rows) {
  // player_id -> [{week, team, pos, car, tgt, rtd, rectd, name}], regular season only
  const m = new Map();
  for (const r of rows) {
    if (r.season_type && r.season_type !== 'REG') continue;
    if (!TD.POSITIONS.includes(r.position)) continue;
    const e = m.get(r.player_id) || [];
    e.push({ week: num(r.week), team: r.team, pos: r.position, name: r.player_display_name,
             car: num(r.carries), tgt: num(r.targets), rtd: num(r.rushing_tds), rectd: num(r.receiving_tds) });
    m.set(r.player_id, e);
  }
  for (const e of m.values()) e.sort((a, b) => a.week - b.week);
  return m;
}

function buildRows(games, stats) {
  const out = [];
  for (let season = FIRST; season <= LAST; season++) {
    const cur = logsBySeason(stats[season]), prior = logsBySeason(stats[season - 1]);
    const sg = games.filter(g => Number(g.season) === season && g.game_type === 'REG' && g.home_score !== '');
    const weeks = [...new Set(sg.map(g => Number(g.week)))].sort((a, b) => a - b).filter(w => w >= 2);
    for (const week of weeks) {
      const scoring = TD.teamScoring(games, season, week);
      for (const g of sg.filter(x => Number(x.week) === week)) {
        for (const [team, opp, home] of [[g.home_team, g.away_team, true], [g.away_team, g.home_team, false]]) {
          const players = [];
          for (const [id, log] of cur) {
            const before = log.filter(x => x.week < week);
            const now = log.find(x => x.week === week);
            if (!before.length || !now || now.team !== team) continue;
            if (before[before.length - 1].team !== team) continue;
            players.push({ id, name: now.name, pos: now.pos, cur: before, prior: prior.get(id) || [], now });
          }
          for (const p of TD.candidates(players)) {
            const row = TD.featureRow({ pos: p.pos, cur: p.cur, prior: p.prior, team, opp, home, scoring, depth: p.depth });
            out.push({ ...row, season, week, game_id: g.game_id, team, player: p.name, pos: p.pos,
                       depth: p.depth, home_win: TD.tdsOf(p.now) > 0 ? 1 : 0 });
          }
        }
      }
    }
    console.log(`  ${season}: ${out.filter(r => r.season === season).length} player-games`);
  }
  return out;
}

const brier = rows => rows.reduce((s, r) => s + (r.prob - r.home_win) ** 2, 0) / rows.length;
function calibration(rows) {
  const bins = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 1.01];
  return bins.slice(0, -1).map((lo, i) => {
    const b = rows.filter(r => r.prob >= lo && r.prob < bins[i + 1]);
    return { bin: `${lo}-${Math.min(1, bins[i + 1])}`, n: b.length,
             predicted: b.length ? +(b.reduce((s, r) => s + r.prob, 0) / b.length).toFixed(3) : null,
             actual: b.length ? +(b.reduce((s, r) => s + r.home_win, 0) / b.length).toFixed(3) : null };
  });
}
function topPicks(rows) {
  const byGame = new Map();
  rows.forEach(r => { const a = byGame.get(r.game_id) || []; a.push(r); byGame.set(r.game_id, a); });
  let top1 = 0, top2any = 0, n = 0;
  for (const a of byGame.values()) {
    a.sort((x, y) => y.prob - x.prob); n++;
    top1 += a[0].home_win; top2any += (a[0].home_win || (a[1] && a[1].home_win)) ? 1 : 0;
  }
  return { games: n, top_pick_scored: +(top1 / n).toFixed(3), top_two_at_least_one: +(top2any / n).toFixed(3) };
}

function main() {
  const games = get(FEED);
  const stats = {};
  for (let s = FIRST - 1; s <= LAST; s++) stats[s] = get(`${REL}/stats_player/stats_player_week_${s}.csv`);
  const rows = buildRows(games, stats);
  const evidence = { generated_at: new Date().toISOString(), model_version: 'leo-nfltd-v2',
                     features: TD.FEATURES, lambda: LAMBDA, folds: [] };
  const oos = [];
  for (const t of TEST) {
    const train = rows.filter(r => r.season < t), test = rows.filter(r => r.season === t);
    const m = fitLogistic(train, TD.FEATURES, { lambda: LAMBDA });
    const scored = test.map(r => ({ ...r, prob: TD.probability(m, r) }));
    const rate = test.reduce((s, r) => s + r.home_win, 0) / test.length;
    const posRate = {};
    for (const p of TD.POSITIONS) { const x = train.filter(r => r.pos === p); posRate[p] = x.reduce((s, r) => s + r.home_win, 0) / x.length; }
    evidence.folds.push({
      test_season: t, train_n: train.length, test_n: test.length, scored_rate: +rate.toFixed(3),
      brier: +brier(scored).toFixed(4),
      brier_constant: +(test.reduce((s, r) => s + (rate - r.home_win) ** 2, 0) / test.length).toFixed(4),
      brier_position_avg: +(test.reduce((s, r) => s + (posRate[r.pos] - r.home_win) ** 2, 0) / test.length).toFixed(4)
    });
    oos.push(...scored);
  }
  evidence.oos = {
    n: oos.length, brier: +brier(oos).toFixed(4),
    calibration: calibration(oos), top_picks: topPicks(oos),
    by_depth: Object.fromEntries([...new Set(oos.map(r => r.depth))].sort().map(d => {
      const x = oos.filter(r => r.depth === d);
      return [d, { n: x.length, predicted: +(x.reduce((s, r) => s + r.prob, 0) / x.length).toFixed(3),
                   actual: +(x.reduce((s, r) => s + r.home_win, 0) / x.length).toFixed(3) }];
    }))
  };
  console.log(JSON.stringify(evidence.folds, null, 1));
  console.log(JSON.stringify(evidence.oos, null, 1));

  if (TRAIN) {
    const m = fitLogistic(rows, TD.FEATURES, { lambda: LAMBDA });
    const model = { model_version: 'leo-nfltd-v2', trained_at: new Date().toISOString(),
      trained_seasons: [FIRST, LAST], training_rows: rows.length, features: m.features, lambda: m.lambda,
      intercept: m.intercept, beta: m.beta, scaler: m.scaler, coefficients: m.coefficients,
      ceiling: TD.CEILING, evidence: 'data/nfl/backtest-td.json' };
    fs.writeFileSync(path.join(ROOT, 'data/nfl/td-model.json'), JSON.stringify(model, null, 2) + '\n');
    console.log('wrote data/nfl/td-model.json', JSON.stringify(m.coefficients));
  }
  fs.writeFileSync(path.join(ROOT, 'data/nfl/backtest-td.json'), JSON.stringify(evidence, null, 2) + '\n');
}
if (require.main === module) main();
module.exports = { buildRows, get, FEED, REL };
