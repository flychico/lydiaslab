#!/usr/bin/env node
/**
 * Train and backtest Leo NBA v1 (scripts/lib/nba-model.js).
 *
 *   node scripts/train-nba.js            backtest only, prints the table
 *   node scripts/train-nba.js --write    also writes data/nba/model.json and
 *                                        data/nba/backtest.json
 *
 * Walk-forward: each test season is predicted with coefficients fitted only
 * on earlier seasons, and every game only sees games before its date. The
 * market lines (DraftKings via ESPN, data/nba/lines-<season>.jsonl) are used
 * for grading and never as an input.
 *
 * Training uses who actually sat out each game as "value missing". Live,
 * that input comes from the injury report, which is less certain, so the
 * backtest also reports a version that only knows who sat out the team's
 * previous game. Live results should land between the two.
 */
const fs = require("fs");
const path = require("path");
const M = require("./lib/nba-model");

const SEASONS = [2023, 2024, 2025, 2026, 2027];
const TRAIN_FROM = 2024;               // 2023 only seeds the priors
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "data", "nba");

function lines(season) {
  const f = path.join(OUT, `lines-${season}.jsonl`); const out = {};
  if (!fs.existsSync(f)) return out;
  for (const l of fs.readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    const j = JSON.parse(l); if (!j.lines || !j.lines.length) continue;
    const L = j.lines.find(x => x.provider === "DraftKings") || j.lines[0];
    out[String(j.game_id)] = L;
  }
  return out;
}

async function features() {
  const rows = [], finals = {};
  let lastFinal = {};
  for (const s of SEASONS) {
    const { games, players } = await M.loadSeason(s, { maxAgeHours: 24 * 30 });
    const teams = [...new Set(games.flatMap(g => [g.home, g.away]))].sort();
    const prior = Object.fromEntries(teams.map(t => [t, M.PRIOR_REGRESS * (lastFinal[t] || 0)]));
    const L = lines(s);
    const playedIn = new Map();   // game_id|team -> Set of athlete ids who logged minutes
    for (const p of players) if (p.played) { const k = p.game_id + "|" + p.team; if (!playedIn.has(k)) playedIn.set(k, new Set()); playedIn.get(k).add(p.id); }
    const lastGame = {};          // team -> {date, game_id}
    const dates = [...new Set(games.map(g => g.date))];
    for (const d of dates) {
      const prev = games.filter(g => g.date < d);
      const { r } = M.ratings(prev, teams, prior);
      const regs = M.regulars(players, d);
      const today = games.filter(g => g.date === d);
      for (const g of today) {
        const f = { season: s, game_id: g.game_id, date: d, home: g.home, away: g.away, margin: g.margin, rating_diff: r[g.home] - r[g.away] };
        for (const side of ["home", "away"]) {
          const team = g[side], lg = lastGame[team];
          const { rest, b2b } = M.restDays(lg && lg.date, d);
          f[side + "_rest"] = rest; f[side + "_b2b"] = b2b;
          const sat = playedIn.get(g.game_id + "|" + team) || new Set();
          f[side + "_lost"] = M.lostValue(regs, team, x => sat.has(x.id) ? 0 : 1).lost;
          const prevSat = lg ? (playedIn.get(lg.game_id + "|" + team) || new Set()) : null;
          f[side + "_lost_prev"] = prevSat ? M.lostValue(regs, team, x => prevSat.has(x.id) ? 0 : 1).lost : 0;
        }
        f.b2b_d = f.home_b2b - f.away_b2b; f.rest_d = f.home_rest - f.away_rest;
        f.lost_d = f.home_lost - f.away_lost; f.lost_prev_d = f.home_lost_prev - f.away_lost_prev;
        const l = L[g.game_id];
        if (l && l.spread != null) { f.mkt_margin = -l.spread; f.home_ml = l.home_ml; f.away_ml = l.away_ml; }
        rows.push(f);
      }
      for (const g of today) { lastGame[g.home] = { date: d, game_id: g.game_id }; lastGame[g.away] = { date: d, game_id: g.game_id }; }
    }
    lastFinal = M.ratings(games, teams, prior).r;
    finals[s] = lastFinal;
    console.log(`  ${s}: ${games.length} games`);
  }
  return { rows, finals };
}

function ols(rows, X) {
  const k = X.length + 1, A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (const r of rows) { const x = [1, ...X.map(c => r[c])]; for (let i = 0; i < k; i++) { b[i] += x[i] * r.margin; for (let j = 0; j < k; j++) A[i][j] += x[i] * x[j]; } }
  const w = M.solve(A, b);
  const coef = Object.fromEntries([["intercept", w[0]], ...X.map((c, i) => [c, w[i + 1]])]);
  const pred = r => w[0] + X.reduce((s, c, i) => s + w[i + 1] * r[c], 0);
  const resid = rows.map(r => r.margin - pred(r)), mean = resid.reduce((s, v) => s + v, 0) / resid.length;
  const sd = Math.sqrt(resid.reduce((s, v) => s + (v - mean) ** 2, 0) / resid.length);
  return { coef, resid_sd: sd, pred };
}

const payout = ml => ml < 0 ? 100 / -ml : ml / 100;
function evaluate(rows, X, label) {
  const tested = [];
  for (const test of [2026, 2027]) {
    const fit = ols(rows.filter(r => r.season >= TRAIN_FROM && r.season < test), X);
    for (const r of rows.filter(r => r.season === test)) {
      const m = fit.pred(r); tested.push({ ...r, pred: m, p_home: M.normCdf(m / fit.resid_sd) });
    }
  }
  const g = tested.filter(r => r.mkt_margin != null && r.home_ml && r.away_ml);
  const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
  const y = r => r.margin > 0 ? 1 : 0;
  g.forEach(r => { r.mkt_p = M.noVig(r.home_ml, r.away_ml); });
  const out = {
    label, games: g.length,
    miss_leo: +avg(g.map(r => Math.abs(r.pred - r.margin))).toFixed(2),
    miss_line: +avg(g.map(r => Math.abs(r.mkt_margin - r.margin))).toFixed(2),
    brier_leo: +avg(g.map(r => (r.p_home - y(r)) ** 2)).toFixed(4),
    brier_market: +avg(g.map(r => (r.mkt_p - y(r)) ** 2)).toFixed(4),
    winner_leo: +avg(g.map(r => +((r.p_home > .5) === !!y(r)))).toFixed(3),
    winner_market: +avg(g.map(r => +((r.mkt_p > .5) === !!y(r)))).toFixed(3),
    spread: [], moneyline: []
  };
  for (const t of [0, 2, 3, 4, 5, 6]) {
    let w = 0, l = 0, p = 0;
    for (const r of g) {
      const d = r.pred - r.mkt_margin; if (Math.abs(d) < t || d === 0) continue;
      const res = Math.sign(d) * (r.margin - r.mkt_margin); if (res > 0) w++; else if (res < 0) l++; else p++;
    }
    out.spread.push({ edge_pts: t, won: w, lost: l, push: p, pct: +(w / Math.max(1, w + l)).toFixed(3), roi_at_110: +((w * 100 / 110 - l) / Math.max(1, w + l + p)).toFixed(3) });
  }
  for (const e of [0.05, 0.08, 0.10]) {
    const res = [];
    for (const r of g) {
      const eh = r.p_home - r.mkt_p;
      if (eh >= e) res.push(r.margin > 0 ? payout(r.home_ml) : -1);
      else if (-eh >= e) res.push(r.margin < 0 ? payout(r.away_ml) : -1);
    }
    out.moneyline.push({ edge: e, bets: res.length, won: res.filter(v => v > 0).length, roi: res.length ? +avg(res).toFixed(3) : null });
  }
  return out;
}

(async () => {
  console.log("Building features (walk-forward, no future data)...");
  const { rows, finals } = await features();
  const variants = [
    ["Team ratings only", ["rating_diff"]],
    ["+ rest and back-to-backs", ["rating_diff", "b2b_d", "rest_d"]],
    ["+ regulars who sat out the previous game", ["rating_diff", "b2b_d", "rest_d", "lost_prev_d"]],
    ["+ exactly who sat out (training input, upper limit)", ["rating_diff", "b2b_d", "rest_d", "lost_d"]]
  ];
  const results = variants.map(([l, X]) => evaluate(rows, X, l));
  for (const r of results) {
    const s4 = r.spread.find(s => s.edge_pts === 4), m10 = r.moneyline.find(m => m.edge === 0.10);
    console.log(`${r.label.padEnd(52)} miss ${r.miss_leo}/${r.miss_line}  brier ${r.brier_leo}/${r.brier_market}  4+pt ${s4.won}-${s4.lost} (${(s4.pct * 100).toFixed(1)}%)  ML10 ${m10.bets} roi ${m10.roi}`);
  }
  if (!process.argv.includes("--write")) return;
  // Production fit: every completed season from TRAIN_FROM.
  const current = Math.max(...SEASONS);
  const fit = ols(rows.filter(r => r.season >= TRAIN_FROM && r.season < current), M.FEATURES);
  const prev = finals[current - 1];
  const model = {
    model_version: M.MODEL_VERSION, season: current, trained_on: `${TRAIN_FROM}-${current - 1} regular seasons`,
    trained_at: new Date().toISOString().slice(0, 10),
    coef: Object.fromEntries(Object.entries(fit.coef).map(([k, v]) => [k, +v.toFixed(4)])), resid_sd: +fit.resid_sd.toFixed(3),
    lean_edge_pts: M.LEAN_EDGE, status_weight: M.STATUS_WEIGHT,
    prior_ratings: Object.fromEntries(Object.entries(prev).map(([t, v]) => [t, +(M.PRIOR_REGRESS * v).toFixed(3)]))
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "model.json"), JSON.stringify(model, null, 1) + "\n");
  fs.writeFileSync(path.join(OUT, "backtest.json"), JSON.stringify({
    generated: new Date().toISOString().slice(0, 10),
    note: "Walk-forward. Test seasons 2025-26 and 2026-27 to date against DraftKings lines (ESPN). Spread ROI assumes -110. Older seasons had no lines in the source.",
    variants: results
  }, null, 1) + "\n");
  console.log("Wrote data/nba/model.json and data/nba/backtest.json");
})().catch(e => { console.error(e); process.exit(1); });
