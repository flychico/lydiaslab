#!/usr/bin/env node
/**
 * NFL posts for X (HO-0087, DEC-20261116-50).
 *
 *   node scripts/build-nfl-social.js [YYYY-MM-DD ...]     default: yesterday and today (ET)
 *
 * Writes data/nfl/social/<date>.json in the shared contract (HO-0087):
 *   { sport, date, posts: [{ id, kind, created_at, header, lines, record, facts, hashtags, text, link }] }
 *
 *   picks    one post per slate, written or refreshed by each run until the first
 *            kickoff and frozen after it. Lines are Leo's calls as the site shows
 *            them (calls stay once made, DEC-20261115-53: nfl-calls.js held() over
 *            every read saved before kickoff, else the picks file), plus Leo's three
 *            highest anytime touchdown chances (last capture before kickoff).
 *   wave-N   one post per wave in data/nfl/waves/<date>.json, never rewritten.
 *   day      one post when every game of the date with a Leo read is graded.
 *            Lines are each graded call with a check or a cross, from
 *            data/nfl/results-review.json; record = calls only.
 *   facts    1 to 3 short lines on the players in those games: a player Leo had in
 *            his top 3 touchdown chances who scored (with that chance), multi touchdown
 *            games, a three touchdown passer. From ESPN's game summaries on the
 *            runner (minutes after the final), else nflverse's weekly player stats.
 *
 * Voice and rules: ADMIN_RULES.md "Post voice". Numbers only from the files; no
 * dashes, no exclamation marks; never "bet", "lock", promo codes or sportsbook
 * names; ends with the link and 21+. Hashtags from data/nfl/social/hashtags.json,
 * at most 4. Display only: nothing here feeds Leo.
 *
 * Test hooks: NFL_ESPN_DIR=<dir with scoreboard-<date>.json and summary-<event>.json>,
 * NFL_STATS_FILE=<saved stats_player_week_<season>.csv>, NFL_SOCIAL_NOW=<ISO time>.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const TEAMS = require("./lib/nfl-teams");
const CALLS = require("./lib/nfl-calls");
const { preKickoffReads } = require("./lib/prediction-history");
const { fromEspn } = require("./lib/nfl-finals");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "data/nfl");
const OUT = path.join(DIR, "social");
const SITE = "https://ndhorizon.com";
const NOW = () => (process.env.NFL_SOCIAL_NOW ? Date.parse(process.env.NFL_SOCIAL_NOW) : Date.now());
const etDate = d => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const nick = a => TEAMS.nick(a);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };
const nameKey = n => String(n || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "").replace(/[^a-z]/g, "");
const MARK = { W: "✅", L: "❌", P: "➖" };

function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

// ---------- hashtags ----------
const TAGS = readJson(path.join(OUT, "hashtags.json")) || { sport_tag: "#NFLPicks", teams: {} };
function hashtags(teams) {
  const out = [TAGS.sport_tag || "#NFLPicks"];
  for (const t of teams) {
    const h = TAGS.teams[t] && TAGS.teams[t].primary;
    if (h && !out.includes(h)) out.push(h);
    if (out.length >= 4) break;
  }
  return out;
}

// ---------- Leo's top anytime touchdown chances, last capture before kickoff ----------
function tdReads(date) {
  const f = path.join(DIR, "prop-prediction-history.csv");
  if (!fs.existsSync(f)) return [];
  const best = new Map();
  for (const r of parseCsv(fs.readFileSync(f, "utf8"))) {
    if (r.date !== date || r.market !== "ANYTIME_TD") continue;
    const cap = Date.parse(r.captured_at), kick = Date.parse(r.kickoff_utc);
    if (!Number.isFinite(cap) || !Number.isFinite(kick) || !(cap < kick)) continue;
    const k = `${r.game_id}|${r.team}|${r.player}`, prev = best.get(k);
    if (!prev || cap > prev._cap) best.set(k, { ...r, _cap: cap, chance: +r.projection });
  }
  return [...best.values()].filter(r => Number.isFinite(r.chance)).sort((a, b) => b.chance - a.chance || a.player.localeCompare(b.player));
}
const pct = p => Math.round(p * 100);

// ---------- picks post ----------
function callLine(mk, c, g) {
  if (!c || !c.call) return null;
  if (mk === "ml") return `${nick(c.call)} ML`;
  if (mk === "spread") return `${nick(c.call)} ${String(c.label).split(" ").slice(1).join(" ")}`;
  return `${nick(g.away)}/${nick(g.home)} ${c.label}`;
}
function slateHeader(date, week) {
  const day = new Date(date + "T12:00:00Z").getUTCDay();
  if (day === 1) return "MONDAY NIGHT FOOTBALL 🏈";
  if (day === 4) return "THURSDAY NIGHT FOOTBALL 🏈";
  return `NFL WEEK ${week} 🏈`;
}
function picksPost(date, existing) {
  const picks = readJson(path.join(DIR, `picks-${date}.json`));
  if (!Array.isArray(picks) || !picks.length) return null;
  const games = picks.slice().sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)) || a.matchup.localeCompare(b.matchup));
  const first = Math.min(...games.map(g => Date.parse(g.kickoff)).filter(Number.isFinite));
  if (existing && NOW() >= first) return existing;            // frozen at the first kickoff
  const READS = preKickoffReads(path.join(DIR, "prediction-history.csv"), date);
  const lines = [], teams = [];
  for (const g of games) {
    const reads = READS.get(g.game_id);
    const H = reads && reads.length ? CALLS.held(reads) : CALLS.calls(g);
    for (const mk of ["ml", "spread", "total"]) {
      const l = callLine(mk, H[mk], g);
      if (l) { lines.push(l); if (mk !== "total") teams.push(H[mk].call); }
    }
  }
  const td = tdReads(date).slice(0, 3).map(r => `${r.player} ${pct(r.chance)}% to score`);
  const week = games[0].week;
  const one = games.length === 1;
  const link = one && games[0].game_id ? pageUrl(date, games[0]) : `${SITE}/nfl/week/${date.slice(0, 4)}-week-${week}/`;
  const header = slateHeader(date, week);
  const tags = hashtags([...teams, ...games.flatMap(g => [g.home, g.away])]);
  // Lynold, Nov 16: "what would Leo do?" then "Leo picks:".
  const body = [header, "What would Leo do?", "", "Leo picks:"];
  body.push(...(lines.length ? lines : ["No call from Leo on this slate."]));
  if (td.length) body.push("", "TOUCHDOWN CHANCES", ...td);
  body.push("", link, `21+ ${tags.join(" ")}`);
  return { id: "picks", kind: "picks", created_at: new Date(NOW()).toISOString(), header, lines, record: null,
    facts: td, hashtags: tags, text: body.join("\n"), link };
}
function pageUrl(date, g) {
  const m = readJson(path.join(DIR, "matchups", `${date}.json`));
  const list = Array.isArray(m) ? m : (m && m.games) || [];
  const x = list.find(y => y.game_id === g.game_id);
  return x && x.url ? (x.url.startsWith("http") ? x.url : SITE + x.url) : `${SITE}/nfl/scoreboard/`;
}

// ---------- results posts ----------
function resultLine(g, c) {
  const head = String(c.text || "").split(",")[0].trim();
  let l;
  if (c.market === "ml") l = `${head.split(" ").slice(0, -1).join(" ")} ML`;
  else if (c.market === "total") l = `${g.away_name}/${g.home_name} ${head}`;
  else l = head;
  return `${l} ${MARK[c.result] || ""}`.trim();
}
function tally(calls) {
  const w = calls.filter(c => c.result === "W").length, l = calls.filter(c => c.result === "L").length, p = calls.filter(c => c.result === "P").length;
  const rec = `${w}-${l}${p ? "-" + p : ""}`;
  return { w, l, p, rec, pct: w + l ? Math.round(100 * w / (w + l)) : null };
}
function opener(t) {
  const r = `${t.rec}${t.pct != null ? ` (${t.pct}%)` : ""}`;
  return r;   // plain record and percent (Lynold, Nov 16: no "BANG" style openers)
}
const dayName = date => new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }).toUpperCase();

function resultsPost(id, date, games, label, facts) {
  const calls = games.flatMap(g => (g.calls || []).filter(c => c.result).map(c => ({ ...c, g })));
  if (!calls.length) return null;
  const t = tally(calls);
  // Winners on top, then pushes, then losers (Lynold, Nov 16); kickoff order within each.
  const rank = { W: 0, P: 1, L: 2 };
  const lines = calls.map((c, i) => ({ c, i })).sort((a, b) => rank[a.c.result] - rank[b.c.result] || a.i - b.i).map(x => resultLine(x.c.g, x.c));
  const short = String(label || "").replace(/, the last of the day$/i, "");
  const header = id === "day" ? `NFL ${dayName(date)} RESULTS 🏈` : `NFL ${dayName(date)}: ${short.toUpperCase()} 🏈`;
  const winners = calls.filter(c => c.result === "W").map(c => c.g.winner).filter(Boolean);
  const tags = hashtags([...winners, ...games.flatMap(g => [g.winner, g.loser])]);
  const link = `${SITE}/nfl/results/`;
  const record = `${t.rec}${t.pct != null ? ` (${t.pct}%)` : ""}`;
  const body = [header, opener(t), "", ...lines];
  if (facts.length) body.push("", ...facts);
  body.push("", `Every call graded, misses included: ${link}`, `21+ ${tags.join(" ")}`);
  return { id, kind: "results", created_at: new Date(NOW()).toISOString(), header, lines, record, facts,
    hashtags: tags, text: body.join("\n"), link };
}

// ---------- player facts ----------
function curl(url) {
  return execFileSync("curl", ["-sSL", "--fail", "--max-time", "60", url], { encoding: "utf8", maxBuffer: 1 << 28 });
}
// Per player: { name, team, pass_tds, pass_yds, cmp, att, tds } for the date's games.
function espnStats(date) {
  const dir = process.env.NFL_ESPN_DIR;
  const get = (name, url) => dir ? JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) : JSON.parse(curl(url));
  let sb;
  try { sb = get(`scoreboard-${date}.json`, `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${date.replace(/-/g, "")}`); }
  catch (e) { return null; }
  const P = new Map(); let n = 0;
  const add = (name, team) => { const k = nameKey(name); if (!P.has(k)) P.set(k, { name, team, tds: 0, pass_tds: 0, pass_yds: null, cmp: null, att: null }); return P.get(k); };
  for (const ev of sb.events || []) {
    const st = ((ev.competitions || [])[0] || {}).status || ev.status || {};
    if (!((st.type || {}).completed)) continue;
    let s; try { s = get(`summary-${ev.id}.json`, `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${ev.id}`); } catch (e) { continue; }
    n++;
    for (const p of s.scoringPlays || []) {
      const t = ((p.scoringType || {}).abbreviation || (p.type || {}).abbreviation || "") + " " + ((p.scoringType || {}).displayName || (p.type || {}).text || "");
      if (!/\bTD\b|touchdown/i.test(t)) continue;
      const team = fromEspn((p.team || {}).abbreviation || "");
      const m = String(p.text || "").match(/^(.*?)\s+\d+\s*(?:yd|yds|yrd|yard|yards)\b/i);
      if (m) add(m[1].trim(), team).tds++;
      const q = String(p.text || "").match(/pass from (.+?)(?:\s*\(|$)/i);
      if (q) add(q[1].trim(), team).pass_tds++;
    }
    for (const tl of s.leaders || []) {
      const team = fromEspn((tl.team || {}).abbreviation || "");
      const pass = (tl.leaders || []).find(x => x.name === "passingYards");
      const top = pass && (pass.leaders || [])[0];
      if (!top || !top.athlete) continue;
      const m = String(top.displayValue || "").match(/(\d+)\/(\d+),\s*([\d,]+)\s*YDS/i);
      if (m) Object.assign(add(top.athlete.displayName, team), { cmp: +m[1], att: +m[2], pass_yds: +m[3].replace(/,/g, "") });
    }
  }
  return n ? P : null;
}
function nflverseStats(date, week) {
  let text;
  try { text = process.env.NFL_STATS_FILE ? fs.readFileSync(process.env.NFL_STATS_FILE, "utf8")
    : curl(`https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${date.slice(0, 4)}.csv`); }
  catch (e) { return null; }
  const P = new Map();
  for (const r of parseCsv(text)) {
    if (String(r.week) !== String(week) || r.season_type !== "REG") continue;
    const tds = (+r.rushing_tds || 0) + (+r.receiving_tds || 0);
    P.set(nameKey(r.player_display_name), { name: r.player_display_name, team: r.team, tds,
      pass_tds: +r.passing_tds || 0, pass_yds: +r.passing_yards || 0, cmp: +r.completions || 0, att: +r.attempts || 0, pos: r.position });
  }
  return P.size ? P : null;
}
let STATS_CACHE = {};
function playerStats(date, week) {
  if (!(date in STATS_CACHE)) STATS_CACHE[date] = espnStats(date) || nflverseStats(date, week) || null;
  return STATS_CACHE[date];
}
function facts(date, week, games) {
  const P = playerStats(date, week);
  if (!P) return [];
  // Only the games in the post that carry a graded call.
  const teams = new Set(games.filter(g => (g.calls || []).some(c => c.result)).flatMap(g => [g.away, g.home]));
  const reads = tdReads(date);
  const out = [], used = new Set();
  // A player in Leo's top 3 touchdown chances for his game who scored.
  const byGame = new Map();
  for (const r of reads) { if (!byGame.has(r.game_id)) byGame.set(r.game_id, []); if (byGame.get(r.game_id).length < 3) byGame.get(r.game_id).push(r); }
  const saw = [];
  for (const list of byGame.values()) for (const r of list) {
    const p = P.get(nameKey(r.player));
    if (p && p.tds > 0 && teams.has(r.team)) saw.push({ r, p });
  }
  saw.sort((a, b) => b.p.tds - a.p.tds || a.r.chance - b.r.chance);
  for (const { r, p } of saw.slice(0, 1)) { out.push(`${r.player} ${p.tds > 1 ? `${p.tds} TD` : "scored"} (Leo had him at ${pct(r.chance)}% to score)`); used.add(nameKey(r.player)); }
  const all = [...P.values()].filter(p => teams.has(p.team) && !used.has(nameKey(p.name)));
  const multi = all.filter(p => p.tds >= 2).sort((a, b) => b.tds - a.tds || a.name.localeCompare(b.name))
    .map(p => ({ k: nameKey(p.name), s: p.tds * 10, t: `${p.name} ${p.tds} TD` }));
  const qbs = all.filter(p => p.pass_tds >= 3).sort((a, b) => b.pass_tds - a.pass_tds || b.pass_yds - a.pass_yds)
    .map(p => ({ k: nameKey(p.name), s: p.pass_tds * 9, t: `${p.name} ${p.pass_yds ? p.pass_yds + " yds, " : ""}${p.pass_tds} TD passes` }));
  for (const f of [...multi, ...qbs].sort((a, b) => b.s - a.s)) {
    if (out.length >= 3) break;
    if (!used.has(f.k)) { out.push(f.t); used.add(f.k); }
  }
  return out;
}

// ---------- main ----------
function build(date) {
  const file = path.join(OUT, `${date}.json`);
  const doc = readJson(file) || { sport: "NFL", date, posts: [] };
  const has = id => doc.posts.find(p => p.id === id);
  const set = post => { if (!post) return; const i = doc.posts.findIndex(p => p.id === post.id); if (i >= 0) doc.posts[i] = post; else doc.posts.push(post); };
  let changed = false;

  const before = JSON.stringify(has("picks") || null);
  const pk = picksPost(date, has("picks"));
  if (pk && JSON.stringify(pk) !== before) { set(pk); changed = true; }

  const rv = readJson(path.join(DIR, "results-review.json"));
  const KICK = new Map((readJson(path.join(DIR, `picks-${date}.json`)) || []).map(g => [`${g.away}|${g.home}`, String(g.kickoff || "")]));
  const rvGames = (rv ? rv.games.filter(g => g.date === date && g.three) : [])
    .sort((a, b) => (KICK.get(`${a.away}|${a.home}`) || "").localeCompare(KICK.get(`${b.away}|${b.home}`) || "") || a.matchup.localeCompare(b.matchup));
  const byFull = new Map(rvGames.map(g => [`${TEAMS.full(g.away)}|${TEAMS.full(g.home)}`, g]));
  const week = rvGames.length ? rvGames[0].week : null;
  const waves = readJson(path.join(DIR, "waves", `${date}.json`));
  const W = (waves && waves.waves) || [];
  for (const w of W) {
    if (has(w.id)) continue;
    // A single wave that already holds the whole day is the day post; skip it.
    if (W.length === 1 && w.still_playing === 0) continue;
    const gs = w.games.map(x => byFull.get(`${x.away}|${x.home}`)).filter(Boolean);
    if (!gs.length) continue;
    set(resultsPost(w.id, date, gs, w.label, facts(date, week, gs))); changed = true;
  }
  if (!has("day") && rvGames.length) {
    const READS = preKickoffReads(path.join(DIR, "prediction-history.csv"), date);
    const graded = new Set(rvGames.map(g => `${g.away}|${g.home}`));
    const all = [...READS.values()].every(rs => graded.has(`${rs[0].away}|${rs[0].home}`));
    if (all) { set(resultsPost("day", date, rvGames, "", facts(date, week, rvGames))); changed = true; }
  }
  doc.posts = doc.posts.filter(Boolean);
  if (!changed) { console.log(`NFL social ${date}: nothing new (${doc.posts.length} post(s)).`); return doc; }
  const order = id => id === "picks" ? 0 : id === "day" ? 9999 : 1 + (parseInt(String(id).split("-")[1], 10) || 0);
  doc.posts.sort((a, b) => order(a.id) - order(b.id));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 1) + "\n");
  console.log(`NFL social ${date}: ${doc.posts.map(p => p.id + (p.record ? " " + p.record : "")).join(", ")} -> data/nfl/social/${date}.json`);
  return doc;
}

if (require.main === module) {
  const dates = process.argv.slice(2).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!dates.length) dates.push(etDate(new Date(NOW() - 864e5)), etDate(new Date(NOW())));
  for (const d of [...new Set(dates)]) { try { build(d); } catch (e) { console.log(`NFL social ${d}: skipped (${e.message.split("\n")[0]})`); } }
}
module.exports = { build, resultLine, tally, opener, hashtags };
