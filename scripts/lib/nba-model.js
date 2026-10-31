/**
 * Leo NBA model, v1 (leo-nba-v1). Spread and win chance only.
 *
 *   home margin = b0 + b1 * (rating home - rating away)
 *                    + b2 * (home on a back-to-back - away on a back-to-back)
 *                    + b3 * (home rest days - away rest days, capped at 4)
 *                    + b4 * (home value missing - away value missing)
 *   win chance  = normal CDF(margin / residual SD)
 *
 * Ratings: ridge regression of every home margin this season on team
 * strength plus home court, with each team pulled toward 60% of its rating
 * at the end of last season (worth 8 games of evidence).
 *
 * Value missing: regulars (10+ minutes a game over their last 10 games, 3+
 * appearances) who will not play, weighted by how much they produce per
 * minute above a replacement level (game score per minute over 0.20).
 * In training this is who actually sat out; live it is the injury report.
 *
 * The coefficients, the residual SD and last season's ratings live in
 * data/nba/model.json, written by scripts/train-nba.js. Nothing here reads
 * the betting line: the market is only ever the thing Leo is graded against.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const MODEL_VERSION = "leo-nba-v1";
const PRIOR_REGRESS = 0.6;
const PRIOR_GAMES = 8;
const HCA_PRIOR = 2.5, HCA_PRIOR_GAMES = 20;
const REG_MPG = 10, REG_GAMES = 3, LAST_N = 10, REPLACEMENT_GPM = 0.20;
const FEATURES = ["rating_diff", "b2b_d", "rest_d", "lost_d"];
const LEAN_EDGE = 4;   // points between Leo and the line before Leo records a lean
// How much a listed player counts as missing. Out is out. ESPN folds
// questionable and probable into "Day-To-Day", so it counts as a coin flip
// leaning towards playing. Reviewed in the nightly audit.
const STATUS_WEIGHT = { "out": 1, "doubtful": 0.75, "day-to-day": 0.4, "questionable": 0.5, "probable": 0.1, "suspension": 1 };

const RELEASE = "https://github.com/sportsdataverse/sportsdataverse-data/releases/download";
const CACHE = process.env.NBA_CACHE || path.join(os.tmpdir(), "leo-nba-cache");

// ---------- data ----------
function parseCsv(text, keep) {
  const rows = []; let row = [], field = "", q = false, head = null, idx = null;
  const push = () => {
    if (!head) { head = row; idx = keep.map(k => head.indexOf(k)); }
    else if (row.length > 1) { const o = {}; keep.forEach((k, i) => { o[k] = idx[i] >= 0 ? row[idx[i]] : ""; }); rows.push(o); }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); field = ""; push(); }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); push(); }
  return rows;
}

async function download(kind, season, { maxAgeHours = 3 } = {}) {
  const names = { schedule: ["espn_nba_schedules", "nba_schedule"], team: ["espn_nba_team_boxscores", "team_box"], player: ["espn_nba_player_boxscores", "player_box"] };
  const [tag, stem] = names[kind];
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${stem}_${season}.csv`);
  const fresh = fs.existsSync(file) && (Date.now() - fs.statSync(file).mtimeMs) < maxAgeHours * 36e5;
  if (!fresh) {
    const res = await fetch(`${RELEASE}/${tag}/${stem}_${season}.csv`);
    if (!res.ok) throw new Error(`${stem}_${season}.csv: HTTP ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return fs.readFileSync(file, "utf8");
}

/** Regular-season games and player lines for one season, sorted by date. */
async function loadSeason(season, opts) {
  const tb = parseCsv(await download("team", season, opts),
    ["game_id", "season_type", "game_date", "team_home_away", "team_abbreviation", "team_score", "opponent_team_abbreviation", "opponent_team_score"]);
  const games = tb.filter(r => r.season_type === "2" && r.team_home_away === "home").map(r => ({
    game_id: r.game_id, date: r.game_date, home: r.team_abbreviation, away: r.opponent_team_abbreviation,
    hs: +r.team_score, as: +r.opponent_team_score, margin: +r.team_score - +r.opponent_team_score
  })).filter(g => Number.isFinite(g.margin)).sort((a, b) => a.date.localeCompare(b.date) || a.game_id.localeCompare(b.game_id));
  const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
  const pb = parseCsv(await download("player", season, opts),
    ["game_id", "season_type", "game_date", "athlete_id", "athlete_display_name", "team_abbreviation", "minutes", "points",
      "field_goals_made", "field_goals_attempted", "free_throws_made", "free_throws_attempted", "offensive_rebounds",
      "defensive_rebounds", "steals", "assists", "blocks", "fouls", "turnovers"]);
  const players = pb.filter(r => r.season_type === "2").map(r => {
    const minutes = n(r.minutes);
    // Hollinger game score: one number for what a player put into a game.
    const gmsc = n(r.points) + 0.4 * n(r.field_goals_made) - 0.7 * n(r.field_goals_attempted)
      - 0.4 * (n(r.free_throws_attempted) - n(r.free_throws_made)) + 0.7 * n(r.offensive_rebounds)
      + 0.3 * n(r.defensive_rebounds) + n(r.steals) + 0.7 * n(r.assists) + 0.7 * n(r.blocks) - 0.4 * n(r.fouls) - n(r.turnovers);
    return { game_id: r.game_id, date: r.game_date, id: r.athlete_id, name: r.athlete_display_name, team: r.team_abbreviation, minutes, gmsc, played: minutes > 0 ? 1 : 0 };
  }).sort((a, b) => a.date.localeCompare(b.date));
  return { season, games, players };
}

// ---------- ratings ----------
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/** margin = hca + r_home - r_away, ridge-pulled toward each team's prior. */
function ratings(games, teams, prior) {
  const idx = Object.fromEntries(teams.map((t, i) => [t, i])), n = teams.length, k = n + 1;
  const A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (const g of games) {
    const h = idx[g.home], a = idx[g.away]; if (h == null || a == null) continue;
    const x = [[h, 1], [a, -1], [n, 1]];
    for (const [i, xi] of x) { b[i] += xi * g.margin; for (const [j, xj] of x) A[i][j] += xi * xj; }
  }
  teams.forEach((t, i) => { A[i][i] += PRIOR_GAMES; b[i] += PRIOR_GAMES * (prior[t] || 0); });
  A[n][n] += HCA_PRIOR_GAMES; b[n] += HCA_PRIOR_GAMES * HCA_PRIOR;
  for (let i = 0; i < k; i++) A[i][i] += 1e-6;
  const w = solve(A, b);
  return { r: Object.fromEntries(teams.map((t, i) => [t, w[i]])), hca: w[n] };
}

// ---------- availability ----------
/** Regulars per team as of a date: last 10 lines per player this season. */
function regulars(players, beforeDate) {
  const byPlayer = new Map();
  for (const p of players) { if (p.date >= beforeDate) break; if (!byPlayer.has(p.id)) byPlayer.set(p.id, []); byPlayer.get(p.id).push(p); }
  const out = [];
  for (const [id, rows] of byPlayer) {
    const last = rows.slice(-LAST_N), groups = new Map();
    for (const r of last) { if (!groups.has(r.team)) groups.set(r.team, []); groups.get(r.team).push(r); }
    for (const [team, g] of groups) {
      const mins = g.reduce((s, r) => s + r.minutes, 0), mpg = mins / g.length, n = g.reduce((s, r) => s + r.played, 0);
      const gpm = mins > 0 ? g.reduce((s, r) => s + r.gmsc, 0) / Math.max(1, mins) : 0;
      if (mpg >= REG_MPG && n >= REG_GAMES) out.push({ id, name: g[g.length - 1].name, team, mpg, gpm, value: Math.max(0, mpg * (gpm - REPLACEMENT_GPM)) });
    }
  }
  return out;
}

/** Sum of value missing for one team. weightOf(player) -> 0..1 chance he sits. */
function lostValue(regs, team, weightOf) {
  let lost = 0; const missing = [];
  for (const r of regs) {
    if (r.team !== team) continue;
    const w = weightOf(r); if (!w) continue;
    lost += w * r.value;
    missing.push({ name: r.name, id: r.id, mpg: +r.mpg.toFixed(1), value: +r.value.toFixed(1), weight: w });
  }
  return { lost, missing: missing.sort((a, b) => b.value * b.weight - a.value * a.weight) };
}

// ---------- prediction ----------
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
function predict(model, f) {
  const c = model.coef;
  const margin = c.intercept + FEATURES.reduce((s, k) => s + c[k] * f[k], 0);
  return { margin, p_home: normCdf(margin / model.resid_sd) };
}
function restDays(lastDate, date) {
  if (!lastDate) return { rest: 4, b2b: 0 };
  const d = Math.round((Date.parse(date + "T12:00:00Z") - Date.parse(lastDate + "T12:00:00Z")) / 864e5);
  return { rest: Math.min(d, 4), b2b: d === 1 ? 1 : 0 };
}

// ---------- market ----------
const implied = ml => ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
function noVig(homeMl, awayMl) {
  if (!Number.isFinite(homeMl) || !Number.isFinite(awayMl) || !homeMl || !awayMl) return null;
  const h = implied(homeMl), a = implied(awayMl); return h / (h + a);
}

module.exports = {
  MODEL_VERSION, FEATURES, LEAN_EDGE, STATUS_WEIGHT, PRIOR_REGRESS, CACHE,
  parseCsv, download, loadSeason, ratings, regulars, lostValue, predict, normCdf, restDays, noVig, implied, solve
};
