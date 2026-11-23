#!/usr/bin/env node
/**
 * Train and backtest Leo NBA (scripts/lib/nba-model.js).
 *
 *   node scripts/train-nba.js            backtest only, prints the table
 *   node scripts/train-nba.js --audit    also prints calibration by bucket and the Leo Pick rule table
 *   node scripts/train-nba.js --write    also writes data/nba/model.json and
 *                                        data/nba/backtest.json
 *
 * Audit fixes (Lynold, 2026-11-22): only the 30 NBA teams (no All-Star exhibition teams); the league three point
 * rate behind each game's luck uses only earlier games; resid_sd written to model.json is the spread of the
 * walk-forward (out of sample) residuals, not the in-sample fit's; players with fewer than 3 games this season
 * fall back to a share of last season's value (lostf_* rows, PRIOR_VALUE_SHARE in nba-model.js).
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
  const rows = [], finals = {}, endValues = {};
  let lastFinal = {}, lastLg3 = null, lastValues = null;
  // NBA-H32 settings: [tag, weight after 5+ straight missed team games, weight after 10+].
  const H32 = [["_h32a", 0.75, 0.5], ["_h32b", 0.5, 0.25]];
  for (const s of SEASONS) {
    const { games, players, lg3 } = await M.loadSeason(s, { maxAgeHours: 24 * 30, priorLg3: lastLg3 });
    const teams = [...new Set(games.flatMap(g => [g.home, g.away]))].sort();
    const prior = Object.fromEntries(teams.map(t => [t, M.PRIOR_REGRESS * (lastFinal[t] || 0)]));
    const L = lines(s);
    const playedIn = new Map();   // game_id|team -> Set of athlete ids who logged minutes
    for (const p of players) if (p.played) { const k = p.game_id + "|" + p.team; if (!playedIn.has(k)) playedIn.set(k, new Set()); playedIn.get(k).add(p.id); }
    const lastGame = {}, teamHist = {};          // team -> {date, game_id}; team -> game ids played so far
    const dates = [...new Set(games.map(g => g.date))];
    for (const d of dates) {
      const prev = games.filter(g => g.date < d);
      const { r } = M.ratings(prev, teams, prior);
      const regs = M.regulars(players, d);
      const regsF = lastValues ? M.regulars(players, d, lastValues) : regs;
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
          f[side + "_lostf"] = M.lostValue(regsF, team, x => sat.has(x.id) ? 0 : 1).lost;
          f[side + "_lostf_prev"] = prevSat ? M.lostValue(regsF, team, x => prevSat.has(x.id) ? 0 : 1).lost : 0;
          // NBA-H32 (long-absence discount): a regular out 5+ straight team games is partly in the ratings already.
          const hist = teamHist[team] || [];
          const streak = x => { let k = 0; for (let i = hist.length - 1; i >= 0 && k < 20; i--) { if ((playedIn.get(hist[i] + "|" + team) || new Set()).has(x.id)) break; k++; } return k; };
          for (const [tag, w5, w10] of H32) {
            const w = x => { const k = streak(x); return k >= 10 ? w10 : k >= 5 ? w5 : 1; };
            f[side + "_lost" + tag] = M.lostValue(regs, team, x => sat.has(x.id) ? 0 : w(x)).lost;
            f[side + "_lost_prev" + tag] = prevSat ? M.lostValue(regs, team, x => prevSat.has(x.id) ? 0 : w(x)).lost : 0;
          }
        }
        for (const [tag] of H32) { f["lost" + tag + "_d"] = f["home_lost" + tag] - f["away_lost" + tag]; f["lost_prev" + tag + "_d"] = f["home_lost_prev" + tag] - f["away_lost_prev" + tag]; }
        f.b2b_d = f.home_b2b - f.away_b2b; f.rest_d = f.home_rest - f.away_rest;
        f.lost_d = f.home_lost - f.away_lost; f.lost_prev_d = f.home_lost_prev - f.away_lost_prev;
        f.lostf_d = f.home_lostf - f.away_lostf; f.lostf_prev_d = f.home_lostf_prev - f.away_lostf_prev;
        const l = L[g.game_id];
        if (l && l.spread != null) { f.mkt_margin = -l.spread; f.home_ml = l.home_ml; f.away_ml = l.away_ml; }
        rows.push(f);
      }
      for (const g of today) { lastGame[g.home] = { date: d, game_id: g.game_id }; lastGame[g.away] = { date: d, game_id: g.game_id };
        for (const t of [g.home, g.away]) (teamHist[t] = teamHist[t] || []).push(g.game_id); }
    }
    lastFinal = M.ratings(games, teams, prior).r;
    finals[s] = lastFinal; lastLg3 = lg3; lastValues = M.seasonEndValues(players); endValues[s] = lastValues;
    console.log(`  ${s}: ${games.length} games`);
  }
  return { rows, finals, endValues };
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
// Walk-forward residual SD: each earlier season predicted by a fit on the seasons before it (2025 from 2024,
// 2026 from 2024-25, ...), so the spread of misses is what a fit shows on games it never saw.
function oosSd(rows, X, upTo) {
  const res = [];
  for (let t = TRAIN_FROM + 1; t < upTo; t++) {
    const fit = ols(rows.filter(r => r.season >= TRAIN_FROM && r.season < t), X);
    for (const r of rows.filter(r => r.season === t)) res.push(r.margin - fit.pred(r));
  }
  if (!res.length) return null;
  const mean = res.reduce((s, v) => s + v, 0) / res.length;
  return Math.sqrt(res.reduce((s, v) => s + (v - mean) ** 2, 0) / res.length);
}

function evaluate(rows, X, label, opts = {}) {
  const tested = [];
  for (const test of [2026, 2027]) {
    const fit = ols(rows.filter(r => r.season >= TRAIN_FROM && r.season < test), X);
    const sd = opts.oos ? (oosSd(rows, X, test) || fit.resid_sd) : fit.resid_sd;
    for (const r of rows.filter(r => r.season === test)) {
      const m = fit.pred(r); tested.push({ ...r, pred: m, p_home: M.normCdf(m / sd), sd, sd_in: fit.resid_sd });
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
    spread: [], moneyline: [], sd_used: +avg([...new Set(g.map(r => r.sd))]).toFixed(3)
  };
  out._tested = g;
  for (const t of [0, 2, 3, 4, 5, 6]) {
    let w = 0, l = 0, p = 0;
    for (const r of g) {
      const d = r.pred - r.mkt_margin; if (Math.abs(d) < t || d === 0) continue;
      const res = Math.sign(d) * (r.margin - r.mkt_margin); if (res > 0) w++; else if (res < 0) l++; else p++;
    }
    out.spread.push({ edge_pts: t, won: w, lost: l, push: p, pct: +(w / Math.max(1, w + l)).toFixed(3), roi_at_110: +((w * 100 / 110 - l) / Math.max(1, w + l + p)).toFixed(3) });
  }
  // NBA-H07: lean thresholds as cumulative (gap >= t) and as bands, with
  // Leo's stated cover chance (normal CDF of gap / resid_sd of that fold)
  // against the actual cover rate, per test season, plus a 95% interval.
  const bucket = (lo, hi) => {
    const s = { won: 0, lost: 0, push: 0, stated: 0, by_season: {}, big_injury: 0 };
    for (const r of g) {
      const d = r.pred - r.mkt_margin, a = Math.abs(d);
      if (d === 0 || a < lo || (hi != null && a >= hi)) continue;
      const res = Math.sign(d) * (r.margin - r.mkt_margin);
      const k = res > 0 ? "won" : res < 0 ? "lost" : "push"; s[k]++;
      s.stated += M.normCdf(a / r.sd);
      const bs = s.by_season[r.season] || (s.by_season[r.season] = { won: 0, lost: 0, push: 0 }); bs[k]++;
      if (Math.abs(r.lost_d) >= 5 || Math.abs(r.lost_prev_d) >= 5) s.big_injury++;
    }
    const n = s.won + s.lost + s.push, wl = s.won + s.lost, p = s.won / Math.max(1, wl);
    const se = Math.sqrt(p * (1 - p) / Math.max(1, wl));
    return { gap: hi == null ? `${lo}+` : `${lo}-${hi}`, won: s.won, lost: s.lost, push: s.push,
      stated_cover: n ? +(s.stated / n).toFixed(3) : null, actual_cover: wl ? +p.toFixed(3) : null,
      ci95: wl ? [+(p - 1.96 * se).toFixed(3), +(p + 1.96 * se).toFixed(3)] : null,
      roi_at_110: +((s.won * 100 / 110 - s.lost) / Math.max(1, n)).toFixed(3),
      by_season: s.by_season, injury_heavy_share: n ? +(s.big_injury / n).toFixed(2) : null };
  };
  out.lean_buckets = [[4], [6], [7], [8], [10], [4, 6], [6, 8], [8, 10]].map(([lo, hi]) => bucket(lo, hi));
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

// Calibration of Leo's win chance on the favoured side, by stated bucket.
function calibration(g) {
  const out = [];
  for (const [lo, hi] of [[0.5, 0.6], [0.6, 0.7], [0.7, 1.01]]) {
    const b = g.map(r => ({ p: Math.max(r.p_home, 1 - r.p_home), w: (r.p_home >= 0.5) === (r.margin > 0) ? 1 : 0 })).filter(x => x.p >= lo && x.p < hi);
    out.push({ bucket: `${Math.round(lo * 100)}-${hi > 1 ? "100" : Math.round(hi * 100)}%`, games: b.length,
      stated: b.length ? +(b.reduce((s, x) => s + x.p, 0) / b.length).toFixed(3) : null,
      won: b.length ? +(b.reduce((s, x) => s + x.w, 0) / b.length).toFixed(3) : null });
  }
  return out;
}

// Leo Pick rules on the walk-forward rows, through the live rule book (scripts/lib/nba-picks.js) for the base
// rule; variants add a price cap and an edge over the no-vig chance. Lines are the saved DraftKings line, one per
// game, so closing line value cannot be measured here (see the live check in business/MODEL_LAB.md).
function pickRules(g) {
  const PK = require("./lib/nba-picks");
  const be = ml => ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
  const rules = [["today: 60%+, better than -230", () => true]];
  for (const cap of [-230, -165, -150]) for (const e of [0, 0.04, 0.05, 0.06]) {
    if (cap === -230 && e === 0) continue;
    rules.push([`60%+, better than ${cap}${e ? `, edge ${Math.round(e * 100)}+ pts` : ""}`, (x) => x.price > cap && x.edge >= e]);
  }
  const out = [];
  for (const [label, ok] of rules) {
    const pk = [];
    for (const r of g) {
      const base = PK.pick({ p_home: r.p_home, home_ml: r.home_ml, away_ml: r.away_ml, home: r.home, away: r.away });
      if (!base || !base.ok) continue;
      const mp = base.side === "home" ? r.mkt_p : 1 - r.mkt_p, x = { price: base.price, edge: base.p - mp };
      if (!ok(x)) continue;
      const won = base.side === "home" ? r.margin > 0 : r.margin < 0;
      pk.push({ u: PK.units(won ? "win" : "loss", base.price), won, be: be(base.price), season: r.season });
    }
    const n = pk.length, W = pk.filter(x => x.won).length, U = pk.reduce((s, x) => s + x.u, 0);
    const sd = Math.sqrt(pk.reduce((s, x) => s + (x.u - U / Math.max(1, n)) ** 2, 0));
    const byS = t => +pk.filter(x => x.season === t).reduce((s, x) => s + x.u, 0).toFixed(2);
    out.push({ rule: label, picks: n, won: W, lost: n - W, win_pct: n ? +(W / n).toFixed(3) : null,
      breakeven: n ? +(pk.reduce((s, x) => s + x.be, 0) / n).toFixed(3) : null, units: +U.toFixed(2), noise: +sd.toFixed(1),
      roi: n ? +(U / n).toFixed(3) : null, season_2026: byS(2026), season_2027: byS(2027) });
  }
  return out;
}

(async () => {
  console.log("Building features (walk-forward, no future data)...");
  const { rows, finals, endValues } = await features();
  const AUDIT = process.argv.includes("--audit") || process.argv.includes("--write");
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
  if (process.argv.includes("--leans")) {
    for (const r of results) {
      console.log(`\n${r.label} (${r.games} games)`);
      for (const b of r.lean_buckets) console.log(`  gap ${b.gap.padEnd(5)} ${b.won}-${b.lost}-${b.push}  stated ${b.stated_cover}  actual ${b.actual_cover}  ci95 ${JSON.stringify(b.ci95)}  roi ${b.roi_at_110}  injury-heavy ${b.injury_heavy_share}  ${JSON.stringify(b.by_season)}`);
    }
  }
  let audit = null;
  if (AUDIT) {
    const LIVE = ["rating_diff", "b2b_d", "rest_d", "lost_prev_d"], EXACT = M.FEATURES;
    const LIVE_F = ["rating_diff", "b2b_d", "rest_d", "lostf_prev_d"], EXACT_F = ["rating_diff", "b2b_d", "rest_d", "lostf_d"];
    const line = r => `miss ${r.miss_leo}  brier ${r.brier_leo}  winners ${r.winner_leo}  sd ${r.sd_used}`;
    const A = {
      live_in: evaluate(rows, LIVE, "live-like, in-sample SD"), live_oos: evaluate(rows, LIVE, "live-like, walk-forward SD", { oos: true }),
      exact_in: evaluate(rows, EXACT, "exact, in-sample SD"), exact_oos: evaluate(rows, EXACT, "exact, walk-forward SD", { oos: true }),
      livef_oos: evaluate(rows, LIVE_F, "live-like + prior-season fallback", { oos: true }), exactf_oos: evaluate(rows, EXACT_F, "exact + prior-season fallback", { oos: true })
    };
    for (const [tag, lab] of [["_h32a", "H32 0.75 after 5+, 0.5 after 10+"], ["_h32b", "H32 0.5 after 5+, 0.25 after 10+"]]) {
      A["live" + tag] = evaluate(rows, ["rating_diff", "b2b_d", "rest_d", "lost_prev" + tag + "_d"], "live-like " + lab, { oos: true });
      A["exact" + tag] = evaluate(rows, ["rating_diff", "b2b_d", "rest_d", "lost" + tag + "_d"], "exact " + lab, { oos: true });
    }
    const bySeason = r => [2026, 2027].map(t => { const g = r._tested.filter(x => x.season === t);
      return `${t}: miss ${(g.reduce((s, x) => s + Math.abs(x.margin - x.pred), 0) / g.length).toFixed(3)} brier ${(g.reduce((s, x) => s + (x.p_home - (x.margin > 0 ? 1 : 0)) ** 2, 0) / g.length).toFixed(4)}`; }).join("  ");
    console.log("\nH32 by test season:");
    for (const k of ["live_oos", "live_h32a", "live_h32b", "exact_oos", "exact_h32a", "exact_h32b"]) console.log(`  ${A[k].label.padEnd(50)} ${bySeason(A[k])}`);
    console.log("\nAUDIT (walk-forward, test seasons 2025-26 and 2026-27)");
    for (const [k, r] of Object.entries(A)) console.log(`  ${r.label.padEnd(40)} ${line(r)}`);
    console.log("\nCalibration, favoured side (stated vs won):");
    for (const k of ["live_in", "live_oos", "exact_in", "exact_oos"]) console.log(`  ${A[k].label.padEnd(30)} ` + calibration(A[k]._tested).map(b => `${b.bucket}: ${b.games} games, said ${b.stated}, won ${b.won}`).join(" | "));
    const rules = pickRules(A.live_oos._tested);
    console.log("\nLeo Pick rules (live-like, walk-forward SD):");
    for (const x of rules) console.log(`  ${x.rule.padEnd(40)} ${String(x.picks).padStart(4)} ${`${x.won}-${x.lost}`.padStart(8)} won ${x.win_pct} needed ${x.breakeven} units ${x.units} (+-${x.noise}) roi ${x.roi} by season ${x.season_2026} / ${x.season_2027}`);
    audit = { variants: Object.fromEntries(Object.entries(A).map(([k, r]) => [k, { label: r.label, games: r.games, miss: r.miss_leo, brier: r.brier_leo, winners: r.winner_leo, sd: r.sd_used }])),
      calibration: Object.fromEntries(["live_in", "live_oos", "exact_in", "exact_oos"].map(k => [k, calibration(A[k]._tested)])), pick_rules: rules };
  }
  for (const r of results) delete r._tested;
  if (!process.argv.includes("--write")) return;
  // Production fit: every completed season from TRAIN_FROM. resid_sd is the walk-forward SD (audit fix 2).
  const current = Math.max(...SEASONS);
  const useFallback = process.argv.includes("--fallback");
  const X = useFallback ? ["rating_diff", "b2b_d", "rest_d", "lostf_d"] : M.FEATURES;
  const train = rows.filter(r => r.season >= TRAIN_FROM && r.season < current).map(r => useFallback ? { ...r } : r);
  const fit = ols(train, X);
  if (useFallback) { fit.coef.lost_d = fit.coef.lostf_d; delete fit.coef.lostf_d; }
  const sdOos = oosSd(rows, X, current);
  const prev = finals[current - 1];
  const model = {
    model_version: M.MODEL_VERSION, season: current, trained_on: `${TRAIN_FROM}-${current - 1} regular seasons`,
    trained_at: new Date().toISOString().slice(0, 10),
    coef: Object.fromEntries(Object.entries(fit.coef).map(([k, v]) => [k, +v.toFixed(4)])), resid_sd: +(sdOos || fit.resid_sd).toFixed(3),
    resid_sd_in_sample: +fit.resid_sd.toFixed(3), resid_sd_source: sdOos ? "walk-forward residuals" : "in-sample fit",
    lean_edge_pts: M.LEAN_EDGE, status_weight: M.STATUS_WEIGHT,
    prior_ratings: Object.fromEntries(Object.entries(prev).filter(([t]) => M.isNbaTeam(t)).map(([t, v]) => [t, +(M.PRIOR_REGRESS * v).toFixed(3)])),
    ...(useFallback ? { prior_player_values: endValues[current - 1], prior_value_share: M.PRIOR_VALUE_SHARE } : {})
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "model.json"), JSON.stringify(model, null, 1) + "\n");
  fs.writeFileSync(path.join(OUT, "backtest.json"), JSON.stringify({
    generated: new Date().toISOString().slice(0, 10),
    note: "Walk-forward. Test seasons 2025-26 and 2026-27 to date against DraftKings lines (ESPN). Spread ROI assumes -110. Older seasons had no lines in the source.",
    variants: results, audit
  }, null, 1) + "\n");
  console.log("Wrote data/nba/model.json and data/nba/backtest.json");
})().catch(e => { console.error(e); process.exit(1); });
