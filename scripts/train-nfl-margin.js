#!/usr/bin/env node
/**
 * Fit leo-nflmargin-v2 (scripts/lib/nfl-margin-v2.js) and the private shadow
 * win chance with injuries beyond the QB. DEC-20261120-02.
 *
 *   node scripts/train-nfl-margin.js            -> data/nfl/margin-v2-model.json
 *
 * Walk-forward check first (train on seasons before each test season, test
 * 2023, 2024, 2025), then the live fit on 2021 to 2025. Margin: ridge, lambda 1.
 * Shadow win chance: L2 logistic on qb_diff, off_diff, def_diff, injr_all_d.
 * The closing spread is only used to grade the walk-forward calls.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { get, buildRows, chooseLambda, CORE_FEATURES } = require("./backtest-nfl-moneyline");
const { fitLogistic, predict: mlPredict } = require("./lib/nfl-moneyline");
const { fitRidge } = require("./lib/nfl-totals-model");
const MV = require("./lib/nfl-margin-v2");

const REL = "https://github.com/nflverse/nflverse-data/releases/download";
const FEED = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";
const START = 2021, LAST = 2025, TESTS = [2023, 2024, 2025];
const n = v => { const x = Number.parseFloat(v); return Number.isFinite(x) ? x : null; };
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;

function main() {
  const games = get(FEED);
  const stats = {}, snaps = {}, inj = {};
  for (let s = START - 1; s <= LAST; s++) {
    stats[s] = get(`${REL}/stats_player/stats_player_week_${s}.csv`);
    snaps[s] = get(`${REL}/snap_counts/snap_counts_${s}.csv`);
    inj[s] = get(`${REL}/injuries/injuries_${s}.csv`);
  }
  const rows = buildRows(games, stats).filter(r => r.season >= START);
  const byId = new Map(rows.map(r => [r.game_id, r]));
  for (let s = START; s <= LAST; s++) {
    const gs = MV.finished(games, s);
    const teams = [...new Set(gs.flatMap(g => [g.home_team, g.away_team]))].sort();
    const prior = MV.finalRatings(games, s - 1);
    const ix = MV.snapIndex([...snaps[s - 1], ...snaps[s]]);
    for (const wk of [...new Set(gs.map(g => +g.week))].sort((a, b) => a - b)) {
      const S = MV.sosRatings(gs.filter(g => +g.week < wk), teams, prior);
      for (const g of gs.filter(g => +g.week === wk)) {
        const r = byId.get(g.game_id); if (!r) continue;
        r.margin = n(g.home_score) - n(g.away_score); r.line = n(g.spread_line);
        r.sos_d = (S.r[g.home_team] || 0) - (S.r[g.away_team] || 0);
        r.home = g.location === "Neutral" ? 0 : 1;
        r.injr_all_d = MV.injuryTotal(ix, inj[s], s, g.home_team, wk).total - MV.injuryTotal(ix, inj[s], s, g.away_team, wk).total;
      }
    }
  }
  const R = rows.filter(r => r.margin != null);
  const ML = [...CORE_FEATURES, "injr_all_d"];
  const check = {};
  for (const t of TESTS) {
    const train = R.filter(r => r.season < t), test = R.filter(r => r.season === t);
    const f = fitRidge(train.map(r => ({ ...r, y: r.margin })), MV.FEATURES, 1);
    const mlm = fitLogistic(train, CORE_FEATURES, { lambda: chooseLambda(train, CORE_FEATURES) });
    const shm = fitLogistic(train, ML, { lambda: chooseLambda(train, ML) });
    let w = 0, l = 0, u = 0;
    for (const r of test) {
      if (r.line == null) continue;
      const m = MV.predict(f, r), gap = m - r.line, side = gap >= 1.5 ? 1 : gap <= -1.5 ? 0 : null;
      if (side == null || side !== (mlPredict(mlm, r) >= 0.5 ? 1 : 0)) continue;
      const c = r.margin - r.line; if (c === 0) continue;
      if ((side === 1) === (c > 0)) { w++; u += 100 / 110; } else { l++; u -= 1; }
    }
    check[t] = { games: test.length, miss: +avg(test.map(r => Math.abs(MV.predict(f, r) - r.margin))).toFixed(3),
      line_miss: +avg(test.filter(r => r.line != null).map(r => Math.abs(r.line - r.margin))).toFixed(3),
      calls: `${w}-${l}`, units: +u.toFixed(2),
      win_chance_brier: +avg(test.map(r => (mlPredict(mlm, r) - r.home_win) ** 2)).toFixed(4),
      shadow_brier: +avg(test.map(r => (mlPredict(shm, r) - r.home_win) ** 2)).toFixed(4) };
    console.log(t, JSON.stringify(check[t]));
  }
  const fit = fitRidge(R.map(r => ({ ...r, y: r.margin })), MV.FEATURES, 1);
  const sd = Math.sqrt(avg(R.map(r => (r.margin - MV.predict(fit, r)) ** 2)));
  const shadow = fitLogistic(R, ML, { lambda: chooseLambda(R, ML) });
  const out = { model_version: MV.MODEL_VERSION, trained_at: new Date().toISOString(), trained_seasons: [START, LAST], training_rows: R.length,
    features: fit.features, lambda: 1, intercept: fit.intercept, beta: fit.beta, coefficients: fit.coefficients, resid_sd: +sd.toFixed(3),
    constants: { PR: MV.PR, PK: MV.PK, HCA: MV.HCA, HK: MV.HK },
    spread_rule: "call when Leo's margin is 1.5+ points off the line and the side covers for the team Leo's win chance favours",
    walk_forward: check,
    shadow_win_chance: { note: "private, not shown or graded publicly (Lynold, Nov 20: track it privately)", ...shadow } };
  fs.writeFileSync(path.join(__dirname, "..", "data", "nfl", "margin-v2-model.json"), JSON.stringify(out, null, 1) + "\n");
  console.log("wrote data/nfl/margin-v2-model.json", JSON.stringify(fit.coefficients), "sd", out.resid_sd);
}
if (require.main === module) main();
