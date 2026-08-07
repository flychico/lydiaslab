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
const Arsenal = require("./lib/arsenal-leverage.js");

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
    // Lines are captured once at publish and kept all day — only a pitcher
    // change re-captures.
    //
    // 2026-08-05: a missing/stale prior capture used to be treated the same
    // as "nothing changed" (return early, no fetch) -- correct once something
    // had already captured today, wrong on the day's FIRST run, where it
    // meant that run silently skipped the odds fetch entirely and nothing
    // downstream ever got real data. Now: no comparable capture -> fall
    // through and run the real (paid) capture. Only "compared, and nothing
    // moved" skips the API call.
    const todayPath = path.join(ROOT, "data", "k-props", "today.json");
    let prev = null;
    if (fs.existsSync(todayPath)) { try { prev = JSON.parse(fs.readFileSync(todayPath, "utf8")); } catch (e) { prev = null; } }
    if (!prev || prev.date !== DATE || !prev.probables) {
      console.log("No comparable capture for today yet — running a full capture.");
    } else {
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
      if (!changes.length) { console.log("Probables unchanged — keeping the morning capture, no API call."); return; }
      console.log(`Pitcher change detected (${changes.join("; ")}) — re-capturing prop lines.`);
    }
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

  /*
    SELF-CALIBRATION — banded, not global.

    This previously computed ONE rolling bias over the last 100 graded pitchers
    and added it to every projection. That is only correct if the error is the
    same everywhere, and it is not. Measured over 142 graded starts joined back
    to their true PRE-correction projection:

        raw projection <6.0   n=109   bias -0.48
        raw projection 6.0-7  n= 16   bias -0.73
        raw projection >=7.0  n= 17   bias -3.27

    The error is a gradient, not an offset. No single number fits a -0.48 to
    -3.27 spread: centring the low band leaves the high band nearly 3 strikeouts
    long, and centring the high band would wreck everything below it.

    A replay over those 142 starts:

        no correction          MAE 2.158   RMSE 2.788
        global -0.54 (live)    MAE 2.111   RMSE 2.675
        banded                 MAE 2.046   RMSE 2.596

    The live global correction was also thrashing. Because it is a hard
    threshold (|bias| >= 0.15) over a rolling window with a hard cap, small
    changes flipped it between no correction and the cap: across 07-20..08-02 it
    read 0, -0.6, -0.42, -0.44, 0, 0, -0.21, -0.21, 0, -0.6, -0.6, -0.54. Which
    correction a pitcher received depended on which day he happened to start.
    Banding plus sample-size shrinkage removes most of that: a band only moves
    in proportion to n/(n+SHRINK_K), so it drifts rather than snapping.

    Bias is measured on projection_raw where the ledger has it (column 11,
    written from this version forward and backfilled from data/k-props/*.json).
    Older rows fall back to the corrected projection, which biases their band
    assignment slightly; that self-heals as the window rolls over.

    The >=7 band is where the real problem lives and a bias correction is a
    patch on it, not a diagnosis. The leading hypothesis is short outings
    (expected innings not being realised), which is a modelling question, not a
    calibration one. This keeps the number honest until that is answered.
  */
  const K_BANDS = [
    { key: "<6",   min: -Infinity, max: 6.0 },
    { key: "6-7",  min: 6.0,       max: 7.0 },
    { key: ">=7",  min: 7.0,       max: Infinity }
  ];
  const K_MIN_N = 15;        // below this a band has nothing trustworthy to say
  const K_MIN_BIAS = 0.15;   // ignore noise-level corrections
  const K_SHRINK = 25;       // pulls thin bands toward no correction
  const K_CAP = 1.5;         // a single band may not move a projection more than this
  const K_WINDOW = 150;      // graded starts considered

  const bandFor = proj => (K_BANDS.find(b => proj >= b.min && proj < b.max) || K_BANDS[0]).key;
  const learnedByBand = {};
  let learnedN = 0;
  try {
    const klog = path.join(ROOT, "data", "calibration", "kprops_log.csv");
    if (fs.existsSync(klog)) {
      const rows = fs.readFileSync(klog, "utf8").trim().split("\n").slice(1).map(l => l.split(","))
        .filter(r => r.length >= 7 && r[5] !== "" && r[6] !== "" && isFinite(Number(r[5])) && isFinite(Number(r[6])))
        .slice(-K_WINDOW);
      learnedN = rows.length;
      const byBand = {};
      for (const r of rows) {
        const proj = Number(r[5]), actual = Number(r[6]);
        // Band on the pre-correction projection when the row carries it
        // (column 10). Banding on the corrected number measures the residual
        // after last week's correction rather than the model's own error, which
        // is how the <6 band looked unbiased at -0.09 when its true error was
        // -0.48. Fall back to the corrected value for legacy rows.
        const rawLogged = r.length > 10 && r[10] !== "" && isFinite(Number(r[10])) ? Number(r[10]) : null;
        const bandOn = rawLogged !== null ? rawLogged : proj;
        const b = bandFor(bandOn);
        // The error is always actual minus what was actually projected and
        // graded, regardless of which value chose the band.
        (byBand[b] = byBand[b] || []).push(actual - (rawLogged !== null ? rawLogged : proj));
      }
      for (const band of K_BANDS) {
        const errs = byBand[band.key] || [];
        if (errs.length < K_MIN_N) continue;
        const raw = errs.reduce((a, e) => a + e, 0) / errs.length;
        const shrunk = raw * (errs.length / (errs.length + K_SHRINK));
        if (Math.abs(shrunk) < K_MIN_BIAS) continue;
        learnedByBand[band.key] = {
          bias: Number(Math.max(-K_CAP, Math.min(K_CAP, shrunk)).toFixed(2)),
          n: errs.length,
          raw: Number(raw.toFixed(2))
        };
      }
    }
  } catch (e) { console.warn("K self-calibration skipped:", e.message); }

  const biasFor = projRaw => (learnedByBand[bandFor(projRaw)] || {}).bias || 0;

  if (Object.keys(learnedByBand).length) {
    const parts = K_BANDS.filter(b => learnedByBand[b.key]).map(b => {
      const v = learnedByBand[b.key];
      return `${b.key}: ${v.bias > 0 ? "+" : ""}${v.bias} (raw ${v.raw > 0 ? "+" : ""}${v.raw}, n=${v.n})`;
    });
    console.log(`K self-calibration by band — ${parts.join("; ")}. Window ${learnedN} graded starts.`);
  } else {
    console.log(`K self-calibration: no band met the n>=${K_MIN_N} / |bias|>=${K_MIN_BIAS} threshold (window ${learnedN}).`);
  }

  // Our projection per pitcher, captured alongside the market line so the
  // nightly grader can score projection vs line vs actual. Mirrors the tool math.
  try {
    const yr = Number(DATE.slice(0, 4));
    const sched = await j(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}&hydrate=probablePitcher,lineups`);
    const games = (((sched.dates || [])[0]) || {}).games || [];
    const base = `https://statsapi.mlb.com/api/v1/teams/stats?sportId=1&group=hitting&season=${yr}&stats=statSplits&sitCodes=`;
    const [vl, vr] = await Promise.all([j(base + "vl"), j(base + "vr")]);
    // League K% is not one number: hitters strike out at different rates against
    // lefties and righties. A single baseline (previously the vs-RHP figure only)
    // was applied to every pitcher, overstating left-handers' lineup adjustment
    // by roughly 2.5% — about 0.15K on a 6K projection, always toward the over.
    const kv = { L: {}, R: {} }; let soL = 0, paL = 0, soR = 0, paR = 0;
    for (const t of (vl.stats[0] || {}).splits || []) { const so = +t.stat.strikeOuts || 0, pa = +t.stat.plateAppearances || 0; if (pa) { kv.L[t.team.id] = so / pa; soL += so; paL += pa; } }
    for (const t of (vr.stats[0] || {}).splits || []) { const so = +t.stat.strikeOuts || 0, pa = +t.stat.plateAppearances || 0; if (pa) { kv.R[t.team.id] = so / pa; soR += so; paR += pa; } }
    const leagueKByHand = { L: paL ? soL / paL : 0.223, R: paR ? soR / paR : 0.223 };

    /*
      LINEUP K% — the opponent adjustment now reads the actual nine hitters.

      Previously oppK was the opposing TEAM's season K% against the pitcher's
      hand. That is a whole-roster figure and it barely moves: the posted
      lineup and the team season rate agreed to within 0.001 on a same-day
      check. It could not tell a whiff-heavy nine from a contact nine.

      This uses the mean of the nine posted hitters' individual 30-day K rates,
      UNWEIGHTED — Lynold's call, and it is the same construction the strikeout
      tool displays as "Lineup avg K%", so the page and the graded model now
      agree instead of showing two different numbers for the same idea.

      THE BASELINE MUST MATCH THE NUMERATOR. adj is a ratio, so if the top is a
      mean-of-nine-rates the bottom has to be a mean-of-nine-rates too. It is
      computed fresh each run as the average lineup mean across the whole slate
      (0.2164 on 2026-08-02), NOT the league PA-weighted rate (0.2224). Reusing
      the PA-weighted figure would have silently rescaled every projection,
      because an unweighted mean of nine rates and a PA-weighted population rate
      are different statistics that happen to look alike.

      KNOWN PROPERTY, STATED PLAINLY: an unweighted mean lets a low-PA hitter
      count as much as a 400-PA regular, so it spreads teams much further than a
      PA-weighted rate does — 0.142 to 0.302 across the 2026-08-02 slate, a 2.1x
      range feeding an adjustment that no longer has a clamp. That is the
      intended behaviour here, but it means a thin-sample bench bat can move a
      projection, and the >=7K band is already the band that over-projects
      (-3.27). Both numbers are stored per pitcher (opp_lineup_k and
      opp_lineup_k_weighted) so grade-confidence.js can settle which one
      actually predicts rather than either of us arguing it.
    */
    /*
      PITCHER RECENT FORM — last 5 starts, blended not substituted.

      The K rate driving every projection was season-long K/BF. A pitcher who
      has lost a tick of velocity, changed a grip, or is pitching hurt looks
      identical to his April self until the season number slowly catches up.

      Five starts is roughly 110 batters faced. That is a real signal and a
      thin one at the same time, so it is BLENDED toward the season rate by its
      own sample size rather than replacing it:

          weight = recentBf / (recentBf + FORM_SHRINK)
          rate   = seasonRate + weight * (recentRate - seasonRate)

      At FORM_SHRINK = 200 a full five starts earns about 35% weight, and a
      pitcher with two starts back from the IL earns about 18%. The resulting
      rate is also capped to +/-15% of the season rate, because the failure
      mode this session kept finding is a short window given enough authority
      to run away with a projection — the totals model's last-7 weighting, the
      thrashing global K bias, the unweighted lineup mean. This one is
      deliberately built so it cannot do that.

      Uses the season game log and counts only games the pitcher STARTED, so a
      long relief outing does not masquerade as recent starting form. Any
      failure falls back to the season rate and the run continues.
    */
    const FORM_STARTS = 5;
    const FORM_SHRINK = 200;
    const FORM_CAP = 0.15;
    const recentForm = {};
    async function loadRecentForm(pitcherIds) {
      await Promise.all(pitcherIds.map(async id => {
        try {
          const d = await j(`https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=gameLog&group=pitching&season=${yr}`);
          const splits = (((d.stats || [])[0] || {}).splits || [])
            .filter(s => s && s.stat && Number(s.stat.gamesStarted) > 0 && s.date)
            .sort((a, b) => String(b.date).localeCompare(String(a.date)))
            .slice(0, FORM_STARTS);
          let so = 0, bf = 0, ip = 0;
          for (const s of splits) {
            so += Number(s.stat.strikeOuts) || 0;
            bf += Number(s.stat.battersFaced) || 0;
            ip += (() => { const v = String(s.stat.inningsPitched || "0"); const [w, o] = v.split("."); return (Number(w) || 0) + (Number(o) || 0) / 3; })();
          }
          if (bf > 0) recentForm[Number(id)] = { so, bf, ip: Number(ip.toFixed(1)), starts: splits.length, rate: so / bf };
        } catch (e) { /* season rate is the fallback */ }
      }));
    }

    // Season rate adjusted toward recent form, sample-weighted and capped.
    function formAdjustedRate(pitcherId, seasonSo, seasonBf) {
      const season = seasonBf > 0 ? seasonSo / seasonBf : null;
      const rf = recentForm[Number(pitcherId)];
      if (season === null || !rf || !rf.bf) return { rate: season, applied: false, weight: 0, recent: null };
      const w = rf.bf / (rf.bf + FORM_SHRINK);
      let rate = season + w * (rf.rate - season);
      const lo = season * (1 - FORM_CAP), hi = season * (1 + FORM_CAP);
      const capped = rate < lo || rate > hi;
      rate = Math.max(lo, Math.min(hi, rate));
      return { rate, applied: true, weight: Number(w.toFixed(3)), recent: rf.rate, capped, starts: rf.starts, recent_bf: rf.bf };
    }

    const LINEUP_WINDOW_DAYS = 30;
    const winEnd = new Date(DATE + "T00:00:00Z");
    winEnd.setUTCDate(winEnd.getUTCDate() - 1);
    const winStart = new Date(winEnd);
    winStart.setUTCDate(winStart.getUTCDate() - LINEUP_WINDOW_DAYS);
    const iso = d => d.toISOString().slice(0, 10);
    const batterK = {};
    try {
      const bd = await j(`https://statsapi.mlb.com/api/v1/stats?stats=byDateRange&group=hitting`
        + `&startDate=${iso(winStart)}&endDate=${iso(winEnd)}&sportId=1&limit=2000&sortStat=plateAppearances`);
      for (const s of ((bd.stats || [])[0] || {}).splits || []) {
        const pa = Number((s.stat || {}).plateAppearances) || 0;
        if (!pa) continue;
        batterK[s.player.id] = { k: (Number(s.stat.strikeOuts) || 0) / pa, pa };
      }
    } catch (e) { console.warn("lineup K% window fetch skipped:", e.message); }

    // Unweighted mean of a lineup's individual K rates. Needs most of the nine
    // resolved or it is not a lineup rate, it is a rumour.
    const MIN_RESOLVED = 7;
    const lineupMean = ids => {
      const ks = (ids || []).map(id => batterK[Number(id)]).filter(Boolean).map(b => b.k);
      if (ks.length < MIN_RESOLVED) return null;
      return { mean: ks.reduce((a, v) => a + v, 0) / ks.length, resolved: ks.length };
    };
    const lineupMeanWeighted = ids => {
      const bs = (ids || []).map(id => batterK[Number(id)]).filter(Boolean);
      if (bs.length < MIN_RESOLVED) return null;
      const pa = bs.reduce((a, b) => a + b.pa, 0);
      return pa ? bs.reduce((a, b) => a + b.k * b.pa, 0) / pa : null;
    };

    const pids = [...new Set([
      ...games.flatMap(g => ["away", "home"].map(sd => g.teams[sd].probablePitcher && g.teams[sd].probablePitcher.id).filter(Boolean)),
      ...PitchingPlan.participantIds(reportedPlans)
    ])];
    if (pids.length) {
      const ps = await PitcherCore.fetchPitchers(pids, DATE, j);
      await loadRecentForm(pids);
      console.log(`Pitcher recent form: last-${FORM_STARTS}-start K/BF loaded for ${Object.keys(recentForm).length} of ${pids.length} pitcher(s).`);
      const bulkRoleStats = await PitchingPlan.fetchBulkRoleStats(reportedPlans, DATE, j);
      // Swing-and-miss / arsenal leverage data (Baseball Savant, 2 calls, whole league).
      const arsenalData = await Arsenal.fetchArsenalData(yr, j).catch(() => ({ ready: false }));
      const teamCodes = arsenalData.ready ? await Arsenal.fetchTeamCodes(j) : {};

      /*
        Resolve every lineup on the slate FIRST, so the league baseline is the
        average of the same statistic we are about to divide by. Doing this
        inside the per-pitcher loop would mean each pitcher was compared against
        a baseline built from a different subset of games.
      */
      const resolveLineup = (g, forSide) => {
        const oppSide = forSide === "away" ? "home" : "away";
        const posted = ((g.lineups || {})[oppSide + "Players"] || []).map(p => p.id).filter(Boolean);
        if (posted.length >= 9) return { ids: posted, source: "posted", conf: 1 };
        const code = teamCodes[g.teams[oppSide].team.id];
        const proj = ((arsenalData.byTeam && arsenalData.byTeam[code]) || []).slice(0, 9).map(x => x.id);
        return { ids: proj, source: proj.length ? "projected_regulars" : "none", conf: 0.5 };
      };
      const lineupCache = new Map();
      const slateMeans = [];
      for (const g of games) {
        for (const sd of ["away", "home"]) {
          const lu = resolveLineup(g, sd);
          const m = lineupMean(lu.ids);
          lineupCache.set(`${g.gamePk}|${sd}`, { ...lu, stat: m, weighted: lineupMeanWeighted(lu.ids) });
          if (m) slateMeans.push(m.mean);
        }
      }
      // Fall back to the season league rate only if the slate is unusable; a
      // half-built baseline is worse than the old behaviour, not better.
      const leagueLineupK = slateMeans.length >= 10
        ? slateMeans.reduce((a, v) => a + v, 0) / slateMeans.length
        : null;
      console.log(leagueLineupK
        ? `Lineup K% baseline: ${leagueLineupK.toFixed(4)} (unweighted mean across ${slateMeans.length} lineup(s); league PA-weighted for reference ${leagueKByHand.R.toFixed(4)}).`
        : `Lineup K% baseline unavailable (${slateMeans.length} lineup(s) resolved) — falling back to team season K% vs hand.`);

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
            const hasAssignedInnings = candidate.expected_innings !== null
              && candidate.expected_innings !== undefined
              && candidate.expected_innings !== ""
              && Number.isFinite(Number(candidate.expected_innings));
            const expIP = hasAssignedInnings
              ? Number(candidate.expected_innings)
              : inferredRole.expectedInnings;
            const roleStats = candidate.role === "bulk" ? bulkRoleStats[Number(candidate.pitcher_id)] || null : null;
            const skillSo = roleStats && roleStats.bf ? roleStats.so : pit.so;
            const skillBf = roleStats && roleStats.bf ? roleStats.bf : pit.bf;
            /*
              Opponent adjustment. Preferred source is the posted lineup's
              unweighted mean K% over the trailing 30 days, divided by the
              slate-wide average of that same statistic. Falls back to the
              previous team-season-vs-hand ratio when the lineup cannot be
              resolved (fewer than 7 of 9 hitters with a window sample) or when
              too few lineups exist to build a baseline — early-morning runs
              before any lineup is posted take this path.
            */
            const luStat = lineupCache.get(`${g.gamePk}|${sd}`) || null;
            const teamOppK = pit.hand && kv[pit.hand] ? kv[pit.hand][oppId] : null;
            const teamLeagueK = leagueKByHand[pit.hand] || leagueKByHand.R;
            let adj = 1, adjSource = "none";
            if (luStat && luStat.stat && leagueLineupK) {
              adj = luStat.stat.mean / leagueLineupK;
              adjSource = `lineup_unweighted_30d_${luStat.source}`;
            } else if (teamOppK && teamLeagueK) {
              adj = teamOppK / teamLeagueK;
              adjSource = "team_season_vs_hand";
            }
            // Swing-and-miss / arsenal leverage: how much THIS lineup misses THIS
            // pitcher's specific pitch mix, relative to a league-average lineup.
            // Posted lineup -> full confidence; projected regulars -> half.
            const oppSide = sd === "away" ? "home" : "away";
            const postedPlayers = ((g.lineups || {})[oppSide + "Players"] || []);
            const postedLu = postedPlayers.map(p => p.id).filter(Boolean);
            let luIds = postedLu, luConf = 1, luSource = "posted";
            if (luIds.length < 5) {
              const code = teamCodes[oppId];
              luIds = ((arsenalData.byTeam && arsenalData.byTeam[code]) || []).slice(0, 9).map(x => x.id);
              luConf = 0.5; luSource = luIds.length ? "projected_regulars" : "none";
            }
            const lev = Arsenal.leverage(Number(candidate.pitcher_id), luIds, arsenalData, { cap: 0.12, confidence: luConf });
            const whiffFactor = lev.applied ? lev.factor : 1;
            // Batters faced per inning is pitcher-specific, not a league constant.
            // Efficient arms (low WHIP) face fewer hitters per inning; the old flat
            // 4.28 overstated their batters and inflated K projections (e.g. Wheeler,
            // 3.80 BF/IP, was being run at 4.28 -> ~12% too high). Derive it from the
            // same skill source as the K rate, fall back to season, clamp to a
            // realistic band so a thin sample can't blow up the projection.
            const paceBf = (roleStats && roleStats.bf && roleStats.ip) ? roleStats.bf : pit.bf;
            const paceIp = (roleStats && roleStats.bf && roleStats.ip) ? roleStats.ip : pit.ip;
            const bfPerIp = Math.max(3.6, Math.min(4.8, paceBf / paceIp));
            // Season K/BF nudged toward the last five starts, sample-weighted
            // and capped at +/-15%. Bulk-role pitchers keep their role-specific
            // rate as the base; recent form still applies on top of it.
            const form = formAdjustedRate(candidate.pitcher_id, skillSo, skillBf);
            const kRate = form.rate !== null && Number.isFinite(form.rate) ? form.rate : (skillSo / skillBf);
            const projRaw = Number((expIP * bfPerIp * kRate * adj * whiffFactor).toFixed(2));
            // Band is chosen on the RAW projection so the correction cannot move
            // a pitcher into a different band and then be re-derived from it.
            const projBand = bandFor(projRaw);
            const projBias = biasFor(projRaw);
            const proj = Number((projRaw + projBias).toFixed(2));
            const key = pit.name.toLowerCase();
            const rec = pitchers[key] || (pitchers[key] = { name: pit.name, line: null, over: null, under: null, books: 0, game: `${g.teams.away.team.name} @ ${g.teams.home.team.name}` });
            rec.projection = proj;
            rec.projection_raw = projRaw;
            rec.calibration_band = projBand;
            rec.calibration_bias = projBias;
            // Both constructions are recorded every run so grade-confidence.js
            // can measure which one actually predicts, rather than the question
            // being settled by argument.
            rec.k_rate_season = skillBf > 0 ? Number((skillSo / skillBf).toFixed(4)) : null;
            rec.k_rate_used = Number(kRate.toFixed(4));
            rec.recent_form = form.applied ? {
              starts: form.starts, batters_faced: form.recent_bf,
              recent_k_rate: Number(form.recent.toFixed(4)),
              weight: form.weight, capped: Boolean(form.capped)
            } : null;
            rec.opp_k_adjustment = Number(adj.toFixed(4));
            rec.opp_k_source = adjSource;
            rec.opp_lineup_k = luStat && luStat.stat ? Number(luStat.stat.mean.toFixed(4)) : null;
            rec.opp_lineup_k_weighted = luStat && Number.isFinite(luStat.weighted) ? Number(luStat.weighted.toFixed(4)) : null;
            rec.opp_lineup_k_resolved = luStat && luStat.stat ? luStat.stat.resolved : 0;
            rec.opp_team_season_k = Number.isFinite(teamOppK) ? Number(teamOppK.toFixed(4)) : null;
            rec.league_lineup_k = leagueLineupK ? Number(leagueLineupK.toFixed(4)) : null;
            rec.bf_per_ip = Number(bfPerIp.toFixed(2));
            rec.whiff_leverage = whiffFactor;
            rec.whiff_leverage_applied = lev.applied;
            // Store the lineup the leverage was actually computed against. Without
            // it the page can show a whiff factor but not the nine hitters behind
            // it, and the learning loop cannot tell which lineup produced which
            // projection. Names are kept when the lineup is posted; projected
            // regulars carry ids only and the page resolves them.
            rec.opp_team_id = oppId;
            rec.opp_lineup_source = luSource;
            rec.opp_lineup = luSource === "posted"
              ? postedPlayers.map((p, i) => ({
                  order: i + 1,
                  id: p.id,
                  name: p.useName && p.lastName ? `${p.useName} ${p.lastName}` : (p.fullName || null),
                  pos: (p.primaryPosition || {}).abbreviation || null
                }))
              : luIds.map((id, i) => ({ order: i + 1, id, name: null, pos: null }));
            rec.whiff_lineup_source = lev.applied ? luSource : (lev.note || "n/a");
            rec.whiff_detail = lev.per_pitch || null;
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
  //
  // 2026-08-06, Lynold: this comment was already a lie before today (flagged in
  // HANDOFF's "Also open" as "the k-props merge lies"), and today gave a concrete
  // case -- Dylan Cease and others had a real captured line (7.5, real odds) this
  // morning, and by evening, once their games had started and the sportsbook
  // pulled the pregame market, the line came back null on a later run and this
  // merge did NOT restore it. Root cause: the projection-compute loop above
  // (~line 500) unconditionally creates a `pitchers[key]` entry -- with
  // `line: null` -- for EVERY probable pitcher, whether or not odds exist for
  // them this run. So by the time this merge runs, the key is never actually
  // "absent" for any pitcher still on today's slate -- `if (!pitchers[k])` can
  // only ever fire for a pitcher dropped from the probables list entirely
  // (scratched), never for one who simply lost market coverage. His instruction:
  // "before all those games went live we had their info -- we had pitcher, line,
  // projected -- that's what needs to be logged." Once real market data
  // (line/over/under/books) is captured, it must persist for the day even after
  // the book pulls the market -- everything else (projection, lineup, expected
  // innings) should keep updating fresh, since those get MORE accurate later in
  // the day (real posted lineup vs. this morning's projected regulars).
  try {
    const prevPath = path.join(ROOT, "data", "k-props", `${DATE}.json`);
    if (fs.existsSync(prevPath)) {
      const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
      if (prev && prev.date === DATE && prev.pitchers) {
        for (const [k, v] of Object.entries(prev.pitchers)) {
          if (!pitchers[k]) {
            // Pitcher isn't in today's fresh probables/projection pass at all
            // (e.g. scratched) -- restore the whole prior record, as before.
            pitchers[k] = v;
          } else if (pitchers[k].line === null && Number.isFinite(v.line)) {
            // Still on today's slate and this run recomputed a fresh
            // projection/lineup for them, but the market line came back empty
            // (the book pulled it, almost always because the game started).
            // Keep the last real captured market data; leave the fresh
            // projection/lineup/etc. this run just computed untouched.
            pitchers[k].line = v.line;
            pitchers[k].over = v.over;
            pitchers[k].under = v.under;
            pitchers[k].books = v.books;
          }
        }
      }
    }
  } catch (e) {}
  const out = { date: DATE, generated_at: new Date().toISOString(), source: "the-odds-api pitcher_strikeouts (us region; consensus = most common posted line, best price at it)", events_fetched: fetched, probables, pitching_plan_signature: pitchingPlanSignature, pitchers,
    // learned_bias is kept as a single number for any older consumer that reads
    // it, but it is now only meaningful alongside learned_by_band. It reports
    // the correction for the band most projections fall in, not one global
    // adjustment applied to everyone — that behaviour is what this replaced.
    learned_bias: (learnedByBand["<6"] || {}).bias || 0,
    learned_by_band: learnedByBand,
    learned_n: learnedN };
  fs.mkdirSync(path.join(ROOT, "data", "k-props"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "k-props", `${DATE}.json`), JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(ROOT, "data", "k-props", "today.json"), JSON.stringify(out, null, 1));
  console.log(`K-props: wrote lines for ${Object.keys(pitchers).length} pitcher(s) from ${fetched} event call(s).`);
}
main().catch(e => { console.error("k-props error:", e.message); process.exit(0); });
