#!/usr/bin/env node
"use strict";
/*
  LyDia — fetch pitcher strikeout prop lines (Over/Under) for today's slate.

  - Uses The Odds API per-event endpoint: /events/{id}/odds?markets=pitcher_strikeouts
  - Cost: 1 quota-counted request per event (~15/day). The /events list itself is free.
  - Writes data/k-props/<date>.json and data/k-props/today.json keyed by pitcher name:
    consensus line (median), best over/under prices at that line, book count.
  - No key or missing data → logs and exits 0. The daily run is never blocked.
*/
const fs = require("fs");
const path = require("path");
const PitcherCore = require("../js/pitcher-matchup-core.js");
const PitchingPlan = require("./lib/pitching-plan-core.js");

const ROOT = path.join(__dirname, "..");
const KEY = (process.env.ODDS_API_KEY || "").trim();
const DATE = (process.argv[2] || "").match(/^\d{4}-\d{2}-\d{2}$/)
  ? process.argv[2]
  : new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

async function j(url) { const r = await fetch(url); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }
// consensus = the most common posted line (a median can invent a line no book offers)
const consensus = a => {
  const counts = {};
  for (const v of a) counts[v] = (counts[v] || 0) + 1;
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  return Number(Object.entries(counts).sort((x, y) => y[1] - x[1] || Math.abs(x[0] - mean) - Math.abs(y[0] - mean))[0][0]);
};

const IF_CHANGED = process.argv.includes("--if-changed");

async function currentProbables() {
  const sched = await j(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}&hydrate=probablePitcher`);
  const out = {};
  for (const g of (((sched.dates || [])[0]) || {}).games || []) {
    if (!g.status || g.status.abstractGameState !== "Preview") continue;
    out[g.gamePk] = {
      away: (g.teams.away.probablePitcher || {}).fullName || "TBD",
      home: (g.teams.home.probablePitcher || {}).fullName || "TBD"
    };
  }
  return out;
}

async function main() {
  if (!KEY) { console.log("ODDS_API_KEY not set — strikeout props skipped."); return; }
  const reportedPlans = PitchingPlan.load(ROOT, DATE);
  const pitchingPlanSignature = JSON.stringify(reportedPlans.games || {});

  if (IF_CHANGED) {
    // Lines are captured once at publish and kept all day — only a pitcher change re-captures.
    const todayPath = path.join(ROOT, "data", "k-props", "today.json");
    if (!fs.existsSync(todayPath)) { console.log("No capture yet today — nothing to check."); return; }
    let prev; try { prev = JSON.parse(fs.readFileSync(todayPath, "utf8")); } catch (e) { prev = null; }
    if (!prev || prev.date !== DATE || !prev.probables) { console.log("No comparable capture — skipping."); return; }
    const now = await currentProbables();
    const changes = [];
    if (prev.pitching_plan_signature !== pitchingPlanSignature) changes.push("reported pitching plan updated");
    for (const [pk, cur] of Object.entries(now)) {
      const was = prev.probables[pk];
      if (!was) continue;
      for (const side of ["away", "home"]) {
        if (was[side] !== "TBD" && cur[side] !== was[side]) changes.push(`${was[side]} → ${cur[side]}`);
        if (was[side] === "TBD" && cur[side] !== "TBD") changes.push(`TBD → ${cur[side]}`);
      }
    }
    if (!changes.length) { console.log("Probables unchanged — keeping the morning capture."); return; }
    console.log(`Pitcher change detected (${changes.join("; ")}) — re-capturing prop lines.`);
  }
  const events = await j(`https://api.the-odds-api.com/v4/sports/baseball_mlb/events?apiKey=${KEY}`);
  // keep events that start on DATE in ET
  const todays = (events || []).filter(e => new Date(e.commence_time).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === DATE);
  console.log(`K-props: ${todays.length} event(s) on ${DATE}.`);
  const pitchers = {};
  let fetched = 0;

  for (const ev of todays) {
    let data;
    try {
      data = await j(`https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${ev.id}/odds?apiKey=${KEY}&regions=us&markets=pitcher_strikeouts&oddsFormat=american`);
      fetched++;
    } catch (e) { console.warn(`event ${ev.id}: ${e.message}`); continue; }
    // collect per pitcher: [{point, overPrice, underPrice, book}]
    const rows = {};
    for (const bk of data.bookmakers || []) {
      const mkt = (bk.markets || []).find(m => m.key === "pitcher_strikeouts");
      if (!mkt) continue;
      const byPitcher = {};
      for (const o of mkt.outcomes || []) {
        const name = (o.description || "").trim();
        if (!name) continue;
        (byPitcher[name] = byPitcher[name] || {})[o.name === "Over" ? "over" : "under"] = { price: o.price, point: o.point };
      }
      for (const [name, ou] of Object.entries(byPitcher)) {
        const pt = (ou.over && ou.over.point) ?? (ou.under && ou.under.point);
        if (!Number.isFinite(pt)) continue;
        (rows[name] = rows[name] || []).push({ point: pt, over: ou.over ? ou.over.price : null, under: ou.under ? ou.under.price : null, book: bk.key });
      }
    }
    for (const [name, arr] of Object.entries(rows)) {
      const line = consensus(arr.map(r => r.point));
      const atLine = arr.filter(r => Math.abs(r.point - line) < 0.01);
      const bestOver = atLine.filter(r => r.over !== null).sort((a, b) => b.over - a.over)[0] || null;
      const bestUnder = atLine.filter(r => r.under !== null).sort((a, b) => b.under - a.under)[0] || null;
      pitchers[name.toLowerCase()] = {
        name, line,
        over: bestOver ? bestOver.over : null,
        under: bestUnder ? bestUnder.under : null,
        books: arr.length,
        game: `${ev.away_team} @ ${ev.home_team}`
      };
    }
  }

  const probables = await currentProbables().catch(() => ({}));

  // SELF-CALIBRATION: read our own graded history and correct systematic bias.
  // Rolling mean error (actual − projection) over the last 100 graded pitchers;
  // applied only with n ≥ 30 and |bias| ≥ 0.15 K, capped at ±0.6 so learning
  // nudges, never lurches. The corrected number is what gets graded next —
  // the loop measures its own medicine.
  let learnedBias = 0, learnedN = 0;
  try {
    const klog = path.join(ROOT, "data", "calibration", "kprops_log.csv");
    if (fs.existsSync(klog)) {
      const rows = fs.readFileSync(klog, "utf8").trim().split("\n").slice(1).map(l => l.split(","))
        .filter(r => r.length >= 7 && r[5] !== "" && r[6] !== "" && isFinite(Number(r[5])) && isFinite(Number(r[6]))).slice(-100);
      learnedN = rows.length;
      if (learnedN >= 30) {
        const b = rows.reduce((a, r) => a + (Number(r[6]) - Number(r[5])), 0) / learnedN;
        if (Math.abs(b) >= 0.15) learnedBias = Math.max(-0.6, Math.min(0.6, Number(b.toFixed(2))));
      }
    }
  } catch (e) {}
  if (learnedBias) console.log(`K self-calibration: applying ${learnedBias > 0 ? "+" : ""}${learnedBias} K learned correction (n=${learnedN}).`);

  // Our projection per pitcher, captured alongside the market line so the
  // nightly grader can score projection vs line vs actual. Mirrors the tool math.
  try {
    const yr = Number(DATE.slice(0, 4));
    const sched = await j(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}&hydrate=probablePitcher`);
    const games = (((sched.dates || [])[0]) || {}).games || [];
    const base = `https://statsapi.mlb.com/api/v1/teams/stats?sportId=1&group=hitting&season=${yr}&stats=statSplits&sitCodes=`;
    const [vl, vr] = await Promise.all([j(base + "vl"), j(base + "vr")]);
    const kv = { L: {}, R: {} }; let soT = 0, paT = 0;
    for (const t of (vl.stats[0] || {}).splits || []) { const so = +t.stat.strikeOuts || 0, pa = +t.stat.plateAppearances || 0; if (pa) kv.L[t.team.id] = so / pa; }
    for (const t of (vr.stats[0] || {}).splits || []) { const so = +t.stat.strikeOuts || 0, pa = +t.stat.plateAppearances || 0; if (pa) { kv.R[t.team.id] = so / pa; soT += so; paT += pa; } }
    const leagueK = paT ? soT / paT : 0.223;
    const pids = [...new Set([
      ...games.flatMap(g => ["away", "home"].map(sd => g.teams[sd].probablePitcher && g.teams[sd].probablePitcher.id).filter(Boolean)),
      ...PitchingPlan.participantIds(reportedPlans)
    ])];
    if (pids.length) {
      const ps = await PitcherCore.fetchPitchers(pids, DATE, j);
      const bulkRoleStats = await PitchingPlan.fetchBulkRoleStats(reportedPlans, DATE, j);
      for (const g of games) {
        for (const sd of ["away", "home"]) {
          const probable = g.teams[sd].probablePitcher || null;
          const reported = PitchingPlan.getSidePlan(reportedPlans, g.gamePk, sd);
          const candidates = reported
            ? reported.segments.filter(segment => segment.role !== "bullpen")
            : probable ? [{ role: null, pitcher_id: probable.id, pitcher: probable.fullName, expected_innings: null }] : [];
          for (const candidate of candidates) {
            const pit = ps[Number(candidate.pitcher_id)];
            if (!pit || !pit.ip || pit.ip < 15 || !pit.bf) continue;
            const oppId = g.teams[sd === "away" ? "home" : "away"].team.id;
            const inferredRole = PitcherCore.classifyPitcherRole(pit);
            const expIP = Number.isFinite(Number(candidate.expected_innings))
              ? Number(candidate.expected_innings)
              : inferredRole.expectedInnings;
            const roleStats = candidate.role === "bulk" ? bulkRoleStats[Number(candidate.pitcher_id)] || null : null;
            const skillSo = roleStats && roleStats.bf ? roleStats.so : pit.so;
            const skillBf = roleStats && roleStats.bf ? roleStats.bf : pit.bf;
            const oppK = pit.hand && kv[pit.hand] ? kv[pit.hand][oppId] : null;
            const adj = (oppK && leagueK) ? Math.max(0.87, Math.min(1.13, oppK / leagueK)) : 1;
            const projRaw = Number((expIP * 4.28 * (skillSo / skillBf) * adj).toFixed(2));
            const proj = Number((projRaw + learnedBias).toFixed(2));
            const key = pit.name.toLowerCase();
            const rec = pitchers[key] || (pitchers[key] = { name: pit.name, line: null, over: null, under: null, books: 0, game: `${g.teams.away.team.name} @ ${g.teams.home.team.name}` });
            rec.projection = proj;
            rec.projection_raw = projRaw;
            rec.game_pk = g.gamePk;
            rec.pitcher_role = candidate.role || inferredRole.key;
            rec.pitcher_role_label = candidate.role === "bulk" ? "Bulk pitcher" : candidate.role === "opener" ? "Opener" : inferredRole.label;
            rec.expected_innings = Number(expIP.toFixed(1));
            rec.bullpen_game = candidate.role === "opener" || (!candidate.role && inferredRole.bullpenGame);
            rec.pitching_plan_reported = Boolean(reported);
            rec.role_stats = roleStats;
          }
        }
      }
    }
  } catch (e) { console.warn("projection compute skipped:", e.message); }
  // MERGE with any existing capture — started games keep their morning lines/projections.
  try {
    const prevPath = path.join(ROOT, "data", "k-props", `${DATE}.json`);
    if (fs.existsSync(prevPath)) {
      const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
      if (prev && prev.date === DATE && prev.pitchers) {
        for (const [k, v] of Object.entries(prev.pitchers)) if (!pitchers[k]) pitchers[k] = v;
      }
    }
  } catch (e) {}
  const out = { date: DATE, generated_at: new Date().toISOString(), source: "the-odds-api pitcher_strikeouts (us region; consensus = most common posted line, best price at it)", events_fetched: fetched, probables, pitching_plan_signature: pitchingPlanSignature, pitchers, learned_bias: learnedBias, learned_n: learnedN };
  fs.mkdirSync(path.join(ROOT, "data", "k-props"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "k-props", `${DATE}.json`), JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(ROOT, "data", "k-props", "today.json"), JSON.stringify(out, null, 1));
  console.log(`K-props: wrote lines for ${Object.keys(pitchers).length} pitcher(s) from ${fetched} event call(s).`);
}
main().catch(e => { console.error("k-props error:", e.message); process.exit(0); });
