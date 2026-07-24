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
const PitcherCore = require("../js/pitcher-matchup-core.js");

const ROOT = path.join(__dirname, "..");
const HFA = 54 / 46;
const PYTH_EXP = 1.83;
const FORM_WEIGHT = 0.25;
const ERA_K = 0.20;
const LEAGUE_ERA = 4.20;
const MIN_IP = 20;
const ERA_CLAMP = [2.75, 6.00];

const VALUE_EDGE = 0.03;
const OFFICIAL_LAB_SCORE = 80;
const OFFICIAL_MODEL_PROB = 0.72;
const VALUE_WATCH_LAB_SCORE = 75;
const WATCHLIST_LAB_SCORE = 65;
const MAX_ABS_PRICE = 1000;
const RUN_MODEL_WEIGHT = 0.50;
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
  const oddsMap = {
    ...buildLockedMarketOddsMap(readJsonSafe(`data/market/${DATE}.json`)),
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
  const rows = allGames
    .map(game => freshByPk.get(String(game.gamePk)) || previousByPk.get(String(game.gamePk)) || null)
    .filter(Boolean)
    .sort((a, b) => (b.lab_score || 0) - (a.lab_score || 0));

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
    throw new Error(
      `Daily brief retention guard: refusing to overwrite ${DATE}; missing posted analysis for game(s) ` +
      missingGames.map(game => game.gamePk).join(",")
    );
  }

  if (!rows.length) {
    throw new Error(`Model guard: ${DATE} produced zero retained game rows. No official files were written.`);
  }

  const brief = {
    date: DATE,
    generated_at: generatedAt,
    snapshot_type: SNAPSHOT,
    source_of_truth: "LyDia Daily Engine",
    current_official_model: "multi_market_v1",
    model_version: "moneyline-v2-plus-runs-v1",
    official_pick_rules: {
      minimum_model_probability: OFFICIAL_MODEL_PROB,
      minimum_lab_score: OFFICIAL_LAB_SCORE,
      minimum_market_edge: VALUE_EDGE,
      note: "Lab Rating is setup quality. It is not win probability. Official picks require both strong win probability and strong setup quality."
    },
    summary: summarize(rows, Boolean(ODDS_API_KEY)),
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
    injectBriefInline({ date: brief.date, generated_at: brief.generated_at, summary: brief.summary, games: brief.games });
    // The old /picks/ hub is now a redirect to the unified /previews/ Picks
    // experience. Do not inject data into that retired duplicate page.
  }

  if (args["defer-publish"] === "true") {
    console.log(`Generated provisional LyDia source data for ${DATE}. Waiting for unified run projections before locking picks.`);
  } else {
    const candidatePublished = buildPicksFile(rows, generatedAt);
    const published = writeOrReusePublishedPicks(candidatePublished, allGames.length);
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

function buildStrength(standings) {
  const strength = {};
  for (const rec of standings.records || []) {
    for (const t of rec.teamRecords || []) {
      const l10 = (((t.records || {}).splitRecords) || []).find(r => r.type === "lastTen");
      strength[t.team.id] = {
        pyth: pythag(t.runsScored, t.runsAllowed),
        form: l10 ? l10.wins / Math.max(1, l10.wins + l10.losses) : null,
        l10: l10 ? `${l10.wins}-${l10.losses}` : "-",
        wins: t.wins,
        losses: t.losses
      };
    }
  }
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

async function fetchOffenseForm(date) {
  // Team offense snapshots captured daily for relevance analysis (NOT in any score yet).
  // Same gate as the pitcher advanced stats: the learning pass must establish
  // predictive value before recent offensive form enters the model.
  const out = { season: {}, window: {}, vsHand: {}, windowDays: 15 };
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
    for (const t of splitsOf(sn)) out.season[t.team.id] = Number(t.stat.ops);
    for (const t of splitsOf(win)) out.window[t.team.id] = { ops: Number(t.stat.ops), rpg: t.stat.gamesPlayed ? Number(((t.stat.runs || 0) / t.stat.gamesPlayed).toFixed(2)) : null, g: Number(t.stat.gamesPlayed) || 0 };
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
  const hand = oppPitcher && oppPitcher.hand ? oppPitcher.hand : null;
  const vs = hand ? ((offense.vsHand[teamId] || {})[hand === "L" ? "vl" : "vr"] ?? null) : null;
  return {
    ops_15d: Number.isFinite(w.ops) ? w.ops : null,
    season_ops: Number.isFinite(sOps) ? sOps : null,
    delta_ops: (Number.isFinite(w.ops) && Number.isFinite(sOps)) ? Number((w.ops - sOps).toFixed(3)) : null,
    rpg_15d: w.rpg ?? null,
    opp_hand: hand,
    ops_vs_opp_hand: Number.isFinite(vs) ? vs : null
  };
}
/* ============ Shadow model v3 (A/B test — NEVER drives official picks) ============
   Candidate inputs:
   1. FIP-lite pitcher skill (K, BB, HR per IP).
   2. A capped 15-day OPS-form adjustment.
   3. Bullpen workload differential.
   The locked shadow probability is recorded beside the locked production
   probability. grade-calibration.js writes both with explicit model versions
   to data/calibration/shadow_model_log.csv. Never compare mixed model eras. */
const V3_OFF_K = 0.8;      // log-odds per full point of OPS-delta difference (capped ±0.1 → max ~±2%)
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
  const dA = offAway && Number.isFinite(offAway.delta_ops) ? Math.max(-0.1, Math.min(0.1, offAway.delta_ops)) : 0;
  const dH = offHome && Number.isFinite(offHome.delta_ops) ? Math.max(-0.1, Math.min(0.1, offHome.delta_ops)) : 0;
  odds *= Math.exp(V3_OFF_K * (dH - dA));
  // v3.1: bullpen fatigue differential — home gains when the AWAY pen is the tired one
  const bpAdj = bullpenProbAdjustment(bpAway, bpHome);
  odds *= Math.exp(bpAdj);
  const pHome = odds / (1 + odds);
  return { p_home: Number(pHome.toFixed(4)), fip_away: Number(spA.toFixed(2)), fip_home: Number(spH.toFixed(2)), off_adj: Number((V3_OFF_K * (dH - dA)).toFixed(4)), bp_adj: Number(bpAdj.toFixed(4)), version: "v3.1-bullpen" };
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

  const blendA = sA.form === null ? sA.pyth : (1 - FORM_WEIGHT) * sA.pyth + FORM_WEIGHT * sA.form;
  const blendH = sH.form === null ? sH.pyth : (1 - FORM_WEIGHT) * sH.pyth + FORM_WEIGHT * sH.form;
  const pBase = log5Home(blendH, blendA);
  const spA = starterEff(g, "away", pitchers);
  const spH = starterEff(g, "home", pitchers);
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
  const runProjection = runProjections && runProjections[String(g.gamePk)];
  const pitchingPlan = runProjection && runProjection.pitching_plan ? runProjection.pitching_plan : null;
  const bullpenGame = Boolean(runProjection && runProjection.bullpen_game);
  const runPHome = runProjection
    ? winProbabilityFromRuns(Number(runProjection.proj_home), Number(runProjection.proj_away))
    : null;
  // Preserve the established moneyline model and enhance it with the run
  // projection as a second signal. Blend on the log-odds scale so neither
  // component is discarded and both remain auditable.
  const pHome = Number.isFinite(runPHome)
    ? blendProbabilities(legacyPHome, runPHome, RUN_MODEL_WEIGHT)
    : legacyPHome;

  const pickHome = pHome >= 0.5;
  const pickTeam = pickHome ? hT.name : aT.name;
  const oppTeam = pickHome ? aT.name : hT.name;
  const side = pickHome ? "home" : "away";
  const modelProb = pickHome ? pHome : 1 - pHome;

  const awayPitcher = g.teams.away.probablePitcher;
  const homePitcher = g.teams.home.probablePitcher;
  const awayStats = awayPitcher ? pitchers[awayPitcher.id] : null;
  const homeStats = homePitcher ? pitchers[homePitcher.id] : null;
  const awayScore = pitcherScore(awayStats);
  const homeScore = pitcherScore(homeStats);
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

  const lab = calcLabScore({ edge, pitchGap, pitchEdgeSupports: pitchEdgeTeam === pickTeam, pickBullpen, oppBullpen, hasMarket: !!m });
  const officialEligible = edge !== null
    && edge >= VALUE_EDGE
    && modelProb >= OFFICIAL_MODEL_PROB
    && lab.score >= OFFICIAL_LAB_SCORE
    && !pitcherConflict;

  let status = "pass";
  if (officialEligible) status = "official_pick";
  else if (edge !== null && edge >= VALUE_EDGE && lab.score >= VALUE_WATCH_LAB_SCORE) status = "value_watch";
  else if (lab.score >= WATCHLIST_LAB_SCORE) status = "watchlist";

  const passReason = status === "pass"
    ? passReasonFor({ edge, modelProb, pitchEdgeTeam, pickTeam, pitcherConflict, labScore: lab.score, market: m, majorBullpenCaution })
    : null;

  const pickOffCtx = offenseFormFor(pickHome ? hT.id : aT.id, null, offense);
  const oppOffCtx = offenseFormFor(pickHome ? aT.id : hT.id, null, offense);
  const preBullpenModelProb = Number.isFinite(runPHome)
    ? modelProb
    : (pickHome ? preBullpenHomeProb : 1 - preBullpenHomeProb);
  const read = buildRead({
    status, pickTeam, oppTeam, modelProb, marketProb, edge, lab, pitchEdgeTeam, pitchGap,
    pitcherConflict, bullpenRead, pickBullpen, oppBullpen, bestPrice, majorBullpenCaution, passReason,
    pitchingPlan, bullpenGame,
    pickOff: pickOffCtx, oppOff: oppOffCtx, preBullpenModelProb
  });

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
    model_source: Number.isFinite(runPHome) ? "moneyline-v2-plus-runs-v1" : "legacy-strength-fallback",
    projected_runs: Number.isFinite(runPHome) ? {
      away: Number(runProjection.proj_away),
      home: Number(runProjection.proj_home),
      total: Number(runProjection.projection)
    } : null,
    pitching_plan: pitchingPlan,
    bullpen_game: bullpenGame,
    legacy_strength_probability: round(pickHome ? legacyPHome : 1 - legacyPHome, 4),
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
    official_pick_gate: {
      minimum_model_probability: OFFICIAL_MODEL_PROB,
      minimum_lab_score: OFFICIAL_LAB_SCORE,
      minimum_edge: VALUE_EDGE,
      model_probability_passed: modelProb >= OFFICIAL_MODEL_PROB,
      lab_score_passed: lab.score >= OFFICIAL_LAB_SCORE,
      edge_passed: edge !== null && edge >= VALUE_EDGE
    },
    pass_reason: passReason,
    read,
    pitcher_edge: {
      team: pitchEdgeTeam,
      gap: pitchGap,
      conflict: pitcherConflict,
      away_score: awayScore.score,
      home_score: homeScore.score,
      away_pitcher: awayPitcher ? awayPitcher.fullName : "TBD",
      home_pitcher: homePitcher ? homePitcher.fullName : "TBD",
      away_pitcher_id: awayPitcher ? awayPitcher.id : null,
      home_pitcher_id: homePitcher ? homePitcher.id : null,
      away_era: awayStats && Number.isFinite(awayStats.era) ? awayStats.era : null,
      home_era: homeStats && Number.isFinite(homeStats.era) ? homeStats.era : null,
      away_whip: awayStats && Number.isFinite(awayStats.whip) ? awayStats.whip : null,
      home_whip: homeStats && Number.isFinite(homeStats.whip) ? homeStats.whip : null,
      // Advanced stats captured daily for relevance analysis (NOT in any score yet).
      // Once enough graded games accumulate, the learning pass can test whether
      // K-BB%, GB%, or BABIP separation predicts outcomes better than ERA/WHIP.
      away_advanced: advStats(awayStats),
      home_advanced: advStats(homeStats)
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

function calcLabScore({ edge, pitchGap, pitchEdgeSupports, pickBullpen, oppBullpen, hasMarket }) {
  const modelPts = edge === null ? 0 : clamp(edge / 0.08, 0, 1) * 35;
  const pitcherPts = pitchEdgeSupports ? clamp(pitchGap / 20, 0, 1) * 25 : Math.max(0, 8 - clamp(pitchGap / 20, 0, 1) * 8);
  let bullpenPts = 7;
  if (pickBullpen && oppBullpen) {
    const pickRisk = pickBullpen.risk_index ?? pickBullpen.score;
    const oppRisk = oppBullpen.risk_index ?? oppBullpen.score;
    bullpenPts = 8 + clamp((oppRisk - pickRisk) / 45, -1, 1) * 7;
    if (pickRisk >= 78) bullpenPts -= 2;
    if (pickRisk >= 78 && oppRisk >= 78) bullpenPts -= 1;
  }
  const marketPts = !hasMarket ? 0 : edge >= VALUE_EDGE ? 15 : edge >= 0 ? 10 : edge > -VALUE_EDGE ? 5 : 1;
  const basePts = 5;
  const score = Math.round(clamp(modelPts + pitcherPts + bullpenPts + marketPts + basePts, 0, 100));
  return {
    score,
    model_edge_points: round(modelPts, 2),
    pitcher_points: round(pitcherPts, 2),
    bullpen_points: round(bullpenPts, 2),
    market_points: round(marketPts, 2),
    base_points: basePts,
    note: "Lab Rating grades setup quality. It is not win probability."
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
  if (edge !== null && edge < 0) return "Market is higher than LyDia's model probability.";
  if (edge !== null && edge < VALUE_EDGE) return "Model and market are too close for a clear official pick.";
  if (modelProb < OFFICIAL_MODEL_PROB && labScore >= VALUE_WATCH_LAB_SCORE) return `Setup quality is strong, but LyDia's win probability is only ${fmtPct(modelProb)}. That is not high enough for an official pick.`;
  if (pitcherConflict) return "Starting pitcher edge conflicts with the model side.";
  if (labScore < OFFICIAL_LAB_SCORE) return "The combined Lab Rating did not clear the official threshold.";
  if (pitchEdgeTeam !== "No clear SP edge" && pitchEdgeTeam !== pickTeam) return "Starting pitcher edge does not support the model side.";
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
  const labLine = `Lab Rating ${(ctx.lab.score/10).toFixed(1)}/10: model edge ${ctx.lab.model_edge_points}, pitcher ${ctx.lab.pitcher_points}, bullpen ${ctx.lab.bullpen_points}, market ${ctx.lab.market_points}, base ${ctx.lab.base_points}.`;
  const pitchingPlanLine = (() => {
    if (!ctx.pitchingPlan) return "";
    const plans = [ctx.pitchingPlan.away, ctx.pitchingPlan.home].filter(Boolean);
    const flagged = plans.filter(plan => plan.bullpen_game || plan.role === "limited_starter");
    if (!flagged.length) return "";
    const detail = flagged.map(plan =>
      `${plan.pitcher}: ${plan.label}, ${Number(plan.expected_innings).toFixed(1)} expected innings`
    ).join("; ");
    return ` Pitching plan: ${detail}. The remaining innings are assigned to the bullpen.` +
      " Bullpen fatigue, efficiency, and combined risk determine how LyDia grades those remaining innings.";
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
function summarize(rows, hasOdds) {
  const official = rows.filter(r => r.status === "official_pick").length;
  const valueWatch = rows.filter(r => r.status === "value_watch").length;
  const watch = rows.filter(r => r.status === "watchlist").length;
  const high = rows.filter(r => r.lab_score >= VALUE_WATCH_LAB_SCORE).length;
  if (!hasOdds) return "Brief generated without live market pricing. Treat the card as research-only until pricing is checked.";
  if (official) return `${official} official moneyline pick${official === 1 ? "" : "s"} cleared the stricter model-probability and Lab Rating gates. ${valueWatch} value-watch setup${valueWatch === 1 ? "" : "s"} had good price math but did not clear official-pick probability rules.`;
  return `No official picks cleared the stricter rules. ${valueWatch} value-watch setup${valueWatch === 1 ? "" : "s"} and ${watch} watchlist game${watch === 1 ? "" : "s"} remain research-only. ${high} game${high === 1 ? "" : "s"} reached a Lab Rating of ${(VALUE_WATCH_LAB_SCORE/10).toFixed(1)}+/10 but did not clear every official gate.`;
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

  for (const [pk, t] of Object.entries(totals.games || {})) {
    const r = byPk.get(String(pk));
    if (!r || !Number.isFinite(t.projection) || !Number.isFinite(t.line) || !Number.isFinite(t.lab)) continue;
    const edge = Number((t.projection - t.line).toFixed(1));
    const pick = edge > 0 ? "Over" : "Under";
    const price = pick === "Over" ? t.over : t.under;
    if (Math.abs(edge) < OFFICIAL_TOTAL_EDGE || t.lab < OFFICIAL_TOTAL_LAB || !Number.isFinite(price)) continue;
    ensureGroup(r).total = {
      pick,
      line: t.line,
      bestAm: price,
      projection: t.projection,
      edge,
      labScore: t.lab,
      books: t.books || 0,
      modelVersion: totals.model_version || "totals-runs-v2-innings-allocation",
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
    if (Math.abs(edge) < OFFICIAL_K_EDGE || !roleEligible || Number(rec.books) < OFFICIAL_K_MIN_BOOKS || !Number.isFinite(price)) continue;
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
    lock_policy: "Dated official pick files are append-only. Re-running the engine for the same date reuses the existing dated file instead of changing official picks.",
    note: "Official records are separated by market. Moneylines use the 72% probability and 8.0/10 Lab gates; game totals use a 1.0-run edge and 8.0/10 totals setup; pitcher Ks use a 0.7-K edge, posted price, two-book coverage, and a confirmed non-opener workload.",
    rules: {
      moneyline: { minimum_probability: OFFICIAL_MODEL_PROB, minimum_lab: OFFICIAL_LAB_SCORE, minimum_edge: VALUE_EDGE },
      game_total: { minimum_edge_runs: OFFICIAL_TOTAL_EDGE, minimum_lab: OFFICIAL_TOTAL_LAB },
      pitcher_strikeouts: { minimum_edge_k: OFFICIAL_K_EDGE, minimum_books: OFFICIAL_K_MIN_BOOKS, minimum_expected_innings: 4 },
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

    // A zero-pick file is a provisional snapshot, not an immutable official-pick
    // lock. Morning runs can happen before the market and all model inputs are
    // ready. If a later PREVIEW-only run produces official picks, promote that
    // candidate before first pitch. Once any game starts, only a manual,
    // evidence-backed repair may change the dated file.
    if (existing.picks.length === 0 && candidate.picks.length > 0) {
      const now = Date.now();
      const allCandidatesPregame = candidate.picks.every(p => {
        const firstPitch = Date.parse(p.time);
        return Number.isFinite(firstPitch) && now < firstPitch;
      });
      if (!allCandidatesPregame) {
        throw new Error(
          `${file} is an empty provisional snapshot, but a later run found ${candidate.picks.length} official pick(s) after first pitch. ` +
          "Refusing a retroactive lock. Restore the documented posted pick manually."
        );
      }
      writeJson(file, candidate);
      console.log(`Promoted ${candidate.picks.length} official pick(s) from the provisional zero-pick snapshot for ${DATE}.`);
      if (DATE === etToday()) {
        writeJson("data/published-picks/today.json", candidate);
        injectInlineData("results/index.html", "results-inline-picks",
          { date: candidate.date, picks: candidate.picks },
          '<div class="loading">Loading live pick results...</div>');
      }
      return candidate;
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
