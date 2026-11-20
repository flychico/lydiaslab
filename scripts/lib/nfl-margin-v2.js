/**
 * Leo NFL margin v2 (leo-nflmargin-v2), DEC-20261120-02. ONE COPY, shared by
 * scripts/train-nfl-margin.js (fit) and scripts/generate-nfl-model.js (live).
 *
 * Leo's margin (home points minus away points) from a ridge regression on:
 *   sos_d       schedule-adjusted team ratings, home minus away: every game this
 *               season fitted at once (margin = home edge + r_home - r_away), each
 *               team pulled toward 0.6 of its final rating last season (worth 4
 *               games), home edge toward 2.0 points (worth 30 games). Neutral
 *               site games carry no home edge.
 *   home        1 unless the game is at a neutral site
 *   qb_diff, off_diff, def_diff   the win chance inputs (lib/nfl-moneyline.js)
 *   injr_all_d  injuries beyond the quarterback: for each team, the summed
 *               average snap share of its non-QB regulars (50%+ snaps on their
 *               side of the ball in the games they played, from the team's last
 *               8 games, at least 2; last season's last 8 when the team has
 *               fewer than 2 this season) listed Out or Doubtful on that week's
 *               injury report. Home minus away.
 * No sportsbook number is an input. Backtest (business/MODEL_LAB.md, Nov 20):
 * margin miss 2023 10.290, 2024 9.894, 2025 10.330 against v1's 10.539, 10.187,
 * 10.438; spread calls (1.5+ off the line, on the win chance's side) 139-129,
 * -2.64u against v1's 207-197, -8.81u. The line is still more accurate.
 *
 * Pure: parsed CSV rows in, numbers out.
 */
"use strict";
const MODEL_VERSION = "leo-nflmargin-v2";
const PR = 0.6, PK = 4, HCA = 2.0, HK = 30;
const FEATURES = ["sos_d", "home", "qb_diff", "off_diff", "def_diff", "injr_all_d"];
const n = v => { const x = Number.parseFloat(v); return Number.isFinite(x) ? x : null; };

function solve(A, b) {
  const k = b.length; A = A.map(r => r.slice()); b = b.slice();
  for (let c = 0; c < k; c++) {
    let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < k; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let j = c; j < k; j++) A[r][j] -= f * A[c][j]; b[r] -= f * b[c]; }
  }
  return b.map((v, i) => v / A[i][i]);
}

/** history: finished games (games.csv rows). prior: team -> last season's final rating. */
function sosRatings(history, teams, prior) {
  const idx = Object.fromEntries(teams.map((t, i) => [t, i])), N = teams.length, k = N + 1;
  const A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (const g of history) {
    const h = idx[g.home_team], a = idx[g.away_team], hs = n(g.home_score), as = n(g.away_score);
    if (h == null || a == null || hs == null || as == null) continue;
    const x = [[h, 1], [a, -1]]; if (g.location !== "Neutral") x.push([N, 1]);
    for (const [i, xi] of x) { b[i] += xi * (hs - as); for (const [j, xj] of x) A[i][j] += xi * xj; }
  }
  teams.forEach((t, i) => { A[i][i] += PK; b[i] += PK * PR * ((prior && prior[t]) || 0); });
  A[N][N] += HK; b[N] += HK * HCA;
  const w = solve(A, b);
  return { r: Object.fromEntries(teams.map((t, i) => [t, w[i]])), hca: w[N] };
}
const finished = (games, season) => games.filter(g => +g.season === season && ["REG", "POST"].includes(g.game_type) && g.home_score !== "" && g.away_score !== "");
/** Final ratings of `season`, chained from `from` (each season's prior is the one before). */
function finalRatings(games, season, from = 2018) {
  let prior = {};
  for (let s = from; s <= season; s++) {
    const gs = finished(games, s); if (!gs.length) continue;
    const teams = [...new Set(gs.flatMap(g => [g.home_team, g.away_team]))].sort();
    prior = sosRatings(gs, teams, prior).r;
  }
  return prior;
}

const norm = s => String(s || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "").replace(/[^a-z]/g, "");
const GROUP = p => /^(T|G|C|OT|OG|OL)$/.test(p) ? "off" : /^(WR|TE|RB|FB)$/.test(p) ? "off"
  : /^(DE|DT|NT|DL|LB|OLB|ILB|MLB|EDGE|CB|S|FS|SS|DB|SAF)$/.test(p) ? "def" : null;

/**
 * Snap index for one season and the one before: snapRows are nflverse
 * snap_counts rows (both seasons together is fine).
 */
function snapIndex(snapRows) {
  const byTeamGame = new Map(), teamGames = {};
  for (const r of snapRows) {
    const key = r.team + "|" + r.game_id, tg = r.season + r.team;
    if (!byTeamGame.has(key)) { byTeamGame.set(key, new Map()); (teamGames[tg] = teamGames[tg] || []).push({ id: r.game_id, wk: +r.week }); }
    const g = GROUP(r.position); if (!g) continue;
    const pct = g === "def" ? (n(r.defense_pct) || 0) : (n(r.offense_pct) || 0);
    byTeamGame.get(key).set(norm(r.player), { pct, name: r.player });
  }
  for (const k in teamGames) teamGames[k].sort((a, b) => a.wk - b.wk);
  return { byTeamGame, teamGames };
}
/** Non-QB regulars of `team` before `week` of `season`: [{nm, name, v}] (v = average snap share). */
function regulars(ix, season, team, week) {
  const prev = (ix.teamGames[season + team] || []).filter(x => x.wk < week).slice(-8);
  const src = prev.length >= 2 ? prev : (ix.teamGames[(season - 1) + team] || []).slice(-8);
  const hist = new Map();
  for (const x of src) { const m = ix.byTeamGame.get(team + "|" + x.id); if (!m) continue;
    for (const [nm, v] of m) { const h = hist.get(nm) || { sum: 0, n: 0, name: v.name }; if (v.pct > 0) { h.sum += v.pct; h.n++; } hist.set(nm, h); } }
  return [...hist].filter(([, h]) => h.n >= 2 && h.sum / h.n >= 0.5).map(([nm, h]) => ({ nm, name: h.name, v: h.sum / h.n }));
}
/** report: nflverse injuries rows. Returns {total, players:[{name, status, share}]} for one team and week. */
function injuryTotal(ix, report, season, team, week) {
  const st = new Map();
  for (const r of report) if (+r.season === season && r.team === team && +r.week === week && r.position !== "QB") st.set(norm(r.full_name), String(r.report_status || ""));
  let total = 0; const players = [];
  for (const r of regulars(ix, season, team, week)) {
    const s = st.get(r.nm) || "";
    if (/^(Out|Doubtful)$/i.test(s)) { total += r.v; players.push({ name: r.name, status: s, share: Math.round(r.v * 100) / 100 }); }
  }
  return { total, players: players.sort((a, b) => b.share - a.share) };
}

function predict(model, f) {
  return model.intercept + model.features.reduce((s, x, i) => s + model.beta[i] * (Number(f[x]) || 0), 0);
}

module.exports = { MODEL_VERSION, FEATURES, PR, PK, HCA, HK, sosRatings, finalRatings, finished, snapIndex, regulars, injuryTotal, predict, norm };
