#!/usr/bin/env node
"use strict";
/*
  LyDia — total-runs projections + market total lines (K-props pattern).

  - Projection per game: league run environment × each lineup's offense factor
    × the opposing pitching factor (FIP-lite starter for ~expected innings share,
    league-average relief for the rest, small bump for a tired opposing pen)
    × the home park's run factor.
  - Market line: The Odds API featured `totals` market (ONE bulk request for the
    whole slate). Consensus = most common posted line; best O/U prices at it.
  - Captured once at publish, kept all day; --if-changed re-captures only when a
    listed starter changes (same policy as K props).
  - No key → projections still computed, lines null. Nothing blocks the run.
*/
const fs = require("fs");
const path = require("path");
const PitcherCore = require("../js/pitcher-matchup-core.js");

const ROOT = path.join(__dirname, "..");
const KEY = (process.env.ODDS_API_KEY || "").trim();
const DATE = (process.argv[2] || "").match(/^\d{4}-\d{2}-\d{2}$/)
  ? process.argv[2]
  : new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const IF_CHANGED = process.argv.includes("--if-changed");

const LEAGUE_ERA = 4.20;
const TOTALS_MODEL_VERSION = "totals-runs-v2-innings-allocation";
const TOTALS_POLICY = Object.freeze({
  version: "totals-policy-v3-official",
  research_min_edge: 0.7,
  research_min_setup: 70,
  strong_min_edge: 1.0,
  strong_min_setup: 80,
  official_totals_enabled: true,
  team_totals_official_enabled: false
});
const PARKS = {"Colorado Rockies": 1.18, "Cincinnati Reds": 1.07, "Boston Red Sox": 1.06, "Philadelphia Phillies": 1.06, "Atlanta Braves": 1.05, "New York Yankees": 1.05, "Chicago White Sox": 1.04, "Toronto Blue Jays": 1.03, "Arizona Diamondbacks": 1.02, "Chicago Cubs": 1.02, "Texas Rangers": 1.0, "Baltimore Orioles": 1.0, "Milwaukee Brewers": 1.0, "Los Angeles Angels": 1.0, "Cleveland Guardians": 0.99, "Minnesota Twins": 0.99, "Houston Astros": 0.99, "Washington Nationals": 0.98, "Tampa Bay Rays": 0.98, "Pittsburgh Pirates": 0.97, "St. Louis Cardinals": 0.97, "Kansas City Royals": 0.96, "New York Mets": 0.96, "Detroit Tigers": 0.95, "Los Angeles Dodgers": 0.94, "Miami Marlins": 0.93, "San Diego Padres": 0.93, "Seattle Mariners": 0.92, "San Francisco Giants": 0.91};

async function j(u) { const r = await fetch(u); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }
const clampEra = e => Math.min(6, Math.max(2.75, e));
const fipLite = st => { if (!st || !st.ip || st.ip < 10) return LEAGUE_ERA; const fip = (13 * st.hr + 3 * st.bb - 2 * st.so) / st.ip + 3.15; const wt = Math.min(st.ip, 80) / 80; return clampEra(fip * wt + LEAGUE_ERA * (1 - wt)); };
const consensus = a => { const c = {}; for (const v of a) c[v] = (c[v] || 0) + 1; const mean = a.reduce((x, y) => x + y, 0) / a.length; return Number(Object.entries(c).sort((x, y) => y[1] - x[1] || Math.abs(x[0] - mean) - Math.abs(y[0] - mean))[0][0]); };

async function currentProbables(games) {
  const out = {};
  for (const g of games) {
    if (!g.status || g.status.abstractGameState !== "Preview") continue;
    out[g.gamePk] = {
      away: (g.teams.away.probablePitcher || {}).fullName || "TBD",
      home: (g.teams.home.probablePitcher || {}).fullName || "TBD"
    };
  }
  return out;
}

async function main() {
  const sched = await j(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}&hydrate=probablePitcher`);
  const games = (((sched.dates || [])[0]) || {}).games || [];
  const probables = await currentProbables(games);

  if (IF_CHANGED) {
    const tPath = path.join(ROOT, "data", "totals", "today.json");
    if (!fs.existsSync(tPath)) { console.log("Totals: no capture yet today."); return; }
    let prev; try { prev = JSON.parse(fs.readFileSync(tPath, "utf8")); } catch (e) { prev = null; }
    if (!prev || prev.date !== DATE || !prev.probables) { console.log("Totals: no comparable capture."); return; }
    const changes = [];
    for (const [pk, cur] of Object.entries(probables)) {
      const was = prev.probables[pk];
      if (!was) continue;
      for (const side of ["away", "home"]) {
        if (was[side] !== "TBD" && cur[side] !== was[side]) changes.push(`${was[side]} → ${cur[side]}`);
        if (was[side] === "TBD" && cur[side] !== "TBD") changes.push(`TBD → ${cur[side]}`);
      }
    }
    if (!changes.length) { console.log("Totals: probables unchanged — keeping the morning capture."); return; }
    console.log(`Totals: pitcher change (${changes.join("; ")}) — re-capturing.`);
  }

  // --- inputs: standings (offense factors), pitcher stats, bullpen fatigue ---
  const yr = Number(DATE.slice(0, 4));
  const standings = await j(`https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${yr}&standingsTypes=regularSeason`);
  const off = {}; let rsT = 0, gT = 0;
  for (const rec of standings.records || []) for (const t of rec.teamRecords || []) {
    const gp = t.wins + t.losses;
    if (gp) { off[t.team.id] = t.runsScored / gp; rsT += t.runsScored; gT += gp; }
  }
  const lgRPG = gT ? rsT / gT : 4.5;
  // Recent form: last-15-day scoring, blended 70/30 with season — same philosophy
  // as the moneyline model's Pythagorean + last-10 blend. Form matters; it just
  // doesn't get to shout over a 90-game sample.
  // Three-tier blend: season 60% + last-15 25% + last-7 15%. Short-window weight
  // scales DOWN with sample size (3 games of 7-6-2 is a whisper, not a shout).
  const off15 = {}, off7 = {}, g15 = {}, g7 = {};
  const f = d => d.toISOString().slice(0, 10);
  const end = new Date(DATE + "T12:00:00Z");
  const windowFetch = async (days, store, gstore) => {
    const start = new Date(end.getTime() - days * 864e5);
    const win = await j(`https://statsapi.mlb.com/api/v1/teams/stats?sportId=1&group=hitting&season=${yr}&stats=byDateRange&startDate=${f(start)}&endDate=${f(end)}`);
    for (const t of (win.stats[0] || {}).splits || []) {
      const gp = Number(t.stat.gamesPlayed) || 0;
      if (gp > 0) { store[t.team.id] = (Number(t.stat.runs) || 0) / gp; gstore[t.team.id] = gp; }
    }
  };
  try { await Promise.all([windowFetch(15, off15, g15), windowFetch(7, off7, g7)]); }
  catch (e) { console.warn("form windows unavailable:", e.message); }

  const pids = [...new Set(games.flatMap(g => ["away", "home"].map(sd => g.teams[sd].probablePitcher && g.teams[sd].probablePitcher.id).filter(Boolean)))];
  // Use the same starter-only usage and role classifier as the Pitcher Matchup
  // Tool. Total season innings divided by starts is invalid for mixed-role
  // pitchers because it incorrectly assigns their relief innings to starts.
  const ps = await PitcherCore.fetchPitchers(pids, DATE, j);
  let bullpen = {};
  try { const bp = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "bullpen", `${DATE}.json`), "utf8")); if (bp.date === DATE) bullpen = bp.teams_by_name || {}; } catch (e) {}

  // --- market total lines: one bulk request, retried ---
  let lines = {};
  const eventIds = {};
  if (KEY) {
    const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds?apiKey=${KEY}&regions=us&markets=h2h,totals&oddsFormat=american`;
    let odds = null;
    for (let attempt = 1; attempt <= 3 && !odds; attempt++) {
      try { odds = await j(url); }
      catch (e) {
        console.warn(`totals odds attempt ${attempt} failed: ${e.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
    if (odds) {
      for (const ev of odds || []) {
        eventIds[`${ev.away_team} @ ${ev.home_team}`] = ev.id;
        const rows = [];
        for (const bk of ev.bookmakers || []) {
          const mkt = (bk.markets || []).find(m => m.key === "totals");
          if (!mkt) continue;
          const over = (mkt.outcomes || []).find(o => o.name === "Over");
          const under = (mkt.outcomes || []).find(o => o.name === "Under");
          const pt = over && Number.isFinite(over.point) ? over.point : (under && under.point);
          if (Number.isFinite(pt)) rows.push({ point: pt, over: over ? over.price : null, under: under ? under.price : null });
        }
        if (!rows.length) continue;
        const line = consensus(rows.map(r => r.point));
        const at = rows.filter(r => Math.abs(r.point - line) < 0.01);
        lines[`${ev.away_team} @ ${ev.home_team}`] = {
          line,
          over: (at.filter(r => r.over !== null).sort((a, b) => b.over - a.over)[0] || {}).over ?? null,
          under: (at.filter(r => r.under !== null).sort((a, b) => b.under - a.under)[0] || {}).under ?? null,
          books: rows.length
        };
      }
    } else console.warn("totals odds unavailable after retries — reusing prior capture if present.");
  } else console.log("ODDS_API_KEY not set — projections only, no market lines.");

  // Team totals are an additional market and must be requested one event at a
  // time. They are stored beside each team's run projection. Coverage varies
  // by book, so missing team totals never block the daily publish.
  const teamTotalLines = {};
  if (KEY) {
    for (const [gameName, eventId] of Object.entries(eventIds)) {
      let data = null;
      try {
        data = await j(`https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${eventId}/odds?apiKey=${KEY}&regions=us&markets=team_totals&oddsFormat=american`);
      } catch (e) {
        console.warn(`team totals ${gameName}: ${e.message}`);
        continue;
      }
      const byTeam = {};
      for (const bk of data.bookmakers || []) {
        const mkt = (bk.markets || []).find(m => m.key === "team_totals");
        if (!mkt) continue;
        for (const o of mkt.outcomes || []) {
          const team = String(o.description || "").trim();
          if (!team || !Number.isFinite(o.point) || !["Over", "Under"].includes(o.name)) continue;
          const row = (byTeam[team] = byTeam[team] || {});
          const key = `${o.point}`;
          const line = (row[key] = row[key] || { point: o.point, over: null, under: null, books: new Set() });
          if (o.name === "Over" && (line.over === null || o.price > line.over)) line.over = o.price;
          if (o.name === "Under" && (line.under === null || o.price > line.under)) line.under = o.price;
          line.books.add(bk.key);
        }
      }
      teamTotalLines[gameName] = {};
      for (const [team, linesByPoint] of Object.entries(byTeam)) {
        const offered = Object.values(linesByPoint);
        if (!offered.length) continue;
        const featured = offered.sort((a, b) => b.books.size - a.books.size || Math.abs(a.point - 4.5) - Math.abs(b.point - 4.5))[0];
        teamTotalLines[gameName][team] = {
          line: featured.point,
          over: featured.over,
          under: featured.under,
          books: featured.books.size
        };
      }
    }
  }

  // SELF-CALIBRATION: rolling mean error over the last 100 graded totals;
  // n ≥ 25 and |bias| ≥ 0.2 runs to act, capped ±0.8.
  let learnedBias = 0, learnedN = 0;
  try {
    const tlog = path.join(ROOT, "data", "calibration", "totals_model_log.csv");
    if (fs.existsSync(tlog)) {
      const rows2 = fs.readFileSync(tlog, "utf8").trim().split("\n").slice(1).map(l => l.split(","))
        .filter(r => r.length >= 8 && r[2] === TOTALS_MODEL_VERSION && r[6] !== "" && r[7] !== "" && isFinite(Number(r[6])) && isFinite(Number(r[7]))).slice(-100);
      learnedN = rows2.length;
      if (learnedN >= 25) {
        const b = rows2.reduce((a, r) => a + (Number(r[7]) - Number(r[6])), 0) / learnedN;
        if (Math.abs(b) >= 0.2) learnedBias = Math.max(-0.8, Math.min(0.8, Number(b.toFixed(2))));
      }
    }
  } catch (e) {}
  if (learnedBias) console.log(`Totals self-calibration: applying ${learnedBias > 0 ? "+" : ""}${learnedBias} run learned correction (n=${learnedN}).`);

  // --- projection per game ---
  const out = {};
  for (const g of games) {
    if (!g.status || !["Preview", "Live"].includes(g.status.abstractGameState)) continue;
    const aT = g.teams.away.team, hT = g.teams.home.team;
    const park = PARKS[hT.name] ?? 1.0;
    const side = (batTeamId, oppStarter, oppPenName) => {
      const seasonRpg = off[batTeamId] || lgRPG;
      // weights scale with each window's sample; unearned weight returns to season
      let w15 = Number.isFinite(off15[batTeamId]) ? 0.25 * Math.min(1, (g15[batTeamId] || 0) / 12) : 0;
      let w7 = Number.isFinite(off7[batTeamId]) ? 0.15 * Math.min(1, (g7[batTeamId] || 0) / 6) : 0;
      const rpg = (1 - w15 - w7) * seasonRpg + w15 * (off15[batTeamId] || 0) + w7 * (off7[batTeamId] || 0);
      const offF = rpg / lgRPG;
      const st = oppStarter ? ps[oppStarter.id] : null;
      const role = PitcherCore.classifyPitcherRole(st);
      const fip = fipLite(st);
      const expIP = role.expectedInnings;
      const share = expIP / 9;
      const pen = bullpen[oppPenName];
      // Run projection should react to how likely the pen is to actually give
      // up runs, not just how much it's pitched — a tired-but-dominant pen
      // (heavy IP, low ERA/WHIP) shouldn't inflate the total the same way a
      // tired-and-bad one does. Uses the combined risk index (fatigue blended
      // with efficiency), same field the moneyline model and Lab Rating use,
      // so this page's run bump agrees with the rest of the site instead of
      // reacting to raw workload alone. Falls back to raw fatigue score for
      // any bullpen file generated before the efficiency split existed.
      const penRisk = pen && Number.isFinite(pen.risk_index ?? pen.score) ? (pen.risk_index ?? pen.score) : null;
      const penFatigue = pen && Number.isFinite(pen.score) ? pen.score : null;
      const penEfficiency = pen && Number.isFinite(pen.efficiency_score) ? pen.efficiency_score : null;
      const penEfficiencyLabel = pen && pen.efficiency_label ? pen.efficiency_label : null;
      // The combined bullpen risk score already blends workload/fatigue with
      // recent ERA/WHIP efficiency. Convert it directly around neutral 50:
      // risk 76 = 1.26 run factor, risk 40 = 0.90. Apply that factor only to
      // the innings assigned to the bullpen, so an opener handing over 7.9
      // innings has a materially larger effect than a starter handing over 2.2.
      const penF = penRisk !== null
        ? Math.max(0.75, Math.min(1.35, 1 + (penRisk - 50) / 100))
        : 1;
      // Allocate the probable pitcher's quality only to his expected workload.
      // The bullpen factor owns every remaining inning, which is the majority
      // of an opener or bullpen game.
      const pitchF = (fip / LEAGUE_ERA) * share + penF * (1 - share);
      return {
        runs: lgRPG * offF * pitchF * park,
        rpg: Number(rpg.toFixed(2)), season_rpg: Number(seasonRpg.toFixed(2)),
        form15_rpg: Number.isFinite(off15[batTeamId]) ? Number(off15[batTeamId].toFixed(2)) : null, form15_g: g15[batTeamId] || 0,
        form7_rpg: Number.isFinite(off7[batTeamId]) ? Number(off7[batTeamId].toFixed(2)) : null, form7_g: g7[batTeamId] || 0,
        off_factor: Number(offF.toFixed(3)),
        opp_sp: st ? st.name : "TBD", opp_sp_fip: Number(fip.toFixed(2)), opp_sp_ip: st ? Number(expIP.toFixed(1)) : null,
        opp_pitcher_role: role.key, opp_pitcher_role_label: role.label,
        opp_pitcher_role_confidence: role.confidence,
        opp_bullpen_game: role.bullpenGame,
        opp_bullpen_ip: Number(role.bullpenInnings.toFixed(1)),
        opp_pitcher_role_reason: role.reason,
        pitch_factor: Number(pitchF.toFixed(3)),
        opp_pen_risk: penRisk, opp_pen_fatigue: penFatigue, opp_pen_efficiency: penEfficiency, opp_pen_efficiency_label: penEfficiencyLabel,
        pen_factor: Number(penF.toFixed(3)),
        sp_sample_ok: !!(st && st.ip >= 40 && role.confidence !== "low"),
        pitching_plan_confident: role.confidence === "high" && !role.bullpenGame
      };
    };
    const A = side(aT.id, g.teams.home.probablePitcher, hT.name);
    const H = side(hT.id, g.teams.away.probablePitcher, aT.name);
    const pitchingPlan = {
      away: {
        pitcher: g.teams.away.probablePitcher ? g.teams.away.probablePitcher.fullName : "TBD",
        role: H.opp_pitcher_role,
        label: H.opp_pitcher_role_label,
        expected_innings: H.opp_sp_ip,
        bullpen_innings: H.opp_bullpen_ip,
        confidence: H.opp_pitcher_role_confidence,
        bullpen_game: H.opp_bullpen_game
      },
      home: {
        pitcher: g.teams.home.probablePitcher ? g.teams.home.probablePitcher.fullName : "TBD",
        role: A.opp_pitcher_role,
        label: A.opp_pitcher_role_label,
        expected_innings: A.opp_sp_ip,
        bullpen_innings: A.opp_bullpen_ip,
        confidence: A.opp_pitcher_role_confidence,
        bullpen_game: A.opp_bullpen_game
      }
    };
    const projRaw = Number((A.runs + H.runs).toFixed(1));
    const proj = Number((projRaw + learnedBias).toFixed(1));
    const mkt = lines[`${aT.name} @ ${hT.name}`] || {};
    const line = Number.isFinite(mkt.line) ? mkt.line : null;
    // Totals Lab Rating (0–100 internal, shown /10): setup quality, auditable.
    // 40 edge pts (|proj − line| / 2.5 capped) + 25 data confidence (both starters
    // listed with real samples) + 20 alignment (park + both offense factors point
    // the same way as the lean) + 15 base. No line → edge/alignment unscored.
    let tLab = 15;
    const lean = line !== null ? proj - line : null;
    if (lean !== null) tLab += Math.min(1, Math.abs(lean) / 2.5) * 40;
    // Openers are not penalized simply for being openers. When the probable
    // pitcher and bullpen risk data are available, the pitching plan has the
    // same data-completeness credit as a traditional start. Performance and
    // risk flow through the projection and bullpen model instead.
    const sideConfidence = x => {
      const hasPitcher = x.opp_sp !== "TBD" && x.opp_pitcher_role !== "unknown";
      const hasBullpen = x.opp_pen_risk !== null;
      if (hasPitcher && hasBullpen) return 12.5;
      if (hasPitcher) return 8;
      return 0;
    };
    const dataConf = sideConfidence(A) + sideConfidence(H);
    tLab += dataConf;
    if (lean !== null && Math.abs(lean) >= TOTALS_POLICY.research_min_edge) {
      const dir = lean > 0 ? 1 : -1;
      let align = 0;
      if ((park - 1) * dir > 0.02) align += 7;
      if ((A.off_factor - 1) * dir > 0.03) align += 6.5;
      if ((H.off_factor - 1) * dir > 0.03) align += 6.5;
      tLab += align;
    }
    const totalsLab = Math.round(Math.max(0, Math.min(100, tLab)));
    const absLean = lean === null ? null : Math.abs(lean);
    const officialEligible = lean !== null
      && absLean >= TOTALS_POLICY.strong_min_edge
      && totalsLab >= TOTALS_POLICY.strong_min_setup
      && (lean > 0 ? Number.isFinite(mkt.over) : Number.isFinite(mkt.under));
    const classification = lean === null
      ? "line_pending"
      : absLean < TOTALS_POLICY.research_min_edge
        ? "no_lean"
        : totalsLab < TOTALS_POLICY.research_min_setup
          ? "no_lean_low_setup"
          : officialEligible
            ? "official_pick"
            : "research_lean";
    const postedTeamTotals = teamTotalLines[`${aT.name} @ ${hT.name}`] || {};
    const teamTotal = (team, projected) => {
      const market = postedTeamTotals[team] || {};
      const edge = Number.isFinite(market.line) ? Number((projected - market.line).toFixed(1)) : null;
      return {
        team,
        projection: projected,
        line: Number.isFinite(market.line) ? market.line : null,
        over: market.over ?? null,
        under: market.under ?? null,
        books: market.books || 0,
        edge,
        lean: edge === null || Math.abs(edge) < TOTALS_POLICY.research_min_edge ? null : (edge > 0 ? "Over" : "Under"),
        classification: edge === null ? "line_pending" : Math.abs(edge) < TOTALS_POLICY.research_min_edge ? "no_lean" : "research_lean"
      };
    };
    out[g.gamePk] = {
      game: `${aT.name} @ ${hT.name}`,
      game_time_iso: g.gameDate,
      projection: proj,
      projection_raw: projRaw,
      proj_away: Number(A.runs.toFixed(1)),
      proj_home: Number(H.runs.toFixed(1)),
      away: { team: aT.name, ...A, runs: undefined },
      home: { team: hT.name, ...H, runs: undefined },
      park_factor: park,
      away_sp: (g.teams.away.probablePitcher || {}).fullName || "TBD",
      home_sp: (g.teams.home.probablePitcher || {}).fullName || "TBD",
      line, over: mkt.over ?? null, under: mkt.under ?? null, books: mkt.books || 0,
      team_totals: {
        away: teamTotal(aT.name, Number(A.runs.toFixed(1))),
        home: teamTotal(hT.name, Number(H.runs.toFixed(1)))
      },
      lab: totalsLab,
      official_eligible: officialEligible,
      setup_components: {
        base: 15,
        data_confidence: dataConf,
        edge_points: lean === null ? 0 : Number((Math.min(1, Math.abs(lean) / 2.5) * 40).toFixed(2)),
        alignment_threshold: TOTALS_POLICY.research_min_edge
      },
      classification
    };
  }

  // MERGE with any existing capture: games that already started must keep their
  // morning projections/lines — a re-capture may only update or add pregame games.
  try {
    const prevPath = path.join(ROOT, "data", "totals", `${DATE}.json`);
    if (fs.existsSync(prevPath)) {
      const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
      if (prev && prev.date === DATE && prev.games) {
        for (const [pk, g] of Object.entries(prev.games)) {
          if (!out[pk]) {
            out[pk] = g;
            if (!out[pk].team_totals) {
              out[pk].team_totals = {
                away: { team: g.away && g.away.team, projection: g.proj_away, line: null, over: null, under: null, books: 0, edge: null, lean: null, classification: "line_pending" },
                home: { team: g.home && g.home.team, projection: g.proj_home, line: null, over: null, under: null, books: 0, edge: null, lean: null, classification: "line_pending" }
              };
            }
            continue;
          }
          // A failed/empty live call must never wipe a line captured earlier.
          if (out[pk].line == null && g.line != null) {
            out[pk].line = g.line; out[pk].over = g.over ?? null;
            out[pk].under = g.under ?? null; out[pk].books = g.books || 0;
          }
          for (const side of ["away", "home"]) {
            const current = out[pk].team_totals && out[pk].team_totals[side];
            const captured = g.team_totals && g.team_totals[side];
            if (current && captured && current.line == null && captured.line != null) {
              out[pk].team_totals[side] = captured;
            }
          }
        }
      }
    }
  } catch (e) {}

  const payload = { date: DATE, generated_at: new Date().toISOString(), model_version: TOTALS_MODEL_VERSION, policy: TOTALS_POLICY, source: "LyDia totals projection (offense factor × opposing pitching × park × pen fatigue) + the-odds-api totals consensus", league_rpg: Number(lgRPG.toFixed(2)), probables, games: out, learned_bias: learnedBias, learned_n: learnedN };
  fs.mkdirSync(path.join(ROOT, "data", "totals"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "totals", `${DATE}.json`), JSON.stringify(payload, null, 1));
  fs.writeFileSync(path.join(ROOT, "data", "totals", "today.json"), JSON.stringify(payload, null, 1));
  console.log(`Totals: ${Object.keys(out).length} games projected, ${Object.values(out).filter(x => x.line !== null).length} with market lines.`);
}
main().catch(e => { console.error("totals error:", e.message); process.exit(0); });
