#!/usr/bin/env node
/* MLB Edges — static daily recap generator.
   Usage: node scripts/generate-recap.js [YYYY-MM-DD]
   Default date: yesterday in US Eastern time.
   Writes: recaps/<date>.html, recaps/index.html, sitemap.xml
   Exits 0 with no writes if there are no completed games. */

const fs = require("fs");
const path = require("path");

const SITE = "https://mlbedges.com";
const ROOT = path.join(__dirname, "..");
const RECAP_DIR = path.join(ROOT, "recaps");

function etYesterday() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  et.setDate(et.getDate() - 1);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}

const DATE = process.argv[2] || etYesterday();
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) { console.error("Bad date arg:", DATE); process.exit(1); }

function niceDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}
function esc(s) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s).replace(/[&<>"']/g, c => map[c]);
}
function teamShort(name) {
  const two = ["Red Sox", "White Sox", "Blue Jays"].find(x => name.endsWith(x));
  if (two) return two;
  const parts = name.split(" ");
  return parts[parts.length - 1];
}
function marginPhrase(m) {
  if (m === 1) return "edged";
  if (m === 2) return "slipped past";
  if (m <= 4) return "beat";
  if (m <= 7) return "pulled away from";
  return "routed";
}
function gameFacts(g) {
  const a = g.teams.away, h = g.teams.home;
  const winner = a.score > h.score ? a : h;
  const loser = winner === a ? h : a;
  const margin = winner.score - loser.score;
  const ls = g.linescore || {};
  const innings = ls.currentInning || 9;
  let bigInning = null;
  for (const inn of ls.innings || []) {
    const side = winner === a ? "away" : "home";
    const runs = inn[side] && inn[side].runs;
    if (runs >= 4 && (!bigInning || runs > bigInning.runs)) bigInning = { runs, ord: inn.ordinalNum };
  }
  return { a, h, winner, loser, margin, innings, bigInning };
}
function recapSentence(g) {
  const { a, winner, loser, margin, innings, bigInning } = gameFacts(g);
  const where = winner === a ? "on the road" : "at home";
  let s = `The ${teamShort(winner.team.name)} ${marginPhrase(margin)} the ${teamShort(loser.team.name)} ${winner.score}–${loser.score} ${where}`;
  if (innings > 9) s += ` in ${innings} innings`;
  s += ".";
  if (bigInning) s += ` A ${bigInning.runs}-run ${bigInning.ord} broke the game open.`;
  const wr = winner.leagueRecord, lr = loser.leagueRecord;
  if (wr && lr) s += ` The win moves them to ${wr.wins}-${wr.losses}; the ${teamShort(loser.team.name)} fall to ${lr.wins}-${lr.losses}.`;
  return s;
}

const NAV = `<nav><div class="nav-inner">
  <a class="brand" href="/index.html"><span class="brand-ly">Ly</span><span class="brand-dia">Dia</span> Picks</a>
  <a class="navlink" href="/index.html">Home</a>
  <a class="navlink" href="/dashboard.html">Dashboard</a>
  <a class="navlink" href="/picks.html">Picks</a>
  <a class="navlink" href="/odds.html">Live Odds</a>
  <a class="navlink" href="/tools.html">Value Tools</a>
  <a class="navlink" href="/stats.html">Team Stats</a>
  <a class="navlink active" href="/recaps/">Daily Recap</a>
  <a class="navlink" href="/articles.html">Articles</a>
</div></nav>`;
const FOOTER = `<footer>MLB Edges — analysis and education only, not betting advice. Please bet responsibly. If gambling stops being fun, call 1-800-GAMBLER.</footer>`;

function pageShell(title, desc, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>&#9918;</text></svg>">
<link rel="stylesheet" href="/css/style.css">
<style>
.recap-game { border-left: 3px solid var(--accent2); padding-left: 14px; margin: 18px 0; }
.recap-game h3 { margin: 0 0 4px; font-weight: 700; }
.recap-game p { color: var(--text); font-size: .95rem; margin-top: 4px; }
.roundup { font-size: 1.02rem; margin-bottom: 8px; }
.archive-list a { display: block; padding: 8px 0; border-bottom: 1px solid var(--border); }
</style>
</head>
<body>
${NAV}
<main>
${body}
</main>
${FOOTER}
</body>
</html>
`;
}

async function main() {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}&hydrate=linescore`;
  const res = await fetch(url);
  if (!res.ok) { console.error("MLB API error HTTP " + res.status); process.exit(1); }
  const sched = await res.json();
  const games = (((sched.dates || [])[0]) || {}).games || [];
  const finals = games.filter(g => g.status.abstractGameState === "Final" && g.teams.away.score !== undefined);
  if (!finals.length) { console.log(`No completed games for ${DATE} — nothing to publish.`); return; }

  const nice = niceDate(DATE);
  const facts = finals.map(gameFacts);
  const totalRuns = facts.reduce((s, f) => s + f.winner.score + f.loser.score, 0);
  const blow = facts.reduce((x, f) => f.margin > x.margin ? f : x, facts[0]);
  const close = facts.filter(f => f.margin === 1).length;
  const extras = facts.filter(f => f.innings > 9).length;

  const intro = `${finals.length} games went final on ${nice}, producing ${totalRuns} total runs. ` +
    `The biggest margin of the day belonged to the ${teamShort(blow.winner.team.name)}, who ${marginPhrase(blow.margin)} the ${teamShort(blow.loser.team.name)} by ${blow.margin}. ` +
    `${close ? `${close} game${close > 1 ? "s were" : " was"} decided by a single run` : "No one-run games"}${extras ? `, and ${extras} went to extra innings` : ""}.`;

  let body = `<h1>MLB Recap — ${esc(nice)}</h1>\n<p class="roundup">${esc(intro)}</p>\n`;
  for (const g of finals) {
    const { a, h } = gameFacts(g);
    const head = `${teamShort(a.team.name)} ${a.score}, ${teamShort(h.team.name)} ${h.score}`;
    body += `<div class="recap-game"><h3>${esc(head)}</h3><p>${esc(recapSentence(g))}</p></div>\n`;
  }
  body += `<p class="dim small">Generated from official MLB data. <a href="/recaps/">All recaps</a> · <a href="/picks.html">Today's model picks</a> · <a href="/odds.html">Live odds</a></p>`;

  fs.mkdirSync(RECAP_DIR, { recursive: true });
  const outFile = path.join(RECAP_DIR, `${DATE}.html`);
  fs.writeFileSync(outFile, pageShell(
    `MLB Recap ${nice} — every final score | MLB Edges`,
    `MLB results for ${nice}: ${finals.length} finals, ${totalRuns} runs. ${intro.slice(0, 120)}`,
    body));
  console.log("wrote", path.relative(ROOT, outFile));

  // archive index
  const posts = fs.readdirSync(RECAP_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).sort().reverse();
  const list = posts.map(f => {
    const d = f.replace(".html", "");
    return `<a href="/recaps/${f}">MLB Recap — ${esc(niceDate(d))}</a>`;
  }).join("\n");
  fs.writeFileSync(path.join(RECAP_DIR, "index.html"), pageShell(
    "Daily MLB Recaps — archive | MLB Edges",
    "Archive of daily MLB recaps: every final score, every day of the season.",
    `<h1>Daily Recaps</h1>\n<p class="subtitle">Every day of the season, recapped.</p>\n<div class="card archive-list">\n${list}\n</div>`));
  console.log("wrote recaps/index.html");

  // sitemap
  const staticPages = ["", "dashboard.html", "picks.html", "odds.html", "tools.html", "stats.html", "recaps.html", "articles.html", "recaps/"];
  const urls = staticPages.map(p => `${SITE}/${p}`).concat(posts.map(f => `${SITE}/recaps/${f}`));
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `  <url><loc>${u}</loc></url>`).join("\n") + `\n</urlset>\n`;
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), sitemap);
  console.log("wrote sitemap.xml with", urls.length, "urls");
}

main().catch(e => { console.error(e); process.exit(1); });
