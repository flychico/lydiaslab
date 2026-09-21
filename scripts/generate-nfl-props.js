#!/usr/bin/env node
/**
 * NFL player-props projections.
 *
 * Ports the K-props methodology (see claude/K_PROPS_MODEL_ANALYSIS.md):
 *
 *   PROJECTION = (rate_used * expected_volume * opp_adjustment) + calibration_bias
 *
 * Every input is real. Sources (all open nflverse data, no auth):
 *   schedule/odds  games.csv
 *   weekly stats   stats_player_week_{2026,2025}.csv
 *   rosters        roster_2026.csv
 *
 * EARLY-SEASON SHRINKAGE
 * K-props blends recent form with season average. In Week 1-3 an NFL player has
 * 1-2 games, so a 60/40 recent/season blend is fitting pure noise. We therefore
 * shrink toward the prior season and relax that prior as real games accumulate.
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const REL = "https://github.com/nflverse/nflverse-data/releases/download";
const FEED = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

const SEASON = 2026, PRIOR = 2025;
const CLAMP_LO = 0.85, CLAMP_HI = 1.15;   // opponent multiplier bounds (K-props spec)
// Calibration bias, MEASURED — not guessed and not zero.
// scripts/backtest-nfl-props.js walked the full 3828-projection 2025 season
// walk-forward and found the raw model under-projects every yardage market.
// These correct that measured bias. Re-derive them by re-running the backtest;
// do NOT hand-tune.
const CALIBRATION = {
  QB_PASS_YARDS: +8.4,   // 2025 bias -8.4 yds over n=590
  RB_RUSH_YARDS: +3.4,   // 2025 bias -3.4 yds over n=1221
  WR_REC_YARDS:  +1.1,   // 2025 bias -1.1 yds over n=2017
  ANYTIME_TD:     0.0     // probability market; bias handled by the TD_CEILING cap
};
const CALIBRATION_BIAS = 0.0;  // retained so existing references still resolve

// --- blend weights by games played (shrinkage toward prior season) -----------
function weights(n) {
  if (n >= 6) return { recent: 0.60, season: 0.40, prior: 0.00 };
  if (n >= 3) return { recent: 0.45, season: 0.30, prior: 0.25 };
  return { recent: 0.30, season: 0.20, prior: 0.50 };
}

// --- tiny CSV parser (quoted fields, embedded commas) -----------------------
function parseCSV(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift().map(h => h.trim());
  return rows.filter(r => r.length > 1)
             .map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}

// Node's global fetch ignores HTTP(S)_PROXY env vars, which breaks behind a
// corporate/sandbox proxy. curl honours them and exists both locally and in CI.
const { execFileSync } = require("child_process");
async function get(url) {
  const body = execFileSync("curl", ["-sSL", "--fail", "--max-time", "120", url],
                            { maxBuffer: 1024 * 1024 * 512, encoding: "utf8" });
  return parseCSV(body);
}

const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const r1 = x => Math.round(x * 10) / 10;

/**
 * Empirical-Bayes shrinkage toward a prior.
 * With K pseudo-observations, a 1-game sample stays ~K/(1+K) prior-weighted.
 * Without this, a 1-2 game NFL sample pins every derived rate to an extreme.
 */
const K_PSEUDO = 4;
function shrink(observed, nObs, prior, k = K_PSEUDO) {
  if (!nObs) return prior;
  return ((nObs * observed) + (k * prior)) / (nObs + k);
}

/** Blend recent / season-to-date / prior-season per-game rates. */
function blend(recentArr, seasonArr, priorArr) {
  const w = weights(seasonArr.length);
  const recent = mean(recentArr.slice(-3));         // last 3 games
  const season = mean(seasonArr);
  const prior  = mean(priorArr);
  const wp = priorArr.length ? w.prior : 0;
  const denom = w.recent + w.season + wp;
  if (denom === 0) return 0;
  return ((recent * w.recent) + (season * w.season) + (prior * wp)) / denom;
}

/** Opponent multiplier: yards allowed vs league average, blended + clamped. */
function oppAdjustment(defRecent, defSeason, leagueAvg, nGames) {
  if (!leagueAvg) return 1.0;
  const blended = (0.6 * (defRecent || defSeason)) + (0.4 * defSeason);
  // Regress toward the league mean before forming the ratio. A 1-2 game
  // defensive sample is otherwise extreme enough to peg the clamp every time.
  const regressed = shrink(blended, nGames, leagueAvg);
  return Math.max(CLAMP_LO, Math.min(CLAMP_HI, regressed / leagueAvg));
}

// League-typical TDs per game by position; used as the shrinkage prior so a
// single 2-TD game cannot imply a 90% anytime-TD probability.
const TD_BASE_RB = 0.38, TD_BASE_WR = 0.30;
const TD_CEILING = 0.72;   // no NFL anytime-TD price implies more than ~72%

function anytimeTD(e, field, base, adj) {
  const cur = e.cur.map(x => x[field]);
  const prior = e.prior.map(x => x[field]);
  // player's own prior-season rate is itself shrunk toward the position baseline
  const priorRate = prior.length ? shrink(mean(prior), prior.length, base, 6) : base;
  const rate = shrink(mean(cur), cur.length, priorRate) * adj;
  const p = 1 - Math.exp(-Math.max(0, rate));
  return Math.round(Math.min(TD_CEILING, p) * 1000) / 1000;
}

(async function main() {
  const targetDate = process.argv[2] || new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  console.log(`NFL props for ${targetDate}`);

  const [games, wk26, wk25, roster] = await Promise.all([
    get(FEED),
    get(`${REL}/stats_player/stats_player_week_${SEASON}.csv`),
    get(`${REL}/stats_player/stats_player_week_${PRIOR}.csv`),
    get(`${REL}/rosters/roster_${SEASON}.csv`)
  ]);

  const slate = games.filter(g => g.gameday === targetDate);
  if (!slate.length) { console.log("No games on that date. Nothing written."); return; }
  console.log(`  slate: ${slate.length} games`);

  const active = new Set(roster.filter(r => r.status === "ACT").map(r => r.full_name));

  // ---- per-player game logs -------------------------------------------------
  const logs = new Map();  // key -> {pos, team, cur:[], prior:[]}
  const add = (bucket, r) => {
    const k = r.player_display_name;
    if (!logs.has(k)) logs.set(k, { pos: r.position, team: r.team, cur: [], prior: [] });
    const e = logs.get(k);
    if (bucket === "cur") e.team = r.team;
    e[bucket].push({
      att: n(r.attempts), pyds: n(r.passing_yards), ptd: n(r.passing_tds),
      car: n(r.carries), ryds: n(r.rushing_yards), rtd: n(r.rushing_tds),
      tgt: n(r.targets), recy: n(r.receiving_yards), rectd: n(r.receiving_tds)
    });
  };
  wk26.forEach(r => add("cur", r));
  wk25.forEach(r => add("prior", r));

  // ---- team defense: yards allowed per game --------------------------------
  const def = new Map(); // team -> {pass:[], rush:[]} per week
  const byOppWeek = new Map();
  wk26.forEach(r => {
    const k = `${r.opponent_team}|${r.week}`;
    if (!byOppWeek.has(k)) byOppWeek.set(k, { pass: 0, rush: 0 });
    const d = byOppWeek.get(k);
    d.pass += n(r.passing_yards); d.rush += n(r.rushing_yards);
  });
  byOppWeek.forEach((v, k) => {
    const team = k.split("|")[0];
    if (!def.has(team)) def.set(team, { pass: [], rush: [] });
    def.get(team).pass.push(v.pass); def.get(team).rush.push(v.rush);
  });
  const leaguePass = mean([...def.values()].map(d => mean(d.pass)));
  const leagueRush = mean([...def.values()].map(d => mean(d.rush)));
  console.log(`  league baseline: ${r1(leaguePass)} pass yds/g, ${r1(leagueRush)} rush yds/g allowed`);

  // ---- pick real starters by actual usage ----------------------------------
  function starters(team) {
    const onTeam = [...logs.entries()]
      .filter(([name, e]) => e.team === team && e.cur.length && active.has(name));
    const top = (pos, field, count) => onTeam
      .filter(([, e]) => e.pos === pos)
      .map(([name, e]) => ({ name, e, use: mean(e.cur.map(g => g[field])) }))
      .filter(x => x.use > 0)
      .sort((a, b) => b.use - a.use)
      .slice(0, count);
    return { qb: top("QB", "att", 1), rb: top("RB", "car", 2), wr: top("WR", "tgt", 3) };
  }

  const props = [];
  const push = (g, p, market, projection, extra = {}) => props.push({
    date: targetDate, game_id: g.game_id,
    matchup: `${g.away_team} @ ${g.home_team}`,
    team: p.team, opponent: p.opp, player: p.name, position: p.pos,
    market, projection, model_version: "leo-nflprop-v1",
    depth: p.depth || null,
    games_played: p.gp, opp_adjustment: r1(p.adj * 100) / 100, ...extra
  });

  for (const g of slate) {
    for (const [team, opp] of [[g.away_team, g.home_team], [g.home_team, g.away_team]]) {
      const s = starters(team);
      const d = def.get(opp) || { pass: [], rush: [] };
      const adjPass = oppAdjustment(mean(d.pass.slice(-3)), mean(d.pass), leaguePass, d.pass.length);
      const adjRush = oppAdjustment(mean(d.rush.slice(-3)), mean(d.rush), leagueRush, d.rush.length);

      for (const [i, { name, e }] of s.qb.entries()) {
        const ypa = blend(e.cur.map(x => x.att ? x.pyds / x.att : 0), e.cur.map(x => x.att ? x.pyds / x.att : 0), e.prior.map(x => x.att ? x.pyds / x.att : 0));
        const att = blend(e.cur.map(x => x.att), e.cur.map(x => x.att), e.prior.map(x => x.att));
        const proj = (ypa * att * adjPass) + CALIBRATION.QB_PASS_YARDS;
        push(g, { name, pos: "QB", depth: `QB${i + 1}`, team, opp, gp: e.cur.length, adj: adjPass },
             "QB_PASS_YARDS", Math.max(0, Math.round(proj)), { rate_used: r1(ypa), expected_volume: r1(att) });
      }
      for (const [i, { name, e }] of s.rb.entries()) {
        const ypc = blend(e.cur.map(x => x.car ? x.ryds / x.car : 0), e.cur.map(x => x.car ? x.ryds / x.car : 0), e.prior.map(x => x.car ? x.ryds / x.car : 0));
        const car = blend(e.cur.map(x => x.car), e.cur.map(x => x.car), e.prior.map(x => x.car));
        const proj = (ypc * car * adjRush) + CALIBRATION.RB_RUSH_YARDS;
        push(g, { name, pos: "RB", depth: `RB${i + 1}`, team, opp, gp: e.cur.length, adj: adjRush },
             "RB_RUSH_YARDS", Math.max(0, Math.round(proj)), { rate_used: r1(ypc), expected_volume: r1(car) });
        push(g, { name, pos: "RB", depth: `RB${i + 1}`, team, opp, gp: e.cur.length, adj: adjRush },
             "ANYTIME_TD", anytimeTD(e, "rtd", TD_BASE_RB, adjRush));
      }
      for (const [i, { name, e }] of s.wr.entries()) {
        const ypt = blend(e.cur.map(x => x.tgt ? x.recy / x.tgt : 0), e.cur.map(x => x.tgt ? x.recy / x.tgt : 0), e.prior.map(x => x.tgt ? x.recy / x.tgt : 0));
        const tgt = blend(e.cur.map(x => x.tgt), e.cur.map(x => x.tgt), e.prior.map(x => x.tgt));
        const proj = (ypt * tgt * adjPass) + CALIBRATION.WR_REC_YARDS;
        push(g, { name, pos: "WR", depth: `WR${i + 1}`, team, opp, gp: e.cur.length, adj: adjPass },
             "WR_REC_YARDS", Math.max(0, Math.round(proj)), { rate_used: r1(ypt), expected_volume: r1(tgt) });
        push(g, { name, pos: "WR", depth: `WR${i + 1}`, team, opp, gp: e.cur.length, adj: adjPass },
             "ANYTIME_TD", anytimeTD(e, "rectd", TD_BASE_WR, adjPass));
      }
    }
  }

  fs.mkdirSync(path.join(ROOT, "data/nfl"), { recursive: true });
  const out = path.join(ROOT, `data/nfl/props-${targetDate}.json`);
  fs.writeFileSync(out, JSON.stringify(props, null, 2));
  // Never let an empty slate blank the published props (see generate-nfl-model.js).
  if (props.length) {
    fs.writeFileSync(path.join(ROOT, "data/nfl/props-today.json"), JSON.stringify(props, null, 2));
  } else {
    console.log("  props: empty for this date, leaving props-today.json untouched");
  }

  /*
    FREEZE THE PROJECTION AND ITS FACTORS before anything can revise them.
    A prepare-slate rerun after kickoff has that week's player stats in hand
    and rebuilds every projection from them -- 198 of 290 were rewritten this
    way on 2026-09-20. The factors move with the projection, which matters
    more: they are what the learning system attributes error to.
  */
  try {
    const { recordProps, kickoffUtc } = require("./lib/prediction-history");
    const kickoffs = {};
    for (const g of slate) {
      kickoffs[`${g.away_team} @ ${g.home_team}`] = kickoffUtc(g.gameday, g.gametime);
    }
    const h = recordProps(path.join(ROOT, "data/nfl"), props, kickoffs);
    console.log(`  prop history: +${h.appended} new/changed, ${h.unchanged} unchanged` +
                (h.created ? " (created prop-prediction-history.csv)" : ""));
  } catch (e) {
    console.warn(`  prop history NOT written: ${e.message}`);
  }

  // unified log schema (claude/MODEL_IMPROVEMENT_FRAMEWORK.md)
  const logPath = path.join(ROOT, "data/nfl/nfl-props-log.csv");
  const header = "date,game_id,matchup,market,model_version,status,player,position,model_value,opp_adjustment,games_played,result,actual_value\n";
  const lines = props.map(p => [p.date, p.game_id, `"${p.matchup}"`, p.market, p.model_version,
    "projection", `"${p.player}"`, p.position, p.projection, p.opp_adjustment, p.games_played, "", ""].join(","));
  fs.writeFileSync(logPath, header + lines.join("\n") + "\n");

  const byMarket = {};
  props.forEach(p => byMarket[p.market] = (byMarket[p.market] || 0) + 1);
  console.log(`  wrote ${props.length} props ->`, Object.entries(byMarket).map(([k, v]) => `${k}:${v}`).join("  "));
  console.log(`  ${path.relative(ROOT, out)}`);
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
