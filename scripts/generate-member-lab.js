#!/usr/bin/env node
/*
  LyDia source-of-truth daily engine.
  Creates research data and locked official picks only for an open slate.
  Official markets: moneyline, full-game totals, and pitcher strikeouts.
  Each market keeps its own qualification rule and record.
*/
const fs = require("fs");
const path = require("path");
const { buildBullpenSource } = require("./lib/bullpen-fatigue-core");
const { calcLabRating, labRatingSentence, LAB_RATING_VERSION } = require("./lib/lab-rating-core");
const PitcherCore = require("../js/pitcher-matchup-core.js");

const ROOT = path.join(__dirname, "..");
const HFA = 54 / 46;
const PYTH_EXP = 1.83;
const FORM_WEIGHT = 0.25;
const ERA_K = 0.20;
const LEAGUE_ERA = 4.20;
const MIN_IP = 20;
const ERA_CLAMP = [2.75, 6.00];

// 2026-08-06, Lynold: the current live moneyline model is called "leo" in
// conversation and in the vault (Model Versions.md). Every prior version is
// "the old model". Single source of truth for the string written to every
// graded ledger row (calibration_model_log.csv, attribution_model_log.csv,
// the member brief, etc.) so it can never drift between the two write sites.
const MONEYLINE_MODEL_VERSION = "leo";

const VALUE_EDGE = 0.03;
const OFFICIAL_LAB_SCORE = 80;
/*
  MONEYLINE CALIBRATION (2026-08-05, measured on 266 graded games)

  The raw model is systematically OVERCONFIDENT above 55%. Measured, by band:
    50-55%  predicted 52.5%  actual 54.8%   (+2.3, slightly under-confident)
    55-60%  predicted 57.4%  actual 50.0%   (-7.4)
    60-65%  predicted 62.6%  actual 55.3%   (-7.2)
    65-70%  predicted 67.2%  actual 48.8%  (-18.5)
    70%+    predicted 78.0%  actual 63.8%  (-14.2)

  The low band is the honest one; everything above it drifts. Shrinking the
  published probability toward 0.5 fixes it:  p -> 0.5 + K * (p - 0.5).

  K = 0.50 was fit on the FIRST 159 graded games and tested on the LAST 107 it
  had never seen: Brier 0.2732 -> 0.2534, a 7.2% out-of-sample improvement.
  Not an in-sample fit.

  This is a monotonic, order-preserving transform, so it changes no ranking and
  no pick. The gate below is remapped through the same transform (0.72 -> 0.61)
  so exactly the same games qualify as before. What changes is that the number
  published to a reader is now the number the record actually supports.
*/
const MONEYLINE_CALIBRATION_K = 0.50;
const calibrateProb = p => (Number.isFinite(p) ? 0.5 + MONEYLINE_CALIBRATION_K * (p - 0.5) : p);
// 0.72 raw, expressed on the calibrated scale. Same games, honest number.
const OFFICIAL_MODEL_PROB = 0.61;
const VALUE_WATCH_LAB_SCORE = 75;
const WATCHLIST_LAB_SCORE = 65;
const MAX_ABS_PRICE = 1000;

/*
  Hard price floor for ANY official pick (2026-08-02, Lynold's call).

  A price of -185 needs a 64.9% strike rate just to break even, and -250 needs
  71.4%. Our own calibration says we do not hit those numbers: over 261 graded
  games the 75-85% band came in at 52.4% actual and the 85%+ band at 57.1%. A
  favourite that heavy is a market we are paying a premium to be right about,
  and the record does not support paying it.

  This is a price gate, not a rating gate. It sits alongside the market veto in
  the official-pick condition and never touches the Lab Rating — the analysis
  can still be excellent, it just is not a bet at that number. A rejected pick
  keeps its status and read; only official publication is withheld, and every
  rejection is logged so the count is visible rather than silent.

  Applied to all three official markets — moneyline, game total, pitcher Ks —
  because the break-even arithmetic is identical regardless of market. Change
  this one constant to retune, or scope it per market if that ever diverges.
*/
const MIN_OFFICIAL_PRICE = -185;
// American odds: -185 and anything more negative is rejected. Positive prices
// and shorter favourites pass. Missing prices are handled by existing checks.
const priceAllowsOfficial = price =>
  !Number.isFinite(price) ? false : price > MIN_OFFICIAL_PRICE;

/*
  Weight of the totals run-projection inside the moneyline probability.

  Set to 0 on 2026-08-02. It was 0.50 — half of every moneyline log-odds came
  from the run model — and the evidence says that signal has never been shown to
  be worth anything:

    - Totals projection vs its own market: beta = +0.066, 95% CI [-0.46, +0.59].
      beta = 0 cannot be rejected. It carries no information the line lacks.
    - Moneyline calibration over 261 graded games: Brier 0.2572, worse than a
      coin flip (0.2500) and worse than always betting the base rate (0.2477).
      The 75-85% band went 52.4% actual against 78.7% predicted.
    - On 2026-07-29 the totals model was replaced with v4-additive-median-woba,
      which emitted per-side projections like 0.6 runs for St. Louis and 9.0 for
      Seattle. Poisson-converted and blended at 0.50 those produced moneyline
      probabilities up to 0.9858 — a number no baseball matchup supports. The
      maximum before that day was 0.8084.

  This is staged, not a deletion. The run model stays wired up and its
  contribution is still recorded per game (run_model_probability), so the
  accountability ledger can measure whether it earns weight back. Raise this
  above 0 only on that evidence.
*/
const RUN_MODEL_WEIGHT = 0;

/*
  Plausibility bounds on a per-side run projection.

  Even at weight 0 this matters, because run_model_probability is still stored,
  displayed, and fed to the Lab Rating's model-agreement term. A projection
  outside these bounds is not a bold opinion, it is a broken input: no MLB team
  has ever averaged under 3 runs a game over a season, and 8.5 is already an
  extreme single-game total for one side. Outside the range the run model is
  treated as unavailable for that game rather than blended in.
*/
const RUN_PROJ_MIN = 2.0;
const RUN_PROJ_MAX = 8.5;
// Fallback totals gate, used only for older data/totals files written before
// update-totals.js started publishing its own `policy` object (2026-07-29 and
// earlier had no per-file policy; TOTALS_POLICY.strong_min_edge/strong_min_setup/
// official_totals_enabled are read from that file when present and take
// priority over these constants below). Keeping one hardcoded gate in sync
// with another hardcoded gate in update-totals.js was exactly the drift this
// removes: see EXP-20260727-01.
const OFFICIAL_TOTAL_EDGE = 1.0;
const OFFICIAL_TOTAL_LAB = 80;
const OFFICIAL_K_EDGE = 0.7;
const OFFICIAL_K_MIN_BOOKS = 2;

const args = parseArgs(process.argv.slice(2));
const DATE = args.date || etToday();
const SNAPSHOT = args.snapshot || process.env.SNAPSHOT_TYPE || "posted";
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";

if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error(`Bad date: ${DATE}`);
  process.exit(1);
}
if (!["posted", "current", "closing"].includes(SNAPSHOT)) {
  console.error(`Bad snapshot: ${SNAPSHOT}. Use posted, current, or closing.`);
  process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });

async function main() {
  ["data/member-brief", "data/picks", "data/published-picks", "data/market", "data/bullpen"].forEach(p => fs.mkdirSync(path.join(ROOT, p), { recursive: true }));

  const [sched, standings, oddsEvents] = await Promise.all([
    fetchJson(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}&hydrate=probablePitcher`),
    fetchJson(`https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${seasonYear(DATE)}&standingsTypes=regularSeason`),
    ODDS_API_KEY ? fetchJson(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${encodeURIComponent(ODDS_API_KEY)}&regions=us&markets=h2h&oddsFormat=american`).catch(() => []) : Promise.resolve([])
  ]);

  const allGames = ((((sched.dates || [])[0]) || {}).games || [])
    .filter(g => g.gameType === "R" || g.gameType === undefined)
    .sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate));

  if (!allGames.length) {
    throw new Error(`No MLB games found for ${DATE}. No files were written.`);
  }

  const previousBrief = readJsonSafe(`data/member-brief/${DATE}.json`) || { games: [] };
  const previousRows = Array.isArray(previousBrief.games) ? previousBrief.games : [];
  const previousByPk = new Map(previousRows.map(row => [String(row.game_pk), row]));
  const openGames = allGames.filter(g => g.status && g.status.abstractGameState === "Preview");
  if (!openGames.length && !previousRows.length) {
    throw new Error(`Closed slate guard: ${DATE} has ${allGames.length} game(s), but none are in Preview state. LyDia will not create or overwrite official picks after games start. Run Site maintenance cleanup or grade-results instead.`);
  }

  const generatedAt = new Date().toISOString();
  const strength = buildStrength(standings);
  const pitchers = await fetchPitchers(openGames);
  const offense = await fetchOffenseForm(DATE);
  // A second publish pass must never erase a valid morning price because a
  // later odds request was rate-limited or temporarily empty. Current odds
  // win when present; otherwise reuse the already captured member-brief or
  // locked market snapshot for that game.
  // capturedOdds: written by scripts/update-moneyline-odds.js, the only
  // place h2h odds get fetched with a real ODDS_API_KEY present (from
  // refresh-lines.yml, run manually or on its own schedule). This script
  // itself never has that key when it runs inside publish-picks.yml, so
  // without this fallback oddsEvents below is always [] there and every
  // matchup page shows "Market probability: Not available" regardless of
  // the game -- there was no path from a real odds fetch to this script's
  // output at all. ERR-20260801-02.
  const oddsMap = {
    ...buildLockedMarketOddsMap(readJsonSafe(`data/market/${DATE}.json`)),
    ...buildCapturedMoneylineMap(readJsonSafe(`data/moneyline-odds/${DATE}.json`)),
    ...buildPreviousOddsMap(previousRows),
    ...buildOddsMap(oddsEvents)
  };
  const bullpenSource = allGames.length
    ? await buildBullpenSource({ date: DATE, todayGames: allGames, fetchJson, generatedAt })
    : readJsonSafe(`data/bullpen/${DATE}.json`);
  if (!bullpenSource) {
    throw new Error(`Closed slate guard: no retained bullpen source exists for ${DATE}. No daily files were overwritten.`);
  }
  const bullpen = bullpenSource.teams_by_name || {};

  writeJson(`data/bullpen/${DATE}.json`, bullpenSource);
  if (DATE === etToday()) {
    writeJson("data/bullpen/today.json", bullpenSource);
    // Public-safe subset only — the full object carries internal fields
    // (source_of_truth, formula text, method notes) that don't belong in a
    // public page even inside a script tag, and the client only reads
    // date/teams anyway.
    injectInlineData("tools/bullpen-fatigue/index.html", "bullpen-inline-data",
      { date: bullpenSource.date, generated_at: bullpenSource.generated_at, teams: bullpenSource.teams },
      '<div id="status" class="loading">Loading bullpen workload…</div>');
  }

  const totalsSource = readJsonSafe(`data/totals/${DATE}.json`) || { games: {} };
  const runProjections = totalsSource.games || {};
  const freshRows = openGames.map(g => modelGame(g, strength, pitchers, oddsMap, bullpen, offense, runProjections)).filter(Boolean);
  const freshByPk = new Map(freshRows.map(row => [String(row.game_pk), row]));

  // The Member Brief is the permanent full-day record. Recalculate games that
  // have not started, but retain the posted pregame row for every live or final
  // game. Never replace the daily file with a shrinking Preview-only subset.
  /*
    THE DAY'S RECORD ONLY EVER GROWS. (2026-08-03)

    This used to build the day's rows by walking `allGames` — the schedule
    response — and taking the fresh row, else the previous row. Two ways that
    loses analysis, and both fired on 2026-08-02, when the brief went from 15
    games to 1 and ten games ended up graded nowhere:

      1. If the schedule fetch returns a short slate, every game missing from
         `allGames` is never even considered. No guard notices, because every
         guard also iterates `allGames`.
      2. A started game absent from the previous brief was dropped with a
         console warning. That warning exists for a real case — the day's first
         capture running after an early first pitch, where there genuinely is
         nothing to post — but it cannot tell that apart from "we analysed this
         six hours ago and just lost it."

    Both are fixed by keying off the union of what we know rather than off the
    schedule alone: every previously recorded row is carried forward
    unconditionally, and fresh rows are layered on top. A row that exists can
    never be dropped by a later run, whatever the schedule says.

    Fresh always wins over previous for the same game — that is how a Preview
    game gets its updated read — and `freshRows` only ever contains Preview
    games, so a started game can never be recomputed from post-result standings.
  */
  const merged = new Map();
  for (const [pk, row] of previousByPk) merged.set(pk, row);   // never lose a recorded row
  for (const [pk, row] of freshByPk) merged.set(pk, row);      // fresh read wins for unstarted games

  const rows = [...merged.values()]
    .filter(Boolean)
    .sort((a, b) => (b.lab_score || 0) - (a.lab_score || 0));

  // A shrinking day is always a bug now. Nothing legitimately removes a game
  // from a day's record once it has been analysed — not a short schedule
  // response, not a late run, not a rate-limited odds fetch.
  if (previousRows.length && rows.length < previousRows.length) {
    throw new Error(
      `Daily record shrink guard: ${DATE} previously had ${previousRows.length} analysed game(s) and this run produced ${rows.length}. ` +
      "Refusing to write. The day's record only ever grows — see ERR-20260802-05 and the 2026-08-02 collapse from 15 games to 1."
    );
  }

  const previousMarketCoverage = previousRows.filter(row => row.market && Number(row.market.books) > 0).length;
  const currentMarketCoverage = rows.filter(row => row.market && Number(row.market.books) > 0).length;
  if (previousMarketCoverage > 0 && currentMarketCoverage < previousMarketCoverage) {
    throw new Error(
      `Moneyline retention guard: market coverage fell from ${previousMarketCoverage} to ${currentMarketCoverage} games. ` +
      "Refusing to overwrite captured Lab Ratings with a partial odds response."
    );
  }

  const retainedPks = new Set(rows.map(row => String(row.game_pk)));
  const missingGames = allGames.filter(game => !retainedPks.has(String(game.gamePk)));
  if (missingGames.length) {
    // A game already underway (Live/Final) with no posted pregame row on
    // record is not a data bug — it means the day's first capture happened
    // after that game's first pitch (a late manual run, or an unusually
    // early start time). There is nothing to retroactively post for a game
    // already in progress, so skip it rather than failing the whole day.
    // A missing PREVIEW game is still a real problem — that is upcoming
    // analysis that should have modeled cleanly — so that case still fails
    // loudly. 2026-07-30: Rangers @ Rays (822946) hit exactly this on the
    // day's first capture, after first pitch, with no prior row to fall
    // back to.
    const missingUpcoming = missingGames.filter(game => game.status && game.status.abstractGameState === "Preview");
    const missingStarted = missingGames.filter(game => !(game.status && game.status.abstractGameState === "Preview"));
    if (missingStarted.length) {
      console.warn(
        `Daily brief retention guard: skipping already-started game(s) with no posted pregame analysis on record: ` +
        missingStarted.map(game => `${game.gamePk} (${(game.status && game.status.detailedState) || "unknown"})`).join(", ") +
        ". This is expected when the day's first capture runs after first pitch; nothing to retroactively post."
      );
    }
    if (missingUpcoming.length) {
      throw new Error(
        `Daily brief retention guard: refusing to overwrite ${DATE}; missing posted analysis for game(s) ` +
        missingUpcoming.map(game => game.gamePk).join(",")
      );
    }
  }

  if (!rows.length) {
    throw new Error(`Model guard: ${DATE} produced zero retained game rows. No official files were written.`);
  }

  // The card is built first so the summary can describe what is actually on it.
  // Counting only moneyline rows is what produced "No official picks cleared the
  // stricter rules" on a day carrying an official total and six strikeout props.
  const candidateCard = buildPicksFile(rows, generatedAt);
  // The brief must describe the LOCKED card, not a fresh recomputation.
  // Published picks are append-only and reused for the day; recomputing after a
  // line moves produced a Member Brief that disagreed with the Results page on
  // the SIDE of a pick (Wheeler Over 7.5 published, Under 7.5 in the brief).
  // Publish first, then describe whatever actually got published.
  const deferPublish = args["defer-publish"] === "true";
  const officialCard = deferPublish
    ? candidateCard
    : writeOrReusePublishedPicks(candidateCard, allGames.length);

  const brief = {
    date: DATE,
    generated_at: generatedAt,
    snapshot_type: SNAPSHOT,
    source_of_truth: "LyDia Daily Engine",
    current_official_model: "multi_market_v1",
    model_version: MONEYLINE_MODEL_VERSION,
    lab_rating_version: LAB_RATING_VERSION,
    official_pick_rules: {
      minimum_model_probability: OFFICIAL_MODEL_PROB,
      minimum_lab_score: OFFICIAL_LAB_SCORE,
      // 2026-08-06: market edge dropped as an official-pick requirement
      // (Lynold's call) -- this note already didn't claim edge was a gate,
      // so it's untouched and still accurate.
      note: "Lab Rating grades LyDia's analysis quality only and contains no price input. An official pick additionally requires a strong win probability and a good enough price."
    },
    summary: summarize(rows, Boolean(ODDS_API_KEY), officialCard),
    // The official card, market by market. The brief page renders from this so
    // it stops inferring "official" from the moneyline status alone.
    official_card: (officialCard.picks || []).map(g => ({
      game_pk: g.gamePk,
      game: `${g.away} @ ${g.home}`,
      away: g.away,
      home: g.home,
      time: g.time,
      lab_score: g.labScore,
      moneyline: g.moneyline ? {
        pick: g.moneyline.pick, prob: g.moneyline.prob,
        mkt_prob: g.moneyline.mktProb, best_price: g.moneyline.bestAm
      } : null,
      total: g.total ? {
        pick: g.total.pick, line: g.total.line, best_price: g.total.bestAm,
        projection: g.total.projection, edge: g.total.edge, lab_score: g.total.labScore
      } : null,
      strikeouts: (g.strikeouts || []).map(k => ({
        pitcher: k.pitcher, pick: k.pick, line: k.line,
        best_price: k.bestAm, projection: k.projection, edge: k.edge
      }))
    })),
    games: rows
  };
  writeJson(`data/member-brief/${DATE}.json`, brief);

  if (DATE === etToday()) {
    writeJson("data/member-brief/today.json", brief);
    // Bake today's brief into the page itself so the initial HTML has real
    // content — a failed fetch, slow connection, or crawler no longer sees
    // an empty "Loading member brief..." placeholder. The page's own JS
    // renders this inline data immediately, then still fetches in the
    // background to catch any later-in-the-day changes. Public-safe subset
    // only (renderBrief() only ever reads date/generated_at/summary/games).
    injectBriefInline({ date: brief.date, generated_at: brief.generated_at, summary: brief.summary, official_card: brief.official_card, games: brief.games });
    // The old /picks/ hub is now a redirect to the unified /previews/ Picks
    // experience. Do not inject data into that retired duplicate page.
  }

  if (args["defer-publish"] === "true") {
    console.log(`Generated provisional LyDia source data for ${DATE}. Waiting for unified run projections before locking picks.`);
  } else {
    const published = officialCard;
    writeJson(`data/picks/${DATE}.json`, published);
    if (DATE === etToday()) writeJson("data/picks/today.json", published);
    mergeAndWriteMarket(buildMarketFile(rows, generatedAt));
    console.log(`Generated unified LyDia source data for ${DATE}. Games: ${rows.length}. Official picks: ${published.picks.length}.`);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (!v.startsWith("--")) continue;
    const key = v.slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith("--") ? next : "true";
    if (next && !next.startsWith("--")) i++;
  }
  return out;
}
function etToday() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
function injectPicksInline(brief) {
  injectInlineData("picks/index.html", "picks-inline-data", brief, "<!--PICKS-INLINE-DATA_START-->");
}
// Public record for the picks hub. Wins, losses, units, and days only, so the
// graded-pick count can sit beside the win rate instead of a bare percentage.
function injectPicksRecord() {
  let results;
  try { results = readJson("data/results.json"); } catch (e) { return; }
  const days = Object.values((results && results.days) || {});
  if (!days.length) return;
  let wins = 0, losses = 0, units = 0;
  for (const d of days) {
    if (!["moneyline_only", "multi_market_v1"].includes(d.current_official_model)) continue;
    if (d.market_records) {
      for (const r of Object.values(d.market_records)) {
        wins += Number(r.wins) || 0;
        losses += Number(r.losses) || 0;
      }
    } else for (const p of (Array.isArray(d.picks) ? d.picks : [])) {
      if (p.mlResult === "W") wins++;
      else if (p.mlResult === "L") losses++;
    }
    if (typeof d.units === "number") units += d.units;
  }
  injectInlineData("picks/index.html", "picks-inline-record", {
    official_wins: wins,
    official_losses: losses,
    units: Number(units.toFixed(2)),
    days_tracked: days.length
  }, "<!--PICKS-INLINE-RECORD_START-->");
}
function injectBriefInline(brief) {
  injectInlineData("member-brief/index.html", "brief-inline-data", brief, '<div id="passes"></div>');
}
// Bakes today's already-computed data into a page's own HTML so the initial
// page load has real content instead of a client-side-only "Loading..."
// placeholder. Idempotent: re-running replaces the previous block instead of
// duplicating it. The page's JS still refreshes in the background.
function injectInlineData(relFile, elementId, payload, anchorHtml) {
  const file = path.join(ROOT, relFile);
  if (!fs.existsSync(file)) return;
  let html = fs.readFileSync(file, "utf8");
  const start = `<!--${elementId.toUpperCase()}_START-->`;
  const end = `<!--${elementId.toUpperCase()}_END-->`;
  const block = `${start}\n<script type="application/json" id="${elementId}">${JSON.stringify(payload)}</script>\n${end}`;
  if (html.includes(start) && html.includes(end)) {
    const re = new RegExp(`${start}[\\s\\S]*?${end}`);
    html = html.replace(re, block);
  } else if (anchorHtml && html.includes(anchorHtml)) {
    html = html.replace(anchorHtml, `${anchorHtml}\n${block}`);
  } else {
    return;
  }
  fs.writeFileSync(file, html, "utf8");
}
function writeJson(file, obj) {
  const out = path.join(ROOT, file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
}
function readJsonSafe(file) {
  try { return readJson(file); } catch (_) { return null; }
}
function seasonYear(date) {
  const d = new Date(date + "T12:00:00");
  return d.getMonth() >= 2 ? d.getFullYear() : d.getFullYear() - 1;
}
function pythag(rs, ra) {
  const num = Math.pow(rs, PYTH_EXP);
  return num / (num + Math.pow(ra, PYTH_EXP));
}
function log5Home(sHome, sAway) {
  const raw = (sHome * (1 - sAway)) / (sHome * (1 - sAway) + sAway * (1 - sHome));
  const odds = (raw / (1 - raw)) * HFA;
  return odds / (1 + odds);
}
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function round(n, dp = 4) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const m = Math.pow(10, dp);
  return Math.round(n * m) / m;
}
function clampEra(e) { return Math.min(ERA_CLAMP[1], Math.max(ERA_CLAMP[0], e)); }
function ipToNum(ip) {
  if (!ip || ip === "-.--") return 0;
  const [w, f] = String(ip).split(".");
  return Number(w || 0) + (Number(f || 0) / 3);
}
function amToDec(am) {
  am = Number(am);
  return am > 0 ? 1 + am / 100 : 1 + 100 / Math.abs(am);
}
function amToProb(am) {
  am = Number(am);
  return am > 0 ? 100 / (am + 100) : Math.abs(am) / (Math.abs(am) + 100);
}
function decToAm(dec) {
  return dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
}
function fmtPct(v, dp = 1) {
  return typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(dp)}%` : "-";
}
function fmtOdds(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "-";
  return v > 0 ? `+${v}` : String(v);
}
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/*
  HOME / ROAD SPLITS (2026-08-02)

  The standings call already returns splitRecords containing `home`, `away` and
  `lastTen`. Only lastTen was ever read; the other two were fetched and thrown
  away. So team strength was venue-blind: the same number was used whether a
  club was playing in its own park or finishing a long road trip.

  It showed up on 2026-08-02 — Atlanta 0.643 at home, Washington 0.571 on the
  road, and the model took Washington. Atlanta won. Siding purely with the
  better venue record went 11-3 across that slate against the model's 5-9.
  One night, n=14, nowhere near proof — but the mechanism is real and the data
  is free.

  DOUBLE-COUNTING IS THE TRAP HERE. log5Home() already multiplies by a flat
  HFA of 54/46, which is the league-wide home edge. Feeding raw home and road
  win rates in on top of that would apply the same advantage twice, and every
  home side would drift up for no reason.

  So this extracts only the TEAM-SPECIFIC part: how far a club's venue record
  sits from its own overall record, minus how far an average club's does. A
  team that is exactly league-average at home contributes zero and HFA alone
  handles it. Only clubs unusually strong or weak at a venue move the number.

  Shrunk by sample (n/(n+40)) because a half-season split is ~55 games, and
  capped so one hot home stretch cannot dominate a season of evidence.
*/
const VENUE_WEIGHT = 0.5;      // how much of the isolated venue edge to apply
const VENUE_SHRINK = 40;       // games of regression toward no venue effect
const VENUE_CAP = 0.06;        // hard ceiling on the win-rate shift, either way

function splitPct(rec) {
  if (!rec) return null;
  const n = (rec.wins || 0) + (rec.losses || 0);
  return n ? { pct: rec.wins / n, n } : null;
}

function buildStrength(standings) {
  const strength = {};
  const homeDeltas = [], awayDeltas = [];
  for (const rec of standings.records || []) {
    for (const t of rec.teamRecords || []) {
      const splits = ((t.records || {}).splitRecords) || [];
      const find = type => splits.find(r => r.type === type);
      const l10 = find("lastTen");
      const home = splitPct(find("home"));
      const away = splitPct(find("away"));
      const overallN = (t.wins || 0) + (t.losses || 0);
      const overall = overallN ? t.wins / overallN : null;
      if (overall !== null && home) homeDeltas.push(home.pct - overall);
      if (overall !== null && away) awayDeltas.push(away.pct - overall);
      strength[t.team.id] = {
        pyth: pythag(t.runsScored, t.runsAllowed),
        form: l10 ? l10.wins / Math.max(1, l10.wins + l10.losses) : null,
        l10: l10 ? `${l10.wins}-${l10.losses}` : "-",
        overall,
        home,
        away,
        home_record: home ? `${find("home").wins}-${find("home").losses}` : "-",
        away_record: away ? `${find("away").wins}-${find("away").losses}` : "-",
        wins: t.wins,
        losses: t.losses
      };
    }
  }
  // League-average venue effect, subtracted out so HFA is not applied twice.
  const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const leagueHomeDelta = mean(homeDeltas);
  const leagueAwayDelta = mean(awayDeltas);
  for (const id of Object.keys(strength)) {
    const s = strength[id];
    for (const [key, leagueDelta] of [["home", leagueHomeDelta], ["away", leagueAwayDelta]]) {
      const split = s[key];
      if (!split || s.overall === null) { s[`${key}_edge`] = 0; continue; }
      const raw = (split.pct - s.overall) - leagueDelta;
      const shrunk = raw * (split.n / (split.n + VENUE_SHRINK));
      s[`${key}_edge`] = Math.max(-VENUE_CAP, Math.min(VENUE_CAP, shrunk));
    }
  }
  strength.__league_venue = { home_delta: leagueHomeDelta, away_delta: leagueAwayDelta };
  return strength;
}
async function fetchPitchers(games) {
  const ids = [...new Set(games.flatMap(g => ["away", "home"].map(s => g.teams[s].probablePitcher && g.teams[s].probablePitcher.id).filter(Boolean)))];
  if (!ids.length) return {};
  try {
    return await PitcherCore.fetchPitchers(ids, DATE, fetchJson);
  } catch (e) {
    console.warn("Pitcher stats unavailable:", e.message);
    return {};
  }
}
function advStats(st) {
  if (!st) return null;
  const kbb = st.bf ? Number((((st.so - st.bb) / st.bf)).toFixed(4)) : null;
  const gb = (st.go + st.ao) ? Number((st.go / (st.go + st.ao)).toFixed(4)) : null;
  const den = st.ab - st.so - st.hr + (st.sf || 0);
  const babip = den > 0 ? Number(((st.h - st.hr) / den).toFixed(4)) : null;
  const role = PitcherCore.classifyPitcherRole(st);
  return { w: st.w ?? null, l: st.l ?? null, kbb_pct: kbb, gb_pct: gb, babip, hr9: st.ip ? Number(((st.hr / st.ip) * 9).toFixed(2)) : null, ip_per_start: Number(role.starterIpPerStart?.toFixed(1)) || null, role: role.key, role_label: role.label, expected_innings: Number(role.expectedInnings.toFixed(1)), bullpen_innings: Number(role.bullpenInnings.toFixed(1)) };
}
function pitcherScore(st) {
  const scored = PitcherCore.scorePitcher(st || { name: "TBD", missing: true });
  return { score: scored.score, label: scored.grade, k9: scored.k9, bb9: scored.bb9, role: scored.role };
}
function starterEff(g, side, pitchers) {
  const p = g.teams[side].probablePitcher;
  if (!p) return LEAGUE_ERA;
  const st = pitchers[p.id];
  if (!st || !isFinite(st.era) || st.ip < MIN_IP) return LEAGUE_ERA;
  const role = PitcherCore.classifyPitcherRole(st);
  const workloadShare = role.expectedInnings / 5.5;
  return clampEra(LEAGUE_ERA + (st.era - LEAGUE_ERA) * workloadShare);
}

// The named starter a totals pitching-plan side was built for (its first
// non-bullpen segment), used to detect a stale capture.
function planStarterIdentity(sidePlan) {
  if (!sidePlan) return { id: null, name: null };
  const seg = Array.isArray(sidePlan.segments)
    ? sidePlan.segments.find(segment => segment.role !== "bullpen")
    : null;
  const id = seg && seg.pitcher_id != null ? String(seg.pitcher_id) : null;
  const name = (seg && seg.pitcher) || sidePlan.pitcher || null;
  return { id, name };
}

// Effective ERA for the moneyline's starter term. Prefer the totals capture's
// whole-game effective_era, but ONLY when the plan it was built from names the
// same starter the schedule now confirms. If the capture is stale relative to
// the confirmed probable (still "TBD" after the pitcher posted, or a different
// arm than the schedule now lists) the moneyline would price the wrong pitcher,
// so recompute from the fresh probable instead. The fallback is logged, never
// silent (same discipline as the bullpen-read fix, ERR-20260803-01).
function effectiveEraFor(g, side, pitchingPlan, pitchers) {
  const sidePlan = pitchingPlan && pitchingPlan[side];
  const cached = sidePlan && Number.isFinite(sidePlan.effective_era) ? sidePlan.effective_era : null;
  if (cached === null) return starterEff(g, side, pitchers);
  const probable = g.teams[side].probablePitcher || null;
  if (!probable) return cached; // nothing fresher to check the capture against
  const plan = planStarterIdentity(sidePlan);
  const matches = (plan.id && String(probable.id) === plan.id)
    || (plan.name && probable.fullName
        && plan.name.trim().toLowerCase() === probable.fullName.trim().toLowerCase());
  if (matches) return cached;
  console.warn(`Stale totals starter for ${g.teams[side].team.name}: plan has `
    + `"${plan.name || "TBD"}", schedule confirms "${probable.fullName}". `
    + `Recomputing the moneyline effective ERA from the confirmed probable.`);
  return starterEff(g, side, pitchers);
}
function buildOddsMap(events) {
  const map = {};
  for (const ev of events || []) {
    const rows = [];
    for (const bk of ev.bookmakers || []) {
      const m = (bk.markets || []).find(m => m.key === "h2h");
      if (!m) continue;
      const oA = m.outcomes.find(o => o.name === ev.away_team);
      const oH = m.outcomes.find(o => o.name === ev.home_team);
      if (oA && oH && Math.abs(Number(oA.price)) <= MAX_ABS_PRICE && Math.abs(Number(oH.price)) <= MAX_ABS_PRICE) {
        rows.push([oA.price, oH.price]);
      }
    }
    if (!rows.length) continue;
    const avgA = rows.reduce((s, r) => s + amToProb(r[0]), 0) / rows.length;
    const avgH = rows.reduce((s, r) => s + amToProb(r[1]), 0) / rows.length;
    const tot = avgA + avgH;
    map[ev.away_team + "@" + ev.home_team] = {
      pAway: avgA / tot,
      pHome: avgH / tot,
      bestAway: decToAm(Math.max(...rows.map(r => amToDec(r[0])))),
      bestHome: decToAm(Math.max(...rows.map(r => amToDec(r[1])))),
      books: rows.length
    };
  }
  return map;
}

function buildCapturedMoneylineMap(snapshot) {
  const map = {};
  for (const [key, g] of Object.entries((snapshot && snapshot.games) || {})) {
    if (!g || !Number.isFinite(g.pAway) || !Number.isFinite(g.pHome)) continue;
    map[key] = {
      pAway: g.pAway,
      pHome: g.pHome,
      bestAway: Number.isFinite(g.bestAway) ? g.bestAway : null,
      bestHome: Number.isFinite(g.bestHome) ? g.bestHome : null,
      books: Number(g.books) || 0,
      fallback_source: "captured_moneyline_odds"
    };
  }
  return map;
}
function buildPreviousOddsMap(rows) {
  const map = {};
  for (const row of rows || []) {
    const m = row && row.market;
    if (!row || !m || !Number.isFinite(m.away_no_vig) || !Number.isFinite(m.home_no_vig)) continue;
    map[`${row.away_team}@${row.home_team}`] = {
      pAway: m.away_no_vig,
      pHome: m.home_no_vig,
      bestAway: Number.isFinite(m.away_price) ? m.away_price : null,
      bestHome: Number.isFinite(m.home_price) ? m.home_price : null,
      books: Number(m.books) || 0,
      fallback_source: "member_brief_capture"
    };
  }
  return map;
}

function buildLockedMarketOddsMap(snapshot) {
  const map = {};
  for (const item of (snapshot && snapshot.items) || []) {
    if (!item || !item.game || !item.pick_team || !Number.isFinite(item.market_probability)) continue;
    const [away, home] = String(item.game).split(" @ ");
    if (!away || !home) continue;
    const pickedHome = item.pick_team === home;
    map[`${away}@${home}`] = {
      pAway: pickedHome ? 1 - item.market_probability : item.market_probability,
      pHome: pickedHome ? item.market_probability : 1 - item.market_probability,
      bestAway: pickedHome ? null : item.posted_price,
      bestHome: pickedHome ? item.posted_price : null,
      books: 1,
      fallback_source: "locked_market_snapshot"
    };
  }
  return map;
}

// wOBA linear weights -- must match scripts/generate-matchup-pages.js's
// fetchOffense30() exactly (kept in sync manually; both compute the same
// stat from the same MLB StatsAPI hitting split). Matchup pages display it;
// this file's shadow model (modelV3, v3.2-woba) uses it as a model input.
const WOBA_WEIGHTS = { bb: 0.69, hbp: 0.72, "1b": 0.89, "2b": 1.27, "3b": 1.62, hr: 2.10 };
function wobaOf(stat) {
  const s = stat || {};
  const n = key => { const v = Number(s[key]); return Number.isFinite(v) ? v : 0; };
  const singles = n("hits") - n("doubles") - n("triples") - n("homeRuns");
  const ubb = n("baseOnBalls") - n("intentionalWalks");
  const num = WOBA_WEIGHTS.bb * ubb + WOBA_WEIGHTS.hbp * n("hitByPitch") + WOBA_WEIGHTS["1b"] * singles
    + WOBA_WEIGHTS["2b"] * n("doubles") + WOBA_WEIGHTS["3b"] * n("triples") + WOBA_WEIGHTS.hr * n("homeRuns");
  const den = n("atBats") + n("baseOnBalls") - n("intentionalWalks") + n("sacFlies") + n("hitByPitch");
  return den > 0 ? num / den : null;
}
async function fetchOffenseForm(date) {
  // Team offense snapshots captured daily for relevance analysis (NOT in any score yet).
  // Same gate as the pitcher advanced stats: the learning pass must establish
  // predictive value before recent offensive form enters the model.
  // seasonWoba / window[].woba added 2026-08-08 for shadow's head-to-head
  // wOBA term (modelV3, DEC-20260808-04). Leo's own offense_form fields
  // (ops_15d, season_ops, delta_ops below) are unchanged and untouched.
  const out = { season: {}, seasonWoba: {}, window: {}, vsHand: {}, windowDays: 15 };
  try {
    const yr = Number(date.slice(0, 4));
    const end = new Date(date + "T12:00:00Z");
    const start = new Date(end.getTime() - 15 * 86400000);
    const fmtD = d => d.toISOString().slice(0, 10);
    const base = `https://statsapi.mlb.com/api/v1/teams/stats?sportId=1&group=hitting&season=${yr}`;
    const [sn, win, vl, vr] = await Promise.all([
      fetchJson(base + "&stats=season"),
      fetchJson(base + `&stats=byDateRange&startDate=${fmtD(start)}&endDate=${fmtD(end)}`),
      fetchJson(base + "&stats=statSplits&sitCodes=vl"),
      fetchJson(base + "&stats=statSplits&sitCodes=vr")
    ]);
    const splitsOf = d => (((d || {}).stats || [])[0] || {}).splits || [];
    for (const t of splitsOf(sn)) { out.season[t.team.id] = Number(t.stat.ops); out.seasonWoba[t.team.id] = wobaOf(t.stat); }
    for (const t of splitsOf(win)) out.window[t.team.id] = { ops: Number(t.stat.ops), rpg: t.stat.gamesPlayed ? Number(((t.stat.runs || 0) / t.stat.gamesPlayed).toFixed(2)) : null, g: Number(t.stat.gamesPlayed) || 0, woba: wobaOf(t.stat) };
    for (const t of splitsOf(vl)) (out.vsHand[t.team.id] = out.vsHand[t.team.id] || {}).vl = Number(t.stat.ops);
    for (const t of splitsOf(vr)) (out.vsHand[t.team.id] = out.vsHand[t.team.id] || {}).vr = Number(t.stat.ops);
  } catch (e) {
    console.warn("Offense form unavailable:", e.message);
  }
  return out;
}
function offenseFormFor(teamId, oppPitcher, offense) {
  if (!offense || !offense.season || offense.season[teamId] === undefined) return null;
  const w = offense.window[teamId] || {};
  const sOps = offense.season[teamId];
  const sWoba = offense.seasonWoba ? offense.seasonWoba[teamId] : null;
  const hand = oppPitcher && oppPitcher.hand ? oppPitcher.hand : null;
  const vs = hand ? ((offense.vsHand[teamId] || {})[hand === "L" ? "vl" : "vr"] ?? null) : null;
  return {
    ops_15d: Number.isFinite(w.ops) ? w.ops : null,
    season_ops: Number.isFinite(sOps) ? sOps : null,
    delta_ops: (Number.isFinite(w.ops) && Number.isFinite(sOps)) ? Number((w.ops - sOps).toFixed(3)) : null,
    // Added 2026-08-08 for shadow's head-to-head wOBA term (modelV3). Leo's
    // own probability and read text use delta_ops/ops_15d above, unchanged.
    woba_15d: Number.isFinite(w.woba) ? Number(w.woba.toFixed(4)) : null,
    woba_season: Number.isFinite(sWoba) ? Number(sWoba.toFixed(4)) : null,
    rpg_15d: w.rpg ?? null,
    opp_hand: hand,
    ops_vs_opp_hand: Number.isFinite(vs) ? vs : null
  };
}
/* ============ Shadow model v3 (A/B test — NEVER drives official picks) ============
   Candidate inputs:
   1. FIP-lite pitcher skill (K, BB, HR per IP).
   2. A capped head-to-head wOBA comparison (each team's trailing-15-day wOBA
      vs the opponent's — see V3_OFF_K_WOBA below. Replaced the OPS-delta term
      2026-08-08, DEC-20260808-04, Lynold's call: compare current offense
      directly against the opponent, not each team's deviation from its own
      season norm).
   3. Bullpen workload differential.
   The locked shadow probability is recorded beside the locked production
   probability. grade-calibration.js writes both with explicit model versions
   to data/calibration/shadow_model_log.csv. Never compare mixed model eras. */
/*
  2026-08-08: offense term rebuilt around wOBA, head-to-head.

  Previous term (V3_OFF_K = 0.8) compared each team's OWN 15-day OPS against
  its OWN season OPS -- a "hot or cold vs itself" signal -- each side capped
  at +/-0.10, coefficient 0.8, so max log-odds swing = 0.8 * 0.2 = 0.16.

  Lynold's correction: compare the two teams' CURRENT offense directly
  against each other, not against their own history. The new term takes each
  team's trailing-15-day wOBA (same formula/weights as the display-only wOBA
  already shown on matchup pages, generate-matchup-pages.js's fetchOffense30)
  and takes the home-minus-away gap.

  wOBA's team-to-team spread is much tighter than OPS's (full-season wOBA
  typically runs ~0.290-0.360 across all 30 teams, spread ~0.07; OPS spread
  is roughly 3x that). A 15-day window can widen it further on small samples,
  so the gap is capped at +/-0.060 -- already close to the full season's
  best-to-worst spread, rather than a fluke week.

  Coefficient chosen to reproduce the OLD term's max swing at the new cap, so
  this change isolates "OPS-delta vs wOBA head-to-head" as the only variable
  and doesn't also quietly make the term stronger or weaker:
    V3_OFF_K_WOBA = (0.8 * 0.2) / 0.060 = 2.6667
  Same +/-0.16 max log-odds shift (~+/-4% win probability) as before, at the
  cap. Revisit once shadow_model_log.csv has enough graded games under the
  new term to test it on its own evidence, same as every other constant here.
*/
const V3_OFF_WOBA_CAP = 0.060;     // max |home wOBA - away wOBA| gap applied, in wOBA points
const V3_OFF_K_WOBA = 2.6667;      // log-odds per point of wOBA gap (cap * coef matches old term's 0.16 max)
const V3_FIP_C = 3.15;     // FIP constant
// Shared by v2 and v3 — a starter only covers 5-6 of 9 innings; the bullpen
// covers the rest and was previously invisible to the probability itself
// (it only affected Lab Rating and the official-pick gate). Coefficient and
// cap were proven in v3 first (v3.1-bullpen) before being promoted here.
const BULLPEN_PROB_K = 0.3; // log-odds per 100 pts of bullpen-fatigue gap (gap capped ±50 → max ~±3.7%)
function bullpenProbAdjustment(bpAwayScore, bpHomeScore) {
  const gap = (Number.isFinite(bpAwayScore) && Number.isFinite(bpHomeScore))
    ? Math.max(-50, Math.min(50, bpAwayScore - bpHomeScore))
    : 0;
  return BULLPEN_PROB_K * (gap / 100);
}
function fipLite(st) {
  if (!st || !st.ip || st.ip < 10) return LEAGUE_ERA;
  const fip = (13 * (st.hr || 0) + 3 * (st.bb || 0) - 2 * (st.so || 0)) / st.ip + V3_FIP_C;
  const wt = Math.min(st.ip, 80) / 80; // regress small samples toward league
  return clampEra(fip * wt + LEAGUE_ERA * (1 - wt));
}
function modelV3(pBase, awayStats, homeStats, offAway, offHome, bpAway, bpHome) {
  const spA = fipLite(awayStats), spH = fipLite(homeStats);
  let odds = (pBase / (1 - pBase)) * Math.exp(ERA_K * (spA - spH));
  // Head-to-head current offense: each team's trailing-15-day wOBA compared
  // directly to the opponent's, not to its own season norm. See the
  // 2026-08-08 comment above V3_OFF_K_WOBA for the full reasoning.
  const wobaA = offAway && Number.isFinite(offAway.woba_15d) ? offAway.woba_15d : null;
  const wobaH = offHome && Number.isFinite(offHome.woba_15d) ? offHome.woba_15d : null;
  const wobaGapRaw = (wobaA !== null && wobaH !== null) ? (wobaH - wobaA) : 0;
  const wobaGap = Math.max(-V3_OFF_WOBA_CAP, Math.min(V3_OFF_WOBA_CAP, wobaGapRaw));
  const offAdj = V3_OFF_K_WOBA * wobaGap;
  odds *= Math.exp(offAdj);
  // v3.1: bullpen fatigue differential — home gains when the AWAY pen is the tired one
  const bpAdj = bullpenProbAdjustment(bpAway, bpHome);
  odds *= Math.exp(bpAdj);
  const pHome = odds / (1 + odds);
  // version bumped v3.1-bullpen -> v3.2-woba: the offense term's MEANING
  // changed (OPS-delta-from-self vs wOBA-head-to-head), not just its value,
  // so mixed-era comparisons in shadow_model_log.csv must be able to tell
  // rows apart. See the "Never compare mixed model eras" note above.
  return { p_home: Number(pHome.toFixed(4)), fip_away: Number(spA.toFixed(2)), fip_home: Number(spH.toFixed(2)), off_adj: Number(offAdj.toFixed(4)), woba_away: wobaA, woba_home: wobaH, bp_adj: Number(bpAdj.toFixed(4)), version: "v3.2-woba" };
}

// Convert the same expected runs shown publicly into an additional moneyline
// signal. Regulation ties are split evenly as a neutral extra-innings
// approximation before this signal is blended with the established model.
function winProbabilityFromRuns(homeRuns, awayRuns) {
  if (!Number.isFinite(homeRuns) || !Number.isFinite(awayRuns) || homeRuns <= 0 || awayRuns <= 0) return null;
  const maxRuns = 30;
  const home = [Math.exp(-homeRuns)];
  const away = [Math.exp(-awayRuns)];
  for (let runs = 1; runs <= maxRuns; runs++) {
    home[runs] = home[runs - 1] * homeRuns / runs;
    away[runs] = away[runs - 1] * awayRuns / runs;
  }
  let homeWin = 0;
  let tie = 0;
  for (let h = 0; h <= maxRuns; h++) {
    for (let a = 0; a <= maxRuns; a++) {
      const probability = home[h] * away[a];
      if (h > a) homeWin += probability;
      else if (h === a) tie += probability;
    }
  }
  return homeWin + tie * 0.5;
}

function blendProbabilities(baseProbability, runProbability, runWeight) {
  const clampProbability = value => Math.max(0.001, Math.min(0.999, value));
  const logit = value => Math.log(clampProbability(value) / (1 - clampProbability(value)));
  const logistic = value => 1 / (1 + Math.exp(-value));
  const weight = Math.max(0, Math.min(1, runWeight));
  return logistic((1 - weight) * logit(baseProbability) + weight * logit(runProbability));
}

function modelGame(g, strength, pitchers, oddsMap, bullpen, offense, runProjections) {
  const aT = g.teams.away.team;
  const hT = g.teams.home.team;
  const sA = strength[aT.id];
  const sH = strength[hT.id];
  if (!sA || !sH) return null;

  const formA = sA.form === null ? sA.pyth : (1 - FORM_WEIGHT) * sA.pyth + FORM_WEIGHT * sA.form;
  const formH = sH.form === null ? sH.pyth : (1 - FORM_WEIGHT) * sH.pyth + FORM_WEIGHT * sH.form;
  // Venue edge: the away side is judged on how it travels, the home side on
  // how it holds its own park — each already stripped of the league-wide home
  // advantage that log5Home applies separately. See buildStrength().
  const venueA = VENUE_WEIGHT * (Number.isFinite(sA.away_edge) ? sA.away_edge : 0);
  const venueH = VENUE_WEIGHT * (Number.isFinite(sH.home_edge) ? sH.home_edge : 0);
  const clampStrength = v => Math.max(0.05, Math.min(0.95, v));
  const blendA = clampStrength(formA + venueA);
  const blendH = clampStrength(formH + venueH);
  const pBase = log5Home(blendH, blendA);
  const runProjection = runProjections && runProjections[String(g.gamePk)];
  const pitchingPlan = runProjection && runProjection.pitching_plan ? runProjection.pitching_plan : null;
  // Prefer the totals capture's effective ERA, but fall back to the confirmed
  // probable when that capture is stale (see effectiveEraFor). A TBD or
  // mismatched totals plan would otherwise freeze the moneyline on the wrong
  // pitcher even though the page already shows the real one.
  const spA = effectiveEraFor(g, "away", pitchingPlan, pitchers);
  const spH = effectiveEraFor(g, "home", pitchingPlan, pitchers);
  // Bullpen risk adjusts the probability itself, not just Lab Rating and the
  // official-pick gate — a starter only covers part of the game. Uses the
  // combined risk index (fatigue blended with efficiency), not raw fatigue,
  // so a tired-but-dominant pen doesn't get penalized like a tired-and-bad
  // one. Falls back to raw fatigue score for any bullpen record generated
  // before the efficiency split existed.
  const bpAwayScoreForModel = bullpen[aT.name] ? (bullpen[aT.name].risk_index ?? bullpen[aT.name].score) : null;
  const bpHomeScoreForModel = bullpen[hT.name] ? (bullpen[hT.name].risk_index ?? bullpen[hT.name].score) : null;
  const bullpenAdj = bullpenProbAdjustment(bpAwayScoreForModel, bpHomeScoreForModel);
  const preBullpenOdds = (pBase / (1 - pBase)) * Math.exp(ERA_K * (spA - spH));
  const preBullpenHomeProb = preBullpenOdds / (1 + preBullpenOdds);
  const modelOdds = preBullpenOdds * Math.exp(bullpenAdj);
  const legacyPHome = modelOdds / (1 + modelOdds);
  const bullpenGame = Boolean(runProjection && runProjection.bullpen_game);
  // Plausibility gate on the run projection before it is converted to a win
  // probability. winProbabilityFromRuns saturates violently — a 5.5-run
  // projected differential already returns 0.9997 — so one broken per-side
  // number does not degrade the blend gracefully, it dominates it. Reject the
  // input rather than trying to temper the output.
  const projHomeRuns = runProjection ? Number(runProjection.proj_home) : NaN;
  const projAwayRuns = runProjection ? Number(runProjection.proj_away) : NaN;
  const runProjPlausible = [projHomeRuns, projAwayRuns].every(
    v => Number.isFinite(v) && v >= RUN_PROJ_MIN && v <= RUN_PROJ_MAX);
  if (runProjection && !runProjPlausible) {
    console.warn(`Run projection out of bounds for ${aT.name} @ ${hT.name}: `
      + `home ${projHomeRuns}, away ${projAwayRuns} (allowed ${RUN_PROJ_MIN}-${RUN_PROJ_MAX}). `
      + `Treating the run model as unavailable for this game.`);
  }
  const runPHome = runProjPlausible
    ? winProbabilityFromRuns(projHomeRuns, projAwayRuns)
    : null;
  // The established moneyline model is the probability. The run projection is
  // blended in on the log-odds scale at RUN_MODEL_WEIGHT, which is currently 0
  // — see the constant for the evidence. Keeping the call site intact (rather
  // than deleting the blend) means the weight is a single reversible number and
  // run_model_probability is still recorded for every game, which is what lets
  // the accountability ledger decide whether the run model earns weight back.
  let pHome = Number.isFinite(runPHome) && RUN_MODEL_WEIGHT > 0
    ? blendProbabilities(legacyPHome, runPHome, RUN_MODEL_WEIGHT)
    : legacyPHome;

  // Calibrate before anything downstream reads it, so the brief, the card, the
  // pages and the Lab Rating all speak in the same (honest) units.
  pHome = calibrateProb(pHome);

  const pickHome = pHome >= 0.5;
  const pickTeam = pickHome ? hT.name : aT.name;
  const oppTeam = pickHome ? aT.name : hT.name;
  const side = pickHome ? "home" : "away";
  const modelProb = pickHome ? pHome : 1 - pHome;

  const awayPitcher = g.teams.away.probablePitcher;
  const homePitcher = g.teams.home.probablePitcher;
  const awayStats = awayPitcher ? pitchers[awayPitcher.id] : null;
  const homeStats = homePitcher ? pitchers[homePitcher.id] : null;
  const awayScore = pitchingPlan && Number.isFinite(pitchingPlan.away && pitchingPlan.away.pitcher_score)
    ? { score: pitchingPlan.away.pitcher_score }
    : pitcherScore(awayStats);
  const homeScore = pitchingPlan && Number.isFinite(pitchingPlan.home && pitchingPlan.home.pitcher_score)
    ? { score: pitchingPlan.home.pitcher_score }
    : pitcherScore(homeStats);
  const pitchGap = Math.abs(homeScore.score - awayScore.score);
  const pitchEdgeTeam = pitchGap < 4 ? "No clear SP edge" : (homeScore.score > awayScore.score ? hT.name : aT.name);
  const pitcherConflict = pitchEdgeTeam !== "No clear SP edge" && pitchEdgeTeam !== pickTeam && pitchGap >= 8;

  const m = oddsMap ? oddsMap[aT.name + "@" + hT.name] : null;
  const marketProb = m ? (pickHome ? m.pHome : m.pAway) : null;
  const bestPrice = m ? (pickHome ? m.bestHome : m.bestAway) : null;
  const edge = marketProb !== null ? modelProb - marketProb : null;

  const pickBullpen = bullpen[pickTeam] || null;
  const oppBullpen = bullpen[oppTeam] || null;
  const bullpenRead = bullpenLabel(pickBullpen, oppBullpen);
  const majorBullpenCaution = bullpenRead === "Adds caution" && pickBullpen && (pickBullpen.risk_index ?? pickBullpen.score) >= 60;

  // Offense context is needed BY the rating, so it is computed before the call.
  const pickOffCtx = offenseFormFor(pickHome ? hT.id : aT.id, null, offense);
  const oppOffCtx = offenseFormFor(pickHome ? aT.id : hT.id, null, offense);

  // Lab Rating v2 grades LyDia's analysis only. No market value is passed in:
  // the sportsbook keeps veto power through the official-pick gate below, but
  // it can no longer strengthen or weaken the analysis itself.
  const lab = calcLabRating({
    modelProb,
    strengthProbPick: pickHome ? legacyPHome : 1 - legacyPHome,
    runProbPick: Number.isFinite(runPHome) ? (pickHome ? runPHome : 1 - runPHome) : null,
    pitchGap,
    pitchEdgeSupports: pitchEdgeTeam === pickTeam,
    pickPlan: pitchingPlan ? (pickHome ? pitchingPlan.home : pitchingPlan.away) : null,
    oppPlan: pitchingPlan ? (pickHome ? pitchingPlan.away : pitchingPlan.home) : null,
    pickBullpenRisk: pickBullpen ? (pickBullpen.risk_index ?? pickBullpen.score) : null,
    oppBullpenRisk: oppBullpen ? (oppBullpen.risk_index ?? oppBullpen.score) : null,
    pickDeltaOps: pickOffCtx && Number.isFinite(pickOffCtx.delta_ops) ? pickOffCtx.delta_ops : null,
    oppDeltaOps: oppOffCtx && Number.isFinite(oppOffCtx.delta_ops) ? oppOffCtx.delta_ops : null,
    hasTeamStrength: Boolean(sA && sH),
    hasBothPitchers: Boolean(awayStats && homeStats),
    hasRunProjection: Boolean(runProjection)
  });
  const priceTooShort = Number.isFinite(bestPrice) && !priceAllowsOfficial(bestPrice);
  // 2026-08-06, Lynold: market edge (VALUE_EDGE) is no longer a requirement
  // for an official moneyline pick. His case: LyDia at 68% win probability
  // against a 66% no-vig market is only a 2-point edge -- below the old 3-point
  // floor -- but he still wants that published as official. `edge !== null` is
  // kept (not dropped) because it's the only thing here guaranteeing real
  // market pricing exists for this side at all; it no longer checks the SIZE
  // of the edge, just that one was computable. VALUE_EDGE itself is untouched
  // and still gates the separate value_watch tier below -- that tier exists
  // specifically to flag real edge that didn't reach official on prob/lab, so
  // removing edge from the official gate doesn't collapse the two tiers.
  if (priceTooShort && edge !== null
    && modelProb >= OFFICIAL_MODEL_PROB && lab.score >= OFFICIAL_LAB_SCORE && !pitcherConflict) {
    console.log(`Price gate: ${pickTeam} cleared every official moneyline gate but the best price is ${bestPrice} `
      + `(floor ${MIN_OFFICIAL_PRICE}). Not published as official.`);
  }
  const officialEligible = edge !== null
    && modelProb >= OFFICIAL_MODEL_PROB
    && lab.score >= OFFICIAL_LAB_SCORE
    && !pitcherConflict
    && !priceTooShort;

  let status = "pass";
  if (officialEligible) status = "official_pick";
  else if (edge !== null && edge >= VALUE_EDGE && lab.score >= VALUE_WATCH_LAB_SCORE) status = "value_watch";
  else if (lab.score >= WATCHLIST_LAB_SCORE) status = "watchlist";

  const passReason = status === "pass"
    ? passReasonFor({ edge, modelProb, pitchEdgeTeam, pickTeam, pitcherConflict, labScore: lab.score, market: m, majorBullpenCaution })
    : null;

  const preBullpenModelProb = Number.isFinite(runPHome)
    ? modelProb
    : (pickHome ? preBullpenHomeProb : 1 - preBullpenHomeProb);
  const read = buildRead({
    status, pickTeam, oppTeam, modelProb, marketProb, edge, lab, pitchEdgeTeam, pitchGap,
    pitcherConflict, bullpenRead, pickBullpen, oppBullpen, bestPrice, majorBullpenCaution, passReason,
    pitchingPlan, bullpenGame,
    pickOff: pickOffCtx, oppOff: oppOffCtx, preBullpenModelProb
  });
  const planIdentity = (plan, scheduled) => {
    const named = ((plan && plan.segments) || []).filter(segment => segment.role !== "bullpen" && segment.pitcher);
    if (!plan || !plan.reported || !named.length) {
      return {
        name: scheduled ? scheduled.fullName : "TBD",
        id: scheduled ? scheduled.id : null,
        overridden: false
      };
    }
    return {
      name: named[0].pitcher,
      id: named[0].pitcher_id || null,
      overridden: true
    };
  };
  const awayIdentity = planIdentity(pitchingPlan && pitchingPlan.away, awayPitcher);
  const homeIdentity = planIdentity(pitchingPlan && pitchingPlan.home, homePitcher);

  return {
    game_pk: g.gamePk,
    game_id: `${slug(aT.name)}-${slug(hT.name)}-${DATE}`,
    game: `${aT.name} @ ${hT.name}`,
    time: new Date(g.gameDate).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }),
    game_time_iso: g.gameDate,
    away_team: aT.name,
    home_team: hT.name,
    away_record: `${sA.wins}-${sA.losses}`,
    home_record: `${sH.wins}-${sH.losses}`,
    away_l10: sA.l10,
    home_l10: sH.l10,
    pick_team: pickTeam,
    side,
    model_probability: round(modelProb, 4),
    // Both branches are "leo" -- whether a run projection was computable for
    // this game (RUN_MODEL_WEIGHT is currently 0 either way, see above) is still
    // visible from projected_runs being null or not on this same row.
    model_source: MONEYLINE_MODEL_VERSION,
    projected_runs: Number.isFinite(runPHome) ? {
      away: Number(runProjection.proj_away),
      home: Number(runProjection.proj_home),
      total: Number(runProjection.projection)
    } : null,
    pitching_plan: pitchingPlan,
    bullpen_game: bullpenGame,
    legacy_strength_probability: round(pickHome ? legacyPHome : 1 - legacyPHome, 4),
    // Venue split, recorded per game so grade-confidence.js can measure whether
    // it earns its weight instead of it being assumed. away_record is how the
    // road team travels, home_record how the host holds its park; the _edge
    // values are those records with the league-wide home advantage removed.
    venue_split: {
      away_record: sA.away_record || "-",
      home_record: sH.home_record || "-",
      away_edge: round(Number.isFinite(sA.away_edge) ? sA.away_edge : 0, 4),
      home_edge: round(Number.isFinite(sH.home_edge) ? sH.home_edge : 0, 4),
      applied_away: round(venueA, 4),
      applied_home: round(venueH, 4),
      weight: VENUE_WEIGHT
    },
    run_model_probability: Number.isFinite(runPHome)
      ? round(pickHome ? runPHome : 1 - runPHome, 4)
      : null,
    run_model_weight: Number.isFinite(runPHome) ? RUN_MODEL_WEIGHT : 0,
    // Same team's win probability WITHOUT the bullpen adjustment, so the
    // effect is auditable and can be disclosed as a plain percentage-point
    // shift instead of a raw log-odds number.
    model_probability_pre_bullpen: Number.isFinite(runPHome)
      ? null
      : round(pickHome ? preBullpenHomeProb : 1 - preBullpenHomeProb, 4),
    edge: edge === null ? null : round(edge, 4),
    status,
    value_tag: status === "official_pick" ? "OFFICIAL PICK" : status === "value_watch" ? "VALUE WATCH" : status === "watchlist" ? "WATCHLIST" : "PASS",
    lab_score: lab.score,
    lab_score_breakdown: lab,
    // 2026-08-06: edge is no longer part of the official gate (Lynold's call).
    // Removed minimum_edge/edge_passed from here rather than leaving them in
    // as dead/misleading fields -- the top-level `edge` field a few lines up
    // still shows the actual number for context, it's just not a pass/fail gate.
    official_pick_gate: {
      minimum_model_probability: OFFICIAL_MODEL_PROB,
      minimum_lab_score: OFFICIAL_LAB_SCORE,
      model_probability_passed: modelProb >= OFFICIAL_MODEL_PROB,
      lab_score_passed: lab.score >= OFFICIAL_LAB_SCORE
    },
    pass_reason: passReason,
    read,
    pitcher_edge: {
      team: pitchEdgeTeam,
      gap: pitchGap,
      conflict: pitcherConflict,
      away_score: awayScore.score,
      home_score: homeScore.score,
      away_pitcher: awayIdentity.name,
      home_pitcher: homeIdentity.name,
      away_pitcher_id: awayIdentity.id,
      home_pitcher_id: homeIdentity.id,
      away_era: !awayIdentity.overridden && awayStats && Number.isFinite(awayStats.era) ? awayStats.era : null,
      home_era: !homeIdentity.overridden && homeStats && Number.isFinite(homeStats.era) ? homeStats.era : null,
      away_whip: !awayIdentity.overridden && awayStats && Number.isFinite(awayStats.whip) ? awayStats.whip : null,
      home_whip: !homeIdentity.overridden && homeStats && Number.isFinite(homeStats.whip) ? homeStats.whip : null,
      // Advanced stats captured daily for relevance analysis (NOT in any score yet).
      // Once enough graded games accumulate, the learning pass can test whether
      // K-BB%, GB%, or BABIP separation predicts outcomes better than ERA/WHIP.
      away_advanced: awayIdentity.overridden ? null : advStats(awayStats),
      home_advanced: homeIdentity.overridden ? null : advStats(homeStats)
    },
    offense_form: {
      away: offenseFormFor(aT.id, homePitcher ? pitchers[homePitcher.id] : null, offense),
      home: offenseFormFor(hT.id, awayPitcher ? pitchers[awayPitcher.id] : null, offense),
      window_days: 15
    },
    model_v3: (() => {
      const oa = offenseFormFor(aT.id, null, offense), oh = offenseFormFor(hT.id, null, offense);
      const bpA = bullpen[aT.name] ? (bullpen[aT.name].risk_index ?? bullpen[aT.name].score) : null;
      const bpH = bullpen[hT.name] ? (bullpen[hT.name].risk_index ?? bullpen[hT.name].score) : null;
      const v3 = modelV3(pBase, awayStats, homeStats, oa, oh, bpA, bpH);
      return { ...v3, p_home_v2: Number(pHome.toFixed(4)), note: "shadow A/B — does not drive picks" };
    })(),
    bullpen: {
      pick_team: pickBullpen,
      opponent: oppBullpen,
      label: bullpenRead,
      major_caution: majorBullpenCaution,
      absolute_risk: absoluteBullpenRisk(pickBullpen, oppBullpen)
    },
    market: {
      no_vig_probability: marketProb === null ? null : round(marketProb, 4),
      best_price: bestPrice,
      // Both sides, so the scoreboard shows a price for each team, not only the
      // picked side. Computed already in the odds map; previously discarded.
      away_price: m ? m.bestAway : null,
      home_price: m ? m.bestHome : null,
      away_no_vig: m ? round(m.pAway, 4) : null,
      home_no_vig: m ? round(m.pHome, 4) : null,
      books: m ? m.books : 0
    }
  };
}


// Both label functions read the combined risk index (fatigue blended with
// efficiency), not raw fatigue — a tired-but-dominant pen shouldn't read as
// "Adds caution" just because it threw a lot of innings.
function bullpenLabel(pick, opp) {
  if (!pick || !opp) return "Unknown";
  const pickRisk = pick.risk_index ?? pick.score;
  const oppRisk = opp.risk_index ?? opp.score;
  if (pickRisk >= 78 && oppRisk >= 78) return "Both bullpens stressed";
  if (pickRisk + 15 < oppRisk) return "Supports LyDia side";
  if (pickRisk > oppRisk + 15) return "Adds caution";
  if (pickRisk >= 60 || oppRisk >= 60) return "Elevated volatility";
  return "Neutral";
}
function absoluteBullpenRisk(pick, opp) {
  if (!pick || !opp) return "Unknown";
  const pickRisk = pick.risk_index ?? pick.score;
  const oppRisk = opp.risk_index ?? opp.score;
  if (pickRisk >= 78 && oppRisk >= 78) return "Both high";
  if (pickRisk >= 78) return "Pick side high";
  if (oppRisk >= 78) return "Opponent high";
  if (pickRisk >= 60 || oppRisk >= 60) return "Elevated";
  return "Normal";
}
function passReasonFor({ edge, modelProb, pitchEdgeTeam, pickTeam, pitcherConflict, labScore, market, majorBullpenCaution }) {
  if (!market) return "No market data available, so this stays research-only until pricing is checked.";
  // 2026-08-06: edge no longer gates the official pick, so the reasons below
  // are reordered -- prob/lab/pitcher-conflict are checked first because
  // those are what can actually keep a game out of official now. Edge is
  // checked last and the copy was reworded: edge still gates the separate
  // value_watch tier, so a low/negative edge here means "not even a value
  // watch," not "not an official pick" (that would now be inaccurate).
  if (modelProb < OFFICIAL_MODEL_PROB && labScore >= VALUE_WATCH_LAB_SCORE) return `Setup quality is strong, but LyDia's win probability is only ${fmtPct(modelProb)}. That is not high enough for an official pick.`;
  if (pitcherConflict) return "Starting pitcher edge conflicts with the model side.";
  if (labScore < OFFICIAL_LAB_SCORE) return "The combined Lab Rating did not clear the official threshold.";
  if (pitchEdgeTeam !== "No clear SP edge" && pitchEdgeTeam !== pickTeam) return "Starting pitcher edge does not support the model side.";
  if (edge !== null && edge < 0) return "Market is higher than LyDia's model probability, and the edge was too small for a value-watch grade.";
  if (edge !== null && edge < VALUE_EDGE) return "Model edge was too small for a value-watch grade.";
  return "No clear setup.";
}

function buildRead(ctx) {
  const valueLine = ctx.marketProb === null
    ? "Market pricing was unavailable."
    : `LyDia projects ${fmtPct(ctx.modelProb)} against a ${fmtPct(ctx.marketProb)} no-vig market number, a ${fmtPct(ctx.edge)} model edge at ${fmtOdds(ctx.bestPrice)}.`;
  const pitcherLine = ctx.pitchEdgeTeam === "No clear SP edge"
    ? "The starting pitcher matchup does not create a meaningful separation."
    : `${ctx.pitchEdgeTeam} owns the starting pitcher edge by ${ctx.pitchGap} points.`;
  const bullpenLine = `Bullpen read: ${ctx.bullpenRead}.`;
  // Fatigue (workload) and efficiency (how well they've actually pitched)
  // are separate reads now — surface both so "Adds caution" (risk-based)
  // doesn't read as a pure workload verdict when efficiency pulled it there,
  // or vice versa.
  const efficiencyLine = (() => {
    const pb = ctx.pickBullpen;
    if (!pb || pb.efficiency_score === null || pb.efficiency_score === undefined) return "";
    return ` ${ctx.pickTeam}'s pen efficiency: ${pb.efficiency_label} (${(pb.efficiency_score / 10).toFixed(1)}/10).`;
  })();
  // Disclose when bullpen fatigue meaningfully moved the win probability
  // itself (not just Lab Rating) — only surfaced when the shift is real,
  // so most games don't carry a near-zero footnote.
  const bullpenProbLine = (() => {
    if (!Number.isFinite(ctx.preBullpenModelProb)) return "";
    const shift = (ctx.modelProb - ctx.preBullpenModelProb) * 100;
    if (Math.abs(shift) < 1) return "";
    const dir = shift > 0 ? "up" : "down";
    return ` Bullpen fatigue moved this probability ${dir} ${Math.abs(shift).toFixed(1)} points from ${fmtPct(ctx.preBullpenModelProb)} (starting pitcher and team strength only) to ${fmtPct(ctx.modelProb)}.`;
  })();
  // Lineup form context. Honest framing: season offense is already inside team
  // strength (runs scored drive the Pythagorean base); this line covers the
  // RECENT form the current model does not use (v3 is testing it).
  const offenseLine = (() => {
    const p = ctx.pickOff, o = ctx.oppOff;
    if (!p || !o || !Number.isFinite(p.delta_ops) || !Number.isFinite(o.delta_ops)) return "";
    const w = (t, d) => `${t} ${d >= 0.05 ? "is swinging a hot bat" : d >= 0.02 ? "is a touch above its season form" : d <= -0.05 ? "is in a cold stretch" : d <= -0.02 ? "is a touch below its season form" : "is near its season form"} (${d >= 0 ? "+" : ""}${d.toFixed(3)} OPS)`;
    const diff = p.delta_ops - o.delta_ops;
    let tail = "";
    if (diff <= -0.06) tail = " Recent form leans against this side and is included in the unified run projection.";
    else if (diff >= 0.06) tail = " Recent form supports this side and is included in the unified run projection.";
    return ` Lineup check: ${w(ctx.pickTeam, p.delta_ops)}; ${w(ctx.oppTeam || "the opponent", o.delta_ops)}.${tail}`;
  })();
  const labLine = labRatingSentence(ctx.lab);
  const pitchingPlanLine = (() => {
    if (!ctx.pitchingPlan) return "";
    const plans = [ctx.pitchingPlan.away, ctx.pitchingPlan.home].filter(Boolean);
    const flagged = plans.filter(plan => plan.bullpen_game || plan.role === "limited_starter");
    if (!flagged.length) return "";
    const detail = flagged.map(plan => {
      if (Array.isArray(plan.segments) && plan.segments.length) {
        return plan.segments.map(segment =>
          `${segment.role === "bullpen" ? "remaining bullpen" : segment.pitcher} ${Number(segment.expected_innings).toFixed(1)} IP`
        ).join(" + ");
      }
      return `${plan.pitcher}: ${plan.label}, ${Number(plan.expected_innings).toFixed(1)} expected innings`;
    }).join("; ");
    return ` Pitching plan: ${detail}. Bullpen fatigue, efficiency, and combined risk grade only the innings assigned to the bullpen.`;
  })();

  if (ctx.status === "official_pick") {
    return `${ctx.pickTeam} is an official moneyline pick because it clears both gates: ${fmtPct(ctx.modelProb)} model win probability and ${(ctx.lab.score/10).toFixed(1)}/10 Lab Rating. ${valueLine} ${pitcherLine} ${bullpenLine}${efficiencyLine}${bullpenProbLine}${pitchingPlanLine}${offenseLine}`;
  }
  if (ctx.status === "value_watch") {
    // Value watch already cleared the edge and Lab Rating floor for this tier —
    // name the SPECIFIC gate(s) that kept it from official, never a generic line.
    const failedGates = [];
    if (ctx.modelProb < OFFICIAL_MODEL_PROB) failedGates.push(`model win probability is ${fmtPct(ctx.modelProb)}, below the ${fmtPct(OFFICIAL_MODEL_PROB)} official-pick gate`);
    if (ctx.lab.score < OFFICIAL_LAB_SCORE) failedGates.push(`Lab Rating is ${(ctx.lab.score/10).toFixed(1)}/10, below the ${(OFFICIAL_LAB_SCORE/10).toFixed(1)}/10 official-pick gate`);
    if (ctx.pitcherConflict) failedGates.push("the starting pitcher edge conflicts with the model side");
    const gateLine = failedGates.length
      ? `It stayed a value watch because ${failedGates.join("; and ")}.`
      : "It stayed a value watch under the stricter official-pick review.";
    return `${ctx.pickTeam} is a value watch, not an official pick. ${valueLine} ${labLine}${efficiencyLine}${bullpenProbLine} ${gateLine}${offenseLine}`;
  }
  if (ctx.status === "watchlist") {
    return `${ctx.pickTeam} remains on the watchlist. ${labLine} ${valueLine} ${pitcherLine} ${bullpenLine}${efficiencyLine}${bullpenProbLine}${pitchingPlanLine}${offenseLine}`;
  }
  return ctx.passReason || "No clear setup.";
}
/*
  The brief summary must describe the whole official card.

  It previously counted only rows with a moneyline status, so a slate with no
  qualifying moneyline reported "No official picks cleared the stricter rules"
  while the very same run published an official total and several strikeout
  props. Counting is now done from the built card, which means the summary and
  the published picks can never disagree — they are the same object.
*/
function officialMarketCounts(card) {
  const groups = card && Array.isArray(card.picks) ? card.picks : [];
  const moneyline = groups.filter(g => g.moneyline && g.moneyline.pick).length;
  const totals = groups.filter(g => g.total && g.total.pick).length;
  const strikeouts = groups.reduce((n, g) => n + ((g.strikeouts || []).length), 0);
  return { moneyline, totals, strikeouts, total: moneyline + totals + strikeouts };
}

function summarize(rows, hasOdds, card) {
  const counts = officialMarketCounts(card);
  const valueWatch = rows.filter(r => r.status === "value_watch").length;
  const watch = rows.filter(r => r.status === "watchlist").length;
  const high = rows.filter(r => r.lab_score >= VALUE_WATCH_LAB_SCORE).length;
  if (!hasOdds) return "Brief generated without live market pricing. Treat the card as research-only until pricing is checked.";

  if (counts.total) {
    const parts = [];
    if (counts.moneyline) parts.push(`${counts.moneyline} moneyline`);
    if (counts.totals) parts.push(`${counts.totals} game total${counts.totals === 1 ? "" : "s"}`);
    if (counts.strikeouts) parts.push(`${counts.strikeouts} pitcher strikeout prop${counts.strikeouts === 1 ? "" : "s"}`);
    const breakdown = parts.length === 1
      ? parts[0]
      : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
    return `${counts.total} official pick${counts.total === 1 ? "" : "s"} cleared their market gates: ${breakdown}. `
      + `${valueWatch} value-watch setup${valueWatch === 1 ? "" : "s"} had good price math but did not clear official-pick rules.`;
  }

  return `No official picks cleared the stricter rules in any market — moneyline, game totals or pitcher strikeouts. `
    + `${valueWatch} value-watch setup${valueWatch === 1 ? "" : "s"} and ${watch} watchlist game${watch === 1 ? "" : "s"} remain research-only. `
    + `${high} game${high === 1 ? "" : "s"} reached a Lab Rating of ${(VALUE_WATCH_LAB_SCORE/10).toFixed(1)}+/10 but did not clear every official gate.`;
}
function riskNote(r) {
  const notes = [];
  if (r.model_probability < OFFICIAL_MODEL_PROB) notes.push(`model win probability is ${fmtPct(r.model_probability)}, below the official-pick gate`);
  if (r.pitcher_edge.conflict) notes.push("starting pitcher edge conflicts with the model side");
  if (r.bullpen.major_caution) notes.push("bullpen fatigue adds late-game caution");
  if (r.bullpen.label === "Both bullpens stressed") notes.push("both bullpens show elevated recent workload");
  else if (r.bullpen.label === "Elevated volatility") notes.push("bullpen workload adds late-game volatility");
  if (r.market.books && r.market.books < 3) notes.push("limited sportsbook sample");
  if (!notes.length) return "No model can see every live lineup, injury, or late bullpen availability update. Recheck official news before first pitch.";
  return `Primary caution: ${notes.join("; ")}. Recheck official news before first pitch.`;
}
function buildPicksFile(rows, generatedAt) {
  const totals = readJsonSafe(`data/totals/${DATE}.json`) || { games: {} };
  const kprops = readJsonSafe(`data/k-props/${DATE}.json`) || { pitchers: {} };
  const byPk = new Map(rows.map(r => [String(r.game_pk), r]));
  const groups = new Map();
  const ensureGroup = r => {
    const key = String(r.game_pk);
    if (!groups.has(key)) groups.set(key, {
      gamePk: r.game_pk,
      away: r.away_team,
      home: r.home_team,
      time: r.game_time_iso,
      labScore: r.lab_score,
      labScoreBreakdown: r.lab_score_breakdown,
      status: "official_pick",
      modelVersion: "multi-market-v1",
      pitcherEdge: r.pitcher_edge,
      bullpen: r.bullpen,
      moneyline: null,
      total: null,
      strikeouts: []
    });
    return groups.get(key);
  };

  for (const r of rows.filter(x => x.status === "official_pick")) {
    ensureGroup(r).moneyline = {
      pick: r.pick_team,
      side: r.side,
      prob: r.model_probability,
      mktProb: r.market.no_vig_probability,
      bestAm: r.market.best_price,
      valueTag: r.value_tag,
      isPass: false,
      tier: r.lab_score >= 90 ? "Elite Setup" : "Qualified Official",
      edgeScore: r.lab_score,
      rawEdge: r.edge,
      why: r.read,
      risk: riskNote(r)
    };
  }

  // The totals gate is read from the policy the totals engine itself wrote to
  // data/totals/DATE.json (update-totals.js's TOTALS_POLICY). That keeps one
  // gate in one place — this used to be a second, independently hardcoded
  // copy of the edge/lab thresholds, which is exactly the kind of drift
  // EXP-20260727-01 flagged elsewhere in the site. Older totals files written
  // before the policy object existed fall back to the constants above.
  const totalsPolicy = totals.policy || {};
  const totalsOfficialEdge = Number.isFinite(totalsPolicy.strong_min_edge) ? totalsPolicy.strong_min_edge : OFFICIAL_TOTAL_EDGE;
  const totalsOfficialLab = Number.isFinite(totalsPolicy.strong_min_setup) ? totalsPolicy.strong_min_setup : OFFICIAL_TOTAL_LAB;
  // OFF 2026-07-29 pending the totals setup-rating rebuild (EXP-20260727-01).
  // Defaults to true only for old files that predate this flag.
  const totalsOfficialEnabled = totalsPolicy.official_totals_enabled !== false;

  for (const [pk, t] of Object.entries(totals.games || {})) {
    if (!totalsOfficialEnabled) continue;
    const r = byPk.get(String(pk));
    if (!r || !Number.isFinite(t.projection) || !Number.isFinite(t.line) || !Number.isFinite(t.lab)) continue;
    const edge = Number((t.projection - t.line).toFixed(1));
    const pick = edge > 0 ? "Over" : "Under";
    const price = pick === "Over" ? t.over : t.under;
    if (Math.abs(edge) < totalsOfficialEdge || t.lab < totalsOfficialLab || !Number.isFinite(price)) continue;
    if (!priceAllowsOfficial(price)) {
      console.log(`Price gate: ${r.game} total ${pick} ${t.line} cleared its gates but the best price is ${price} (floor ${MIN_OFFICIAL_PRICE}). Not published as official.`);
      continue;
    }
    ensureGroup(r).total = {
      pick,
      line: t.line,
      bestAm: price,
      projection: t.projection,
      edge,
      labScore: t.lab,
      books: t.books || 0,
      modelVersion: totals.model_version || "totals-runs-v3-pitching-plan",
      valueTag: "OFFICIAL PICK"
    };
  }

  for (const rec of Object.values(kprops.pitchers || {})) {
    const r = byPk.get(String(rec.game_pk));
    if (!r || !Number.isFinite(rec.projection) || !Number.isFinite(rec.line)) continue;
    const edge = Number((rec.projection - rec.line).toFixed(2));
    const pick = edge > 0 ? "Over" : "Under";
    const price = pick === "Over" ? rec.over : rec.under;
    const roleEligible = rec.bullpen_game !== true && Number(rec.expected_innings) >= 4;
    // 2026-07-30, Lynold: a strikeout prop may not go official on a lineup
    // that isn't posted yet. update-k-props.js's whiff/arsenal-leverage term
    // is computed at half confidence against "projected regulars" when the
    // real lineup isn't up, and the projection can move materially once the
    // real nine posts — several official picks moved after publish for
    // exactly this reason on 2026-07-29. Require the real posted lineup.
    const lineupConfirmed = rec.opp_lineup_source === "posted";
    if (Math.abs(edge) < OFFICIAL_K_EDGE || !roleEligible || !lineupConfirmed || Number(rec.books) < OFFICIAL_K_MIN_BOOKS || !Number.isFinite(price)) continue;
    if (!priceAllowsOfficial(price)) {
      console.log(`Price gate: ${rec.name} K ${pick} ${rec.line} cleared its gates but the best price is ${price} (floor ${MIN_OFFICIAL_PRICE}). Not published as official.`);
      continue;
    }
    ensureGroup(r).strikeouts.push({
      pitcher: rec.name,
      pick,
      line: rec.line,
      bestAm: price,
      projection: rec.projection,
      edge,
      books: rec.books,
      expectedInnings: rec.expected_innings,
      pitcherRole: rec.pitcher_role,
      lineupSource: rec.opp_lineup_source,
      modelVersion: "pitcher-strikeouts-self-calibrated-v1",
      valueTag: "OFFICIAL PICK"
    });
  }

  return {
    date: DATE,
    generated: generatedAt,
    generated_at: generatedAt,
    locked_at: generatedAt,
    source_of_truth: "LyDia Daily Engine",
    current_official_model: "multi_market_v1",
    // 2026-08-06, Lynold: removed the "no pick added to a game that has
    // already started" sentence from this public-facing string, matching the
    // code change in writeOrReusePublishedPicks() below (his explicit
    // instruction, see DEC-20260806-04). A published pick is still never
    // changed or removed once on the card -- that part is unchanged.
    lock_policy: "Dated official pick files are append-only. A published pick is never changed or removed once it is on the card. New picks CAN be appended during the day as they qualify — pitcher strikeout picks require the real posted starting lineup, which for a late game does not exist until the early evening, so the card is expected to grow as the slate progresses.",
    note: `Official records are separated by market. Moneylines use the ${(OFFICIAL_MODEL_PROB * 100).toFixed(0)}% probability and ${(OFFICIAL_LAB_SCORE / 10).toFixed(1)}/10 Lab gates; game totals ${totalsOfficialEnabled ? `use a ${totalsOfficialEdge}-run edge and ${(totalsOfficialLab / 10).toFixed(1)}/10 totals setup` : "are currently paused while the totals setup rating is rebuilt (see EXP-20260727-01)"}; pitcher Ks use a 0.7-K edge, posted price, two-book coverage, a confirmed non-opener workload, and the real posted starting lineup (not a projected one). No market publishes an official pick at a price of ${MIN_OFFICIAL_PRICE} or shorter — a favourite that heavy has to win ${(100 * (185 / 285)).toFixed(1)}% of the time just to break even, and LyDia's graded record does not support paying that.`,
    rules: {
      // Applies to every market. -185 needs a 64.9% strike rate to break even
      // and the graded record does not support paying that.
      maximum_price_all_markets: MIN_OFFICIAL_PRICE,
      // 2026-08-06: minimum_edge dropped -- market edge is no longer an
      // official-pick requirement for moneylines (Lynold's call).
      moneyline: { minimum_probability: OFFICIAL_MODEL_PROB, minimum_lab: OFFICIAL_LAB_SCORE, maximum_price: MIN_OFFICIAL_PRICE },
      game_total: { minimum_edge_runs: totalsOfficialEdge, minimum_lab: totalsOfficialLab, official_enabled: totalsOfficialEnabled, maximum_price: MIN_OFFICIAL_PRICE },
      pitcher_strikeouts: { minimum_edge_k: OFFICIAL_K_EDGE, minimum_books: OFFICIAL_K_MIN_BOOKS, minimum_expected_innings: 4, requires_posted_lineup: true, maximum_price: MIN_OFFICIAL_PRICE },
      team_totals: { official_enabled: false, status: "research_only" }
    },
    picks: [...groups.values()]
  };
}
function writeOrReusePublishedPicks(candidate, scheduledGameCount) {
  const file = `data/published-picks/${DATE}.json`;
  if (fs.existsSync(path.join(ROOT, file))) {
    const existing = readJson(file);
    if (!existing || !Array.isArray(existing.picks)) throw new Error(`${file} exists but does not contain a picks array.`);

    // One-time schema promotion: preserve every locked moneyline exactly as
    // published, then add newly approved official market types only for games
    // that have not started. Once promoted, the multi-market file is immutable.
    if (existing.current_official_model !== "multi_market_v1" && candidate.current_official_model === "multi_market_v1") {
      const existingByPk = new Map(existing.picks.map(p => [String(p.gamePk), p]));
      for (const next of candidate.picks) {
        const firstPitch = Date.parse(next.time);
        if (!Number.isFinite(firstPitch) || Date.now() >= firstPitch) continue;
        const prior = existingByPk.get(String(next.gamePk));
        if (prior) {
          if (!prior.total && next.total) prior.total = next.total;
          if ((!Array.isArray(prior.strikeouts) || !prior.strikeouts.length) && next.strikeouts && next.strikeouts.length) prior.strikeouts = next.strikeouts;
        } else if (next.total || (next.strikeouts && next.strikeouts.length)) {
          existing.picks.push(next);
        }
      }
      existing.current_official_model = "multi_market_v1";
      existing.market_promotion_at = new Date().toISOString();
      existing.rules = candidate.rules;
      existing.note = candidate.note;
      writeJson(file, existing);
      console.log(`Promoted ${file} to the multi-market official schema without changing locked moneylines.`);
    }

    // LINE MOVES. A pick is a bet at a specific number. If the book no longer
    // offers that number before first pitch, the old entry is superseded rather
    // than rewritten: a K prop on 6.5 and one on 7.5 are different bets, and
    // grading the retired number would grade a bet no member could place.
    // Only pregame, only when the line actually changed, and the prior entry is
    // kept under `superseded` so the history stays auditable.
    {
      const candByPk = new Map(candidate.picks.map(p => [String(p.gamePk), p]));
      let moved = 0;
      for (const prior of existing.picks) {
        const firstPitch = Date.parse(prior.time);
        if (!Number.isFinite(firstPitch) || Date.now() >= firstPitch) continue;
        const next = candByPk.get(String(prior.gamePk));
        if (!next) continue;

        if (prior.total && next.total && Number(prior.total.line) !== Number(next.total.line)) {
          (prior.superseded = prior.superseded || []).push({ market: "game_total", was: prior.total, at: new Date().toISOString() });
          prior.total = next.total; moved++;
        }
        if (Array.isArray(prior.strikeouts) && Array.isArray(next.strikeouts)) {
          const nextByPitcher = new Map(next.strikeouts.map(k => [k.pitcher, k]));
          prior.strikeouts = prior.strikeouts.map(k => {
            const n2 = nextByPitcher.get(k.pitcher);
            if (!n2 || Number(n2.line) === Number(k.line)) return k;
            (prior.superseded = prior.superseded || []).push({ market: "pitcher_strikeouts", was: k, at: new Date().toISOString() });
            moved++;
            return n2;
          });
        }
      }
      if (moved) {
        writeJson(file, existing);
        console.log(`Superseded ${moved} pick(s) whose posted line moved before first pitch.`);
      }
    }

    // A zero-pick file is a provisional snapshot, not an immutable official-pick
    // lock. Morning runs can happen before the market and all model inputs are
    // ready. If a later run produces official picks, promote them. Once a pick
    // is promoted, only a manual, evidence-backed repair may change the dated
    // file.
    /*
      APPEND-ONLY MEANS APPEND. (2026-08-02)

      This block used to fire only when `existing.picks.length === 0`, so a card
      with any pick already on it was frozen against every later addition — even
      a different market, on a game hours from first pitch.

      That is not a corner case, it is most days. Official K props REQUIRE a
      posted starting lineup (line ~1126, added 2026-07-29), and lineups post
      roughly two hours before each game. A 10pm first pitch does not have a
      postable lineup until 7:30-8pm. Meanwhile moneylines qualify as soon as
      the market and model inputs are ready, often by late morning. Whichever
      market got there first locked the card and silently discarded the other
      for the rest of the day.

      It happened live on 2026-08-02: five K-prop groups locked the card at
      16:03, and the Milwaukee (84) and Detroit (82) official moneylines found
      at 18:10 — first pitches 19:15 and 20:05, both hours away — were dropped
      on the floor. Same family as ERR-20260801-01: an all-or-nothing check
      withholding valid pregame picks.

      Merging happens at the MARKET level, not the game level, because a game
      already on the card for strikeouts can legitimately qualify for a
      moneyline later.

      2026-08-06, Lynold: the "pick whose game has already started is never
      added" rule (previously enforced here via an `isPregame()` filter that
      dropped any candidate past its first-pitch time, logging it as
      `startedSkipped`) is REMOVED at his explicit instruction. He confirmed
      this directly, after being shown that it would let already-live/in-progress
      games (e.g. a game already showing a 3-0 score) be posted as an official
      "pregame" call — see DEC-20260806-04 and ERR-20260806-02 in the vault.
      What is UNCHANGED: a market already published on the card is still never
      overwritten or removed (the loop below still only fills markets a game
      doesn't already have) — only the started-game timing veto is gone.
    */
    if (candidate.picks.length > 0) {
      const byPk = new Map(existing.picks.map(p => [String(p.gamePk), p]));
      let addedGroups = 0, addedMarkets = 0;

      for (const cand of candidate.picks) {
        const prior = byPk.get(String(cand.gamePk));
        if (!prior) {
          existing.picks.push(cand);
          byPk.set(String(cand.gamePk), cand);
          addedGroups++;
          const markets = ["moneyline", "total"].filter(m => cand[m]).concat((cand.strikeouts || []).length ? ["strikeouts"] : []);
          console.log(`Appended official pick group for ${cand.away} @ ${cand.home} (${markets.join(", ") || "no market"}), first pitch ${cand.time}.`);
          continue;
        }
        // Game already on the card: fill only the markets it does not have.
        for (const m of ["moneyline", "total"]) {
          if (!prior[m] && cand[m]) {
            prior[m] = cand[m];
            addedMarkets++;
            console.log(`Appended ${m} to the existing ${cand.away} @ ${cand.home} group.`);
          }
        }
        if ((cand.strikeouts || []).length) {
          prior.strikeouts = prior.strikeouts || [];
          const have = new Set(prior.strikeouts.map(k => k.pitcher));
          for (const k of cand.strikeouts) {
            if (have.has(k.pitcher)) continue;   // never restate a published K pick
            prior.strikeouts.push(k);
            have.add(k.pitcher);
            addedMarkets++;
            console.log(`Appended strikeout pick for ${k.pitcher} to the existing ${cand.away} @ ${cand.home} group.`);
          }
        }
        // Any market already present is left exactly as published.
      }


      if (addedGroups || addedMarkets) {
        existing.picks.sort((a, b) => String(a.time).localeCompare(String(b.time)));
        existing.last_appended_at = new Date().toISOString();
        writeJson(file, existing);
        console.log(`Card grew for ${DATE}: ${addedGroups} new game group(s), ${addedMarkets} new market(s) on existing groups. Total groups: ${existing.picks.length}.`);
        if (DATE === etToday()) {
          writeJson("data/published-picks/today.json", existing);
          injectInlineData("results/index.html", "results-inline-picks",
            { date: existing.date, picks: existing.picks },
            '<div class="loading">Loading live pick results...</div>');
        }
        return existing;
      }
    }

    if (existing.picks.length === 0 && scheduledGameCount > 0) {
      console.log(`${file} remains a provisional zero-pick snapshot. It may be promoted before first pitch if a later run produces an official pick.`);
    } else {
      console.log(`Published picks already exist for ${DATE}; reusing ${file}.`);
    }
    if (DATE === etToday()) {
      writeJson("data/published-picks/today.json", existing);
      // Public-safe subset only (live-results.js only ever reads date/picks).
      injectInlineData("results/index.html", "results-inline-picks",
        { date: existing.date, picks: existing.picks },
        '<div class="loading">Loading live pick results...</div>');
    }
    return existing;
  }
  writeJson(file, candidate);
  if (DATE === etToday()) {
    writeJson("data/published-picks/today.json", candidate);
    injectInlineData("results/index.html", "results-inline-picks",
      { date: candidate.date, picks: candidate.picks },
      '<div class="loading">Loading live pick results...</div>');
  }
  return candidate;
}
function buildMarketFile(rows, generatedAt) {
  return {
    date: DATE,
    generated_at: generatedAt,
    snapshot_type: SNAPSHOT,
    items: rows.filter(r => r.status === "official_pick").map(r => ({
      pick_id: `${r.game_id}-ml`,
      date: DATE,
      game: r.game,
      game_time_iso: r.game_time_iso,
      market: "Moneyline",
      pick: `${r.pick_team} ML`,
      pick_team: r.pick_team,
      lab_score: r.lab_score,
      model_probability: r.model_probability,
      market_probability: r.market.no_vig_probability,
      raw_edge: r.edge,
      posted_price: SNAPSHOT === "posted" ? r.market.best_price : null,
      current_price: SNAPSHOT === "current" ? r.market.best_price : null,
      closing_price: SNAPSHOT === "closing" ? r.market.best_price : null,
      posted_at: SNAPSHOT === "posted" ? generatedAt : null,
      last_checked_at: generatedAt,
      movement: "pending",
      read: "Market tracking compares LyDia's posted number against later current and closing snapshots."
    }))
  };
}
function mergeAndWriteMarket(newMarket) {
  const file = `data/market/${DATE}.json`;
  let existing = null;
  try { existing = readJson(file); } catch (e) {}
  const merged = existing && Array.isArray(existing.items) ? existing : { date: DATE, generated_at: new Date().toISOString(), items: [] };
  const byId = new Map(merged.items.map(i => [i.pick_id, i]));
  for (const item of newMarket.items) {
    const prev = byId.get(item.pick_id) || {};
    const updated = { ...prev, ...item };
    if (SNAPSHOT !== "posted" && prev.posted_price !== undefined) updated.posted_price = prev.posted_price;
    if (SNAPSHOT !== "posted" && prev.posted_at) updated.posted_at = prev.posted_at;
    if (SNAPSHOT !== "current" && prev.current_price !== undefined) updated.current_price = prev.current_price;
    if (SNAPSHOT !== "closing" && prev.closing_price !== undefined) updated.closing_price = prev.closing_price;
    updated.movement = movement(updated.posted_price, updated.current_price || updated.closing_price);
    byId.set(item.pick_id, updated);
  }
  merged.items = [...byId.values()];
  merged.generated_at = new Date().toISOString();
  merged.snapshot_type = SNAPSHOT;
  writeJson(file, merged);
  if (DATE === etToday()) writeJson("data/market/today.json", merged);
}
function movement(posted, later) {
  if (typeof posted !== "number" || typeof later !== "number") return "pending";
  const postedDec = amToDec(posted);
  const laterDec = amToDec(later);
  if (Math.abs(postedDec - laterDec) < 0.015) return "stable";
  return laterDec < postedDec ? "toward_lydia" : "away_from_lydia";
}

module.exports = { summarize, officialMarketCounts };
