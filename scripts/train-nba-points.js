#!/usr/bin/env node
/**
 * Backtest and fit Leo NBA's projected score (scripts/lib/nba-points.js).
 *
 *   node scripts/train-nba-points.js            backtest only
 *   node scripts/train-nba-points.js --write    also writes data/nba/points-model.json
 *                                               and data/nba/backtest-points.json
 *
 * Walk-forward: every game is projected from games before its date, with
 * priors from the end of the previous season. DraftKings totals
 * (data/nba/lines-<season>.jsonl) are used only to grade the projection.
 */
const fs = require("fs");
const path = require("path");
const P = require("./lib/nba-points");
const M = require("./lib/nba-model");

const SEASONS = [2023, 2024, 2025, 2026, 2027];
const OUT = path.join(__dirname, "..", "data", "nba");
const avg = a => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);

function totals(season) {
  const f = path.join(OUT, `lines-${season}.jsonl`), out = {};
  if (!fs.existsSync(f)) return out;
  for (const l of fs.readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    const j = JSON.parse(l), L = (j.lines || []).find(x => x.provider === "DraftKings") || (j.lines || [])[0];
    if (L && L.ou) out[String(j.game_id)] = +L.ou;
  }
  return out;
}

(async () => {
  let priors = {}, livePriors = {};
  const LIVE = Math.max(...SEASONS);
  const tested = [];
  for (const s of SEASONS) {
    if (s === LIVE) livePriors = priors;
    const G = await P.loadTeamGames(s, { maxAgeHours: 24 * 30 });
    const teams = [...new Set(G.flatMap(g => [g.home.team, g.away.team]))].sort(), ou = totals(s);
    for (const d of [...new Set(G.map(g => g.date))]) {
      const R = P.rate(G.filter(g => g.date < d), teams, priors);
      for (const g of G.filter(x => x.date === d)) {
        const p = P.project(R, g.home.team, g.away.team);
        tested.push({ season: s, date: d, game_id: g.game_id, proj: p.total, act: g.home.pts + g.away.pts, ou: ou[g.game_id] });
      }
    }
    priors = P.toPriors(P.rate(G, teams, priors));
    console.log(`  ${s}: ${G.length} games`);
  }
  const T = tested.filter(r => r.ou != null && r.season >= 2026);
  const res = T.map(r => r.act - r.proj), sd = Math.sqrt(avg(res.map(e => e * e)));
  const bt = { games: T.length, miss_leo: +avg(T.map(r => Math.abs(r.proj - r.act))).toFixed(2), miss_line: +avg(T.map(r => Math.abs(r.ou - r.act))).toFixed(2),
    bias_leo: +avg(T.map(r => r.proj - r.act)).toFixed(2), resid_sd: +sd.toFixed(1), over_under: [] };
  for (const t of [3, 6, 10]) {
    let w = 0, l = 0, p = 0;
    for (const r of T) { const d = r.proj - r.ou; if (Math.abs(d) < t || !d) continue; const x = Math.sign(d) * (r.act - r.ou); x > 0 ? w++ : x < 0 ? l++ : p++; }
    bt.over_under.push({ gap_pts: t, won: w, lost: l, push: p, pct: +(w / Math.max(1, w + l)).toFixed(3) });
  }
  console.log(`Totals vs DraftKings, ${bt.games} games: avg miss Leo ${bt.miss_leo}, line ${bt.miss_line}, bias ${bt.bias_leo}`);
  for (const b of bt.over_under) console.log(`  ${b.gap_pts}+ pts off the total: ${b.won}-${b.lost}-${b.push} (${(b.pct * 100).toFixed(1)}%)`);
  if (!process.argv.includes("--write")) return;
  fs.writeFileSync(path.join(OUT, "points-model.json"), JSON.stringify({
    model: "leo-nba-points-v1", season: LIVE, trained_at: new Date().toISOString().slice(0, 10), display_only: true,
    note: "Projected total = pace x points per possession (scripts/lib/nba-points.js). No over/under leans. Split on the page by Leo's margin.",
    resid_sd: bt.resid_sd, priors: livePriors
  }, null, 1) + "\n");
  fs.writeFileSync(path.join(OUT, "backtest-points.json"), JSON.stringify({
    generated: new Date().toISOString().slice(0, 10),
    note: "Walk-forward projected totals vs DraftKings totals, 2025-26 and 2026-27 to date. The total is never an input.", ...bt
  }, null, 1) + "\n");
  console.log("Wrote data/nba/points-model.json and data/nba/backtest-points.json");
})().catch(e => { console.error(e); process.exit(1); });
