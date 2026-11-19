#!/usr/bin/env node
/**
 * Leo NBA X posts (HO-0087 part B): the words, facts and hashtags for each
 * post, written from data Leo already has. The Manager's cards
 * (claude/picks-card.js, claude/share-card.js) draw the graphic from it and the
 * scheduled tasks email the text to Lynold to post.
 *
 *   node scripts/build-nba-social.js [YYYY-MM-DD]     default: today, New York
 *        [--now=<iso>] [--card=<picks file>]          for replays only
 *
 * Writes data/nba/social/<date>.json:
 *   {sport, date, posts:[{id, kind, created_at, header, lines, record, facts, hashtags, text, link}]}
 *   - "picks": Leo Picks for the slate ("Clippers ML (66%)"). With no Leo Pick,
 *     says so and lists Leo's 3 strongest reads to win, as the picks card does.
 *     Rewritten on each publish run until the first game of the date tips, then
 *     frozen, so it is the last read before the first start.
 *   - "wave-N": one results post per wave in data/nba/waves/<date>.json.
 *   - "day": the whole date, once every game with a Leo read is graded.
 *   A results post is never rewritten. Lines are each Leo Pick (graded at the
 *   read of record, data/nba/results-ledger.csv) and each read named in the
 *   picks post, with ✅ or ❌; misses stay in the list. With neither in a wave,
 *   the lines are Leo's winner in every game of the wave. record counts the
 *   calls (Leo Picks), not winners; on a night with no Leo Pick it counts the reads.
 *   facts: the miss reason for each lost call (data/nba/misses), how many
 *   winners Leo had, and the top scorer of the games named (data/nba/boxscores).
 *   hashtags: #NBAPicks plus the season tag of up to 3 teams named
 *   (data/nba/social/hashtags.json).
 *
 * Rules (ADMIN_RULES.md "Post voice", HO-0087): numbers only from the files,
 * no sportsbook name, line or price, never "bet", "lock" or "tail", no dashes,
 * no exclamation marks, ends with the link and 21+. Display only: nothing
 * here feeds the model or the grades.
 */
const fs = require("fs");
const path = require("path");
const URLS = require("./lib/nba-urls");

const ROOT = path.join(__dirname, ".."), DIR = path.join(ROOT, "data", "nba"), SDIR = path.join(DIR, "social");
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || "").split("=").slice(1).join("=");
const nyDate = d => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const DATE = process.argv.slice(2).find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || nyDate(new Date());
const NOW = arg("now") ? new Date(arg("now")) : new Date();
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const [head, ...lines] = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const h = head.split(",");
  return lines.map(l => { const c = l.split(","); return Object.fromEntries(h.map((k, i) => [k, c[i] ?? ""])); });
}
const pct = p => `${Math.round(p * 100)}%`;
const weekday = d => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
const TAGS = readJson(path.join(SDIR, "hashtags.json"), { picks_tag: "#NBAPicks", teams: {} });
const MARK = { win: "✅", loss: "❌", push: "➖" };
const fmtPrice = x => (+x > 0 ? "+" : "") + Math.round(+x);
const fmtU = u => (u >= 0 ? "+" : "") + (+u).toFixed(2) + "u";
const PK = require("./lib/nba-picks");
const SW = require("./lib/nba-swing");
// "Depends on <player>" under a Leo Pick whose read rests on an open day-to-day status (HO-0097).
const depends = i => { const g = games.find(x => String(x.game_id) === i.game_id); const t = g ? SW.line(g) : ""; return t ? [t] : []; };

const card = readJson(arg("card") || path.join(DIR, `picks-${DATE}.json`), null);
if (!card) { console.log(`NBA social ${DATE}: no card.`); process.exit(0); }
const games = (card.games || []).filter(g => g.leo && g.tip_utc).sort((a, b) => a.tip_utc.localeCompare(b.tip_utc));
const byGame = new Map(games.map(g => [String(g.game_id), g]));
const nick = (g, side) => URLS.nick(g[side], g[side + "_name"]);
const code = (g, side) => g[side];
const ledger = new Map(readCsv(path.join(DIR, "results-ledger.csv")).filter(r => r.date === DATE).map(r => [String(r.game_id), r]));
const misses = new Map((readJson(path.join(DIR, "misses", `${DATE}.json`), { games: [] }).games || []).map(m => [String(m.game_id), m]));
const box = new Map((readJson(path.join(DIR, "boxscores", `${DATE}.json`), { games: [] }).games || []).map(b => [String(b.game_id), b]));
const waves = readJson(path.join(DIR, "waves", `${DATE}.json`), { waves: [] }).waves || [];

const file = path.join(SDIR, `${DATE}.json`);
const doc = readJson(file, null) || { sport: "nba", date: DATE, posts: [] };
const has = id => doc.posts.some(p => p.id === id);

function hashtags(codes) {
  const out = [TAGS.picks_tag || "#NBAPicks"];
  for (const c of codes) { const t = (TAGS.teams[c] || {}).primary; if (t && !out.includes(t) && out.length < 4) out.push(t); }
  return out;
}
// Same shape as the NFL posts (Lynold, NFL chat 2026-11-16): header, plain record, lines with
// winners on top, facts, then the link, "21+" and the hashtags. No "BANG", no "Leo saw it", no ✨.
// Every post link is a short link that forwards with the X campaign tag (SEO-24, HO-0093 part B), so a sign-up shows which post brought it.
const XL = require("./lib/x-links");   // short links: ndhorizon.com/x/nba-1117-day (Lynold, 2026-11-18)
const tagged = (url, id) => XL.short("nba", DATE, id, url);
// Lynold, 2026-11-18: no "21+", no "Every call graded, misses included", no labels like "miss: variance".
// Header, the lines, one plain record line, the short link (shown without https://), the hashtags.
function compose(header, _open, lines, recordLine, tags, link) {
  const parts = [header, "", ...lines, "", recordLine || null, String(link).replace(/^https?:\/\//, ""), tags.join(" ")];
  return parts.filter(x => x !== null).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
// One plain line (Lynold, 2026-11-18, "Bare minimum"): "0-2 tonight, 15-10 on the season".
function plainRecord(mode, counted, hit, n, season) {
  if (mode === "winners") return n === 1 ? (hit ? "Leo had the winner" : "Leo missed the winner") : `Leo had ${hit} of ${n} winners tonight`;
  const r = recordOf(counted);
  const s = String(season || "").split(",")[0].trim();
  return `${r.w}-${r.l}${r.p ? `-${r.p}` : ""} tonight${mode === "picks" && s ? `, ${s} on the season` : ""}`;
}
function recordOf(items) {
  const w = items.filter(i => i.result === "win").length, l = items.filter(i => i.result === "loss").length, p = items.filter(i => i.result === "push").length;
  const s = `${w}-${l}${p ? `-${p}` : ""}`;
  const priced = items.filter(i => i.units != null), u = priced.reduce((t, i) => t + i.units, 0);
  const tail = priced.length ? `, ${fmtU(u)}` : "";
  return { w, l, p, text: (w + l ? `${s} (${Math.round(100 * w / (w + l))}%)` : s) + tail, short: s + tail };
}

/* ---------- picks post ---------- */
function picksPost() {
  const open = games.filter(g => new Date(g.tip_utc) > NOW);
  if (!open.length) return null;
  const items = [];
  for (const g of open) {
    const pk = g.leo.pick;
    if (pk && pk.ok !== false) items.push({ game_id: String(g.game_id), type: "pick", side: pk.side, p: pk.p, price: pk.price, team: nick(g, pk.side), code: code(g, pk.side) });
  }
  let kind = "picks";
  if (!items.length) {
    kind = "reads";
    open.map(g => ({ g, side: g.leo.p_home >= g.leo.p_away ? "home" : "away", p: Math.max(g.leo.p_home, g.leo.p_away) }))
      .sort((a, b) => b.p - a.p).slice(0, 3)
      .forEach(({ g, side, p }) => items.push({ game_id: String(g.game_id), type: "read", side, p, team: nick(g, side), code: code(g, side), why: (g.leo.pick && g.leo.pick.why) || "" }));
  }
  const header = `${weekday(DATE)} night 🏀 What would Leo do?`;
  // The price shown is the locked price the pick is graded at (DEC-20261116-30); the % is Leo's chance to win.
  // Lynold, 2026-11-18: "start being more human like. not so much of a bot." Picks only, no chance or notes.
  const lines = [...(kind === "picks" ? [] : [PK.noPickDay && PK.noPickDay(DATE) ? "No picks on Mondays. Leo likes:" : "No picks tonight. Leo likes:"]),
    ...items.map(i => i.type === "pick" ? `${i.team} ML ${fmtPrice(i.price)}` : i.team)];
  const facts = [];
  const tags = hashtags(items.map(i => i.code));
  const link = tagged(`https://ndhorizon.com/nba/predictions/${DATE}/`, "picks");
  // For the graphic on a no-pick night (Lynold, Nov 19: the card printed "LEO PICKS" over three passes).
  // One plain reason, only when it is true of every team listed.
  let note = "";
  if (kind === "reads") {
    const w = items.map(i => i.why || "");
    note = PK.noPickDay && PK.noPickDay(DATE) ? "Leo makes no picks on Mondays"
      : w.every(x => /^priced /.test(x)) ? "Leo likes them, but the price is too high"
      : w.every(x => x && !/^priced /.test(x) && !/Mondays/.test(x)) ? "None of them reached Leo's 60% bar"
      : "Too close or too pricey to call";
  }
  return { id: "picks", kind: "picks", created_at: NOW.toISOString(), header, lines, record: "", facts, hashtags: tags, nopick: kind === "reads", note,
    text: compose(header, null, lines, null, tags, link), link, items };
}

/* ---------- results posts ---------- */
function topScorer(gid) {
  const b = box.get(gid); if (!b) return null;
  const pl = (b.players || []).filter(p => !p.dnp && p.stats).map(p => ({ name: p.name, team: p.team, pts: +p.stats.points || 0, reb: +p.stats.rebounds || 0, ast: +p.stats.assists || 0 }));
  if (!pl.length) return null;
  pl.sort((a, b) => b.pts - a.pts);
  const t = pl[0], g = byGame.get(gid);
  const side = g && t.team === g.home ? "home" : "away", tn = g ? nick(g, side) : t.team;
  const won = g && ((side === "home") === (+b.home_score > +b.away_score));
  const triple = [t.pts, t.reb, t.ast].filter(x => x >= 10).length >= 3;
  const extra = triple ? `, ${t.reb} reb, ${t.ast} ast, a triple double` : t.reb >= 10 ? `, ${t.reb} reb` : t.ast >= 10 ? `, ${t.ast} ast` : "";
  return `${t.name} ${t.pts} pts${extra} in the ${tn} ${won ? "win" : "loss"}`;
}
function resultsPost(id, gids, last) {
  const posted = (doc.posts.find(p => p.id === "picks") || {}).items || [];
  const items = [];
  for (const gid of gids) {
    const r = ledger.get(gid), g = byGame.get(gid); if (!r || !g) continue;
    const winSide = +r.home_score > +r.away_score ? "home" : "away";
    if (r.pick_result) { items.push({ gid, type: "pick", side: r.pick_side, team: nick(g, r.pick_side), code: code(g, r.pick_side), result: r.pick_result, price: r.pick_price, units: +r.pick_units }); continue; }
    const rd = posted.find(i => i.game_id === gid && i.type === "read");
    if (rd) items.push({ gid, type: "read", side: rd.side, team: rd.team, code: rd.code, result: rd.side === winSide ? "win" : "loss" });
  }
  let mode = items.some(i => i.type === "pick") ? "picks" : items.length ? "reads" : "winners";
  if (mode === "winners") for (const gid of gids) {
    const r = ledger.get(gid), g = byGame.get(gid); if (!r || !g) continue;
    const side = +r.leo_p_home >= 0.5 ? "home" : "away";
    items.push({ gid, type: "winner", side, team: nick(g, side), opp: nick(g, side === "home" ? "away" : "home"), code: code(g, side), result: r.leo_winner_correct === "1" ? "win" : "loss" });
  }
  if (!items.length) return null;
  const ORDER = { win: 0, push: 1, loss: 2 };   // winners on top, losers on bottom (Lynold); tip order within each
  items.sort((a, b) => ORDER[a.result] - ORDER[b.result]);
  const lines = items.map(i => i.type === "pick" ? `${i.team} ML ${fmtPrice(i.price)} ${MARK[i.result]}`
    : (i.type === "read" ? `${i.team} to win` : `${i.team} over ${i.opp}`) + ` ${MARK[i.result]}`);
  // record counts calls (Leo Picks); on a night with none, the reads named in the picks post.
  // Leo's winner in each game is shown, never counted as a record (Lynold: people care about the calls).
  const counted = mode === "picks" ? items.filter(i => i.type === "pick") : mode === "reads" ? items : [];
  const rec = recordOf(counted);
  const hit = items.filter(i => i.result === "win").length;
  const open = mode === "winners" ? `Leo had the winner in ${hit} of ${items.length}` : mode === "reads" ? `Leo's reads ${rec.text}` : rec.text;
  const facts = [];
  for (const i of items.filter(x => x.result === "loss" && x.type !== "winner")) {
    const m = (misses.get(i.gid) || {}).miss;
    if (m && m.label) facts.push(`${i.team} miss: ${m.label.toLowerCase()}`);
  }
  for (const i of items) { const m = misses.get(i.gid); if (m && m.overtime) facts.push(`${nick(byGame.get(i.gid), "away")} at ${nick(byGame.get(i.gid), "home")} went to overtime`); }
  const rows = gids.map(g => ledger.get(g)).filter(Boolean);
  if (mode !== "winners" && rows.length) facts.push(`Leo had the winner in ${rows.filter(r => r.leo_winner_correct === "1").length} of ${rows.length}${last ? " tonight" : ""}`);
  for (const i of items) { if (facts.length >= 3) break; const f = topScorer(i.gid); if (f && !facts.includes(f)) facts.push(f); }
  if (id === "day" && facts.length < 3) {   // the night's top scorer, when not already named
    const best = gids.map(g => [g, topScorer(g)]).filter(x => x[1]).sort((a, b) => +b[1].match(/ (\d+) pts/)[1] - +a[1].match(/ (\d+) pts/)[1])[0];
    if (best && !facts.includes(best[1])) facts.push(`${best[1]}, the top score tonight`);
  }
  const header = id === "day" || last ? `NBA ${weekday(DATE)} 🏀` : `NBA so far 🏀`;
  const tags = hashtags(items.filter(i => i.result !== "loss").concat(items).map(i => i.code));
  const link = tagged("https://ndhorizon.com/nba/results/", id);
  // Leo Picks season to date, from the day they were first counted (DEC-20261102-30), so units can be traced.
  let season = "";
  if (mode === "picks") {
    const all = readCsv(path.join(DIR, "results-ledger.csv")).filter(r => r.pick_result && r.date >= PK.TRACK_FROM && r.date <= DATE)
      .map(r => ({ result: r.pick_result, units: +r.pick_units }));
    season = recordOf(all).short;
  }
  return { id, kind: "results", created_at: NOW.toISOString(), header, lines, record: plainRecord(mode, counted, hit, items.length, season), season: "", facts: [], hashtags: tags,
    text: compose(header, null, lines, plainRecord(mode, counted, hit, items.length, season), tags, link), link };
}

/* ---------- write ---------- */
const changed = [];
const ONLY = arg("only");   // replays: "picks" or "results"
const firstTip = games.length ? new Date(games[0].tip_utc) : null;
if (ONLY !== "results" && (!has("picks") || (firstTip && NOW < firstTip))) {
  const p = picksPost();
  if (p) { doc.posts = doc.posts.filter(x => x.id !== "picks"); doc.posts.unshift(p); changed.push("picks"); }
}
for (const w of ONLY === "picks" ? [] : waves) {
  if (has(w.id)) continue;
  const p = resultsPost(w.id, w.games.map(g => String(g.game_id)), !w.still_playing);
  if (p) { doc.posts.push(p); changed.push(w.id); }
}
const allGraded = games.length && games.every(g => ledger.has(String(g.game_id)));
if (ONLY !== "picks" && !has("day") && allGraded) {
  const p = resultsPost("day", games.map(g => String(g.game_id)), true);
  if (p) { doc.posts.push(p); changed.push("day"); }
}
if (!changed.length) { console.log(`NBA social ${DATE}: nothing new.`); process.exit(0); }
fs.mkdirSync(SDIR, { recursive: true });
fs.writeFileSync(file, JSON.stringify(doc, null, 1) + "\n");
console.log(`NBA social ${DATE}: wrote ${changed.join(", ")}.`);
