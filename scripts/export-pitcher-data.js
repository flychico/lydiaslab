#!/usr/bin/env node
/*
  LyDia — daily pitcher-data export.

  Writes data/calibration/pitcher_data_log.csv: every model input scorePitcher()
  uses (era, whip, ip, so, bb, gs, gp from MLB StatsAPI season stats) plus the
  derived score components (K/9, BB/9, ERA/WHIP/K-BB/Sample scores, Raw Score,
  Role Share, Pitcher Score), for every probable pitcher in today's member
  brief -- captured same-day, before the recap, same pattern as
  export-pregame-attribution.js.

  TWO PITCHER-SCORE COLUMNS
  pitcher_score_published: whatever js/pitcher-matchup-core.js actually
  produced for the live site today (read straight from the brief).
  pitcher_score_role_over5: Lynold's 2026-08-15 roleShare experiment
  (expected_innings / 5 instead of the live model's / 5.5) computed here,
  independent of the live model, so he can compare the two side by side
  before deciding whether to push the divisor change to
  js/pitcher-matchup-core.js itself. THIS SCRIPT DOES NOT CHANGE THE LIVE
  MODEL -- pitcher-matchup-core.js's own roleShare is untouched by this file.

  UPSERT, NOT APPEND -- same reasoning as export-pregame-attribution.js:
  publish-picks.yml runs up to 4x/day, each run replaces this run's rows for
  (date, gamePk, side) so the file always holds the freshest pregame read.

  Usage: node scripts/export-pitcher-data.js [YYYY-MM-DD]  (defaults to today ET)
*/
const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const DATE = (process.argv[2] || "").match(/^\d{4}-\d{2}-\d{2}$/)
  ? process.argv[2]
  : new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

function normDate(s) {
  s = String(s || "");
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return s;
}
function csvField(s) {
  s = String(s == null ? "" : s);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function r2(v) { return (typeof v === "number" && isFinite(v)) ? Number(v.toFixed(2)) : ""; }
function r1(v) { return (typeof v === "number" && isFinite(v)) ? Number(v.toFixed(1)) : ""; }

const COLUMNS = [
  "date", "gamePk", "side", "team", "pitcher_id", "pitcher_name", "role_label",
  "era", "whip", "ip", "so", "bb", "gs", "gp",
  "k9", "bb9", "era_score", "whip_score", "kbb_score", "sample_score", "raw_score",
  "expected_innings", "role_share_over5", "pitcher_score_role_over5",
  "pitcher_score_published"
];
const HEADER = COLUMNS.join(",") + "\n";

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "lydiaslab-pitcher-data-export" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Bad JSON from ${url}: ${e.message}`)); }
      });
    }).on("error", reject);
  });
}

// Chunk into groups of 8 IDs -- MLB StatsAPI 403s ("URL exceeds maximum
// length") past that on a single people?personIds= call.
async function fetchSeasonStats(ids, season) {
  const out = {};
  const chunks = [];
  for (let i = 0; i < ids.length; i += 8) chunks.push(ids.slice(i, i + 8));
  for (const chunk of chunks) {
    const url = `https://statsapi.mlb.com/api/v1/people?personIds=${chunk.join(",")}&hydrate=stats(group=[pitching],type=[season],season=${season})`;
    let json;
    try {
      json = await fetchJson(url);
    } catch (e) {
      console.warn(`Pitcher data export: stats fetch failed for [${chunk.join(",")}] -- ${e.message}`);
      continue;
    }
    for (const person of json.people || []) {
      const split = (person.stats && person.stats[0] && person.stats[0].splits && person.stats[0].splits[0]) || null;
      const st = split ? split.stat : null;
      if (!st) continue;
      out[person.id] = {
        era: Number(st.era), whip: Number(st.whip),
        ip: (() => { const [w, f] = String(st.inningsPitched).split("."); return Number(w || 0) + Number(f || 0) / 3; })(),
        so: Number(st.strikeOuts), bb: Number(st.baseOnBalls),
        gs: Number(st.gamesStarted), gp: Number(st.gamesPitched)
      };
    }
  }
  return out;
}

function scoreRow(st) {
  const { era, whip, ip, so, bb } = st;
  const k9 = ip > 0 ? (so / ip) * 9 : null;
  const bb9 = ip > 0 ? (bb / ip) * 9 : null;
  const eraScore = clamp(100 - (era - 2.00) * 16, 20, 92);
  const whipScore = clamp(100 - (whip - 0.90) * 90, 20, 92);
  const kbbScore = (k9 != null && bb9 != null) ? clamp(50 + (k9 - 8.0) * 4 - (bb9 - 3.0) * 6, 20, 90) : 50;
  const sampleScore = clamp(35 + Math.min(ip, 100) * 0.35, 35, 70);
  const rawScore = Math.round(eraScore * 0.40 + whipScore * 0.25 + kbbScore * 0.20 + sampleScore * 0.15);
  return { k9, bb9, eraScore, whipScore, kbbScore, sampleScore, rawScore };
}

async function main() {
  const briefPath = path.join(ROOT, "data", "member-brief", `${DATE}.json`);
  if (!fs.existsSync(briefPath)) {
    console.log(`Pitcher data export: no member brief for ${DATE} at ${briefPath} -- nothing to export.`);
    return;
  }
  let brief;
  try {
    brief = JSON.parse(fs.readFileSync(briefPath, "utf8"));
  } catch (e) {
    console.warn(`Pitcher data export: could not parse ${briefPath} -- ${e.message}`);
    return;
  }
  const games = Array.isArray(brief.games) ? brief.games : Array.isArray(brief) ? brief : [];
  if (!games.length) {
    console.log(`Pitcher data export: member brief for ${DATE} has no games -- nothing to export.`);
    return;
  }

  // Pull the starter (first non-bullpen segment) for each side of each game.
  const plan = [];
  for (const g of games) {
    for (const side of ["away", "home"]) {
      const p = (g.pitching_plan || {})[side] || {};
      const seg = (p.segments || []).find((s) => s.role !== "bullpen");
      plan.push({
        gamePk: g.game_pk, side, team: side === "away" ? g.away_team : g.home_team,
        pitcher_id: seg ? seg.pitcher_id : null,
        pitcher_name: seg ? seg.pitcher : (p.pitcher || "TBD"),
        role_label: p.label || "",
        expected_innings: p.expected_innings != null ? p.expected_innings : (seg ? seg.expected_innings : null),
        pitcher_score_published: p.pitcher_score != null ? p.pitcher_score : (seg ? seg.pitcher_score : null)
      });
    }
  }

  const ids = [...new Set(plan.filter((p) => p.pitcher_id).map((p) => p.pitcher_id))];
  const season = DATE.slice(0, 4);
  const stats = await fetchSeasonStats(ids, season);

  const rows = [];
  for (const p of plan) {
    const st = p.pitcher_id ? stats[p.pitcher_id] : null;
    if (!st) {
      rows.push([
        DATE, p.gamePk, p.side, csvField(p.team), p.pitcher_id || "", csvField(p.pitcher_name), csvField(p.role_label),
        "", "", "", "", "", "", "",
        "", "", "", "", "", "", "",
        p.expected_innings ?? "", "", "",
        p.pitcher_score_published ?? ""
      ].join(","));
      continue;
    }
    const sc = scoreRow(st);
    const roleShareOver5 = p.expected_innings != null ? p.expected_innings / 5 : null;
    const pitcherScoreOver5 = roleShareOver5 != null
      ? Math.round(clamp(50 + (sc.rawScore - 50) * roleShareOver5, 20, 92))
      : "";
    rows.push([
      DATE, p.gamePk, p.side, csvField(p.team), p.pitcher_id, csvField(p.pitcher_name), csvField(p.role_label),
      r2(st.era), r2(st.whip), r2(st.ip), st.so, st.bb, st.gs, st.gp,
      r2(sc.k9), r2(sc.bb9), r1(sc.eraScore), r1(sc.whipScore), r1(sc.kbbScore), r1(sc.sampleScore), sc.rawScore,
      p.expected_innings ?? "", r2(roleShareOver5), pitcherScoreOver5,
      p.pitcher_score_published ?? ""
    ].join(","));
  }

  if (!rows.length) {
    console.log(`Pitcher data export: ${DATE} has games but no probable pitchers yet -- nothing to export this run.`);
    return;
  }

  const OUT = path.join(ROOT, "data", "calibration", "pitcher_data_log.csv");
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  let existingLines = [];
  if (fs.existsSync(OUT)) {
    existingLines = fs.readFileSync(OUT, "utf8").split("\n").filter(Boolean);
    if (existingLines.length && existingLines[0].startsWith("date,")) existingLines.shift();
  }
  const todaysKeys = new Set(plan.map((p) => `${p.gamePk}|${p.side}`));
  const kept = existingLines.filter((l) => {
    const parts = l.split(",");
    if (parts.length < 3) return false;
    const sameDate = normDate(parts[0]) === DATE;
    return !(sameDate && todaysKeys.has(`${parts[1]}|${parts[2]}`));
  });

  fs.writeFileSync(OUT, HEADER + [...kept, ...rows].join("\n") + "\n");
  console.log(`Pitcher data export: wrote ${rows.length} row(s) for ${DATE} to data/calibration/pitcher_data_log.csv (${kept.length} prior rows retained).`);
}

main().catch((e) => {
  console.error(`Pitcher data export: unhandled error -- ${e.message}`);
  process.exitCode = 0; // never fail the publish job over a reporting script
});
