#!/usr/bin/env node
/**
 * Fit the live NFL moneyline model (leo-nflml-v2) and save it to
 * data/nfl/moneyline-v2-model.json. generate-nfl-model.js loads that file
 * every run; it never refits on its own, so the live number is stable and
 * reproducible.
 *
 * Features: CORE (starting-QB rating, supporting offense, defense) plus the
 * fitted home-field intercept. Three-year H2H was tested on 2026-09-21 and
 * improved out-of-sample Brier by only 0.0001 with a wrong-signed direction
 * coefficient, so it earns no weight (it is still shown as context).
 * No sportsbook input. Rows are strictly pregame (see backtest-nfl-moneyline.js).
 *
 * Usage: node scripts/train-nfl-moneyline.js [--through 2025]
 * Re-run after each season, or when the backtest is re-validated.
 */
const fs = require('fs');
const path = require('path');
const { fitLogistic } = require('./lib/nfl-moneyline');

const argv = process.argv.slice(2);
const i = argv.indexOf('--through');
const through = i >= 0 ? argv[i + 1] : '2025';
// backtest-nfl-moneyline.js reads --through from process.argv at load time.
process.argv = [process.argv[0], process.argv[1], '--through', through];
const { get, buildRows, chooseLambda, CORE_FEATURES, START } = require('./backtest-nfl-moneyline');

const ROOT = path.join(__dirname, '..');
const FEED = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const REL = 'https://github.com/nflverse/nflverse-data/releases/download';

const allGames = get(FEED);
const stats = {};
for (let s = START - 1; s <= Number(through); s++) stats[s] = get(`${REL}/stats_player/stats_player_week_${s}.csv`);
const rows = buildRows(allGames, stats);
const lambda = chooseLambda(rows, CORE_FEATURES);
const m = fitLogistic(rows, CORE_FEATURES, { lambda });

const out = {
  model_version: 'leo-nflml-v2',
  trained_at: new Date().toISOString(),
  trained_seasons: [START, Number(through)],
  training_rows: rows.length,
  features: m.features,
  lambda: m.lambda,
  intercept: m.intercept,
  beta: m.beta,
  scaler: m.scaler,
  coefficients: m.coefficients,
  pick_rule: 'Leo Pick only when one team is strictly above 60%; 40% to 60% inclusive is Too Close to Call',
  evidence: 'data/nfl/backtest-moneyline-v2.json'
};
const file = path.join(ROOT, 'data/nfl/moneyline-v2-model.json');
fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(`trained leo-nflml-v2 on ${rows.length} games (${START}-${through}), lambda ${lambda}`);
console.log(`home-field ${m.intercept.toFixed(3)}  ${Object.entries(m.coefficients).map(([k, v]) => `${k} ${v.toFixed(3)}`).join('  ')}`);
console.log(`wrote ${path.relative(ROOT, file)}`);
