#!/usr/bin/env node
/*
  LyDia automated market snapshot updater.
  Updates data/market/<date>.json from locked published picks only.
  Does not generate picks, change picks, email members, or touch public copy.
*/
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const MAX_ABS_PRICE = 1000;

const args = parseArgs(process.argv.slice(2));
const DATE = args.date || etToday();
const SNAPSHOT = args.snapshot || "auto";

if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error(`Bad date: ${DATE}`);
  process.exit(1);
}
if (!["auto", "current", "closing"].includes(SNAPSHOT)) {
  console.error(`Bad snapshot: ${SNAPSHOT}. Use auto, current, or closing.`);
  process.exit(1);
}
if (!ODDS_API_KEY) {
  console.log("ODDS_API_KEY is missing. Market snapshot skipped.");
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });

async function main() {
  const published = readJsonSafe(`data/published-picks/${DATE}.json`) || readJsonSafe(`data/picks/${DATE}.json`);
  if (!published || !Array.isArray(published.picks) || published.picks.length === 0) {
    console.log(`No locked official picks found for ${DATE}. Market snapshot skipped.`);
    return;
  }

  const oddsEvents = await fetchJson(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${encodeURIComponent(ODDS_API_KEY)}&regions=us&markets=h2h&oddsFormat=american`).catch(() => []);
  const oddsMap = buildOddsMap(oddsEvents);
  const now = new Date();
  const generatedAt = now.toISOString();

  const marketPath = `data/market/${DATE}.json`;
  const existing = readJsonSafe(marketPath) || { date: DATE, generated_at: generatedAt, snapshot_type: "posted", items: [] };
  const byId = new Map((existing.items || []).map(i => [i.pick_id || fallbackPickId(i), i]));

  for (const pick of published.picks) {
    if (!pick.moneyline || pick.moneyline.isPass) continue;

    const gameKey = `${pick.away}@${pick.home}`;
    const m = oddsMap[gameKey];
    if (!m) continue;

    const pickHome = pick.moneyline.side === "home";
    const price = pickHome ? m.bestHome : m.bestAway;
    const marketProbability = pickHome ? m.pHome : m.pAway;

    const itemId = pick.pick_id || `${slug(pick.away)}-${slug(pick.home)}-${DATE}-ml`;
    const prev = byId.get(itemId) || {
      pick_id: itemId,
      date: DATE,
      game: `${pick.away} @ ${pick.home}`,
      game_time_iso: pick.time,
      market: "Moneyline",
      pick: `${pick.moneyline.pick} ML`,
      pick_team: pick.moneyline.pick,
      lab_score: pick.labScore || pick.moneyline.edgeScore || null,
      model_probability: pick.moneyline.prob ?? null,
      market_probability: pick.moneyline.mktProb ?? null,
      raw_edge: pick.moneyline.rawEdge ?? null,
      posted_price: pick.moneyline.bestAm ?? null,
      current_price: null,
      closing_price: null,
      posted_at: published.locked_at || published.generated_at || published.generated || null,
      movement: "pending",
      read: "Market tracking compares LyDia's posted number against later current and closing snapshots."
    };

    const mode = resolveSnapshotMode(SNAPSHOT, pick.time, now);
    const updated = { ...prev, game_time_iso: prev.game_time_iso || pick.time, last_checked_at: generatedAt, books: m.books };
    updated.market_probability_latest = round(marketProbability, 4);

    if (mode === "closing") updated.closing_price = price;
    else updated.current_price = price;

    updated.movement = movement(updated.posted_price, updated.closing_price || updated.current_price);
    byId.set(itemId, updated);
  }

  const merged = {
    date: DATE,
    generated_at: generatedAt,
    snapshot_type: SNAPSHOT,
    note: "Automated market snapshots update current_price before close and closing_price near game time. Official picks remain locked separately.",
    items: [...byId.values()].sort((a, b) => new Date(a.game_time_iso || 0) - new Date(b.game_time_iso || 0))
  };

  writeJson(marketPath, merged);
  if (DATE === etToday()) writeJson("data/market/today.json", merged);
  console.log(`Updated market snapshots for ${DATE}. Items: ${merged.items.length}.`);
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
function readJsonSafe(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")); } catch (e) { return null; }
}
function writeJson(file, obj) {
  const out = path.join(ROOT, file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(obj, null, 2) + "\n", "utf8");
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
function round(n, dp = 4) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const m = Math.pow(10, dp);
  return Math.round(n * m) / m;
}
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
function fallbackPickId(i) {
  return `${slug(i.game || "game")}-${slug(i.market || "market")}`;
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
function resolveSnapshotMode(input, gameIso, now) {
  if (input === "current" || input === "closing") return input;
  if (!gameIso) return "current";
  const gameTime = new Date(gameIso);
  if (Number.isNaN(gameTime.getTime())) return "current";

  // Auto mode: before 45 minutes to first pitch = current. Inside 45 minutes or after first pitch = closing.
  return now >= new Date(gameTime.getTime() - 45 * 60000) ? "closing" : "current";
}
function movement(posted, later) {
  if (typeof posted !== "number" || typeof later !== "number") return "pending";
  const postedDec = amToDec(posted);
  const laterDec = amToDec(later);
  if (Math.abs(postedDec - laterDec) < 0.015) return "stable";
  return laterDec < postedDec ? "toward_lydia" : "away_from_lydia";
}
