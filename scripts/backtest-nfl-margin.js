#!/usr/bin/env node
/**
 * Leo NFL: one model for the margin (SEO-15, Lynold's yes Nov 2, 2026).
 *
 * Question: should spread calls use a margin taken from the v2 win chance
 * (leo-nflml-v2) instead of the old v1 point-margin rating? Today the two
 * models can pick different winners, and the calls rule then passes.
 *
 * Pre-registered before running (DEC-20261102-04):
 *   v2 margin  = 13.2 * probit(v2 home win chance), the same points-to-chance
 *                mapping v1 already uses (SD 13.2). Nothing is fitted to it.
 *   Spread call rule unchanged: |margin - line| >= 1.0 on the side the margin
 *   favours; for v1, PASS when v1's winner differs from v2's winner.
 *   Win = covers the CLOSING spread; priced at -110 (+0.909 / -1, push 0).
 *   Adopt only if v2 beats v1 on ATS units across the three OOS seasons
 *   AND is not worse on margin error (MAE vs the final). Under 50 calls
 *   in any slice is an early read.
 *
 * Walk-forward folds (same as backtest-nfl-moneyline.js):
 *   train 2021-22 -> test 2023, 2021-23 -> 2024, 2021-24 -> 2025.
 * Second check: 2026 frozen reads (prediction-history.csv, last capture
 * before kickoff) graded on nfl-results-log.csv.
 *
 * The line is only used to grade and to decide whether Leo is far enough
 * from it. It never enters a margin.
 *
 * No closing line value here: nflverse carries closing lines only, so there
 * is no earlier line to compare against. CLV is measured live (clv.json).
 *
 * Usage: node scripts/backtest-nfl-margin.js   -> data/nfl/backtest-margin.json
 */
const fs = require('fs');
const path = require('path');
const { get, buildRows, chooseLambda, CORE_FEATURES, START } = require('./backtest-nfl-moneyline');
const { fitLogistic, predict } = require('./lib/nfl-moneyline');

const ROOT = path.join(__dirname, '..');
const FEED = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const REL = 'https://github.com/nflverse/nflverse-data/releases/download';
const TEST_SEASONS = [2023, 2024, 2025];
const SD = 13.2, FLOOR = 1.0;
const n = v => { const x = Number.parseFloat(v); return Number.isFinite(x) ? x : null; };

function normCdf(z) { // same approximation as v1
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
function probit(p) { // inverse of normCdf above, by bisection
  if (!(p > 0 && p < 1)) return null;
  let lo = -8, hi = 8;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (normCdf(mid) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
const toMargin = p => { const z = probit(p); return z == null ? null : SD * z; };

/** One spread call. margin and line are home side (positive = home favoured). */
function spreadCall(margin, line, home, away, pickWinner) {
  if (margin == null || line == null) return null;
  const gap = margin - line;
  if (Math.abs(gap) < FLOOR) return null;
  const mWin = margin > 0 ? home : margin < 0 ? away : null;
  if (pickWinner && mWin && mWin !== pickWinner) return null;
  return { side: gap > 0 ? 'home' : 'away', gap };
}
function gradeCall(c, result, line) {
  if (!c) return null;
  if (result === line) return 'P';
  return (c.side === 'home') === (result > line) ? 'W' : 'L';
}
function summarize(rows, key) {
  let w = 0, l = 0, p = 0, err = 0, ne = 0;
  const buckets = { '1-3': [0, 0], '3-5': [0, 0], '5+': [0, 0] };
  for (const r of rows) {
    if (r[key + '_margin'] != null) { err += Math.abs(r[key + '_margin'] - r.result); ne++; }
    const g = r[key + '_grade']; if (!g) continue;
    if (g === 'W') w++; else if (g === 'L') l++; else p++;
    const a = Math.abs(r[key + '_gap']), b = a < 3 ? '1-3' : a < 5 ? '3-5' : '5+';
    if (g !== 'P') buckets[b][g === 'W' ? 0 : 1]++;
  }
  const units = w * (100 / 110) - l;
  return {
    calls: w + l + p, wins: w, losses: l, pushes: p,
    hit_rate: w + l ? w / (w + l) : null, units: Math.round(units * 100) / 100,
    roi: w + l + p ? units / (w + l + p) : null,
    margin_mae: ne ? err / ne : null, coverage: rows.length ? (w + l + p) / rows.length : null,
    by_gap: Object.fromEntries(Object.entries(buckets).map(([k, [a, b]]) => [k, `${a}-${b}`]))
  };
}

function backtest(games) {
  const stats = {};
  for (let s = START - 1; s <= 2025; s++) stats[s] = get(`${REL}/stats_player/stats_player_week_${s}.csv`);
  const rows = buildRows(games, stats);
  const byId = Object.fromEntries(games.map(g => [g.game_id, g]));
  const oos = [];
  for (const test of TEST_SEASONS) {
    const train = rows.filter(r => r.season < test), te = rows.filter(r => r.season === test);
    const lambda = chooseLambda(train, CORE_FEATURES);
    const model = fitLogistic(train, CORE_FEATURES, { lambda });
    for (const r of te) {
      const g = byId[r.game_id];
      const line = n(g.spread_line), result = n(g.result);
      if (line == null || result == null) continue;
      const pH = predict(model, r);
      const pick = pH >= 0.5 ? r.home : r.away;
      const v1m = toMargin(r.v1_prob), v2m = toMargin(pH);
      const c1 = spreadCall(v1m, line, r.home, r.away, pick);
      const c2 = spreadCall(v2m, line, r.home, r.away, pick);
      oos.push({ season: r.season, game_id: r.game_id, home: r.home, away: r.away, line, result,
        v2_prob: pH, v1_margin: v1m, v2_margin: v2m,
        v1_gap: c1 && c1.gap, v2_gap: c2 && c2.gap,
        v1_grade: gradeCall(c1, result, line), v2_grade: gradeCall(c2, result, line),
        v1_disagree: v1m != null && Math.sign(v1m) !== Math.sign(pH - 0.5) });
    }
  }
  return oos;
}

/** 2026 frozen reads: last capture before kickoff, finals from nflverse. */
function live2026(games) {
  const t = fs.readFileSync(path.join(ROOT, 'data/nfl/prediction-history.csv'), 'utf8').trim().split('\n');
  const h = t.shift().split(',');
  const hist = t.map(l => { const v = l.split(','); return Object.fromEntries(h.map((k, i) => [k, v[i]])); });
  const fin = {};
  for (const g of games) if (Number(g.season) === 2026 && n(g.result) != null) fin[g.game_id] = g;
  const last = {};
  for (const r of hist) {
    if (!fin[r.game_id]) continue;
    const cap = Date.parse(r.captured_at), ko = Date.parse(r.kickoff_utc);
    if (!Number.isFinite(cap) || !Number.isFinite(ko) || cap >= ko) continue;
    if (!last[r.game_id] || r.captured_at > last[r.game_id].captured_at) last[r.game_id] = r;
  }
  const out = [];
  for (const r of Object.values(last)) {
    const line = n(r.spread_line), prob = n(r.model_prob);
    if (line == null || prob == null || !r.pick) continue;
    const result = n(fin[r.game_id].result);
    const pH = r.pick === r.home ? prob : 1 - prob;
    const v1m = n(r.exp_margin !== '' ? r.exp_margin : r.proj_spread), v2m = toMargin(pH);
    const c1 = spreadCall(v1m, line, r.home, r.away, r.pick), c2 = spreadCall(v2m, line, r.home, r.away, r.pick);
    out.push({ date: r.date, game_id: r.game_id, line, result, v1_margin: v1m, v2_margin: v2m,
      v1_gap: c1 && c1.gap, v2_gap: c2 && c2.gap, v1_grade: gradeCall(c1, result, line), v2_grade: gradeCall(c2, result, line),
      model_version: r.model_version });
  }
  return out;
}

function main() {
  console.log('Loading nflverse games and weekly player stats...');
  const games = get(FEED);
  const oos = backtest(games);
  const live = live2026(games);
  const per = TEST_SEASONS.map(s => { const r = oos.filter(x => x.season === s); return { season: s, games: r.length, v1: summarize(r, 'v1'), v2: summarize(r, 'v2') }; });
  const out = {
    generated_at: new Date().toISOString(), decision: 'DEC-20261102-04',
    rule: 'margin = 13.2 * probit(v2 home win chance); spread call |margin - line| >= 1; v1 also passes when its winner differs from v2',
    oos: { games: oos.length, v1: summarize(oos, 'v1'), v2: summarize(oos, 'v2'), v1_disagree_games: oos.filter(r => r.v1_disagree).length, by_season: per },
    live_2026: { games: live.length, v1: summarize(live, 'v1'), v2: summarize(live, 'v2'), rows: live },
  };
  fs.writeFileSync(path.join(ROOT, 'data/nfl/backtest-margin.json'), JSON.stringify(out, null, 2));
  const fmt = s => `${s.wins}-${s.losses}-${s.pushes} (${s.calls} calls, ${s.hit_rate == null ? '-' : (s.hit_rate * 100).toFixed(1) + '%'}, ${s.units >= 0 ? '+' : ''}${s.units}u, MAE ${s.margin_mae == null ? '-' : s.margin_mae.toFixed(2)}) gaps ${JSON.stringify(s.by_gap)}`;
  console.log(`\nOOS 2023-2025, ${oos.length} games`);
  console.log('  v1 margin: ' + fmt(out.oos.v1));
  console.log('  v2 margin: ' + fmt(out.oos.v2));
  for (const p of per) console.log(`  ${p.season}: v1 ${fmt(p.v1)}\n        v2 ${fmt(p.v2)}`);
  console.log(`\n2026 frozen reads, ${live.length} games`);
  console.log('  v1 margin: ' + fmt(out.live_2026.v1));
  console.log('  v2 margin: ' + fmt(out.live_2026.v2));
}
if (require.main === module) main();
module.exports = { toMargin, spreadCall, gradeCall };
