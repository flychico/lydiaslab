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

const ROOT = path.join(__dirname, "..");
const KEY = (process.env.ODDS_API_KEY || "").trim();
const DATE = (process.argv[2] || "").match(/^\d{4}-\d{2}-\d{2}$/)
  ? process.argv[2]
  : new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const IF_CHANGED = process.argv.includes("--if-changed");

const LEAGUE_ERA = 4.20;
const PARKS = {"Colorado Rockies": 1.18, "Cincinnati Reds": 1.07, "Boston Red Sox": 1.06, "Philadelphia Phillies": 1.06, "Atlanta Braves": 1.05, "New York Yankees": 1.05, "Chicago White Sox": 1.04, "Toronto Blue Jays": 1.03, "Arizona Diamondbacks": 1.02, "Chicago Cubs": 1.02, "Texas Rangers": 1.0, "Baltimore Orioles": 1.0, "Milwaukee Brewers": 1.0, "Los Angeles Angels": 1.0, "Cleveland Guardians": 0.99, "Minnesota Twins": 0.99, "Houston Astros": 0.99, "Washington Nationals": 0.98, "Tampa Bay Rays": 0.98, "Pittsburgh Pirates": 0.97, "St. Louis Cardinals": 0.97, "Kansas City Royals": 0.96, "New York Mets": 0.96, "Detroit Tigers": 0.95, "Los Angeles Dodgers": 0.94, "Miami Marlins": 0.93, "San Diego Padres": 0.93, "Seattle Mariners": 0.92, "San Francisco Giants": 0.91};

async function j(u) { const r = await fetch(u); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }
const ipToNum = ip => { if (!ip || ip === "-.--") return 0; const [w, f] = String(ip).split("."); return Number(w || 0) + Number(f || 0) / 3; };
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

  const pids = [...new Set(games.flatMap(g => ["away", "home"].map(sd => g.teams[sd].probablePitcher && g.teams[sd].probablePitcher.id).filter(Boolean)))];
  const ps = {};
  if (pids.length) {
    const pd = await j(`https://statsapi.mlb.com/api/v1/people?personIds=${pids.join(",")}&hydrate=stats(group=[pitching],type=[season])`);
    for (const pp of pd.people || []) {
      const st = ((((pp.stats || [])[0] || {}).splits || [])[0] || {}).stat || {};
      ps[pp.id] = { name: pp.fullName, ip: ipToNum(st.inningsPitched), so: +st.strikeOuts || 0, bb: +st.baseOnBalls || 0, hr: +st.homeRuns || 0, gs: +st.gamesStarted || 0 };
    }
  }
  let bullpen = {};
  try { const bp = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "bullpen", `${DATE}.json`), "utf8")); if (bp.date === DATE) bullpen = bp.teams_by_name || {}; } catch (e) {}

  // --- market total lines: one bulk request ---
  let lines = {};
  if (KEY) {
    try {
      const odds = await j(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds?apiKey=${KEY}&regions=us&markets=totals&oddsFormat=american`);
      for (const ev of odds || []) {
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
    } catch (e) { console.warn("totals odds unavailable:", e.message); }
  } else console.log("ODDS_API_KEY not set — projections only, no market lines.");

  // --- projection per game ---
  const out = {};
  for (const g of games) {
    if (!g.status || !["Preview", "Live"].includes(g.status.abstractGameState)) continue;
    const aT = g.teams.away.team, hT = g.teams.home.team;
    const park = PARKS[hT.name] ?? 1.0;
    const side = (batTeamId, oppStarter, oppPenName) => {
      const rpg = off[batTeamId] || lgRPG;
      const offF = rpg / lgRPG;
      const st = oppStarter ? ps[oppStarter.id] : null;
      const fip = fipLite(st);
      const expIP = st && st.gs ? Math.max(3.8, Math.min(6.8, st.ip / st.gs)) : 5.4;
      const share = expIP / 9;
      const pitchF = (fip / LEAGUE_ERA) * share + 1.0 * (1 - share);
      const pen = bullpen[oppPenName];
      const penScore = pen && Number.isFinite(pen.score) ? pen.score : null;
      const penF = penScore !== null && penScore > 55 ? 1 + Math.min(0.06, (penScore - 55) / 500) : 1;
      return {
        runs: lgRPG * offF * pitchF * penF * park,
        rpg: Number(rpg.toFixed(2)), off_factor: Number(offF.toFixed(3)),
        opp_sp: st ? st.name : "TBD", opp_sp_fip: Number(fip.toFixed(2)), opp_sp_ip: st ? Number(expIP.toFixed(1)) : null,
        pitch_factor: Number(pitchF.toFixed(3)),
        opp_pen_score: penScore, pen_factor: Number(penF.toFixed(3)),
        sp_sample_ok: !!(st && st.ip >= 40)
      };
    };
    const A = side(aT.id, g.teams.home.probablePitcher, hT.name);
    const H = side(hT.id, g.teams.away.probablePitcher, aT.name);
    const proj = Number((A.runs + H.runs).toFixed(1));
    const mkt = lines[`${aT.name} @ ${hT.name}`] || {};
    const line = Number.isFinite(mkt.line) ? mkt.line : null;
    // Totals Lab Rating (0–100 internal, shown /10): setup quality, auditable.
    // 40 edge pts (|proj − line| / 2.5 capped) + 25 data confidence (both starters
    // listed with real samples) + 20 alignment (park + both offense factors point
    // the same way as the lean) + 15 base. No line → edge/alignment unscored.
    let tLab = 15;
    const lean = line !== null ? proj - line : null;
    if (lean !== null) tLab += Math.min(1, Math.abs(lean) / 2.5) * 40;
    const dataConf = (A.sp_sample_ok ? 12.5 : A.opp_sp !== "TBD" ? 6 : 0) + (H.sp_sample_ok ? 12.5 : H.opp_sp !== "TBD" ? 6 : 0);
    tLab += dataConf;
    if (lean !== null && Math.abs(lean) >= 0.5) {
      const dir = lean > 0 ? 1 : -1;
      let align = 0;
      if ((park - 1) * dir > 0.02) align += 7;
      if ((A.off_factor - 1) * dir > 0.03) align += 6.5;
      if ((H.off_factor - 1) * dir > 0.03) align += 6.5;
      tLab += align;
    }
    const totalsLab = Math.round(Math.max(0, Math.min(100, tLab)));
    out[g.gamePk] = {
      game: `${aT.name} @ ${hT.name}`,
      game_time_iso: g.gameDate,
      projection: proj,
      proj_away: Number(A.runs.toFixed(1)),
      proj_home: Number(H.runs.toFixed(1)),
      away: { team: aT.name, ...A, runs: undefined },
      home: { team: hT.name, ...H, runs: undefined },
      park_factor: park,
      away_sp: (g.teams.away.probablePitcher || {}).fullName || "TBD",
      home_sp: (g.teams.home.probablePitcher || {}).fullName || "TBD",
      line, over: mkt.over ?? null, under: mkt.under ?? null, books: mkt.books || 0,
      lab: totalsLab
    };
  }

  const payload = { date: DATE, generated_at: new Date().toISOString(), source: "LyDia totals projection (offense factor × opposing pitching × park × pen fatigue) + the-odds-api totals consensus", league_rpg: Number(lgRPG.toFixed(2)), probables, games: out };
  fs.mkdirSync(path.join(ROOT, "data", "totals"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "totals", `${DATE}.json`), JSON.stringify(payload, null, 1));
  fs.writeFileSync(path.join(ROOT, "data", "totals", "today.json"), JSON.stringify(payload, null, 1));
  console.log(`Totals: ${Object.keys(out).length} games projected, ${Object.values(out).filter(x => x.line !== null).length} with market lines.`);
}
main().catch(e => { console.error("totals error:", e.message); process.exit(0); });
