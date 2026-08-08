#!/usr/bin/env node
/*
  LyDia moneyline odds capture.
  Fetches today's h2h (moneyline) odds and writes them to
  data/moneyline-odds/<date>.json for generate-member-lab.js to read as a
  fallback when it runs without ODDS_API_KEY (every publish-picks.yml run).

  Root cause this exists to fix: generate-member-lab.js only ever fetches
  live h2h odds inline, gated on ODDS_API_KEY -- an env var that is present
  in refresh-lines.yml (which never calls generate-member-lab.js) but never
  present in publish-picks.yml (which always calls generate-member-lab.js).
  No workflow held both the key and the call, so moneyline market data was
  never captured at all: every matchup page showed "Market probability: Not
  available" regardless of the game. ERR-20260801-02.

  Mirrors update-totals.js / update-k-props.js: capture-when-the-key-exists,
  reuse-when-it-doesn't. Touches ONLY data/moneyline-odds/ -- never picks,
  previews, member-brief, or results.

  2026-08-05: added --if-changed, matching update-totals.js / update-k-props.js.
  prepare-slate.yml runs this up to 5x/day and was calling all three odds
  scripts unconditionally every time -- a full h2h odds fetch every run, all
  day, whether or not anything on the slate had actually moved. --if-changed
  compares today's probable-pitcher signature against the last capture and
  skips the fetch when nothing has changed. A missing/stale prior capture
  (the day's first run) always falls through to a real fetch -- it does not
  skip, it captures.

  2026-08-08 (ERR-20260808-02): added a second, free trigger -- a game whose
  lineup has since posted also forces a re-capture, using the same schedule
  call this script already makes for probables (now hydrated with
  ,lineups too, at zero extra cost -- statsapi.mlb.com is free regardless of
  hydrate params). NOTE this is a weaker signal here than it is for
  update-k-props.js / update-totals.js: this script's own model (market
  win probability, read directly off h2h odds) does not consume lineup data
  at all, so a lineup posting is only a loose correlate of "the price may
  have moved," not a direct trigger the way it is for a lineup-wOBA-driven
  projection. It's included because it's free and better than nothing, not
  because it's a targeted fix. Genuine price drift with no lineup or pitcher
  change (the actual gap the Cubs case exposed) still requires the paid
  odds call itself to detect -- there is no free proxy for that. See
  NOTES.md.
*/
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const MAX_ABS_PRICE = 1000;

const args = parseArgs(process.argv.slice(2));
const DATE = args.date || etToday();
const IF_CHANGED = args["if-changed"] === "true";

if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error(`Bad date: ${DATE}`);
  process.exit(1);
}
if (!ODDS_API_KEY) {
  console.log("ODDS_API_KEY is missing. Moneyline odds capture skipped.");
  process.exit(0);
}

main().catch(e => { console.error("moneyline odds capture error:", e.message); process.exit(0); });

// Same probable-pitcher signature construction as update-totals.js /
// update-k-props.js, so the three scripts' --if-changed behavior agrees on
// what "changed" means for a given slate. Now also hydrates lineups on the
// same call (free) to build a lineup-posted signature alongside it.
async function currentProbablesAndLineups() {
  const sched = await fetchJson(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}&hydrate=probablePitcher,lineups`);
  const probables = {};
  const lineupsPosted = {};
  for (const g of (((sched.dates || [])[0]) || {}).games || []) {
    if (!g.status || g.status.abstractGameState !== "Preview") continue;
    probables[g.gamePk] = {
      away: (g.teams.away.probablePitcher || {}).fullName || "TBD",
      home: (g.teams.home.probablePitcher || {}).fullName || "TBD"
    };
    const lu = g.lineups || {};
    lineupsPosted[g.gamePk] = {
      away: (lu.awayPlayers || []).length >= 9,
      home: (lu.homePlayers || []).length >= 9
    };
  }
  return { probables, lineupsPosted };
}

async function main() {
  const { probables, lineupsPosted } = await currentProbablesAndLineups().catch(() => ({ probables: {}, lineupsPosted: {} }));

  if (IF_CHANGED) {
    // No comparable capture yet today (first run of the day, or a stale file
    // from a prior date) -> fall through to a real fetch. Only "compared, and
    // nothing moved" skips the API call.
    const existingPath = path.join(ROOT, `data/moneyline-odds/${DATE}.json`);
    let prev = null;
    if (fs.existsSync(existingPath)) { try { prev = JSON.parse(fs.readFileSync(existingPath, "utf8")); } catch (e) { prev = null; } }
    if (!prev || prev.date !== DATE || !prev.probables) {
      console.log("Moneyline odds: no comparable capture for today yet — running a full capture.");
    } else {
      const changes = [];
      for (const [pk, cur] of Object.entries(probables)) {
        const was = prev.probables[pk];
        if (!was) continue;
        for (const side of ["away", "home"]) {
          if (was[side] !== "TBD" && cur[side] !== was[side]) changes.push(`${was[side]} → ${cur[side]}`);
          if (was[side] === "TBD" && cur[side] !== "TBD") changes.push(`TBD → ${cur[side]}`);
        }
      }
      // 2026-08-08 (ERR-20260808-02): same free lineup-posted trigger added
      // to update-k-props.js / update-totals.js. See file header for why
      // this is a weaker signal for moneyline specifically.
      const prevLineups = prev.lineups_posted || {};
      for (const [pk, cur] of Object.entries(lineupsPosted)) {
        const was = prevLineups[pk];
        if (!was) continue;
        if (was.away === false && cur.away) changes.push(`game ${pk}: away lineup now posted`);
        if (was.home === false && cur.home) changes.push(`game ${pk}: home lineup now posted`);
      }
      if (!changes.length) { console.log("Moneyline odds: probables and lineups unchanged — keeping the morning capture, no API call."); return; }
      console.log(`Moneyline odds: change (${changes.join("; ")}) — re-capturing.`);
    }
  }

  const oddsEvents = await fetchJson(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${encodeURIComponent(ODDS_API_KEY)}&regions=us&markets=h2h&oddsFormat=american`).catch(() => []);
  const games = buildOddsMap(oddsEvents);
  const gameCount = Object.keys(games).length;

  if (!gameCount) {
    console.log(`No h2h odds returned for ${DATE}. Leaving any existing capture in place.`);
    return;
  }

  const payload = {
    date: DATE,
    generated_at: new Date().toISOString(),
    source: "the-odds-api h2h, no-vig blended across books",
    probables,
    lineups_posted: lineupsPosted,
    games
  };

  writeJson(`data/moneyline-odds/${DATE}.json`, payload);
  if (DATE === etToday()) writeJson("data/moneyline-odds/today.json", payload);
  console.log(`Moneyline odds captured for ${DATE}: ${gameCount} game(s), ${Object.values(games).reduce((s, g) => s + g.books, 0)} total book quotes.`);
}

// Identical shape/logic to buildOddsMap() in generate-member-lab.js -- kept
// in sync deliberately so a captured file and a live fetch are
// interchangeable to any reader of oddsMap.
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
function writeJson(file, obj) {
  const out = path.join(ROOT, file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
