#!/usr/bin/env node
/*
  Leo NBA team pages (SEO-07, HO-0039 part A, DEC-20261110-31). One page per
  team at /nba/teams/<nickname>/ (celtics, trail-blazers, 76ers: the same slug
  as the game addresses, scripts/lib/nba-urls.js) plus a hub at /nba/teams/.
  Set up like the NFL team pages (scripts/build-nfl-team-pages.js).

  Each game row keeps the team and Leo apart:
    - Leo's win chance FOR THIS TEAM, from the read of record (the last
      capture before tip; graded games read it from results-ledger.csv).
    - Leo favored: the team Leo gave more than 50%.
    - Final score, then "<Team> result" (the team's own win or loss).
    - Leo's read: Right when the team Leo favored won, Wrong when it lost.
    - Leo's spread for this team beside the DraftKings spread, and the call
      on the game (Leo Pick, lean or no call) with its result.
  Games not played yet come from the latest card, marked "latest, freezes at
  tip" until they tip.

  Display only: reads frozen reads, grades and the schedule; changes no number.
  Usage: node scripts/build-nba-team-pages.js
*/
"use strict";
const fs = require("fs");
const path = require("path");
const { GA_HEAD } = require("./lib/ga");
const URLS = require("./lib/nba-urls");
const PK = require("./lib/nba-picks");

const ROOT = path.resolve(__dirname, ".."), DIR = path.join(ROOT, "data", "nba");
const ORIGIN = "https://ndhorizon.com";
// Conferences and divisions, ESPN abbreviations (as in build-nba-team-stats.js).
const DIVISIONS = [
  ["Eastern Conference: Atlantic", ["BOS", "BKN", "NY", "PHI", "TOR"]], ["Eastern Conference: Central", ["CHI", "CLE", "DET", "IND", "MIL"]],
  ["Eastern Conference: Southeast", ["ATL", "CHA", "MIA", "ORL", "WSH"]], ["Western Conference: Northwest", ["DEN", "MIN", "OKC", "POR", "UTAH"]],
  ["Western Conference: Pacific", ["GS", "LAC", "LAL", "PHX", "SAC"]], ["Western Conference: Southwest", ["DAL", "HOU", "MEM", "NO", "SA"]],
];
const nick = a => URLS.nick(a);
const teamSlug = abbr => URLS.slugify(URLS.nick(abbr));
const teamUrl = abbr => `/nba/teams/${teamSlug(abbr)}/`;
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// One decimal near a coin flip, so "50%" never sits beside a team Leo favored.
const pct = p => (Math.round(p * 100) === 50 && p !== 0.5) ? `${(p * 100).toFixed(1)}%` : `${Math.round(p * 100)}%`;
const sgn = v => v == null ? "" : v === 0 ? "PK" : (v > 0 ? "+" : "") + v;
const units = v => (v > 0 ? "+" : "") + (+v).toFixed(2) + "u";
const num = v => v === "" || v == null || !Number.isFinite(+v) ? null : +v;
const niceDate = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const longDate = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const [head, ...lines] = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const h = head.split(",");
  return lines.map(l => { const c = l.split(","); return Object.fromEntries(h.map((k, i) => [k, c[i] ?? ""])); });
}
const pageUrl = g => { const u = g.url || URLS.gamePath(g); return fs.existsSync(path.join(ROOT, u.replace(/^\/|\/$/g, ""), "index.html")) ? u : null; };
/** Leo's home spread on the .5 grid, rounded toward DraftKings (DEC-20261102-03). */
function leoHomeSpread(margin, dk) { const s = -margin; const v = dk == null ? Math.round(s * 2) / 2 : s > dk ? Math.floor(s * 2) / 2 : Math.ceil(s * 2) / 2; return v === 0 ? 0 : v; }

/** Every game Leo has read: graded games from the ledger, then games on dated cards not graded yet. */
function loadGames(now) {
  const out = new Map();
  for (const r of readCsv(path.join(DIR, "results-ledger.csv"))) {
    const g = { id: r.game_id, date: r.date, away: r.away, home: r.home, played: true, frozen: true, hs: +r.home_score, as: +r.away_score,
      p_home: +r.leo_p_home, margin: +r.leo_home_margin, dk: num(r.mkt_home_spread), pick: null, lean: null };
    if (r.pick_result && r.date >= PK.TRACK_FROM) g.pick = { team: r.pick_team, price: num(r.pick_price), result: r.pick_result, units: num(r.pick_units) };
    if (r.lean_side) g.lean = { team: r.lean_side === "home" ? r.home : r.away, line: num(r.lean_line), result: r.lean_result, units: r.lean_units !== "" ? +r.lean_units : PK.units(r.lean_result, -110) };
    out.set(g.id, g);
  }
  const cards = fs.readdirSync(DIR).filter(f => /^picks-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-3);
  for (const f of cards) for (const c of (readJson(path.join(DIR, f), { games: [] }).games || [])) {
    const id = String(c.game_id), L = c.leo || {};
    if (out.has(id) || L.p_home == null) continue;
    const tipped = c.tip_utc && Date.parse(c.tip_utc) <= now, pk = L.pick && L.pick.ok ? L.pick : null, ln = L.lean || null;
    out.set(id, { id, date: c.date, away: c.away, home: c.home, played: false, frozen: !!tipped, url: c.url, hs: null, as: null,
      p_home: +L.p_home, margin: +L.home_margin, dk: num((c.market || {}).home_spread),
      pick: pk ? { team: pk.team, price: pk.price, result: "", units: null } : null,
      lean: ln ? { team: ln.team, line: ln.line, result: "", units: null } : null });
  }
  return [...out.values()];
}

/** Full names and each team's next scheduled game, from data/nba/schedule.json. */
function loadSchedule(today) {
  const names = {}, next = {};
  for (const d of (readJson(path.join(DIR, "schedule.json"), { days: [] }).days || [])) for (const g of d.games) {
    names[g.home] = g.home_name; names[g.away] = g.away_name;
    if (d.date >= today && !g.final) for (const [t, o, at] of [[g.home, g.away, false], [g.away, g.home, true]]) if (!next[t]) next[t] = { date: d.date, opp: o, at };
  }
  return { names, next };
}

function teamGames(all, abbr) {
  return all.filter(g => g.away === abbr || g.home === abbr).map(g => {
    const home = g.home === abbr, opp = home ? g.away : g.home;
    const chance = home ? g.p_home : 1 - g.p_home;
    const teamPts = g.played ? (home ? g.hs : g.as) : null, oppPts = g.played ? (home ? g.as : g.hs) : null;
    const result = g.played ? (teamPts > oppPts ? "W" : "L") : null;
    const favored = chance > 0.5 ? abbr : chance < 0.5 ? opp : null;
    const hs = leoHomeSpread(g.margin, g.dk);
    return { ...g, opp, at: !home, chance, favored, teamPts, oppPts, result, right: g.played && favored ? (favored === abbr) === (result === "W") : null,
      leoSpread: home ? hs : (hs === 0 ? 0 : -hs), dkSpread: g.dk == null ? null : home ? g.dk : (g.dk === 0 ? 0 : -g.dk), url: pageUrl(g) };
  }).sort((a, b) => b.date.localeCompare(a.date));
}

function summary(games, abbr) {
  const done = games.filter(g => g.played);
  const w = done.filter(g => g.result === "W").length, l = done.length - w;
  const judged = done.filter(g => g.right !== null), right = judged.filter(g => g.right).length;
  const fav = done.filter(g => g.chance > 0.5), dog = done.filter(g => g.chance < 0.5);
  // Leo's official calls ON this team (a pick on them to win, or a lean on their side of the spread).
  const calls = done.flatMap(g => [g.pick, g.lean].filter(c => c && c.team === abbr && c.result));
  const cw = calls.filter(c => c.result === "win").length, cl = calls.filter(c => c.result === "loss").length;
  return { done, w, l, judged, right, fav, favW: fav.filter(g => g.result === "W").length, dog, dogW: dog.filter(g => g.result === "W").length,
    calls, cw, cl, cu: calls.reduce((t, c) => t + (c.units || 0), 0), upcoming: games.filter(g => !g.played) };
}
const rec = (w, l) => `${w}-${l}`;

function shell({ title, desc, url, jsonld, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
${GA_HEAD}
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${ORIGIN}${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Leo">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${ORIGIN}${url}">
<meta property="og:image" content="${ORIGIN}/img/og-card.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/css/style.css">
<style>
.team-table{width:100%;border-collapse:collapse;font-size:.9rem}
.team-table th,.team-table td{padding:7px 8px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
.team-table th{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim)}
.team-table .w{color:var(--good);font-weight:800}.team-table .l{color:var(--danger);font-weight:800}
.team-table td.nw{white-space:nowrap}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
.stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.stat-row .card{padding:12px 14px}.stat-row .v{font-size:1.4rem;font-weight:800}.stat-row .k{font-size:.78rem;color:var(--text-dim)}
.div-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.div-grid ul{margin:6px 0 0;padding-left:18px;line-height:1.8}
.key{margin:8px 0 12px;padding-left:18px;line-height:1.6}
.team-table .only-sm{display:none}
/* Phones: each game is a card, one labelled line per column, so nothing sits off screen. */
@media (max-width:640px){
  .team-table thead{display:none}
  .team-table,.team-table tbody{display:block}
  .team-table tr{display:block;border:1px solid var(--border);border-radius:12px;padding:8px 12px;margin:0 0 10px;background:var(--bg-card)}
  .team-table td{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px dashed var(--border);text-align:right}
  .team-table td:last-child{border-bottom:0}
  .team-table td::before{content:attr(data-l);flex:0 0 42%;text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim);padding-top:2px}
  .team-table td.head{display:block;text-align:left;font-weight:800;font-size:1rem;border-bottom:1px solid var(--border)}
  .team-table td.head::before{content:none}
  .team-table td.date{display:none}
  .team-table .only-sm{display:inline}
}
</style>
<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>
</head>
<body>
<nav id="nav"></nav>
<main>
${body}
<div class="notice warn" style="margin-top:28px">For entertainment and informational purposes. Leo&rsquo;s win chances, picks and leans are a tracked public test, not betting advice, and no model can promise outcomes. 21+. If gambling stops being fun, call 1-800-MY-RESET.</div>
</main>
<footer id="footer"></footer><script src="/js/app.js"></script><script>renderNav("/nba/teams/"); renderFooter();</script>
</body>
</html>
`;
}

function callCell(g) {
  const res = c => c.result === "win" ? ` <span class="w">Won</span> ${units(c.units)}` : c.result === "loss" ? ` <span class="l">Lost</span> ${units(c.units)}` : c.result === "push" ? " Push" : "";
  const parts = [];
  if (g.pick) parts.push(`Pick ${esc(nick(g.pick.team))} ${sgn(g.pick.price)}${res(g.pick)}`);
  if (g.lean) parts.push(`Lean ${esc(nick(g.lean.team))} ${sgn(g.lean.line)}${res(g.lean)}`);
  return parts.length ? parts.join("<br>") : `<span class="dim">No call</span>`;
}

function teamPage(abbr, division, games, sched) {
  const s = summary(games, abbr), name = sched.names[abbr] || nick(abbr), N = nick(abbr), url = teamUrl(abbr);
  const title = `${N} Predictions: Leo's Win Chance and Spread for Every Game | Leo`;
  const desc = `${name} predictions: Leo's win chance and spread before every ${N} game beside the DraftKings line, who Leo favored, the final score and whether Leo's read was right.`;
  const rivals = DIVISIONS.find(d => d[0] === division)[1].filter(t => t !== abbr);
  const nx = sched.next[abbr], nxRead = nx && s.upcoming.find(g => g.date === nx.date);

  const say = [];
  if (s.done.length) {
    say.push(`The ${N} went ${rec(s.w, s.l)} in the ${s.done.length} ${s.done.length === 1 ? "game" : "games"} Leo analyzed between ${longDate(s.done[s.done.length - 1].date)} and ${longDate(s.done[0].date)}.`);
    if (s.judged.length) say.push(`The team Leo favored won ${s.right} of ${s.judged.length}.`);
    if (s.fav.length) say.push(`When Leo favored the ${N}, they went ${rec(s.favW, s.fav.length - s.favW)}.`);
    if (s.dog.length) say.push(`When Leo favored their opponent, the ${N} went ${rec(s.dogW, s.dog.length - s.dogW)}.`);
  }
  if (nx) say.push(`Next: ${nx.at ? "at" : "vs"} the ${nick(nx.opp)} on ${longDate(nx.date)}${nxRead ? `, with Leo at ${pct(nxRead.chance)} for the ${N}${nxRead.frozen ? "" : " so far"}` : ""}.`);

  const rows = games.map(g => {
    const opp = `${g.at ? "at" : "vs"} ${esc(nick(g.opp))}`;
    const chance = `${pct(g.chance)}${g.played || g.frozen ? "" : ` <span class="dim small">latest, freezes at tip</span>`}`;
    const score = g.played ? `${esc(N)} ${g.teamPts}, ${esc(nick(g.opp))} ${g.oppPts}` : `<span class="dim">Not played yet</span>`;
    const result = !g.played ? "" : g.result === "W" ? `<span class="w">Won</span>` : `<span class="l">Lost</span>`;
    const right = g.right === null ? "" : g.right ? `<span class="w">Right</span>` : `<span class="l">Wrong</span>`;
    const L = t => ` data-l="${esc(t)}"`;
    return `<tr><td class="nw date">${esc(niceDate(g.date))}</td><td class="head"><span class="only-sm">${esc(niceDate(g.date))} &middot; </span>${g.url ? `<a href="${g.url}">${opp}</a>` : opp}</td><td${L(`Leo's chance (${N})`)}><span>${chance}</span></td><td${L("Leo favored")}>${g.favored ? esc(nick(g.favored)) : "Even"}</td>` +
      `<td${L("Final score")}>${score}</td><td${L(`${N} result`)}>${result || "&nbsp;"}</td><td${L("Leo's read")}>${right || "&nbsp;"}</td><td class="nw"${L("Leo's spread")}>${sgn(g.leoSpread)}</td><td class="nw"${L("DraftKings")}>${g.dkSpread == null ? `<span class="dim">No line</span>` : sgn(g.dkSpread)}</td><td${L("Call")}><span>${callCell(g)}</span></td></tr>`;
  }).join("");

  const body = `<article>
  <p class="eyebrow"><a href="/nba/teams/">NBA teams</a> &middot; ${esc(division)} &middot; 2026&ndash;27 season</p>
  <h1>${esc(name)} predictions</h1>
  <p class="subtitle">${esc(say.join(" "))}</p>
  <div class="stat-row">
    <div class="card"><div class="v">${rec(s.w, s.l)}</div><div class="k">${esc(N)} record in games Leo analyzed</div></div>
    <div class="card"><div class="v">${s.fav.length ? rec(s.favW, s.fav.length - s.favW) : "None yet"}</div><div class="k">${esc(N)} record when Leo favored them</div></div>
    <div class="card"><div class="v">${s.right}-${s.judged.length - s.right}</div><div class="k">Leo&rsquo;s reads on ${esc(N)} games (right&#8209;wrong)</div></div>
    <div class="card"><div class="v">${s.calls.length ? `${rec(s.cw, s.cl)}, ${units(s.cu)}` : "None yet"}</div><div class="k">Leo Picks and leans on the ${esc(N)}, in units</div></div>
  </div>
  <h2>Every ${esc(N)} game</h2>
  <ul class="key dim small">
    <li><b>Leo&rsquo;s chance</b> is Leo&rsquo;s win chance for the ${esc(N)}, from its last read saved before tip.</li>
    <li><b>Leo favored</b> is the team Leo gave the better chance to win.</li>
    <li><b>${esc(N)} result</b> is whether the ${esc(N)} won or lost.</li>
    <li><b>Leo&rsquo;s read</b> is Right when the team Leo favored won, and Wrong when it lost.</li>
    <li><b>Leo&rsquo;s spread</b> and <b>DraftKings</b> are the ${esc(N)}&rsquo; side of the spread: a minus number means favored by that many points.</li>
    <li><b>Call</b> is Leo&rsquo;s official call on the game. A Leo Pick is a team to win at the moneyline price shown; a lean was a side of the spread, recorded through November 10 and then ended. One unit each, a tracked test, not a bet.</li>
  </ul>
  <div class="table-wrap"><table class="team-table"><thead><tr><th>Date</th><th>Opponent</th><th>Leo&rsquo;s chance (${esc(N)})</th><th>Leo favored</th><th>Final score</th><th>${esc(N)} result</th><th>Leo&rsquo;s read</th><th>Leo&rsquo;s spread</th><th>DraftKings</th><th>Call</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="dim small">Opponents link to Leo&rsquo;s full game analysis: win chance, spread, injury report and box score.</p>
  <h2>More from the ${esc(division.replace(/^.*: /, ""))} Division</h2>
  <p>${rivals.map(t => `<a href="${teamUrl(t)}">${esc(sched.names[t] || nick(t))}</a>`).join(" &middot; ")}</p>
  <p class="dim small">See <a href="/nba/teams/">all 30 teams</a>, <a href="/nba/scoreboard/">tonight&rsquo;s NBA predictions</a>, <a href="/nba/games/">every NBA game page</a> and <a href="/nba/results/">Leo&rsquo;s NBA results</a>.</p>
</article>`;
  const jsonld = { "@context": "https://schema.org", "@graph": [
    { "@type": "CollectionPage", "@id": `${ORIGIN}${url}#page`, name: title.replace(/ \| Leo$/, ""), description: desc, url: ORIGIN + url,
      about: { "@type": "SportsTeam", name, sport: "Basketball", memberOf: { "@type": "SportsOrganization", name: "National Basketball Association" } },
      publisher: { "@type": "Organization", "@id": `${ORIGIN}/#organization`, name: "Leo", url: `${ORIGIN}/` } },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Leo", item: `${ORIGIN}/` },
      { "@type": "ListItem", position: 2, name: "NBA teams", item: `${ORIGIN}/nba/teams/` },
      { "@type": "ListItem", position: 3, name, item: ORIGIN + url } ] } ] };
  return { html: shell({ title, desc, url, jsonld, body }), record: s.done.length ? rec(s.w, s.l) : "" };
}

function hubPage(records, sched) {
  const url = "/nba/teams/";
  const title = "NBA Team Predictions: Leo's Win Chance and Spread for Every Game, by Team | Leo";
  const desc = "Predictions for all 30 NBA teams: Leo's win chance and spread before every game beside the DraftKings line, who Leo favored, the final score and whether Leo's read was right.";
  const body = `<h1>NBA team predictions</h1>
  <p class="subtitle">Pick a team to see every game Leo analyzed this season: Leo&rsquo;s win chance before tip, the team Leo favored, the final score, whether Leo&rsquo;s read was right, and Leo&rsquo;s spread beside DraftKings. The record beside each team is that team&rsquo;s own record in the games Leo analyzed. Leo&rsquo;s NBA reads start on October 31, 2026.</p>
  <div class="div-grid">${DIVISIONS.map(([div, teams]) => `<div class="card"><h2 style="margin:0;font-size:1.05rem">${esc(div)}</h2><ul>${teams.map(t =>
    `<li><a href="${teamUrl(t)}">${esc(sched.names[t] || nick(t))}</a> <span class="dim small">${esc(records[t] || "")}</span></li>`).join("")}</ul></div>`).join("")}</div>
  <p class="dim small" style="margin-top:18px">Tonight: <a href="/nba/scoreboard/">NBA predictions</a> &middot; <a href="/nba/games/">every NBA game page</a> &middot; <a href="/nba/results/">Leo&rsquo;s NBA results</a>.</p>`;
  const jsonld = { "@context": "https://schema.org", "@graph": [
    { "@type": "CollectionPage", "@id": `${ORIGIN}${url}#page`, name: title.replace(/ \| Leo$/, ""), description: desc, url: ORIGIN + url },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Leo", item: `${ORIGIN}/` },
      { "@type": "ListItem", position: 2, name: "NBA teams", item: ORIGIN + url } ] } ] };
  return shell({ title, desc, url, jsonld, body });
}

function main() {
  const now = Date.now(), today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(now));
  const all = loadGames(now), sched = loadSchedule(today);
  const records = {}; let n = 0;
  for (const [division, teams] of DIVISIONS) for (const abbr of teams) {
    const { html, record } = teamPage(abbr, division, teamGames(all, abbr), sched);
    const dir = path.join(ROOT, "nba", "teams", teamSlug(abbr));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), html);
    records[abbr] = record; n++;
  }
  fs.writeFileSync(path.join(ROOT, "nba", "teams", "index.html"), hubPage(records, sched));
  console.log(`NBA team pages: ${n} teams + hub written to nba/teams/ (${all.length} games read)`);
}
if (require.main === module) main();
module.exports = { teamSlug, teamUrl };
