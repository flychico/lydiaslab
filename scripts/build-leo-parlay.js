#!/usr/bin/env node
/**
 * Leo Parlay (Lynold, Manager chat, Nov 19): one parlay a day from Leo's own
 * moneyline picks across sports, posted on any day with 2 or more legs, graded
 * publicly with its own record (never mixed into the moneyline and spread record).
 * He chose "Moneyline picks only", "Any day with 2+ legs", "Public, its own record",
 * "Leo Parlay". DEC-20261119-10.
 *
 *   node scripts/build-leo-parlay.js [date ...]     default: today and yesterday (ET)
 *
 * Legs: NBA Leo Picks on that date's card (leo.pick.ok, at the locked price,
 * data/nba/pick-locks) and NFL moneyline calls on that date (scripts/lib/nfl-calls.js).
 * The parlay follows the picks until the first leg starts; from then on its legs
 * are frozen (a pick made later is not added). A leg whose pick is gone at
 * grading (no graded pick, or a push) drops out and the price is worked out
 * again from the rest. 1 unit at the combined price: a hit wins (decimal - 1)
 * units, a miss loses 1.
 *
 * Writes data/parlay/<date>.json, data/parlay/record.json, the X posts in
 * data/parlay/social/<date>.json (sent by scripts/send-x-posts.js parlay) and
 * the public page /parlay/ (record and every parlay). Never fails a run.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const NOW = process.env.PARLAY_NOW ? Date.parse(process.env.PARLAY_NOW) : Date.now();   // env only for replay tests
const FROM = process.env.PARLAY_FROM || "2026-11-20";   // first Leo Parlay (env only for replay tests)
const etDate = ms => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const read = f => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch (e) { return null; } };
const write = (f, o) => { fs.mkdirSync(path.dirname(path.join(ROOT, f)), { recursive: true }); fs.writeFileSync(path.join(ROOT, f), JSON.stringify(o, null, 1) + "\n"); };
const dec = am => (am > 0 ? 1 + am / 100 : 1 + 100 / -am);
const amer = d => (d >= 2 ? "+" + Math.round((d - 1) * 100) : String(Math.round(-100 / (d - 1))));
const fmtPrice = p => (p > 0 ? "+" + p : String(p));
const lastWord = n => /Trail Blazers$/.test(n || "") ? "Trail Blazers" : String(n || "").split(" ").pop();

function etToUtc(date, hhmm) {
  if (!date || !/^\d{1,2}:\d{2}$/.test(String(hhmm || ""))) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const guess = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m);
  const et = new Date(guess).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const [md, t] = et.split(", "); const [mo, d, y] = md.split("/").map(Number); const [hh, mm] = t.split(":").map(Number);
  return new Date(guess - (Date.UTC(y, mo - 1, d, hh % 24, mm) - guess)).toISOString();
}

// Today's candidate legs, from the picks as they stand now.
function candidateLegs(date) {
  const legs = [];
  const card = read(`data/nba/picks-${date}.json`), locks = read(`data/nba/pick-locks/${date}.json`) || {};
  for (const g of (card && card.games) || []) {
    const pk = g.leo && g.leo.pick;
    if (!pk || !pk.ok) continue;
    const lock = (locks.games || {})[String(g.game_id)];
    const side = (lock && lock.side) || pk.side || (pk.team === g.home ? "home" : "away");
    const price = lock ? lock.price : pk.price;
    if (price == null) continue;
    legs.push({ sport: "nba", game_id: String(g.game_id), team: lastWord(g[side + "_name"]), code: g[side], price: +price, start_utc: g.tip_utc });
  }
  const nfl = read(`data/nfl/picks-${date}.json`);
  if (Array.isArray(nfl)) {
    const C = require("./lib/nfl-calls"), T = require("./lib/nfl-teams");
    for (const g of nfl) {
      const c = C.current(g.calls || C.calls(g), g);
      if (!c || !c.ml || !c.ml.call || c.ml.price == null) continue;
      legs.push({ sport: "nfl", game_id: String(g.game_id), team: T.nick(c.ml.call), code: c.ml.call, away: g.away, home: g.home, price: +c.ml.price, start_utc: etToUtc(g.date, g.kickoff) });
    }
  }
  return legs.sort((a, b) => String(a.start_utc).localeCompare(String(b.start_utc)));
}

// W, L, P or "" (not graded yet) for one leg.
function legResult(date, leg) {
  if (leg.sport === "nba") {
    const csv = (() => { try { return fs.readFileSync(path.join(ROOT, "data/nba/results-ledger.csv"), "utf8"); } catch (e) { return ""; } })();
    const lines = csv.split("\n"); const head = (lines[0] || "").split(",");
    const iD = head.indexOf("date"), iG = head.indexOf("game_id"), iR = head.indexOf("pick_result"), iT = head.indexOf("pick_team");
    for (const l of lines.slice(1)) {
      const c = l.split(",");
      if (c[iD] === date && c[iG] === leg.game_id) {
        if (c[iR]) return c[iT] && c[iT] !== leg.code ? "VOID" : ({ win: "W", loss: "L", push: "P" }[c[iR].toLowerCase()] || c[iR].toUpperCase().slice(0, 1));
        // graded game with no pick at the read of record: the leg is void
        return c[head.indexOf("winner")] || c[head.indexOf("home_score")] ? "VOID" : "";
      }
    }
    return "";
  }
  const rv = read("data/nfl/results-review.json");
  const g = rv && (rv.games || []).find(x => x.date === date && x.away === leg.away && x.home === leg.home);
  if (!g) return "";
  const c = (g.calls || []).find(x => x.market === "ml");
  return c ? c.result : g.score ? "VOID" : "";
}

function build(date) {
  if (date < FROM) return null;
  const file = `data/parlay/${date}.json`;
  const saved = read(file);
  const started = saved && saved.legs && saved.legs.some(l => l.start_utc && Date.parse(l.start_utc) <= NOW);
  let legs = started ? saved.legs : candidateLegs(date);
  // once any leg has started the legs never change
  if (!started && legs.some(l => l.start_utc && Date.parse(l.start_utc) <= NOW)) legs = saved ? saved.legs : [];
  if (!legs || legs.length < 2) { if (saved) write(file, { ...saved, status: saved.status === "graded" ? "graded" : "none" }); return null; }
  const priceD = legs.reduce((a, l) => a * dec(l.price), 1);
  const out = { date, legs: legs.map(l => ({ ...l })), price: amer(priceD), decimal: +priceD.toFixed(4), status: "open" };
  if (started || legs.some(l => l.start_utc && Date.parse(l.start_utc) <= NOW)) out.status = "frozen";
  // grading
  const res = out.legs.map(l => (l.result = legResult(date, l)));
  if (out.status === "frozen" && res.every(r => r)) {
    const live = out.legs.filter(l => l.result === "W" || l.result === "L");
    if (live.some(l => l.result === "L")) { out.result = "L"; out.units = -1; }
    else if (live.length >= 1) { const d = live.reduce((a, l) => a * dec(l.price), 1); out.result = "W"; out.units = +(d - 1).toFixed(2); out.graded_price = amer(d); }
    else { out.result = "P"; out.units = 0; }
    out.status = "graded";
  }
  write(file, out);
  return out;
}

function record() {
  const dir = path.join(ROOT, "data/parlay");
  const days = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
    .map(f => read(`data/parlay/${f}`)).filter(p => p && p.legs && p.legs.length >= 2 && p.status !== "none");
  const g = days.filter(p => p.status === "graded");
  const rec = { from: FROM, w: g.filter(p => p.result === "W").length, l: g.filter(p => p.result === "L").length, p: g.filter(p => p.result === "P").length,
    units: +g.reduce((a, p) => a + (p.units || 0), 0).toFixed(2), n: g.length, parlays: days.map(p => ({ date: p.date, price: p.price, status: p.status, result: p.result || "", units: p.units ?? null, legs: p.legs.map(l => ({ sport: l.sport, team: l.team, price: l.price, result: l.result || "" })) })) };
  write("data/parlay/record.json", rec);
  return rec;
}

const EMO = { nba: "🏀", nfl: "🏈", mlb: "⚾" };
const weekday = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
const recLine = r => `Leo Parlays ${r.w}-${r.l}${r.p ? "-" + r.p : ""}, ${r.units >= 0 ? "+" : ""}${r.units.toFixed(2)}u since Nov 20`;

function posts(date, p, rec) {
  const f = `data/parlay/social/${date}.json`;
  const doc = read(f) || { sport: "parlay", date, posts: [] };
  let link = "https://ndhorizon.com/parlay/";
  try { link = require("./lib/x-links").short("leo", date, "parlay", "https://ndhorizon.com/parlay/"); } catch (e) {}
  const bare = link.replace(/^https?:\/\//, "");
  const sports = [...new Set(p.legs.map(l => l.sport))];
  const tags = sports.map(s => s === "nba" ? "#NBAPicks" : s === "nfl" ? "#NFLPicks" : "").filter(Boolean);
  const header = `${weekday(date).toUpperCase()} LEO PARLAY 🎰 What would Leo do?`;
  const pickLines = p.legs.map(l => `${EMO[l.sport]} ${l.team} ML ${fmtPrice(l.price)}`);
  const pick = { id: "picks", kind: "picks", parlay: true, note: `${p.price} if all ${p.legs.length} hit`, created_at: new Date(NOW).toISOString(), header, lines: pickLines, record: p.price, facts: [], hashtags: tags,
    text: [`${weekday(date).toUpperCase()} LEO PARLAY 🎰`, "What would Leo do?", "", ...pickLines.map(l => `• ${l}`), "", `${p.price} if all ${p.legs.length} hit`, "", bare, tags.join(" ")].join("\n"), link };   // cheat sheet look (Lynold, Nov 20)
  const i = doc.posts.findIndex(x => x.id === "picks");
  if (p.status === "open") { if (i >= 0) doc.posts[i] = pick; else doc.posts.unshift(pick); }
  else if (i < 0) doc.posts.unshift(pick);
  if (p.status === "graded" && !doc.posts.some(x => x.id === "day")) {
    const mark = r => (r === "W" ? " ✅" : r === "L" ? " ❌" : " ➖");
    const ord = r => (r === "W" ? 0 : r === "L" ? 2 : 1);   // winners on top, losers at the bottom
    const lines = p.legs.slice().sort((a, b) => ord(a.result) - ord(b.result)).map(l => `${EMO[l.sport]} ${l.team} ML ${fmtPrice(l.price)}${mark(l.result)}`);
    const head = p.result === "W" ? `Leo Parlay hit ${p.graded_price || p.price} 🎰` : p.result === "L" ? `${weekday(date)} Leo Parlay 🎰` : `${weekday(date)} Leo Parlay 🎰`;
    const recTxt = recLine(rec);
    doc.posts.push({ id: "day", kind: "results", parlay: true, created_at: new Date(NOW).toISOString(), header: head, lines, record: recTxt, facts: [], hashtags: tags,
      text: [head, "", ...lines, "", recTxt, "", bare, tags.join(" ")].join("\n"), link });
  }
  write(f, doc);
}

function page(rec) {
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const day = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  const mark = r => (r === "W" ? '<span class="won">Won</span>' : r === "L" ? '<span class="lost">Lost</span>' : r === "P" || r === "VOID" ? '<span class="dim">Void</span>' : '<span class="dim">Not final</span>');
  const rows = rec.parlays.slice().reverse().map(p => `<article class="card"><h3 style="margin:0 0 6px">${esc(day(p.date))} &middot; ${esc(p.price)}${p.status === "graded" ? " &middot; " + (p.result === "W" ? '<span class="won">Hit, +' + p.units.toFixed(2) + "u</span>" : p.result === "L" ? '<span class="lost">Missed, -1.00u</span>' : "Void") : p.status === "open" ? ' &middot; <span class="dim">open until the first game starts</span>' : ' &middot; <span class="dim">games in progress</span>'}</h3>
<ul style="margin:0;padding-left:18px">${p.legs.map(l => `<li>${l.sport.toUpperCase()} &middot; ${esc(l.team)} moneyline ${esc(fmtPrice(l.price))} &middot; ${mark(l.result)}</li>`).join("")}</ul></article>`).join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leo Parlay: Every Daily Parlay Graded | Leo</title>
<meta name="description" content="Leo's daily parlay, built only from Leo's own NFL and NBA moneyline picks, with every result graded and the running record since November 20, 2026.">
<link rel="canonical" href="https://ndhorizon.com/parlay/">
<meta property="og:title" content="Leo Parlay: Every Daily Parlay Graded | Leo"><meta property="og:image" content="https://ndhorizon.com/img/leo-card.png">
<link rel="stylesheet" href="/css/style.css">
<style>.won{color:#2e7d4f;font-weight:700}.lost{color:#b23b3b;font-weight:700}.dim{color:#7a7368}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0}</style>
</head><body><div id="nav"></div><main class="wrap">
<p class="eyebrow">Leo &middot; NFL and NBA</p>
<h1>Leo Parlay</h1>
<p class="lead">On any day with two or more Leo moneyline picks across the NFL and NBA, Leo combines them into one parlay. The legs are Leo&rsquo;s own picks at the prices they were graded at, locked when the first game starts. Graded at 1 unit, kept apart from Leo&rsquo;s moneyline and spread record.</p>
<div class="tiles"><div class="card"><div class="small dim">Record since Nov 20</div><div class="big">${rec.w}-${rec.l}${rec.p ? "-" + rec.p : ""}</div></div><div class="card"><div class="small dim">Units</div><div class="big">${rec.units >= 0 ? "+" : ""}${rec.units.toFixed(2)}u</div></div><div class="card"><div class="small dim">Parlays</div><div class="big">${rec.parlays.length}</div><div class="small dim">${rec.n < 50 ? "early read" : ""}</div></div></div>
<p class="small dim">A leg whose pick is gone before its game (Leo dropped it) or that pushes drops out, and the price is worked out from the rest. A parlay multiplies the bookmaker&rsquo;s margin, so it swings harder than single picks. Analysis only, not betting advice. <a href="/nfl/results/">NFL record</a> &middot; <a href="/nba/results/">NBA record</a></p>
${rows || '<p class="dim">The first Leo Parlay goes up on the first day with two or more Leo moneyline picks.</p>'}
</main><div id="footer"></div><script src="/js/app.js"></script><script>if(window.renderNav)renderNav("/parlay/");if(window.renderFooter)renderFooter();</script></body></html>
`;
  fs.mkdirSync(path.join(ROOT, "parlay"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "parlay", "index.html"), html);
}

// One line on each results page, kept apart from the moneyline and spread record.
function resultsLines(rec) {
  const line = `<!--leo-parlay--><p class="small" id="leo-parlay-line" style="margin:10px 0 14px"><b>Leo Parlay</b> (daily parlay of Leo's moneyline picks, kept apart from this record): ${rec.w}-${rec.l}${rec.p ? "-" + rec.p : ""}, ${rec.units >= 0 ? "+" : ""}${rec.units.toFixed(2)}u since Nov 20${rec.n < 50 ? ", early read" : ""}. <a href="/parlay/">Every Leo Parlay</a></p><!--/leo-parlay-->`;
  for (const [f, anchor] of [["nfl/results/index.html", '<section id="body"'], ["nba/results/index.html", '<div id="app"']]) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    let html = fs.readFileSync(p, "utf8");
    if (/<!--leo-parlay-->[\s\S]*?<!--\/leo-parlay-->/.test(html)) html = html.replace(/<!--leo-parlay-->[\s\S]*?<!--\/leo-parlay-->/, line);
    else if (html.includes(anchor)) html = html.replace(anchor, line + "\n  " + anchor);
    else continue;
    fs.writeFileSync(p, html);
  }
}

try {
  const args = process.argv.slice(2).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const dates = args.length ? args : [etDate(NOW - 864e5), etDate(NOW)];
  const built = dates.map(d => [d, build(d)]);
  const rec = record();
  for (const [d, p] of built) if (p) posts(d, p, rec);
  page(rec);
  if (rec.parlays.length) resultsLines(rec);   // shown once the first Leo Parlay exists
  for (const [d, p] of built) console.log(`leo parlay ${d}: ${p ? `${p.legs.length} legs, ${p.price}, ${p.status}${p.result ? " " + p.result : ""}` : "none"}`);
  console.log(`leo parlay record: ${rec.w}-${rec.l}${rec.p ? "-" + rec.p : ""}, ${rec.units}u`);
} catch (e) { console.log("::warning::leo parlay: " + e.message); }
