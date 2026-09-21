#!/usr/bin/env node
/**
 * Leo NFL moneyline v2 — walk-forward research backtest.
 *
 * v2 probability inputs (NO sportsbook input):
 *   - expected starting QB rating (player-specific)
 *   - supporting offense rating
 *   - defense rating
 *   - 3-year pregame H2H result + repeat-meeting interaction
 *   - home-field baseline learned by the logistic intercept
 *
 * Public classifier rule:
 *   > 60% = Leo Pick
 *   40%..60% inclusive = Too Close to Call
 *
 * The closing moneyline is evaluation only: market Brier and realized ROI.
 * It never enters the fitted v2 probability.
 *
 * Default OOS folds:
 *   train 2021-22 -> test 2023
 *   train 2021-23 -> test 2024
 *   train 2021-24 -> test 2025
 *
 * Usage:
 *   node scripts/backtest-nfl-moneyline.js
 *   node scripts/backtest-nfl-moneyline.js --through 2024
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  PICK_THRESHOLD, buildQbRatings, buildTeamRatings, h2hRecord, featureRow,
  fitLogistic, predict, classifyPick
} = require('./lib/nfl-moneyline');

const ROOT = path.join(__dirname, '..');
const FEED = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const REL = 'https://github.com/nflverse/nflverse-data/releases/download';
const argv = process.argv.slice(2);
const arg = (name, d) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : d; };
const THROUGH = Number(arg('through', 2025));
const START = 2021;
const TEST_SEASONS = [2023, 2024, 2025].filter(s => s <= THROUGH);
const LAMBDAS = [0.1, 0.3, 1, 3, 10];
const CORE_FEATURES = ['qb_diff', 'off_diff', 'def_diff'];
const H2H_FEATURES = [...CORE_FEATURES, 'h2h_edge', 'h2h_repeat'];

function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift().map(x => x.trim());
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
function get(url) {
  const body = execFileSync('curl', ['-sSL', '--fail', '--max-time', '180', url], {
    maxBuffer: 1024 * 1024 * 512, encoding: 'utf8'
  });
  return parseCSV(body);
}
const n = v => { const x = Number.parseFloat(v); return Number.isFinite(x) ? x : null; };
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const impl = a => { const x = n(a); return x == null ? null : (x > 0 ? 100 / (x + 100) : (-x) / ((-x) + 100)); };
function devig(a, b) {
  const x = impl(a), y = impl(b);
  if (x == null || y == null) return [null, null];
  const s = x + y;
  return s ? [x / s, y / s] : [null, null];
}
const payout = (price, won) => won ? (price > 0 ? price / 100 : 100 / (-price)) : -1;

function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
function shrink(obs, nObs, prior, k) {
  return nObs ? ((nObs * obs) + (k * prior)) / (nObs + k) : prior;
}

/** Exact v1 point-margin baseline, unblended, evaluation only. */
function buildV1Ratings(history, priorGames) {
  const HFA = 2.0, K = 4;
  const m = {}, pm = {};
  const add = (o, t, v) => (o[t] = o[t] || []).push(v);
  for (const g of history) {
    const as = n(g.away_score), hs = n(g.home_score); if (as == null || hs == null) continue;
    add(m, g.away_team, (as - hs) + HFA);
    add(m, g.home_team, (hs - as) - HFA);
  }
  for (const g of priorGames) {
    const as = n(g.away_score), hs = n(g.home_score); if (as == null || hs == null) continue;
    add(pm, g.away_team, (as - hs) + HFA);
    add(pm, g.home_team, (hs - as) - HFA);
  }
  const R = {};
  const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  for (const t of new Set([...Object.keys(m), ...Object.keys(pm)])) {
    const c = m[t] || [], p = pm[t] || [];
    const prior = p.length ? shrink(avg(p), p.length, 0, 6) : 0;
    R[t] = shrink(c.length ? avg(c) : 0, c.length, prior, K);
  }
  return R;
}
function v1Prob(home, away, R) {
  const expMargin = (R[home] ?? 0) - (R[away] ?? 0) + 2.0;
  return normCdf(expMargin / 13.2);
}

function buildRows(allGames, statsBySeason) {
  const out = [];
  for (let season = START; season <= THROUGH; season++) {
    const games = allGames.filter(g => Number(g.season) === season && ['REG', 'POST'].includes(g.game_type));
    const priorGames = allGames.filter(g => Number(g.season) === season - 1 && ['REG', 'POST'].includes(g.game_type)
      && g.away_score !== '' && g.home_score !== '');
    const curStats = statsBySeason[season] || [];
    const priorStats = statsBySeason[season - 1] || [];
    const weeks = [...new Set(games.map(g => Number(g.week)).filter(Number.isFinite))].sort((a, b) => a - b);
    let built = 0;

    for (const week of weeks) {
      const slate = games.filter(g => Number(g.week) === week && g.away_score !== '' && g.home_score !== '');
      if (!slate.length) continue;
      const preStats = curStats.filter(r => Number(r.week) < week);
      const qb = buildQbRatings(preStats, priorStats);
      const team = buildTeamRatings(preStats, priorStats);
      const history = games.filter(g => Number(g.week) < week && g.away_score !== '' && g.home_score !== '');
      const v1 = buildV1Ratings(history, priorGames);

      for (const g of slate) {
        const hs = n(g.home_score), as = n(g.away_score);
        if (hs == null || as == null || hs === as) continue;
        const h2h = h2hRecord(allGames, g.away_team, g.home_team, g.gameday, 3);
        const f = featureRow({
          homeTeam: g.home_team, awayTeam: g.away_team,
          homeQb: g.home_qb_name, awayQb: g.away_qb_name,
          qbRatings: qb, teamRatings: team, h2h
        });
        const [mA, mH] = devig(g.away_moneyline, g.home_moneyline);
        out.push({
          season, week, game_id: g.game_id, gameday: g.gameday,
          away: g.away_team, home: g.home_team,
          away_qb: g.away_qb_name || '', home_qb: g.home_qb_name || '',
          home_win: hs > as ? 1 : 0,
          home_price: n(g.home_moneyline), away_price: n(g.away_moneyline),
          market_home_prob: mH,
          v1_prob: v1Prob(g.home_team, g.away_team, v1),
          h2h_home_wins: h2h.home_wins, h2h_away_wins: h2h.away_wins,
          h2h_ties: h2h.ties, h2h_games: h2h.games,
          ...f
        });
        built++;
      }
    }
    console.log(`  ${season}: ${built} pregame feature rows`);
  }
  return out;
}

function brier(rows, key) {
  const valid = rows.filter(r => Number.isFinite(r[key]));
  return valid.length ? valid.reduce((s, r) => s + (r[key] - r.home_win) ** 2, 0) / valid.length : null;
}
function accuracy(rows, key) {
  const valid = rows.filter(r => Number.isFinite(r[key]));
  return valid.length ? valid.filter(r => ((r[key] >= .5) ? 1 : 0) === r.home_win).length / valid.length : null;
}
function pickSummary(rows, key) {
  let picks = 0, wins = 0, units = 0, priced = 0;
  for (const r of rows) {
    const c = classifyPick(r[key], r.home, r.away);
    if (!c.pick) continue;
    picks++;
    const won = c.pick === (r.home_win ? r.home : r.away);
    if (won) wins++;
    const price = c.pick === r.home ? r.home_price : r.away_price;
    if (price != null) { priced++; units += payout(price, won); }
  }
  return {
    threshold: PICK_THRESHOLD,
    picks, wins,
    hit_rate: picks ? wins / picks : null,
    priced,
    units,
    roi: priced ? units / priced : null,
    coverage: rows.length ? picks / rows.length : null
  };
}
function calibration(rows, key) {
  const buckets = [[0.5, .55], [.55, .60], [.60, .65], [.65, .70], [.70, .75], [.75, 1.001]];
  const out = [];
  // Work on confidence in the selected side, not home-only probability.
  for (const [lo, hi] of buckets) {
    const b = rows.map(r => {
      const p = r[key];
      const conf = Math.max(p, 1 - p);
      const correct = ((p >= .5) ? r.home_win : 1 - r.home_win);
      return { conf, correct };
    }).filter(x => x.conf >= lo && x.conf < hi);
    if (!b.length) continue;
    out.push({
      band: `${Math.round(lo * 100)}-${hi > 1 ? '100' : (Math.round(hi * 100) - .1).toFixed(1)}%`,
      n: b.length,
      mean_confidence: b.reduce((s, x) => s + x.conf, 0) / b.length,
      actual_win_rate: b.reduce((s, x) => s + x.correct, 0) / b.length
    });
  }
  return out;
}

function chooseLambda(trainRows, features) {
  const seasons = [...new Set(trainRows.map(r => r.season))].sort((a, b) => a - b);
  const valSeason = seasons[seasons.length - 1];
  const fitRows = trainRows.filter(r => r.season < valSeason);
  const valRows = trainRows.filter(r => r.season === valSeason);
  if (fitRows.length < 100 || valRows.length < 50) return 1;
  let best = null;
  for (const lambda of LAMBDAS) {
    const model = fitLogistic(fitRows, features, { lambda });
    const scored = valRows.map(r => ({ ...r, prob: predict(model, r) }));
    const score = brier(scored, 'prob');
    if (!best || score < best.score) best = { lambda, score };
  }
  return best.lambda;
}

function runSpec(allRows, features, name) {
  const folds = [];
  const oos = [];
  for (const testSeason of TEST_SEASONS) {
    const train = allRows.filter(r => r.season < testSeason);
    const test = allRows.filter(r => r.season === testSeason);
    if (!train.length || !test.length) continue;
    const lambda = chooseLambda(train, features);
    const model = fitLogistic(train, features, { lambda });
    const scored = test.map(r => ({ ...r, prob: predict(model, r) }));
    oos.push(...scored);
    folds.push({
      test_season: testSeason,
      train_n: train.length,
      test_n: test.length,
      lambda,
      brier: brier(scored, 'prob'),
      accuracy: accuracy(scored, 'prob'),
      picks_60: pickSummary(scored, 'prob'),
      coefficients: { home_field_intercept: model.intercept, ...model.coefficients }
    });
  }
  const marketRows = oos.filter(r => r.market_home_prob != null);
  return {
    name, features, folds,
    oos_n: oos.length,
    oos_brier: brier(oos, 'prob'),
    oos_accuracy: accuracy(oos, 'prob'),
    picks_60: pickSummary(oos, 'prob'),
    calibration: calibration(oos, 'prob'),
    market_brier_same_games: brier(marketRows, 'market_home_prob'),
    v1_brier_same_games: brier(oos, 'v1_prob'),
    v1_picks_60: pickSummary(oos, 'v1_prob'),
    oos
  };
}

function main() {
  console.log(`\nLEO NFL MONEYLINE V2 RESEARCH — through ${THROUGH}\n${'='.repeat(72)}`);
  console.log('Loading games and weekly player data...');
  const allGames = get(FEED);
  const statsBySeason = {};
  for (let s = START - 1; s <= THROUGH; s++) {
    statsBySeason[s] = get(`${REL}/stats_player/stats_player_week_${s}.csv`);
    console.log(`  stats ${s}: ${statsBySeason[s].length} rows`);
  }

  console.log('\nBuilding strictly pregame feature rows...');
  const rows = buildRows(allGames, statsBySeason);
  console.log(`total rows: ${rows.length}`);

  console.log('\nFitting out-of-sample models...');
  const core = runSpec(rows, CORE_FEATURES, 'v2_core_qb_off_def');
  const h2h = runSpec(rows, H2H_FEATURES, 'v2_core_plus_3yr_h2h');

  const compact = spec => ({
    name: spec.name,
    oos_n: spec.oos_n,
    brier: spec.oos_brier,
    accuracy: spec.oos_accuracy,
    picks_60: spec.picks_60,
    market_brier: spec.market_brier_same_games,
    v1_brier: spec.v1_brier_same_games,
    folds: spec.folds
  });

  console.log('\nOOS SUMMARY (lower Brier is better)');
  for (const spec of [core, h2h]) {
    console.log(`\n${spec.name}`);
    console.log(`  n=${spec.oos_n}`);
    console.log(`  Brier ${spec.oos_brier.toFixed(4)}  accuracy ${(100 * spec.oos_accuracy).toFixed(1)}%`);
    console.log(`  >60% picks ${spec.picks_60.picks}/${spec.oos_n} (${(100 * spec.picks_60.coverage).toFixed(1)}% coverage)`);
    console.log(`  pick hit ${(100 * spec.picks_60.hit_rate).toFixed(1)}%  ROI ${spec.picks_60.roi == null ? 'n/a' : (100 * spec.picks_60.roi).toFixed(1) + '%'}`);
    if (spec.market_brier_same_games != null) console.log(`  market Brier ${spec.market_brier_same_games.toFixed(4)}`);
  }
  const delta = h2h.oos_brier - core.oos_brier;
  console.log(`\nH2H ablation: ${delta < 0 ? 'HELPS' : 'HURTS'} Brier by ${Math.abs(delta).toFixed(4)} OOS.`);
  console.log('H2H does not earn model weight merely because it is available; the ablation decides.');

  const result = {
    generated_at: new Date().toISOString(),
    model_version: 'leo-nflml-v2',
    rule: '>60% only; 40%-60% inclusive is Too Close to Call',
    no_market_in_probability: true,
    test_seasons: TEST_SEASONS,
    core: compact(core),
    core_plus_h2h: compact(h2h),
    h2h_ablation_brier_delta: delta,
    calibration: {
      core: core.calibration,
      core_plus_h2h: h2h.calibration
    }
  };
  const dir = path.join(ROOT, 'data/nfl');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'backtest-moneyline-v2.json');
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`\nwrote ${path.relative(ROOT, out)}`);
}

// Exported so scripts/train-nfl-moneyline.js fits the live model with the
// exact same pregame feature rows the backtest evaluated.
module.exports = { get, buildRows, chooseLambda, CORE_FEATURES, H2H_FEATURES, START };
if (require.main === module) main();
