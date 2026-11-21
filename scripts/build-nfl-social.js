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
// HO-0093: tag every post link so the sign up form can say which post brought the reader.
const XL = require("./lib/x-links");   // short links: ndhorizon.com/x/nfl-1115-day (Lynold, 2026-11-18)
const utm = (link, id, date) => XL.short("nfl", date, id, link);
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
  if (mk === "ml") return `${nick(c.call)} ML${Number.isFinite(+c.price) && c.price !== "" && c.price != null ? " " + (+c.price > 0 ? "+" : "") + Math.round(+c.price) : ""}`;   // price shown (HO-0092; Lynold, Nov 20 "Keep prices")
  if (mk === "spread") return `${nick(c.call)} ${String(c.label).split(" ").slice(1).join(" ")}`;
  return `${nick(g.away)}/${nick(g.home)} ${c.label}`;
}
function slateHeader(date, week) {
  const day = new Date(date + "T12:00:00Z").getUTCDay();
  if (day === 1) return "Monday night 🏈";
  if (day === 4) return "Thursday night 🏈";
  return `Week ${week} 🏈`;
}
function cheatTitle(date, week) {
  const day = new Date(date + "T12:00:00Z").getUTCDay();
  if (day === 1) return "MONDAY NIGHT";
  if (day === 4) return "THURSDAY NIGHT";
  return `NFL WEEK ${week}`;
}
// Lynold, 2026-11-18: no "21+", no "Every call graded, misses included", more human, less bot.
const bare = link => String(link).replace(/^https?:\/\//, "");
function picksPost(date, existing) {
  const picks = readJson(path.join(DIR, `picks-${date}.json`));
  if (!Array.isArray(picks) || !picks.length) return null;
  const games = picks.slice().sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)) || a.matchup.localeCompare(b.matchup));
  // kickoff is "13:00" Eastern on the game date; Date.parse on it was NaN, so the post never froze (fixed Nov 20).
  const first = Math.min(...games.map(g => Date.parse(kickUtc(date, g.kickoff) || g.kickoff)).filter(Number.isFinite));
  if (existing && NOW() >= first) return existing;            // frozen at the first kickoff
  const READS = preKickoffReads(path.join(DIR, "prediction-history.csv"), date);
  const lines = [], teams = [], mlCalls = [];
  for (const g of games) {
    const reads = READS.get(g.game_id);
    const H = reads && reads.length ? CALLS.held(reads) : CALLS.calls(g);
    for (const mk of CALLS.MARKETS) {   // totals are information only (DEC-20261119-01)
      const l = callLine(mk, H[mk], g);
      if (l) { lines.push(l); if (mk !== "total") teams.push(H[mk].call);
        if (mk === "ml") mlCalls.push({ line: l, team: H.ml.call, p: H.ml.call === g.pick ? +g.model_prob : 1 - +g.model_prob, tip: kickUtc(date, g.kickoff) }); }
    }
  }
  const td = tdReads(date).slice(0, 3).map(r => `${r.player} ${pct(r.chance)}% to score`);
  const week = games[0].week;
  const one = games.length === 1;
  const link = utm(one && games[0].game_id ? pageUrl(date, games[0]) : `${SITE}/nfl/week/${date.slice(0, 4)}-week-${week}/`, "picks", date);
  const header = slateHeader(date, week);
  const tags = hashtags([...teams, ...games.flatMap(g => [g.home, g.away])]);
  // Lynold, Nov 16: "what would Leo do?"; Nov 18: plain, no 21+.
  // Cheat sheet look (Lynold, Nov 20): "NFL WEEK 12 CHEAT SHEET 🏈", "What would Leo do?", one bullet per call.
  // Hype voice (Lynold, Nov 20, DEC-20261120-05): one call is the NUKE, two or more the cheat sheet,
  // "🔥 if you're with Leo" under the calls; the strongest moneyline call also gets its own nuke post.
  const title = lines.length === 1 ? `${cheatTitle(date, week)} NUKE ☢️` : lines.length ? `${cheatTitle(date, week)} CHEAT SHEET 🏈` : `${cheatTitle(date, week)} 🏈`;
  const body = [title, ""];
  body.push(...(lines.length === 1 ? lines : lines.length ? lines.map(l => `• ${l}`) : ["No picks from Leo on this one."]));
  if (lines.length) body.push("", EX.WITH_LEO);
  if (td.length) body.push("", "Most likely to score:", ...td.map(l => `• ${l}`));
  body.push("", bare(link), tags.join(" "));
  return { id: "picks", kind: "picks", created_at: new Date(NOW()).toISOString(), header: title, lines, record: null, hero: lines.length === 1 ? "Leo's nuke" : undefined,
    facts: td, hashtags: tags, text: body.join("\n"), link, ml_calls: mlCalls, n_calls: lines.length };
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
const dayTitle = date => new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
// The three calls since Nov 2, from the waves file's season block (written by build-nfl-waves.js).
function seasonRec(date) {
  const w = readJson(path.join(DIR, "waves", `${date}.json`));
  const s = w && w.season; if (!s) return "";
  let W = 0, L = 0, P = 0;
  for (const k of Object.keys(s)) { if (!CALLS.MARKETS.includes(k === "moneyline" ? "ml" : k)) continue; W += +s[k].w || 0; L += +s[k].l || 0; P += +s[k].p || 0; }
  return W + L ? `${W}-${L}${P ? "-" + P : ""}` : "";
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
  const header = EX.opener(t.w != null ? t.w : calls.filter(c => c.result === "W").length, t.l != null ? t.l : calls.filter(c => c.result === "L").length, "DAY");   // hype voice (DEC-20261120-05)
  const winners = calls.filter(c => c.result === "W").map(c => c.g.winner).filter(Boolean);
  const tags = hashtags([...winners, ...games.flatMap(g => [g.winner, g.loser])]);
  const link = utm(`${SITE}/nfl/results/`, id, date);
  // One plain line (Lynold, 2026-11-18, "Bare minimum"): "9-4 today, 17-14 since Nov 2".
  const record = `${t.rec} ${id === "day" ? "on the day" : "so far today"}${seasonRec(date) ? `, ${seasonRec(date)} since Nov 2` : ""}`;
  const body = [header, "", ...lines, "", record, bare(link), tags.join(" ")];
  return { id, kind: "results", created_at: new Date(NOW()).toISOString(), header, lines, record, facts: [],
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

// ---------- extra posts: reads, upset watch, spotlights, reads results (DEC-20261120-04) ----------
const EX = require("./lib/extra-posts");
function kickUtc(date, hhmm) {   // "13:00" Eastern on date -> ISO
  if (!/^\d{1,2}:\d{2}$/.test(hhmm || "")) return null;
  const [h, m] = hhmm.split(":").map(Number);
  const guess = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m);
  const et = +new Date(guess).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit" }) % 24;
  return new Date(guess + ((h - et + 24) % 24) * 36e5).toISOString();
}
function extraPosts(date) {
  const picks = readJson(path.join(DIR, `picks-${date}.json`));
  if (!Array.isArray(picks) || !picks.length) return [];
  const mj = readJson(path.join(DIR, "matchups", `${date}.json`));
  const mlist = Array.isArray(mj) ? mj : (mj && mj.games) || [];
  let PC = null; try { PC = require("./lib/nfl-page-copy"); } catch (e) { PC = null; }
  const open = picks.map(g => {
    const tip = kickUtc(date, g.kickoff); if (!tip || Date.parse(tip) <= NOW()) return null;
    const p = +g.model_prob; if (!Number.isFinite(p) || !g.pick) return null;
    const m = mlist.find(y => y.game_id === g.game_id);
    let why = ""; try { why = PC && m ? PC.biggestDriver(m) : ""; } catch (e) { why = ""; }
    return { id: g.game_id, away: nick(g.away), home: nick(g.home), awayCode: g.away, homeCode: g.home, tip,
      p_home: g.pick === g.home ? p : 1 - p, mlHome: g.home_ml, mlAway: g.away_ml, url: pageUrl(date, g), why,
      strength: (+g.home_rating || 0) + (+g.away_rating || 0) };
  }).filter(Boolean);
  if (!open.length) return [];
  const week = picks[0].week, title = cheatTitle(date, week), now = new Date(NOW()).toISOString();
  const weekPage = `${SITE}/nfl/week/${date.slice(0, 4)}-week-${week}/`;
  return [EX.readsPost({ sport: "nfl", emoji: "🏈", dayTitle: title, games: open, link: utm(weekPage, "reads", date), tags: hashtags, now }),
    EX.upsetPost({ emoji: "🏈", dayTitle: title, games: open, link: utm(weekPage, "upset", date), tags: hashtags, now }),
    ...EX.spotlightPosts({ emoji: "🏈", games: open, tags: hashtags, now, linkFor: (g, id) => utm(g.url, id, date) })].filter(Boolean);
}
// QB matchup facts (Lynold, Nov 20: "Bo Nix has never lost to the Raiders, Purdy struggles against the
// Vikings"; DEC-20261120-08). Content only, never a pick: each starter's record as the starting QB against
// this opponent, from nflverse games.csv, the notable ones only (2+ starts and lopsided, or 5+ starts).
const REN = { OAK: "LV", SD: "LAC", STL: "LA", LAR: "LA" };
function qbFactsPost(date) {
  const picks = readJson(path.join(DIR, `picks-${date}.json`));
  if (!Array.isArray(picks) || !picks.length) return null;
  let rows;
  try { rows = parseCsv(curl("https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv")); } catch (e) { return null; }
  const t = x => REN[x] || x;
  const facts = [];
  for (const g of picks) {
    if (!kickUtc(date, g.kickoff) || Date.parse(kickUtc(date, g.kickoff)) <= NOW()) continue;
    for (const [qb, team, opp] of [[g.away_qb, g.away, g.home], [g.home_qb, g.home, g.away]]) {
      if (!qb) continue;
      let w = 0, l = 0;
      for (const r of rows) {
        if (r.home_score === "" || !["REG", "WC", "DIV", "CON", "SB"].includes(r.game_type)) continue;
        const side = r.home_qb_name === qb ? "home" : r.away_qb_name === qb ? "away" : null; if (!side) continue;
        if (t(r[(side === "home" ? "away" : "home") + "_team"]) !== opp) continue;
        const my = +r[side + "_score"], th = +r[(side === "home" ? "away" : "home") + "_score"];
        if (my > th) w++; else if (my < th) l++;
      }
      const n = w + l, rate = n ? w / n : 0.5;
      if (n >= 2 && (rate >= 0.75 || rate <= 0.25) || n >= 5) facts.push({ qb, team, opp, w, l, score: n * Math.abs(rate - 0.5) + (rate <= 0.25 ? 0.3 : 0) });   // losing records draw more reaction
    }
  }
  if (!facts.length) return null;
  facts.sort((a, b) => b.score - a.score);
  const top = facts.slice(0, 6);
  const lines = top.map(f => `${f.qb} ${f.w}-${f.l} vs ${nick(f.opp)}`);
  const week = picks[0].week, title = `WEEK ${week} QB MATCHUPS 🤯`;
  const tags = hashtags(top.map(f => f.team));
  const link = utm(`${SITE}/nfl/previews/`, "picks", date);
  return { id: "qbfacts", kind: "reads", hero: "QB matchups", note: "Starting QBs vs this opponent", created_at: new Date(NOW()).toISOString(),
    tip_utc: picks.map(g => kickUtc(date, g.kickoff)).filter(Boolean).sort()[0], header: title, lines, record: "", facts: [], hashtags: tags,
    text: [title, "", ...top.map(f => `• ${f.qb} is ${f.w}-${f.l} vs the ${nick(f.opp)}`), "", bare(link), tags.join(" ")].join("\n"), link };
}
function readsResults(date, rvGames) {
  const results = rvGames.filter(g => g.leo && g.leo.pick && g.leo_right_winner != null).map(g => {
    const opp = g.leo.pick === g.home ? g.away : g.home;
    const sc = g.score && typeof g.score === "object" ? g.score : {};
    const my = g.leo.pick === g.home ? +sc.home : +sc.away, their = g.leo.pick === g.home ? +sc.away : +sc.home;
    return { leo: nick(g.leo.pick), opp: nick(opp), code: g.leo.pick, right: !!g.leo_right_winner, my, their };
  });
  return EX.readsResultsPost({ emoji: "🏈", dayTitle: `NFL ${dayTitle(date).toUpperCase()}`, results, link: utm(`${SITE}/nfl/results/`, "rday", date), tags: hashtags, now: new Date(NOW()).toISOString() });
}

// Bleacher Report style stat post (DEC-20261120-05): the day's best line, from the same player stats as the facts.
function statOfDay(date, week, rvGames) {
  const P = playerStats(date, week); if (!P || !rvGames.length) return null;
  const teams = new Set(rvGames.flatMap(g => [g.away, g.home]));
  const all = [...P.values()].filter(p => teams.has(p.team));
  const score = p => (p.pass_tds || 0) * 9 + (p.tds || 0) * 10 + (p.pass_yds || 0) / 40;
  const best = all.sort((a, b) => score(b) - score(a))[0];
  if (!best || ((best.pass_tds || 0) < 4 && (best.tds || 0) < 3)) return null;   // only a day worth posting about
  const NAME = String(best.name).toUpperCase();
  const passing = (best.pass_tds || 0) >= 4;
  const headline = passing ? `${NAME} ${best.pass_tds} TD DAY 🤯` : `${NAME} ${best.tds} TOUCHDOWNS 🤯`;
  const stats = passing ? [best.cmp != null && best.att != null ? `${best.cmp}-${best.att}` : null, best.pass_yds ? `${best.pass_yds} YDS` : null, `${best.pass_tds} TD`, best.tds ? `${best.tds} RUSH/REC TD` : null].filter(Boolean)
    : [`${best.tds} TD`, best.pass_tds ? `${best.pass_tds} TD PASSES` : null].filter(Boolean);
  const g = rvGames.find(x => x.away === best.team || x.home === best.team);
  const won = g && g.winner === best.team, opp = g ? (g.away === best.team ? g.home : g.away) : null;
  const sc = g && g.score ? (typeof g.score === "object" ? [+g.score.away, +g.score.home] : null) : null;
  const mine = sc ? (g.away === best.team ? sc[0] : sc[1]) : null, theirs = sc ? (g.away === best.team ? sc[1] : sc[0]) : null;
  const result = g && Number.isFinite(mine) && Number.isFinite(theirs) ? `${nick(best.team)} ${won ? "beat" : "fell to"} the ${nick(opp)}, ${Math.max(mine, theirs)} to ${Math.min(mine, theirs)}` : "";
  const link = utm(g && g.url ? (String(g.url).startsWith("http") ? g.url : SITE + g.url) : `${SITE}/nfl/results/`, "stat", date);
  return EX.statPost({ headline, stats, result, link, tags: hashtags([best.team]), now: new Date(NOW()).toISOString(), player: best.name, team: nick(best.team) });
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

  if (!has("reads")) for (const p of extraPosts(date)) if (!has(p.id)) { set(p); changed = true; }
  if (!has("qbfacts") && has("reads")) { const q = qbFactsPost(date); if (q) { set(q); changed = true; } }
  // Strongest moneyline call as its own nuke post when there are 2+ calls (label only, graded at 1 unit).
  const pkNow = has("picks");
  if (pkNow && (pkNow.n_calls || 0) >= 2 && (pkNow.ml_calls || []).length) {
    const top = pkNow.ml_calls.slice().sort((a, b) => b.p - a.p)[0];
    const np = EX.nukePost({ title: `${cheatTitle(date, (readJson(path.join(DIR, `picks-${date}.json`)) || [{}])[0].week)} NUKE ☢️`, line: top.line,
      link: utm(`${SITE}/nfl/week/${date.slice(0, 4)}-week-${(readJson(path.join(DIR, `picks-${date}.json`)) || [{}])[0].week}/`, "nuke", date), tags: hashtags([top.team]), now: new Date(NOW()).toISOString(), tip: top.tip });
    const old = has("nuke");
    if (NOW() < Date.parse(top.tip || 0) && (!old || JSON.stringify(old.lines) !== JSON.stringify(np.lines))) { set(np); changed = true; }
  }

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
  if (has("day") && !has("rday") && rvGames.length > 1) { const p = readsResults(date, rvGames); if (p) { set(p); changed = true; } }
  if (has("day") && !has("stat")) { const p = statOfDay(date, week, rvGames); if (p) { set(p); changed = true; } }
  doc.posts = doc.posts.filter(Boolean);
  if (!changed) { console.log(`NFL social ${date}: nothing new (${doc.posts.length} post(s)).`); return doc; }
  const order = id => id === "picks" ? 0 : id === "nuke" ? 0.05 : id === "stat" ? 10001 : id === "reads" ? 0.1 : id === "upset" ? 0.2 : id === "qbfacts" ? 0.25 : /^g\d$/.test(id) ? 0.3 + +id.slice(1) / 10 : id === "day" ? 9999 : id === "rday" ? 10000 : 1 + (parseInt(String(id).split("-")[1], 10) || 0);
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
