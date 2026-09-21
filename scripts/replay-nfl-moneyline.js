#!/usr/bin/env node
/**
 * Replay leo-nflml-v2 on 2026 games played BEFORE it went live (2026-09-21),
 * so the Model Tuner has games to work with from day one. Written to
 * data/nfl/ml-v2-replay.json and labelled "Replay" everywhere it is shown.
 * These are NOT predictions of record: the model did not exist when these
 * games were played. The public record is untouched.
 *
 * Inputs are strictly pregame (weeks before each game), same rows as the
 * backtest, scored with the live model file.
 *
 * Usage: node scripts/replay-nfl-moneyline.js
 */
const fs = require('fs');
const path = require('path');
const LIVE_FROM = '2026-09-21';
process.argv = [process.argv[0], process.argv[1], '--through', '2026'];
const { get, buildRows } = require('./backtest-nfl-moneyline');
const { predict } = require('./lib/nfl-moneyline');

const ROOT = path.join(__dirname, '..');
const REL = 'https://github.com/nflverse/nflverse-data/releases/download';
const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/nfl/moneyline-v2-model.json'), 'utf8'));
const games = get('https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv');
const stats = {};
for (let s = 2020; s <= 2026; s++) stats[s] = get(`${REL}/stats_player/stats_player_week_${s}.csv`);
const rows = buildRows(games, stats).filter(r => r.season === 2026 && r.gameday < LIVE_FROM);
const out = rows.map(r => ({
  source: 'replay', season: r.season, week: r.week, date: r.gameday, game_id: r.game_id,
  matchup: `${r.away} @ ${r.home}`, away: r.away, home: r.home, away_qb: r.away_qb, home_qb: r.home_qb,
  home_win: r.home_win, qb_diff: r.qb_diff, off_diff: r.off_diff, def_diff: r.def_diff,
  h2h_edge: r.h2h_edge, h2h_repeat: r.h2h_repeat,
  market_home_prob: r.market_home_prob, home_prob: predict(model, r)
}));
const file = path.join(ROOT, 'data/nfl/ml-v2-replay.json');
fs.writeFileSync(file, JSON.stringify({ generated_at: new Date().toISOString(), model_version: model.model_version,
  note: 'Replay, not predictions of record: leo-nflml-v2 went live 2026-09-21.', games: out }, null, 2) + '\n');
console.log(`replayed ${out.length} games played before ${LIVE_FROM} -> ${path.relative(ROOT, file)}`);
