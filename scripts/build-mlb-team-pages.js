#!/usr/bin/env node
/*
  Leo MLB team pages (2026-11-02, MLB admin chat; business/SEO_GROWTH_LOG.md
  SEO-07 for MLB). One page per team at /mlb/teams/<team>/ plus a hub at
  /mlb/teams/, built from data/review/mlb-<season>/game_review.csv: Leo's
  last read committed before each game started (scripts/build-mlb-season-review.js)
  and the result. Every game links to its matchup page when one exists
  (data/matchup-pages/<date>.json gives game_pk -> page).

  Display only: reads frozen reads, changes no number. No market numbers on
  these pages (DEC-20260926-01: public pages do not rank Leo against the book).

  Usage: node scripts/build-mlb-team-pages.js [--season 2026]
*/
"use strict";
const fs = require("fs");
const path = require("path");
const { GA_HEAD } = require("./lib/ga");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const SEASON = args.includes("--season") ? args[args.indexOf("--season") + 1] : "2026";
const ORIGIN = "https://ndhorizon.com";
const NEXT_OPENING_DAY = { "2026": "March 25, 2027" }[SEASON] || "next spring";

// Divisions (stable since 2013). Team names as the MLB feed spells them.
const DIVISIONS = [
  ["AL East", ["Baltimore Orioles", "Boston Red Sox", "New York Yankees", "Tampa Bay Rays", "Toronto Blue Jays"]],
  ["AL Central", ["Chicago White Sox", "Cleveland Guardians", "Detroit Tigers", "Kansas City Royals", "Minnesota Twins"]],
  ["AL West", ["Athletics", "Houston Astros", "Los Angeles Angels", "Seattle Mariners", "Texas Rangers"]],
  ["NL East", ["Atlanta Braves", "Miami Marlins", "New York Mets", "Philadelphia Phillies", "Washington Nationals"]],
  ["NL Central", ["Chicago Cubs", "Cincinnati Reds", "Milwaukee Brewers", "Pittsburgh Pirates", "St. Louis Cardinals"]],
  ["NL West", ["Arizona Diamondbacks", "Colorado Rockies", "Los Angeles Dodgers", "San Diego Padres", "San Francisco Giants"]],
];
const TWO_WORD = ["Red Sox", "White Sox", "Blue Jays"];
const shortName = n => TWO_WORD.find(t => n.endsWith(t)) || n.split(" ").pop();
const slugify = s => String(s).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const teamSlug = n => slugify(shortName(n));
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// One decimal near a coin flip, so "50%" never sits beside a team Leo favored (2026-11-02, Manager chat).
const pct = p => (Math.round(p * 100) === 50 && p !== 0.5) ? `${(p * 100).toFixed(1)}%` : `${Math.round(p * 100)}%`;
const starterName = n => (!n || /^tbd$/i.test(String(n).trim())) ? "Not announced" : n;
const niceDate = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const longDate = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f.replace(/\r$/, "")); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift();
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

function loadPageIndex() {
  const dir = path.join(ROOT, "data", "matchup-pages");
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const f of fs.readdirSync(dir).filter(f => f.startsWith(SEASON) && f.endsWith(".json"))) {
    let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { continue; }
    for (const p of d.pages || []) {
      if (!p.slug || !p.game_pk) continue;
      if (fs.existsSync(path.join(ROOT, "mlb", p.slug, "index.html"))) map.set(`${p.date}|${p.game_pk}`, `/mlb/${p.slug}/`);
    }
  }
  return map;
}

function teamGames(rows, team, pages) {
  const out = [];
  for (const r of rows) {
    const [away, home] = String(r.matchup).split(" @ ");
    if (away !== team && home !== team) continue;
    const side = home === team ? "home" : "away";
    const leoOnTeam = r.leo_side === side;
    const p = Number(r.leo_prob);
    const won = r.winner_side === "home" || r.winner_side === "away" ? (r.winner_side === side) : null;
    out.push({
      date: r.date, phase: r.phase, opp: side === "home" ? away : home, at: side === "away",
      teamChance: Number.isFinite(p) ? (leoOnTeam ? p : 1 - p) : null,
      teamStarter: leoOnTeam ? r.leo_side_pitcher : r.opp_pitcher,
      oppStarter: leoOnTeam ? r.opp_pitcher : r.leo_side_pitcher,
      won, url: pages.get(`${r.date}|${r.game_pk}`) || null,
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

function summary(team, games) {
  const graded = games.filter(g => g.won !== null && g.teamChance !== null);
  const w = graded.filter(g => g.won).length, l = graded.length - w;
  const fav = graded.filter(g => g.teamChance > 0.5), dog = graded.filter(g => g.teamChance < 0.5);
  const favW = fav.filter(g => g.won).length, dogW = dog.filter(g => g.won).length;
  const avg = graded.length ? graded.reduce((s, g) => s + g.teamChance, 0) / graded.length : null;
  const judged = graded.filter(g => g.teamChance !== 0.5).length;
  const right = graded.filter(g => (g.teamChance > 0.5) === g.won && g.teamChance !== 0.5).length;
  const starters = {};
  for (const g of graded) {
    if (!g.teamStarter || /^tbd$/i.test(g.teamStarter)) continue;
    const s = starters[g.teamStarter] = starters[g.teamStarter] || { n: 0, w: 0, chance: 0 };
    s.n++; s.w += g.won ? 1 : 0; s.chance += g.teamChance;
  }
  const topStarters = Object.entries(starters).sort((a, b) => b[1].n - a[1].n).slice(0, 5);
  const post = graded.filter(g => g.phase === "postseason");
  return { graded, judged, w, l, fav, dog, favW, dogW, avg, right, topStarters, post,
    first: graded.length ? graded[graded.length - 1].date : null, last: graded.length ? graded[0].date : null };
}

function shell({ title, desc, url, jsonld, body, active }) {
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
.team-table th{font-size:.74rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim)}
.team-table .w{color:var(--good);font-weight:800}.team-table .l{color:var(--danger);font-weight:800}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
.stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.stat-row .card{padding:12px 14px}.stat-row .v{font-size:1.4rem;font-weight:800}.stat-row .k{font-size:.78rem;color:var(--text-dim)}
.div-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}
.div-grid ul{margin:6px 0 0;padding-left:18px;line-height:1.8}
.key{margin:8px 0 12px;padding-left:18px;line-height:1.6}
@media (max-width:560px){.team-table .hide-sm{display:none}}
</style>
<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>
</head>
<body>
<nav id="nav"></nav>
<main>
${body}
<div class="notice warn" style="margin-top:28px">For entertainment and informational purposes. Leo&rsquo;s win chances are information, not picks, and no model can promise outcomes. 21+. If gambling stops being fun, call 1-800-MY-RESET.</div>
</main>
<footer id="footer"></footer><script src="/js/app.js"></script><script>renderNav("${active}"); renderFooter();</script>
</body>
</html>
`;
}

function teamPage(team, division, games) {
  const s = summary(team, games);
  const slug = teamSlug(team);
  const url = `/mlb/teams/${slug}/`;
  const nick = shortName(team);
  const title = `${team} ${SEASON}: Every Game Leo Analyzed | Leo`;
  const desc = `Every ${team} game Leo analyzed in ${SEASON}: Leo's win chance before first pitch, both starting pitchers, the result and a link to each game's full analysis. ${s.w}-${s.l} in those games.`;
  const rivals = DIVISIONS.find(d => d[0] === division)[1].filter(t => t !== team);

  const sentences = [];
  if (s.graded.length) {
    sentences.push(`Leo analyzed ${s.graded.length} ${team} games with a final result between ${longDate(s.first)} and ${longDate(s.last)}, ${SEASON}. The ${nick} went ${s.w}-${s.l} in them.`);
    if (s.fav.length) sentences.push(`Leo gave the ${nick} better than an even chance in ${s.fav.length} of those games, and they won ${s.favW}.`);
    if (s.dog.length) sentences.push(`When Leo had them below 50%, they won ${s.dogW} of ${s.dog.length}.`);
    sentences.push(`Leo's average win chance for the ${nick} was ${pct(s.avg)}. The side Leo favored won ${s.right} of the ${s.judged} games where Leo favored a side.`);
    if (s.post.length) sentences.push(`Of these, ${s.post.length} ${s.post.length === 1 ? "was a postseason game" : "were postseason games"} (${s.post.filter(g => g.won).length}-${s.post.filter(g => !g.won).length}).`);
  }
  const starterRows = s.topStarters.map(([name, v]) =>
    `<tr><td>${esc(name)}</td><td>${v.n}</td><td>${v.w}-${v.n - v.w}</td><td>${pct(v.chance / v.n)}</td></tr>`).join("");
  const gameRows = games.map(g => {
    // Team result and Leo's read are separate columns: Lynold could not tell whether W/L was the team's or Leo's.
    const res = g.won === null ? `<span class="dim">No result</span>` : (g.won ? `<span class="w">Won</span>` : `<span class="l">Lost</span>`);
    const fav = g.teamChance === null ? "" : g.teamChance > 0.5 ? esc(shortName(team)) : g.teamChance < 0.5 ? esc(shortName(g.opp)) : "Even";
    const read = (g.won === null || g.teamChance === null || g.teamChance === 0.5) ? "" : ((g.teamChance > 0.5) === g.won ? `<span class="w">Right</span>` : `<span class="l">Wrong</span>`);
    const opp = `${g.at ? "at" : "vs"} ${esc(shortName(g.opp))}`;
    const link = g.url ? `<a href="${g.url}">${opp}</a>` : opp;
    return `<tr><td>${esc(niceDate(g.date))}${g.phase === "postseason" ? " <span class=\"dim small\">post</span>" : ""}</td><td>${link}</td><td class="hide-sm">${esc(starterName(g.teamStarter))}</td><td class="hide-sm">${esc(starterName(g.oppStarter))}</td><td>${g.teamChance === null ? "" : pct(g.teamChance)}</td><td>${fav}</td><td>${res}</td><td>${read}</td></tr>`;
  }).join("");

  const body = `<article>
  <p class="eyebrow"><a href="/mlb/teams/">MLB teams</a> &middot; ${esc(division)} &middot; ${SEASON} season</p>
  <h1>${esc(team)} ${SEASON}: every game Leo analyzed</h1>
  <p class="subtitle">${esc(sentences.join(" "))}</p>
  <div class="stat-row">
    <div class="card"><div class="v">${s.w}-${s.l}</div><div class="k">${esc(nick)} record in games Leo analyzed</div></div>
    <div class="card"><div class="v">${s.right}-${s.judged - s.right}</div><div class="k">Leo&rsquo;s reads on ${esc(nick)} games (right&#8209;wrong)</div></div>
    <div class="card"><div class="v">${s.favW}-${s.fav.length - s.favW}</div><div class="k">${esc(nick)} record when Leo favored them</div></div>
    <div class="card"><div class="v">${s.avg === null ? "" : pct(s.avg)}</div><div class="k">Leo&rsquo;s average win chance for the ${esc(nick)}</div></div>
  </div>
  ${starterRows ? `<h2>Most used starters</h2>
  <p class="dim small">Starts Leo analyzed (postseason included), the ${esc(nick)} record in them, and Leo&rsquo;s average win chance for the ${esc(nick)} on those days.</p>
  <div class="table-wrap"><table class="team-table"><thead><tr><th>Starter</th><th>Starts</th><th>Team record</th><th>Leo&rsquo;s avg chance</th></tr></thead><tbody>${starterRows}</tbody></table></div>` : ""}
  <h2>Every game</h2>
  <ul class="key dim small">
    <li><b>Leo&rsquo;s chance</b> is Leo&rsquo;s win chance for the ${esc(nick)}, from its last read saved before first pitch.</li>
    <li><b>Leo favored</b> is the team Leo gave the better chance to win.</li>
    <li><b>${esc(nick)} result</b> is whether the ${esc(nick)} won or lost.</li>
    <li><b>Leo&rsquo;s read</b> is Right when the team Leo favored won, and Wrong when it lost.</li>
  </ul>
  <p class="dim small">Newest first. Opponents link to the full game analysis where one exists.</p>
  <div class="table-wrap"><table class="team-table"><thead><tr><th>Date</th><th>Opponent</th><th class="hide-sm">${esc(nick)} starter</th><th class="hide-sm">Opp. starter</th><th>Leo&rsquo;s chance (${esc(nick)})</th><th>Leo favored</th><th>${esc(nick)} result</th><th>Leo&rsquo;s read</th></tr></thead><tbody>${gameRows}</tbody></table></div>
  <h2>More from the ${esc(division)}</h2>
  <p>${rivals.map(t => `<a href="/mlb/teams/${teamSlug(t)}/">${esc(t)}</a>`).join(" &middot; ")}</p>
  <p class="dim small">The ${Number(SEASON) + 1} season starts ${NEXT_OPENING_DAY}. Until then, see <a href="/mlb/teams/">all 30 teams</a>, <a href="/mlb/matchups/">every MLB game page</a> and Leo&rsquo;s <a href="/nfl/week/">NFL</a> and <a href="/nba/scoreboard/">NBA</a> cards.</p>
</article>`;
  const jsonld = { "@context": "https://schema.org", "@graph": [
    { "@type": "CollectionPage", "@id": `${ORIGIN}${url}#page`, name: title.replace(/ \| Leo$/, ""), description: desc, url: ORIGIN + url,
      about: { "@type": "SportsTeam", name: team, sport: "Baseball", memberOf: { "@type": "SportsOrganization", name: "Major League Baseball" } },
      publisher: { "@type": "Organization", "@id": `${ORIGIN}/#organization`, name: "Leo", url: `${ORIGIN}/` } },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Leo", item: `${ORIGIN}/` },
      { "@type": "ListItem", position: 2, name: "MLB teams", item: `${ORIGIN}/mlb/teams/` },
      { "@type": "ListItem", position: 3, name: team, item: ORIGIN + url } ] } ] };
  return { slug, html: shell({ title, desc, url, jsonld, body, active: "/mlb/teams/" }), record: `${s.w}-${s.l}` };
}

function hubPage(records) {
  const url = "/mlb/teams/";
  const title = `MLB Teams ${SEASON}: Every Game Leo Analyzed, by Team | Leo`;
  const desc = `All 30 MLB teams in ${SEASON}: every game Leo analyzed for each team, with Leo's win chance before first pitch, the starting pitchers and the result.`;
  const body = `<h1>MLB teams ${SEASON}</h1>
  <p class="subtitle">Pick a team to see every ${SEASON} game Leo analyzed: Leo&rsquo;s win chance before first pitch, both starters, the result and a link to the full game analysis. The record shown is each team&rsquo;s record in the games Leo analyzed, not its full season.</p>
  <div class="div-grid">${DIVISIONS.map(([div, teams]) => `<div class="card"><h2 style="margin:0;font-size:1.05rem">${esc(div)}</h2><ul>${teams.map(t =>
    `<li><a href="/mlb/teams/${teamSlug(t)}/">${esc(t)}</a> <span class="dim small">${esc(records[t] || "")}</span></li>`).join("")}</ul></div>`).join("")}</div>
  <p class="dim small" style="margin-top:18px">The ${Number(SEASON) + 1} season starts ${NEXT_OPENING_DAY}. Every game page: <a href="/mlb/matchups/">MLB matchups</a>. This offseason: <a href="/mlb-cy-young-2026/">the 2026 Cy Young race by the numbers</a> &middot; <a href="/mlb-lockout-2026-explained/">the MLB lockout explained</a>.</p>`;
  const jsonld = { "@context": "https://schema.org", "@graph": [
    { "@type": "CollectionPage", "@id": `${ORIGIN}${url}#page`, name: title.replace(/ \| Leo$/, ""), description: desc, url: ORIGIN + url },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Leo", item: `${ORIGIN}/` },
      { "@type": "ListItem", position: 2, name: "MLB teams", item: ORIGIN + url } ] } ] };
  return shell({ title, desc, url, jsonld, body, active: "/mlb/teams/" });
}

function main() {
  const file = path.join(ROOT, "data", "review", `mlb-${SEASON}`, "game_review.csv");
  if (!fs.existsSync(file)) { console.log(`No ${path.relative(ROOT, file)}; run scripts/build-mlb-season-review.js first.`); return; }
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const pages = loadPageIndex();
  const records = {}; let n = 0;
  for (const [division, teams] of DIVISIONS) {
    for (const team of teams) {
      const games = teamGames(rows, team, pages);
      if (!games.length) { console.log(`No games for ${team}`); continue; }
      const { slug, html, record } = teamPage(team, division, games);
      const dir = path.join(ROOT, "mlb", "teams", slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "index.html"), html);
      records[team] = record; n++;
    }
  }
  fs.writeFileSync(path.join(ROOT, "mlb", "teams", "index.html"), hubPage(records));
  console.log(`MLB team pages: ${n} teams + hub written to mlb/teams/`);
  console.log(`sitemap.xml: ${require("./lib/sitemap").writeSitemap(ROOT)} pages`);
}
main();
