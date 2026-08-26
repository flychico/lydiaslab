#!/usr/bin/env node
"use strict";
/*
  LyDia — total-runs projections + market total lines (K-props pattern).

  2026-07-29: rebuilt as an ADDITIVE runs model. No league-RPG multiplication
  anywhere. Per team:

    runs = median RPG (trailing 30 days)
         + offense adjustment  (tonight's posted lineup's PA-weighted wOBA
                                 vs. trailing-30-day league wOBA, scaled to
                                 runs via wOBA scale and PA/team-game)
         + starter adjustment  ((starter FIP-lite − LEAGUE_ERA) × innings/9,
                                 per pitching-plan segment)
         + bullpen adjustment  ((opposing bullpen's era_7d, shrunk toward
                                 LEAGUE_ERA for thin samples − LEAGUE_ERA) ×
                                 bullpen innings/9 — actual runs allowed over
                                 the last 7 days, shrunk n/(n+k) per Lynold
                                 2026-08-05; see BULLPEN_SHRINK_K)

  LEAGUE_ERA (4.20) is the only fixed reference constant left in the formula,
  kept unchanged per Lynold 2026-07-29. Everything else (league wOBA, PA/game,
  team medians) is computed fresh from real data every run, never hardcoded.

  Lineup wOBA depends on the posted lineup, which is usually not live until
  roughly 2 hours before first pitch. If a game's lineup isn't posted yet
  when this runs, that side's offense_adj is 0 (neutral) and lineup_available
  is false — it is NOT backfilled automatically; only a later re-capture of
  this same game will pick up a posted lineup.

  form15/form7/season_rpg fields are still computed and included for display
  context only — they no longer feed the projection.

  - Market line: The Odds API featured `totals` market (ONE bulk request for the
    whole slate). Consensus = most common posted line; best O/U prices at it.
  - Captured once at publish, kept all day; --if-changed re-captures only when a
    listed starter changes (same policy as K props), OR — 2026-08-08,
    ERR-20260808-02 — when a game's lineup has since posted. The lineup check
    piggybacks on the schedule call this script already makes every run
    (hydrate=probablePitcher,lineups), so it costs zero extra API calls even
    though this script's paid odds fetch is what --if-changed exists to avoid.
  - No key → projections still computed, lines null. Nothing blocks the run.

  official_totals_enabled is permanently OFF, per Lynold 2026-07-29: totals
  will not be published as official picks — research-lean totals only, full
  stop. This is a permanent product decision, not a rebuild-in-progress
  placeholder. See EXP-20260727-01 in the vault for the accuracy history
  that originally prompted it. Do not flip this to true without Lynold's
  explicit sign-off.
*/
const fs = require("fs");
const path = require("path");
const PitcherCore = require("../js/pitcher-matchup-core.js");
const PitchingPlan = require("./lib/pitching-plan-core.js");
const TotalsSetup = require("./lib/totals-setup-core.js");

const ROOT = path.join(__dirname, "..");
const KEY = (process.env.ODDS_API_KEY || "").trim();
const DATE = (process.argv[2] || "").match(/^\d{4}-\d{2}-\d{2}$/)
  ? process.argv[2]
  : new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const IF_CHANGED = process.argv.includes("--if-changed");

const LEAGUE_ERA = 4.20;

// 2026-08-05: bullpen era_7d shrinkage toward LEAGUE_ERA, n/(n+k), n = that
// pen's actual relief innings over the trailing 7 days. Was raw/unshrunk per
// Lynold 2026-07-29 — a thin sample (e.g. 0.00 ERA over 3 IP, or an equally
// unlucky 15.00 over 3 IP) swung a side's run projection outside
// generate-member-lab.js's RUN_PROJ_MIN/MAX plausibility band (2.0–8.5),
// which silently drops the run model for that game — no run projection, and
// blank offense fields wherever recap/component logic reads proj_away/
// proj_home. k=15 means a pen needs roughly 15 trailing-week innings before
// its own number carries half the weight; below that, LEAGUE_ERA dominates.
// This only changes the PROJECTION's input — era_7d itself is untouched
// everywhere it's a display number (opp_pen_era_7d, bullpen risk/efficiency
// reads), and the win-probability model's own bullpenAdj (generate-member-
// lab.js, bullpenProbAdjustment) is a separate calculation left alone.
const BULLPEN_SHRINK_K = 15;

// Same era->score curve PitcherCore.scorePitcher() applies internally (its
// ERA term, weighted 40% into that function's own score). Used to convert
// a side's innings-weighted effective_era into a score on the same 20-92
// scale a directly-scored individual pitcher uses, so a bullpen-game side's
// "pitcher_score" can be built from effective_era instead of only the named
// arm(s), matching the same fix applied in generate-pitcher-matchup-data.js.
function eraToScore(era) {
  if (!Number.isFinite(era)) return null;
  return Math.round(Math.max(20, Math.min(92, 100 - (era - 2.0) * 16)));
}
const WOBA_WEIGHTS = { bb: 0.69, hbp: 0.72, "1b": 0.89, "2b": 1.27, "3b": 1.62, hr: 2.10 };
const WOBA_SCALE = 1.24; // approximate — paired historical constant, not this season's exact published guts number
const TOTALS_MODEL_VERSION = "totals-runs-v4-additive-median-woba";
const TOTALS_POLICY = Object.freeze({
  version: "totals-policy-v4-setup-rebuild",
  research_min_edge: 0.7,
  research_min_setup: 70,
  strong_min_edge: 1.0,
  strong_min_setup: 90,
  // OFF 2026-07-29 pending the setup-rating rebuild (EXP-20260727-01).
  // Research-tier totals are unaffected. Re-enabling is Lynold's call.
  official_totals_enabled: false,
  team_totals_official_enabled: false
});
const PARKS = {"Colorado Rockies": 1.18, "Cincinnati Reds": 1.07, "Boston Red Sox": 1.06, "Philadelphia Phillies": 1.06, "Atlanta Braves": 1.05, "New York Yankees": 1.05, "Chicago White Sox": 1.04, "Toronto Blue Jays": 1.03, "Arizona Diamondbacks": 1.02, "Chicago Cubs": 1.02, "Texas Rangers": 1.0, "Baltimore Orioles": 1.0, "Milwaukee Brewers": 1.0, "Los Angeles Angels": 1.0, "Cleveland Guardians": 0.99, "Minnesota Twins": 0.99, "Houston Astros": 0.99, "Washington Nationals": 0.98, "Tampa Bay Rays": 0.98, "Pittsburgh Pirates": 0.97, "St. Louis Cardinals": 0.97, "Kansas City Royals": 0.96, "New York Mets": 0.96, "Detroit Tigers": 0.95, "Los Angeles Dodgers": 0.94, "Miami Marlins": 0.93, "San Diego Padres": 0.93, "Seattle Mariners": 0.92, "San Francisco Giants": 0.91};

async function j(u) { const r = await fetch(u); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }
const clampEra = e => Math.min(6, Math.max(2.75, e));
const fipLite = st => { if (!st || !st.ip || st.ip < 10) return LEAGUE_ERA; const fip = (13 * st.hr + 3 * st.bb - 2 * st.so) / st.ip + 3.15; const wt = Math.min(st.ip, 80) / 80; return clampEra(fip * wt + LEAGUE_ERA * (1 - wt)); };
const wobaFromCounting = c => {
  const singles = c.h - c.doubles - c.triples - c.hr;
  const ubb = c.bb - c.ibb;
  const num = WOBA_WEIGHTS.bb * ubb + WOBA_WEIGHTS.hbp * c.hbp + WOBA_WEIGHTS["1b"] * singles
    + WOBA_WEIGHTS["2b"] * c.doubles + WOBA_WEIGHTS["3b"] * c.triples + WOBA_WEIGHTS.hr * c.hr;
  const den = c.ab + c.bb - c.ibb + c.sf + c.hbp;
  return den > 0 ? num / den : null;
};
const medianOf = arr => {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
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

// 2026-08-08 (ERR-20260808-02): lineup-posted status per game, read straight
// off the `games` array the main schedule call already fetched with
// hydrate=lineups — no separate API call. away/home is "has 9+ hitters
// posted", same threshold generate-member-lab.js and update-k-props.js use.
function currentLineupsPosted(games) {
  const out = {};
  for (const g of games) {
    if (!g.status || g.status.abstractGameState !== "Preview") continue;
    const lu = g.lineups || {};
    out[g.gamePk] = {
      away: (lu.awayPlayers || []).length >= 9,
      home: (lu.homePlayers || []).length >= 9
    };
  }
  return out;
}

async function main() {
  const sched = await j(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}&hydrate=probablePitcher,lineups`);
  const games = (((sched.dates || [])[0]) || {}).games || [];
  const probables = await currentProbables(games);
  const lineupsPosted = currentLineupsPosted(games);
  const reportedPlans = PitchingPlan.load(ROOT, DATE);
  const pitchingPlanSignature = JSON.stringify(reportedPlans.games || {});

  // 2026-08-26, Lynold's explicit instruction: same fix as update-k-props.js
  // -- track WHICH game(s) actually changed, not just that something did, so
  // the team_totals fetch below (one paid call per event) can target only
  // those games instead of the whole slate. null keeps the original "fetch
  // everything" behavior, used when there's no prior capture or the plan
  // changed (untargetable -- could touch any pitcher's expected innings).
  // Note: unlike update-k-props.js, a lineup-only change here still triggers
  // a full paid re-capture (it always has -- that's a separate, pre-existing
  // question of whether the market line itself needs refreshing on a lineup
  // post, not the one this fix addresses); this only narrows WHICH games get
  // re-pulled once a re-capture is already happening.
  let changedTeamKeys = null;
  const pkToTeams = new Map(games.map(g => [String(g.gamePk), { away: g.teams.away.team.name, home: g.teams.home.team.name }]));
  if (IF_CHANGED) {
    // 2026-08-05: a missing/stale prior capture used to be treated the same
    // as "nothing changed" (return early, no fetch) -- correct once something
    // had already captured today, wrong on the day's FIRST run, where it
    // meant that run silently skipped the odds fetch entirely and nothing
    // downstream ever got real data. Now: no comparable capture -> fall
    // through and run the real (paid) capture. Only "compared, and nothing
    // moved" skips the API call.
    const tPath = path.join(ROOT, "data", "totals", "today.json");
    let prev = null;
    if (fs.existsSync(tPath)) { try { prev = JSON.parse(fs.readFileSync(tPath, "utf8")); } catch (e) { prev = null; } }
    if (!prev || prev.date !== DATE || !prev.probables) {
      console.log("Totals: no comparable capture for today yet — running a full capture.");
    } else {
      const changes = [];
      const changedPks = new Set();
      let planChanged = false;
      if (prev.pitching_plan_signature !== pitchingPlanSignature) { changes.push("reported pitching plan updated"); planChanged = true; }
      for (const [pk, cur] of Object.entries(probables)) {
        const was = prev.probables[pk];
        if (!was) continue;
        for (const side of ["away", "home"]) {
          if (was[side] !== "TBD" && cur[side] !== was[side]) { changes.push(`${was[side]} → ${cur[side]}`); changedPks.add(pk); }
          if (was[side] === "TBD" && cur[side] !== "TBD") { changes.push(`TBD → ${cur[side]}`); changedPks.add(pk); }
        }
      }
      // 2026-08-08 (ERR-20260808-02): a game whose pitcher was locked in
      // early otherwise never gets its lineup-wOBA offense_adj recomputed
      // for the rest of the day, no matter how many more times prepare-slate
      // runs -- lineup_available stays false and offense_adj stays 0 (the
      // exact bug reported for K props, same root cause, same fix pattern).
      // Compares against prev.lineups_posted (added below) using the
      // lineups already hydrated on the schedule call above -- zero extra
      // API calls either way.
      const prevLineups = prev.lineups_posted || {};
      for (const [pk, cur] of Object.entries(lineupsPosted)) {
        const was = prevLineups[pk];
        if (!was) continue;
        if (was.away === false && cur.away) { changes.push(`game ${pk}: away lineup now posted`); changedPks.add(pk); }
        if (was.home === false && cur.home) { changes.push(`game ${pk}: home lineup now posted`); changedPks.add(pk); }
      }
      if (!changes.length) { console.log("Totals: probables and lineups unchanged — keeping the morning capture, no API call."); return; }
      if (!planChanged && changedPks.size) {
        changedTeamKeys = new Set();
        for (const pk of changedPks) {
          const t = pkToTeams.get(pk);
          if (t) changedTeamKeys.add(`${t.away} @ ${t.home}`);
        }
      }
      console.log(`Totals: change (${changes.join("; ")}) — re-capturing${changedTeamKeys ? ` for ${changedTeamKeys.size} game(s), not the full slate` : ""}.`);
    }
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
  // Average team games played this season, at capture time. Used only by the
  // Totals Setup Rating (league-data completeness) to tell an early-season
  // guess from a deep, trustworthy standings sample. Not part of the run
  // projection itself.
  const teamCount = Object.keys(off).length;
  const avgGamesPlayed = teamCount ? gT / teamCount : 0;
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

  // --- 2026-07-29: additive formula inputs (median RPG + lineup wOBA) ---
  // Trailing 30-day league wOBA and PA/team-game — self-computed from real
  // counting stats every run, never hardcoded.
  const start30 = f(new Date(end.getTime() - 30 * 864e5));
  const end30 = f(end);
  let lgWoba30 = null, paPerGame30 = null;
  try {
    const lg = await j(`https://statsapi.mlb.com/api/v1/teams/stats?stats=byDateRange&group=hitting&startDate=${start30}&endDate=${end30}&season=${yr}&sportId=1`);
    const c = { ab: 0, bb: 0, ibb: 0, hbp: 0, sf: 0, h: 0, doubles: 0, triples: 0, hr: 0, pa: 0, g: 0 };
    for (const t of (lg.stats[0] || {}).splits || []) {
      const s = t.stat;
      c.ab += Number(s.atBats) || 0; c.bb += Number(s.baseOnBalls) || 0; c.ibb += Number(s.intentionalWalks) || 0;
      c.hbp += Number(s.hitByPitch) || 0; c.sf += Number(s.sacFlies) || 0; c.h += Number(s.hits) || 0;
      c.doubles += Number(s.doubles) || 0; c.triples += Number(s.triples) || 0; c.hr += Number(s.homeRuns) || 0;
      c.pa += Number(s.plateAppearances) || 0; c.g += Number(s.gamesPlayed) || 0;
    }
    lgWoba30 = wobaFromCounting(c);
    paPerGame30 = c.g ? c.pa / c.g : null;
  } catch (e) { console.warn("league 30d wOBA unavailable:", e.message); }

  // Trailing 30-day median runs scored per team. One bulk league-wide
  // schedule call, bucketed by team, instead of 30 separate per-team calls.
  const medianRuns30 = {};
  try {
    const rangeSched = await j(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${start30}&endDate=${end30}&hydrate=linescore`);
    const runsByTeam = {};
    for (const dt of rangeSched.dates || []) {
      for (const gm of dt.games || []) {
        if (!gm.status || gm.status.abstractGameState !== "Final") continue;
        const a = gm.teams.away, h = gm.teams.home;
        if (!Number.isFinite(a.score) || !Number.isFinite(h.score)) continue;
        (runsByTeam[a.team.id] = runsByTeam[a.team.id] || []).push(a.score);
        (runsByTeam[h.team.id] = runsByTeam[h.team.id] || []).push(h.score);
      }
    }
    for (const [tid, arr] of Object.entries(runsByTeam)) medianRuns30[tid] = medianOf(arr);
  } catch (e) { console.warn("30d median runs unavailable:", e.message); }

  // Tonight's posted-lineup wOBA (last 30 days per batter, PA-weighted).
  // Lineups usually post ~2 hours before first pitch — if a game's lineup
  // isn't posted yet when this runs, offense_adj for that side is 0 and
  // lineup_available is false; it is not backfilled automatically.
  const lineupPlayerIds = new Set();
  for (const g of games) {
    const lu = g.lineups || {};
    for (const p of [...(lu.awayPlayers || []), ...(lu.homePlayers || [])]) if (p && p.id) lineupPlayerIds.add(p.id);
  }
  const batterWoba = {};
  if (lineupPlayerIds.size) {
    const ids = [...lineupPlayerIds];
    const chunkSize = 30;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      try {
        const resp = await j(`https://statsapi.mlb.com/api/v1/people?personIds=${chunk.join(",")}&hydrate=stats(group=hitting,type=byDateRange,startDate=${start30},endDate=${end30})`);
        for (const p of resp.people || []) {
          const splits = ((p.stats || [])[0] || {}).splits || [];
          const s = splits[0] && splits[0].stat;
          if (!s) continue;
          const c = {
            ab: Number(s.atBats) || 0, bb: Number(s.baseOnBalls) || 0, ibb: Number(s.intentionalWalks) || 0,
            hbp: Number(s.hitByPitch) || 0, sf: Number(s.sacFlies) || 0, h: Number(s.hits) || 0,
            doubles: Number(s.doubles) || 0, triples: Number(s.triples) || 0, hr: Number(s.homeRuns) || 0
          };
          const pa = Number(s.plateAppearances) || 0;
          const woba = wobaFromCounting(c);
          if (woba !== null && pa > 0) batterWoba[p.id] = { woba, pa };
        }
      } catch (e) { console.warn(`lineup batter stats chunk failed: ${e.message}`); }
    }
  }
  const lineupWobaFor = (scheduleGame, teamId) => {
    const lu = scheduleGame.lineups || {};
    const isAway = scheduleGame.teams.away.team.id === teamId;
    const isHome = scheduleGame.teams.home.team.id === teamId;
    const players = isAway ? lu.awayPlayers : (isHome ? lu.homePlayers : null);
    if (!players || !players.length) return { woba: null, pa: 0, resolved: 0, total: 0 };
    let totalPa = 0, sum = 0, resolved = 0;
    for (const p of players) {
      const info = p && p.id ? batterWoba[p.id] : null;
      if (info) { totalPa += info.pa; sum += info.woba * info.pa; resolved++; }
    }
    return { woba: totalPa > 0 ? sum / totalPa : null, pa: totalPa, resolved, total: players.length };
  };

  const pids = [...new Set([
    ...games.flatMap(g => ["away", "home"].map(sd => g.teams[sd].probablePitcher && g.teams[sd].probablePitcher.id).filter(Boolean)),
    ...PitchingPlan.participantIds(reportedPlans)
  ])];
  // Use the same starter-only usage and role classifier as the Pitcher Matchup
  // Tool. Total season innings divided by starts is invalid for mixed-role
  // pitchers because it incorrectly assigns their relief innings to starts.
  const ps = await PitcherCore.fetchPitchers(pids, DATE, j);
  const bulkRoleStats = await PitchingPlan.fetchBulkRoleStats(reportedPlans, DATE, j, LEAGUE_ERA);
  let bullpen = {};
  try { const bp = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "bullpen", `${DATE}.json`), "utf8")); if (bp.date === DATE) bullpen = bp.teams_by_name || {}; } catch (e) {}

  // --- market total lines: one bulk request, retried ---
  let lines = {};
  const eventIds = {};
  if (KEY) {
    const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds?apiKey=${KEY}&regions=us&markets=totals&oddsFormat=american`;
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
    // 2026-08-26: only the game(s) that actually changed, when known -- see
    // changedTeamKeys above. Games skipped here are restored from the prior
    // capture by the "temporary Odds API failure must not erase a market"
    // block further down, same mechanism that already covers a real fetch
    // failure, so no separate carry-forward logic is needed for this.
    const eventEntries = changedTeamKeys
      ? Object.entries(eventIds).filter(([gameName]) => changedTeamKeys.has(gameName))
      : Object.entries(eventIds);
    if (changedTeamKeys) console.log(`Totals: targeting team-totals for ${eventEntries.length}/${Object.keys(eventIds).length} game(s).`);
    for (const [gameName, eventId] of eventEntries) {
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

  // A temporary Odds API failure must not erase a market captured earlier in
  // the day. Restore the prior prices before calculating edges, classifications,
  // and Lab Rating so every downstream field is recomputed consistently.
  try {
    const priorPath = path.join(ROOT, "data", "totals", `${DATE}.json`);
    const prior = fs.existsSync(priorPath) ? JSON.parse(fs.readFileSync(priorPath, "utf8")) : null;
    for (const game of Object.values((prior && prior.games) || {})) {
      if (!lines[game.game] && Number.isFinite(game.line)) {
        lines[game.game] = {
          line: game.line,
          over: game.over ?? null,
          under: game.under ?? null,
          books: game.books || 0
        };
      }
      const restored = (teamTotalLines[game.game] = teamTotalLines[game.game] || {});
      for (const side of ["away", "home"]) {
        const priorTeam = game.team_totals && game.team_totals[side];
        if (priorTeam && priorTeam.team && Number.isFinite(priorTeam.line) && !restored[priorTeam.team]) {
          restored[priorTeam.team] = {
            line: priorTeam.line,
            over: priorTeam.over ?? null,
            under: priorTeam.under ?? null,
            books: priorTeam.books || 0
          };
        }
      }
    }
  } catch (error) {
    console.warn(`prior totals market restore skipped: ${error.message}`);
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
    const parkKnown = Object.prototype.hasOwnProperty.call(PARKS, hT.name);
    const side = (batTeamId, oppStarter, oppPenName, pitchingSide) => {
      const seasonRpg = off[batTeamId] || lgRPG;
      // form15/form7/season blend kept for display context only — no longer
      // feeds the projection. medianRpg30 (below) is the real offense baseline.
      let w15 = Number.isFinite(off15[batTeamId]) ? 0.25 * Math.min(1, (g15[batTeamId] || 0) / 12) : 0;
      let w7 = Number.isFinite(off7[batTeamId]) ? 0.15 * Math.min(1, (g7[batTeamId] || 0) / 6) : 0;
      const rpg = (1 - w15 - w7) * seasonRpg + w15 * (off15[batTeamId] || 0) + w7 * (off7[batTeamId] || 0);

      // Offense baseline: this team's own median runs scored, trailing 30
      // days. Falls back to season RPG only if the team has no games in
      // that window (shouldn't happen mid-season).
      const medianRpg30 = Number.isFinite(medianRuns30[batTeamId]) ? medianRuns30[batTeamId] : seasonRpg;

      // Offense adjustment: tonight's actual posted lineup vs. the real
      // trailing-30-day league wOBA, converted to runs via the standard wRAA
      // shape. 0 (neutral) if the lineup isn't posted yet at capture time.
      const lu = lineupWobaFor(g, batTeamId);
      const offenseAdj = (lu.woba !== null && lgWoba30 !== null && paPerGame30 !== null)
        ? ((lu.woba - lgWoba30) / WOBA_SCALE) * paPerGame30
        : 0;

      const st = oppStarter ? ps[oppStarter.id] : null;
      const role = PitcherCore.classifyPitcherRole(st);
      const plan = PitchingPlan.resolveSidePlan(reportedPlans, g.gamePk, pitchingSide, oppStarter, role);
      const pen = bullpen[oppPenName];
      const penRisk = pen && Number.isFinite(pen.risk_index ?? pen.score) ? (pen.risk_index ?? pen.score) : null;
      const penFatigue = pen && Number.isFinite(pen.score) ? pen.score : null;
      const penEfficiency = pen && Number.isFinite(pen.efficiency_score) ? pen.efficiency_score : null;
      const penEfficiencyLabel = pen && pen.efficiency_label ? pen.efficiency_label : null;
      // Bullpen adjustment driver: actual earned runs allowed per 9 over the
      // last 7 days. This is the DISPLAY number (opp_pen_era_7d, bullpen
      // risk/efficiency reads) and stays raw/unshrunk.
      const penEra7d = pen && Number.isFinite(pen.era_7d) ? pen.era_7d : null;
      // Trailing-7-day relief innings for that same pen — the sample size
      // behind penEra7d, used only to decide how much to trust it below.
      const penIp7d = pen && Number.isFinite(pen.last7_bp_ip) ? pen.last7_bp_ip : 0;
      // PROJECTION-ONLY input: era_7d shrunk toward LEAGUE_ERA, n/(n+k) with
      // n = penIp7d, k = BULLPEN_SHRINK_K. Fixes ERR-class bug where a thin
      // recent-week sample (e.g. 0.00 ERA over 3 IP) pushed a side's run
      // projection outside generate-member-lab.js's plausibility band,
      // silently dropping the run model for that game (Lynold 2026-08-05).
      // Only this formula input changes; penEra7d above is untouched.
      const penEra7dShrunk = penEra7d !== null
        ? LEAGUE_ERA + (penIp7d / (penIp7d + BULLPEN_SHRINK_K)) * (penEra7d - LEAGUE_ERA)
        : null;
      // Blended pitching-plan-edge reads use a steadier 15-day bullpen ERA
      // instead -- the win-probability model's own bullpenAdj term (in
      // generate-member-lab.js) deliberately stays on the 7-day number per
      // Lynold 2026-07-29 (it is meant to react fast), but a 7-day sample was
      // too volatile for what is displayed to users as a plan-quality
      // comparison: a single bad or dominant outing can push era_7d past
      // 15.00 or to 0.00, which flipped which pitcher an ordinary
      // pitching-plan edge credited (confirmed live 2026-07-31, Brewers @
      // Angels and Marlins @ Mets). Falls back to era_7d, then league
      // average, if the 15-day figure isn't available (e.g. early season).
      const penEra15d = pen && Number.isFinite(pen.era_15d) ? pen.era_15d
        : (penEra7d !== null ? penEra7d : null);

      // Allocate every known pitcher only to his assigned innings. The generic
      // bullpen owns only the innings left after the opener and bulk pitcher.
      let starterAdj = 0;
      let effectiveEra = 0;
      let plannedPitcherInnings = 0;
      let weightedPitcherScore = 0;
      const segments = plan.segments.map(segment => {
        const innings = Number(segment.expected_innings);
        if (segment.role === "bullpen") {
          return { ...segment };
        }
        const segmentStats = ps[Number(segment.pitcher_id)] || null;
        const roleStats = segment.role === "bulk" ? bulkRoleStats[Number(segment.pitcher_id)] || null : null;
        const segmentFip = roleStats ? roleStats.fip_lite : fipLite(segmentStats);
        const segmentScore = PitcherCore.scorePitcher(segmentStats || { name: segment.pitcher, missing: true }).score;
        starterAdj += (segmentFip - LEAGUE_ERA) * (innings / 9);
        effectiveEra += segmentFip * innings;
        plannedPitcherInnings += innings;
        weightedPitcherScore += segmentScore * innings;
        return {
          ...segment,
          fip_lite: Number(segmentFip.toFixed(2)),
          pitcher_score: segmentScore,
          role_stats: roleStats
        };
      });
      const bullpenInnings = segments.filter(segment => segment.role === "bullpen")
        .reduce((sum, segment) => sum + Number(segment.expected_innings), 0);
      const expIP = segments.filter(segment => segment.role !== "bullpen")
        .reduce((sum, segment) => sum + Number(segment.expected_innings), 0);

      const bullpenAdj = penEra7dShrunk !== null ? (penEra7dShrunk - LEAGUE_ERA) * (bullpenInnings / 9) : 0;
      effectiveEra += (penEra15d !== null ? penEra15d : LEAGUE_ERA) * bullpenInnings;
      const effectiveEraFinal = Number((effectiveEra / 9).toFixed(2));

      // A reported opener/bulk plan hands most of the innings to an
      // anonymous bullpen with no named pitcher, so it can never earn a
      // score in the weightedPitcherScore accumulator above -- that average
      // is silently taken over the opener's own 2-ish innings only, crediting
      // him with the "pitching plan score" for a game where the bullpen
      // throws most of it. Score those plans off effective_era instead,
      // which already correctly folds the bullpen's actual recent ERA in by
      // its share of the innings. Traditional starter plans, where the named
      // arm covers most of the game, keep the direct named-arm average.
      const namedArmScore = plannedPitcherInnings > 0 ? Math.round(weightedPitcherScore / plannedPitcherInnings) : null;
      // The dividing line is whether the named arm covers the bulk of the
      // game for that side: if his own bullpen is projected to throw MORE
      // innings than he is, his own line does not represent "the pitching"
      // for that side, and the blended (bullpen-inclusive) effective-era
      // score is the honest one to use. If he covers the majority of the
      // game himself, his own line already is the representative one, and
      // blending in a bullpen number there only adds noise without adding
      // truth (confirmed live 2026-07-31: doing this for every plan flipped
      // the credited pitcher in both Brewers @ Angels and Marlins @ Mets;
      // never doing it re-broke the original Pirates-opener case). The
      // blended score itself now runs on a 15-day bullpen ERA rather than
      // 7-day (see penEra15d above) specifically because the 7-day number
      // was volatile enough on its own to cause that flip.
      const effectiveEraScore = eraToScore(effectiveEraFinal);
      const bullpenCarriesGame = expIP < 4; // starter under 4 IP is bullpen-carried; a 4-5 IP start is scored on its own line, so 4.4 and 4.6 outings are treated the same (Lynold 2026-08-04)
      const planPitcherScore = bullpenCarriesGame && effectiveEraScore !== null ? effectiveEraScore : namedArmScore;

      const planOutput = {
        ...plan,
        segments,
        expected_innings: Number(expIP.toFixed(1)),
        bullpen_innings: Number(bullpenInnings.toFixed(1)),
        effective_era: effectiveEraFinal,
        pitcher_score: planPitcherScore,
        // True when this side's own bullpen is projected to throw more of
        // the game than its named starter -- the trigger for scoring this
        // side on its blended effective_era instead of the starter's own
        // line, and for the page to label the comparison as a blended
        // pitching-plan edge rather than a pure pitcher-vs-pitcher one.
        bullpen_carries_game: bullpenCarriesGame,
        description: PitchingPlan.describe(plan)
      };
      const primaryFip = segments.find(segment => segment.role !== "bullpen");

      const runs = medianRpg30 + offenseAdj + starterAdj + bullpenAdj;

      return {
        runs,
        rpg: Number(rpg.toFixed(2)), season_rpg: Number(seasonRpg.toFixed(2)),
        form15_rpg: Number.isFinite(off15[batTeamId]) ? Number(off15[batTeamId].toFixed(2)) : null, form15_g: g15[batTeamId] || 0,
        form7_rpg: Number.isFinite(off7[batTeamId]) ? Number(off7[batTeamId].toFixed(2)) : null, form7_g: g7[batTeamId] || 0,
        median_rpg_30d: Number.isFinite(medianRuns30[batTeamId]) ? Number(medianRuns30[batTeamId].toFixed(1)) : null,
        median_rpg_used: Number(medianRpg30.toFixed(2)),
        lineup_woba: lu.woba !== null ? Number(lu.woba.toFixed(3)) : null,
        lineup_pa: lu.pa, lineup_resolved: lu.resolved, lineup_total: lu.total,
        lineup_available: lu.woba !== null,
        league_woba_30d: lgWoba30 !== null ? Number(lgWoba30.toFixed(3)) : null,
        pa_per_game_30d: paPerGame30 !== null ? Number(paPerGame30.toFixed(2)) : null,
        offense_adj: Number(offenseAdj.toFixed(2)),
        opp_sp: st ? st.name : "TBD", opp_sp_fip: primaryFip ? primaryFip.fip_lite : LEAGUE_ERA, opp_sp_ip: Number(expIP.toFixed(1)),
        opp_pitcher_role: plan.type === "opener_bulk" ? "opener_bulk" : role.key,
        opp_pitcher_role_label: plan.type === "opener_bulk" ? "Opener + bulk pitcher" : role.label,
        opp_pitcher_role_confidence: plan.confidence || role.confidence,
        opp_bullpen_game: Boolean(plan.type && plan.type.startsWith("opener")),
        opp_bullpen_ip: Number(bullpenInnings.toFixed(1)),
        opp_pitcher_role_reason: role.reason,
        pitching_plan: planOutput,
        starter_adj: Number(starterAdj.toFixed(2)),
        opp_pen_risk: penRisk, opp_pen_fatigue: penFatigue, opp_pen_efficiency: penEfficiency, opp_pen_efficiency_label: penEfficiencyLabel,
        opp_pen_era_7d: penEra7d,
        opp_pen_era_7d_shrunk: penEra7dShrunk !== null ? Number(penEra7dShrunk.toFixed(2)) : null,
        opp_pen_ip_7d: penIp7d,
        bullpen_adj: Number(bullpenAdj.toFixed(2)),
        sp_sample_ok: !!(st && st.ip >= 40 && role.confidence !== "low"),
        pitching_plan_confident: plan.reported || (role.confidence === "high" && !role.bullpenGame)
      };
    };
    const A = side(aT.id, g.teams.home.probablePitcher, hT.name, "home");
    const H = side(hT.id, g.teams.away.probablePitcher, aT.name, "away");
    const pitchingPlan = {
      away: {
        ...H.pitching_plan,
        pitcher: g.teams.away.probablePitcher ? g.teams.away.probablePitcher.fullName : "TBD",
        role: H.opp_pitcher_role,
        label: H.opp_pitcher_role_label,
        expected_innings: H.opp_sp_ip,
        bullpen_innings: H.opp_bullpen_ip,
        confidence: H.opp_pitcher_role_confidence,
        bullpen_game: H.opp_bullpen_game
      },
      home: {
        ...A.pitching_plan,
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

    // Totals Setup Rating v2 (0–100 internal, shown /10): how much real data
    // backs this projection. No market/edge input — see lib/totals-setup-core.js.
    const setup = TotalsSetup.calcTotalsSetup({ away: A, home: H, lgRPG, parkKnown, avgGamesPlayed });
    const totalsLab = setup.score;

    const lean = line !== null ? proj - line : null;
    const absLean = lean === null ? null : Math.abs(lean);
    const officialEligible = TOTALS_POLICY.official_totals_enabled
      && lean !== null
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
      pitching_plan: pitchingPlan,
      bullpen_game: Boolean(pitchingPlan.away.bullpen_game || pitchingPlan.home.bullpen_game),
      line, over: mkt.over ?? null, under: mkt.under ?? null, books: mkt.books || 0,
      team_totals: {
        away: teamTotal(aT.name, Number(A.runs.toFixed(1))),
        home: teamTotal(hT.name, Number(H.runs.toFixed(1)))
      },
      lab: totalsLab,
      setup_version: TotalsSetup.TOTALS_SETUP_VERSION,
      official_eligible: officialEligible,
      setup_components: {
        form_points: setup.form_points,
        pitching_points: setup.pitching_points,
        bullpen_points: setup.bullpen_points,
        completeness_points: setup.completeness_points
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

  const payload = { date: DATE, generated_at: new Date().toISOString(), model_version: TOTALS_MODEL_VERSION, policy: TOTALS_POLICY, source: "LyDia totals projection (median RPG + lineup wOBA offense adjustment + FIP-lite starter adjustment + shrunk bullpen era_7d adjustment) + the-odds-api totals consensus", league_rpg: Number(lgRPG.toFixed(2)), probables, lineups_posted: lineupsPosted, pitching_plan_signature: pitchingPlanSignature, games: out, learned_bias: learnedBias, learned_n: learnedN };
  fs.mkdirSync(path.join(ROOT, "data", "totals"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "totals", `${DATE}.json`), JSON.stringify(payload, null, 1));
  fs.writeFileSync(path.join(ROOT, "data", "totals", "today.json"), JSON.stringify(payload, null, 1));
  console.log(`Totals: ${Object.keys(out).length} games projected, ${Object.values(out).filter(x => x.line !== null).length} with market lines.`);
}
main().catch(e => { console.error("totals error:", e.message); process.exit(0); });
