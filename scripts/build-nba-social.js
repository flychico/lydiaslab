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
const EXV = require("./lib/extra-posts");   // hype voice helpers (DEC-20261120-05)
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
  // A team tag only when the post is about one team (Lynold, 2026-11-26: a five-team post carried one team's tag).
  const out = [TAGS.picks_tag || "#NBAPicks"], uniq = [...new Set((codes || []).filter(Boolean))];
  if (uniq.length === 1) { const t = (TAGS.teams[uniq[0]] || {}).primary; if (t) out.push(t); }
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
  return EXV.tail([header, "", ...lines, "", recordLine || null], link, tags).trim();   // link last (Nov 21)
}
// One plain line (Lynold, 2026-11-18, "Bare minimum"): "0-2 tonight, 15-10 on the season".
function plainRecord(mode, counted, hit, n, season) {
  if (mode === "winners") return n === 1 ? (hit ? "Leo had the winner" : "Leo missed the winner") : `Leo had ${hit} of ${n} winners tonight`;
  const r = recordOf(counted);
  const s = String(season || "").split(",")[0].trim();
  if (mode === "picks" && s && counted.length === 1) return `${s} on the season`;   // one pick: the mark says it (Nov 20 voice)
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
  for (const g of games) {   // every pick of the night, started or not (locked picks stay), so a later refresh never drops one
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
  // Cheat sheet look (Lynold, Nov 20, from an X post he liked): "NBA FRIDAY CHEAT SHEET 🏀", then
  // "What would Leo do?", then one bullet per pick with its price. A no-pick night drops "CHEAT SHEET".
  // Hype voice (Lynold, Nov 20, DEC-20261120-05): one pick is the night's NUKE; two or more are the
  // cheat sheet (the strongest also gets its own nuke post); "🔥 if you're with Leo" under the picks.
  const DAY = weekday(DATE).toUpperCase();
  const nPicks = items.filter(i => i.type === "pick").length;
  const title = nPicks === 1 ? `NBA ${DAY} NUKE ☢️` : nPicks ? `NBA ${DAY} CHEAT SHEET 🏀` : `NBA ${DAY} 🏀`;
  const header = title;
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
    hero: nPicks === 1 ? "Leo's nuke" : undefined,
    text: EXV.tail([title, "", ...lines.map(l => kind === "picks" && nPicks > 1 ? `• ${l}` : l), "", kind === "picks" ? EXV.WITH_LEO : null], link, tags), link, items };
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
  const header = mode === "picks" ? EXV.opener(rec.w, rec.l) : id === "day" || last ? `NBA ${weekday(DATE)} 🏀` : `NBA so far 🏀`;
  const tags = hashtags(items.filter(i => i.result !== "loss").concat(items).map(i => i.code));
  const link = tagged("https://ndhorizon.com/nba/results/", id);
  // Leo Picks season to date, from the day they were first counted (DEC-20261102-30), so units can be traced.
  let season = "";
  if (mode === "picks") {
    const all = readCsv(path.join(DIR, "results-ledger.csv")).filter(r => r.pick_result && r.date >= PK.TRACK_FROM && r.date <= DATE)
      .map(r => ({ result: r.pick_result, units: +r.pick_units }));
    season = recordOf(all).short;
  }
  return { id, kind: "results", mode, created_at: NOW.toISOString(), header, lines, record: plainRecord(mode, counted, hit, items.length, season), season: "", facts: [], hashtags: tags,
    text: compose(header, null, lines, plainRecord(mode, counted, hit, items.length, season), tags, link), link };
}

/* ---------- extra posts: reads, upset watch, spotlights, reads results (DEC-20261120-04) ---------- */
const EX = require("./lib/extra-posts");
const COPY = require("./lib/nba-game-copy");
function norm(g) {
  const m = g.market || {}, L = g.leo || {}, r = L.rating || {};
  let why = "";
  try { const o = (COPY.opening(g, {}) || []).filter(Boolean); why = [o[1], /^The injury/.test(o[2] || "") ? o[2] : null].filter(Boolean).join(" "); } catch (e) { why = ""; }
  // One short reason for the spotlight post (fits 280): the opponent's missing star, else the rating gap.
  const pSide = L.p_home >= 0.5 ? "home" : "away", oSide = pSide === "home" ? "away" : "home";
  const star = ((L.missing || {})[oSide] || []).filter(x => (x.weight || 0) >= 0.75 && (x.value || 0) >= 6).sort((a, b) => b.value - a.value)[0];
  const gap = Math.abs((+r.home || 0) - (+r.away || 0));
  const short = star ? `No ${star.name} for the ${nick(g, oSide)}` : gap >= 1 ? `${nick(g, pSide)} rate ${gap.toFixed(1)} points better this season` : "";
  return { short, id: String(g.game_id), away: nick(g, "away"), home: nick(g, "home"), awayCode: g.away, homeCode: g.home, tip: g.tip_utc,
    p_home: L.p_home, mlHome: m.home_ml, mlAway: m.away_ml, url: g.url || `https://ndhorizon.com/nba/predictions/${DATE}/`, why,
    strength: (+r.home || 0) + (+r.away || 0) };
}
function extraPosts() {
  const open = games.filter(g => new Date(g.tip_utc) > NOW && g.leo.p_home != null).map(norm);
  if (!open.length) return [];
  const dayTitle = `NBA ${weekday(DATE).toUpperCase()}`, now = NOW.toISOString();
  const night = tagged(`https://ndhorizon.com/nba/predictions/${DATE}/`, "reads");
  return [EX.readsPost({ sport: "nba", emoji: "🏀", dayTitle, games: open, link: night, tags: hashtags, now }),
    EX.upsetPost({ emoji: "🏀", dayTitle, games: open, link: tagged(`https://ndhorizon.com/nba/predictions/${DATE}/`, "upset"), tags: hashtags, now }),
    ...EX.spotlightPosts({ emoji: "🏀", games: open, tags: hashtags, now, linkFor: (g, id) => tagged(g.url, id) })].filter(Boolean);
}
function readsResults() {
  const results = games.map(g => { const r = ledger.get(String(g.game_id)); if (!r || r.leo_winner_correct === "") return null;
    const s = +r.leo_p_home >= 0.5 ? "home" : "away";
    const o = s === "home" ? "away" : "home";
    return { leo: nick(g, s), opp: nick(g, o), code: g[s], right: r.leo_winner_correct === "1", my: +r[s + "_score"], their: +r[o + "_score"],
      beatMarket: r.leo_winner_correct === "1" && r.mkt_winner_correct === "0" }; }).filter(Boolean);
  return EX.readsResultsPost({ emoji: "🏀", dayTitle: `NBA ${weekday(DATE).toUpperCase()}`, results, link: tagged("https://ndhorizon.com/nba/results/", "rday"), tags: hashtags, now: NOW.toISOString() });
}

// Bleacher Report style stat post (DEC-20261120-05): the night's best line from the box scores.
function statOfNight() {
  let best = null;
  for (const [gid, b] of box) {
    const g = byGame.get(gid); if (!g) continue;
    for (const p of b.players || []) {
      if (p.dnp || !p.stats) continue;
      const S = p.stats, pts = +S.points || 0, reb = +S.rebounds || 0, ast = +S.assists || 0, stl = +S.steals || 0, blk = +S.blocks || 0;
      const td = [pts, reb, ast, stl, blk].filter(x => x >= 10).length;
      const score = pts + (td >= 3 ? 25 : 0) + Math.max(0, reb - 12) + Math.max(0, ast - 10);
      if (!best || score > best.score) best = { score, p, g, b, pts, reb, ast, stl, blk, td };
    }
  }
  if (!best || (best.pts < 35 && best.td < 3)) return null;   // only a night worth posting about
  const { p, g, b, pts, reb, ast, stl, blk, td } = best, S = p.stats;
  const side = p.team === g.home ? "home" : "away", opp = side === "home" ? "away" : "home";
  const my = +b[side + "_score"], their = +b[opp + "_score"];
  const NAME = String(p.name).toUpperCase();
  const headline = td >= 3 ? `${NAME} TRIPLE DOUBLE 🤯` : `${NAME} ${pts}-POINT NIGHT 🤯`;
  const fg = S["fieldGoalsMade-fieldGoalsAttempted"], tp = S["threePointFieldGoalsMade-threePointFieldGoalsAttempted"], ft = S["freeThrowsMade-freeThrowsAttempted"];
  const stats = [td >= 3 ? `${pts} PTS` : null, fg ? `${fg} FG` : null, tp && tp !== "0-0" ? `${tp} 3PT` : null, ft && ft !== "0-0" ? `${ft} FT` : null,
    `${reb} REB`, `${ast} AST`, stl >= 3 ? `${stl} STL` : null, blk >= 3 ? `${blk} BLK` : null].filter(Boolean);
  const result = Number.isFinite(my) && Number.isFinite(their) ? (my > their ? `${nick(g, side)} beat the ${nick(g, opp)}, ${my} to ${their}` : `${nick(g, side)} fell to the ${nick(g, opp)}, ${their} to ${my}`) : "";
  return EXV.statPost({ headline, stats, result, link: tagged(g.url || `https://ndhorizon.com/nba/predictions/${DATE}/`, "stat"), tags: hashtags([g[side]]), now: NOW.toISOString(), player: p.name, team: nick(g, side) });
}

/* ---------- write ---------- */
const changed = [];
const ONLY = arg("only");   // replays: "picks" or "results"
// The picks post follows the card until the LAST game tips, not the first (Nov 22: on Nov 21 the Knicks pick was
// dropped and the Timberwolves added after the 1pm tip, and no updated post went out). Picks on games already
// started cannot change (the price lock keeps them), so only later games can move it; send-x-posts.js emails
// the change as "(updated)".
const firstTip = games.length ? new Date(Math.max(...games.map(g => Date.parse(g.tip_utc)).filter(Number.isFinite))) : null;
if (ONLY !== "results" && (!has("picks") || (firstTip && NOW < firstTip))) {
  const p = picksPost();
  if (p) { doc.posts = doc.posts.filter(x => x.id !== "picks"); doc.posts.unshift(p); changed.push("picks"); }
}
// The night's strongest pick gets its own nuke post when there are 2+ picks; follows the picks post until the first tip.
if (ONLY !== "results" && (!has("nuke") || (firstTip && NOW < firstTip))) {
  const pk = doc.posts.find(p => p.id === "picks");
  const picksOnly = pk ? (pk.items || []).filter(i => i.type === "pick") : [];
  if (picksOnly.length >= 2) {
    const top = picksOnly.slice().sort((a, b) => b.p - a.p)[0];
    const np = EXV.nukePost({ title: `NBA ${weekday(DATE).toUpperCase()} NUKE ☢️`, line: `${top.team} ML ${fmtPrice(top.price)}`, link: tagged(`https://ndhorizon.com/nba/predictions/${DATE}/`, "nuke"),
      tags: hashtags([top.code]), now: NOW.toISOString(), tip: (byGame.get(top.game_id) || {}).tip_utc });
    const old = doc.posts.find(p => p.id === "nuke");
    if (!old || JSON.stringify(old.lines) !== JSON.stringify(np.lines)) { doc.posts = doc.posts.filter(p => p.id !== "nuke"); doc.posts.splice(1, 0, np); changed.push("nuke"); }
  } else if (has("nuke") && firstTip && NOW < firstTip) { doc.posts = doc.posts.filter(p => p.id !== "nuke"); changed.push("nuke removed"); }
}
if (ONLY !== "results" && !has("reads")) {
  for (const p of extraPosts()) if (!has(p.id)) { doc.posts.push(p); changed.push(p.id); }
}
// Waves (Nov 21): post only a wave that settles a Leo Pick and is not the last of the night; the last
// one is the day post, and the reads are all in the one reads results post at the end (no repeats).
for (const w of ONLY === "picks" ? [] : waves) {
  if (has(w.id) || !w.still_playing) continue;
  const p = resultsPost(w.id, w.games.map(g => String(g.game_id)), false);
  if (p && p.mode === "picks") { doc.posts.push(p); changed.push(w.id); }
}
const allGraded = games.length && games.every(g => ledger.has(String(g.game_id)));
if (ONLY !== "picks" && !has("day") && allGraded) {
  const p = resultsPost("day", games.map(g => String(g.game_id)), true);
  if (p && p.mode === "picks") { doc.posts.push(p); changed.push("day"); }   // no-pick nights: the reads results post covers every game
}
if (ONLY !== "picks" && !has("stat") && allGraded) {
  const p = statOfNight();
  if (p) { doc.posts.push(p); changed.push("stat"); }
}
if (ONLY !== "picks" && !has("rday") && allGraded) {
  const day = doc.posts.find(p => p.id === "day");
  const p = readsResults();   // always the one reads post at the end; the day post now carries picks only
  if (p) { doc.posts.push(p); changed.push("rday"); }
}
if (!changed.length) { console.log(`NBA social ${DATE}: nothing new.`); process.exit(0); }
fs.mkdirSync(SDIR, { recursive: true });
fs.writeFileSync(file, JSON.stringify(doc, null, 1) + "\n");
console.log(`NBA social ${DATE}: wrote ${changed.join(", ")}.`);
