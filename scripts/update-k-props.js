#!/usr/bin/env node
"use strict";
/*
  LyDia — fetch pitcher strikeout prop lines (Over/Under) for today's slate.

  - Uses The Odds API per-event endpoint: /events/{id}/odds?markets=pitcher_strikeouts
  - Cost: 1 quota-counted request per event (~15/day). The /events list itself is free.
  - Writes data/k-props/<date>.json and data/k-props/today.json keyed by pitcher name:
    consensus line (median), best over/under prices at that line, book count.
  - No key or missing data → logs and exits 0. The daily run is never blocked.

  Model name: "Leo K-Prop" (renamed 2026-08-08 from
  pitcher-strikeouts-self-calibrated-v1, published in generate-member-lab.js
  as modelVersion "leo-kprop" -- Lynold's call: "Leo" is the model name
  across the site now, and it needed to be discoverable that this is the
  same model family, computed fresh every run plus one learned correction).
  Rename only -- the computation below did not change.

  ============================================================
  THE FORMULA, WRITTEN OUT EXPLICITLY
  ============================================================
    projRaw = expIP × bfPerIp × kRate × adj × whiffFactor
    proj    = projRaw + selfCalBias(projRaw)

  expIP        Expected innings for this pitcher: from the reported pitching
               plan if one exists, else the role classifier's default for
               his usage pattern (starter / opener / bulk).

  bfPerIp      Batters faced per inning, THIS pitcher's own rate (role-aware
               -- a bulk-role pitcher uses his role-specific BF/IP, not his
               overall season number), clamped to [3.6, 4.8] so a thin
               sample can't produce an unrealistic pace.

  kRate        Season K/BF blended toward his last 5 starts, sample-weighted
               so a short recent window can't overrule a full season alone:
                 weight = recentBF / (recentBF + 200)
                 kRate  = seasonRate + weight × (recentRate − seasonRate)
               capped to within ±15% of the season rate either direction.

  adj          Opponent adjustment = this lineup's K rate ÷ the slate-wide
               average lineup K rate. "This lineup's K rate" is the
               UNWEIGHTED mean of the nine batters' individual trailing-30-
               day K%, using the posted lineup once it's up, or the team's
               projected regulars before it posts. Falls back to a team-
               season-K%-vs-pitcher-hand ratio if fewer than 7 of 9 hitters
               can be resolved.

  whiffFactor  Arsenal / swing-and-miss leverage: how much MORE or LESS this
               specific lineup whiffs against this specific pitcher's actual
               pitch-type mix, versus a league-average lineup facing the
               same mix. Capped ±12%, confidence-scaled to half weight when
               only projected regulars are available instead of the posted
               lineup.

  selfCalBias  A rolling correction learned from the last 150 graded starts
               (K_WINDOW), banded by projection size (<6 / 6-7 / >=7 Ks --
               K_BANDS), shrunk toward zero for thin bands (n < 15 games --
               K_MIN_N -- or a correction smaller than 0.15 K -- K_MIN_BIAS
               -- does nothing), capped at ±1.5 K (K_CAP) so no single band
               can swing a projection too far. This is the ONLY place recent
               grading results feed back into the number -- everything
               above is recomputed from real, current data every run, never
               cached or reused from a prior day.

  Market line, price, and the official-pick gate (edge >= 0.7 K, posted
  lineup required, 2+ books, non-opener workload >= 4 expected innings) are
  handled separately in generate-member-lab.js -- this formula only
  produces the projection itself. Full narrative version, with the incident
  history behind each constant, is in the Learning Vault: 04 Model and
  Picks > Model Versions.md > "leo-kprop".
  ============================================================
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

// 2026-08-24, Lynold: pitchers with accented names (e.g. "José Urquidy") were
// silently splitting into two dead records instead of one real one. MLB's own
// probable-pitcher feed keeps the accent; the sportsbook feed usually doesn't
// ("Jose Urquidy"). Both sides of the merge below key off name.toLowerCase(),
// and .toLowerCase() does not strip diacritics -- "josé urquidy" !==
// "jose urquidy" -- so the odds-book loop (~line 259) and the projection loop
// (~line 660) created two separate pitchers[] entries for the same real
// person: one with real market odds but no projection/game_pk, one with a
// real projection but line: null. Neither one was usable. normalizeName()
// strips diacritics (NFD decompose, drop combining marks) before lowercasing
// so both loops land on the same key regardless of which spelling either
// feed used. Display name (rec.name) still comes from whichever loop wrote
// the record first, unchanged by this fix.
function normalizeName(name) {
  return String(name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

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
      home: (g.teams.home.probablePitcher || {}).fullName || "TBD",
      // 2026-08-26: team names, from the same free schedule response --
      // added so a targeted re-fetch (below) can match a specific changed
      // game to its the-odds-api event without an extra call.
      awayTeam: g.teams.away.team.name,
      homeTeam: g.teams.home.team.name
    };
  }
  return out;
}

/*
  2026-08-08, ERR-20260808-02: a second, narrower schedule fetch (hydrate=lineups,
  free MLB endpoint, not paid odds quota) built specifically to catch the gap
  `currentProbables()` cannot see -- a game whose PITCHER hasn't changed all day
  but whose OPPOSING LINEUP has since posted. The official-pick gate for K props
  requires opp_lineup_source === "posted" (2026-07-30, Lynold's call). Before
  this, a pitcher confirmed at the day's first capture (e.g. the 4am run, before
  any lineup posts) could never re-trigger a capture later in the day under
  --if-changed's old pitcher-only change detection, since "the probable pitcher"
  is the only thing it compared -- so opp_lineup_source stayed frozen at
  "projected_regulars" all day even once the real lineup went up and the K prop
  could never clear the gate, no matter how many times prepare-slate.yml ran.
  Diagnosed from a live case: Chris Sale / Gerrit Cole (Braves @ Yankees,
  2026-08-08), both locked in as probables since the 4:02am UTC capture, both
  showing a real Over edge that never went official.
*/
async function currentLineupsPosted() {
  const sched = await j(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}&hydrate=lineups`);
  const out = {};
  for (const g of (((sched.dates || [])[0]) || {}).games || []) {
    if (!g.status || g.status.abstractGameState !== "Preview") continue;
    out[g.gamePk] = {
      away: (((g.lineups || {}).awayPlayers) || []).length >= 9,
      home: (((g.lineups || {}).homePlayers) || []).length >= 9
    };
  }
  return out;
}

async function main() {
  if (!KEY) { console.log("ODDS_API_KEY not set — strikeout props skipped."); return; }
  const reportedPlans = PitchingPlan.load(ROOT, DATE);
  const pitchingPlanSignature = JSON.stringify(reportedPlans.games || {});

  // 2026-08-10: whether this run needs a fresh PAID odds pull at all. A
  // lineup posting changes opp_lineup_k (our own projection input) -- it
  // does not change the sportsbook's line or price. Re-pulling odds for the
  // entire slate every time any one pitcher's opposing lineup posts was
  // burning ~1 paid event call per game on the slate for a change that only
  // ever affects the projection math, never the market data. Lynold: "the
  // pitcher itself did not change... we only need to do k prop [odds] when
  // we don't have it for that pitcher." Below, a run with ONLY lineup-posted
  // changes (no pitcher swap, no plan change) skips the paid fetch entirely;
  // the projection loop still runs fresh off free MLB data, and the
  // merge-forward logic near the bottom of this file (the 2026-08-06 Dylan
  // Cease fix) carries the already-captured line/over/under/books forward
  // since this run's pitchers object never populates them.
  let skipOddsFetch = false;

  // 2026-08-26, Lynold's explicit instruction: "if we already captured
  // money lines for a game, and pitcher KO lines, why are we using another
  // call for the same data" -- correct. Until today, ANY single pitcher
  // change on a 15-game slate re-pulled odds for all 15 (~1 quota-counted
  // call per event, per file header above), because the loop below had no
  // idea WHICH game triggered the refetch, only THAT one did. changedPks
  // (and changedTeamKeys, below) narrow that to the actual game(s) that
  // changed. null keeps the safe, original "fetch everything" behavior --
  // used whenever there's no prior capture to compare against, or a
  // pitching-plan update fires (that can touch any pitcher's role/expected
  // innings, not just the one game that reported it, so it stays untargeted
  // on purpose).
  let changedTeamKeys = null;
  if (IF_CHANGED) {
    // Lines are captured once at publish and kept all day — only a pitcher
    // change, a pitching-plan update, or (2026-08-08) an opposing lineup
    // that has since posted, re-triggers this script at all.
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
      // Changes that mean we may not have a price for someone yet, and need
      // a real paid fetch.
      const criticalChanges = [];
      // Changes that only affect OUR projection math (opp_lineup_k), never
      // the market's price -- never need a paid fetch on their own.
      const lineupChanges = [];
      // Per-game gamePks with a critical change, so the fetch below can be
      // targeted. Stays a Set (not just a count) so a plan-signature change
      // -- which isn't tied to one game -- can fall back to fetching
      // everything by leaving changedTeamKeys null.
      const changedPks = new Set();
      let planChanged = false;
      if (prev.pitching_plan_signature !== pitchingPlanSignature) { criticalChanges.push("reported pitching plan updated"); planChanged = true; }
      for (const [pk, cur] of Object.entries(now)) {
        const was = prev.probables[pk];
        if (!was) continue;
        for (const side of ["away", "home"]) {
          if (was[side] !== "TBD" && cur[side] !== was[side]) { criticalChanges.push(`${was[side]} → ${cur[side]}`); changedPks.add(pk); }
          if (was[side] === "TBD" && cur[side] !== "TBD") { criticalChanges.push(`TBD → ${cur[side]}`); changedPks.add(pk); }
        }
      }
      // 2026-08-08 (ERR-20260808-02): catch a lineup that has since posted for
      // any pitcher whose prior capture still shows a non-posted opposing
      // lineup. Checked with a free MLB schedule call, not the paid odds API,
      // so this costs nothing when nothing has actually posted. Checking
      // "either side posted" per game rather than resolving each pitcher's
      // specific opponent side is deliberately loose -- the cost of a false
      // trigger is one harmless extra projection recompute, the cost of a
      // false skip is a K prop that can never go official all day.
      const stillWaiting = Object.values(prev.pitchers || {}).some(rec => rec.opp_lineup_source !== "posted");
      if (stillWaiting) {
        const lineupsNow = await currentLineupsPosted().catch(() => ({}));
        for (const [key, rec] of Object.entries(prev.pitchers || {})) {
          if (rec.opp_lineup_source === "posted") continue;
          const lu = lineupsNow[rec.game_pk];
          if (lu && (lu.away || lu.home)) lineupChanges.push(`${rec.name}: opposing lineup now posted`);
        }
      }
      if (!criticalChanges.length && !lineupChanges.length) {
        console.log("Probables and lineups unchanged — keeping the morning capture, no API call.");
        return;
      }
      if (!criticalChanges.length) {
        skipOddsFetch = true;
        console.log(`Lineup(s) posted (${lineupChanges.join("; ")}) — recomputing projections only, no odds fetch.`);
      } else {
        // Targeted only when this is a genuine subset of the slate: a prior
        // capture exists, the plan didn't change (untargetable, see above),
        // and at least one specific game is actually known. Any of those
        // failing falls back to changedTeamKeys staying null -- fetch
        // everything, the original safe behavior.
        if (!planChanged && changedPks.size) {
          changedTeamKeys = new Set();
          for (const pk of changedPks) {
            const g = now[pk];
            if (g && g.awayTeam && g.homeTeam) changedTeamKeys.add(`${g.awayTeam} @ ${g.homeTeam}`);
          }
        }
        console.log(`Change detected (${[...criticalChanges, ...lineupChanges].join("; ")}) — re-capturing prop lines${changedTeamKeys ? ` for ${changedTeamKeys.size} game(s), not the full slate` : ""}.`);
      }
    }
  }

  const pitchers = {};
  let fetched = 0;

  if (!skipOddsFetch) {
    const events = await j(`https://api.the-odds-api.com/v4/sports/baseball_mlb/events?apiKey=${KEY}`);
    // keep events that start on DATE in ET
    let todays = (events || []).filter(e => new Date(e.commence_time).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === DATE);
    // 2026-08-26: only pull odds for the game(s) that actually changed, when
    // we know which those are (changedTeamKeys set above). Matching is by
    // team-name pair, since that's the only thing the-odds-api's event list
    // and our own schedule data share -- if a specific event can't be
    // matched for any reason, KEEP it rather than drop it (skip only on a
    // confident match, never on doubt -- a missed match costs one harmless
    // extra call; a wrongly-dropped one costs a stale line all day).
    if (changedTeamKeys) {
      const before = todays.length;
      todays = todays.filter(ev => changedTeamKeys.has(`${ev.away_team} @ ${ev.home_team}`));
      console.log(`K-props: targeting ${todays.length}/${before} event(s) on ${DATE} (skipping unchanged games).`);
    } else {
      console.log(`K-props: ${todays.length} event(s) on ${DATE}.`);
    }

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
        pitchers[normalizeName(name)] = {
          name, line,
          over: bestOver ? bestOver.over : null,
          under: bestUnder ? bestUnder.under : null,
          books: arr.length,
          game: `${ev.away_team} @ ${ev.home_team}`
        };
      }
    }
  } else {
    console.log("K-props: skipping paid event odds calls (lineup-only change) — prior line/price will be carried forward.");
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

    Bias is measured on the projection_raw column where the ledger has it
    (found by header name, not position — see the reader below), written from
    this version forward and backfilled from data/k-props/*.json). Older rows
    fall back to the corrected projection, which biases their band assignment
    slightly; that self-heals as the window rolls over.

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
      const lines = fs.readFileSync(klog, "utf8").trim().split("\n");
      // 2026-08-14: kprops_log.csv's columns were reordered/renamed/trimmed
      // (43 -> 38 cols) to Lynold's exact spec. This reader used to address the
      // file POSITIONALLY (r[5]=projection, r[6]=actual_k, r[10]=projection_raw)
      // — a hardcoded index silently reads the wrong column the moment the file
      // is reshaped, with no error, just wrong self-calibration going forward.
      // Switched to a header-name lookup so any future reorder is safe.
      const head = (lines[0] || "").split(",");
      const iProj = head.indexOf("projection");
      const iActual = head.indexOf("actual_k");
      const iProjRaw = head.indexOf("projection_raw");
      if (iProj === -1 || iActual === -1) {
        console.warn(`K self-calibration skipped: kprops_log.csv header is missing "projection" or "actual_k" `
          + `(found: ${head.join("|") || "no header"}). Not guessing a column position.`);
      } else {
        const rows = lines.slice(1).map(l => l.split(","))
          .filter(r => r.length > Math.max(iProj, iActual) && r[iProj] !== "" && r[iActual] !== ""
            && isFinite(Number(r[iProj])) && isFinite(Number(r[iActual])))
          .slice(-K_WINDOW);
        learnedN = rows.length;
        const byBand = {};
        for (const r of rows) {
          const proj = Number(r[iProj]), actual = Number(r[iActual]);
          // Band on the pre-correction projection when the row carries it.
          // Banding on the corrected number measures the residual after last
          // week's correction rather than the model's own error, which is how
          // the <6 band looked unbiased at -0.09 when its true error was -0.48.
          // Fall back to the corrected value for rows with no projection_raw.
          const rawLogged = iProjRaw !== -1 && r.length > iProjRaw && r[iProjRaw] !== "" && isFinite(Number(r[iProjRaw]))
            ? Number(r[iProjRaw]) : null;
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
            const key = normalizeName(pit.name);
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
