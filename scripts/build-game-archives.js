#!/usr/bin/env node
/*
  Builds /nfl/games/ and /nba/games/: one plain HTML page per sport listing
  every Leo game page, newest first, with real <a href> links.

  Why: the nav and most hub pages build their links in the browser, so a
  crawler reading the HTML found 189 indexable pages it could not reach from
  the home page (every NFL game before the current week, every NBA game, and
  NFL weeks 2 to 7). MLB already has this in /mlb/matchups/. These pages give
  every NFL and NBA game a static path from the home page.

  Display only. Reads page titles from the game pages already on disk; reads
  no model output and changes no number. Usage: node scripts/build-game-archives.js
*/
"use strict";
const fs = require("fs");
const path = require("path");
const { listGames, teamLabel } = require("./lib/game-page-seo");

const ROOT = path.join(__dirname, "..");
const ORIGIN = "https://ndhorizon.com";
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// "Cowboys vs Texans Prediction and Odds, Week 4 2026 | Leo" -> link text and week.
function readGame(sportDir, g) {
  const html = fs.readFileSync(path.join(sportDir, g.slug, "index.html"), "utf8").slice(0, 8000);
  const raw = ((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "")
    .replace(/&#39;|&rsquo;/g, "\u2019").replace(/&amp;/g, "&").replace(/\s*\|\s*Leo\s*$/, "").trim();
  const week = (raw.match(/Week (\d+)/) || [])[1];
  const matchup = (raw.match(/^(.*?) Prediction/) || [])[1] || `${teamLabel(g.away)} vs ${teamLabel(g.home)}`;
  return { ...g, title: raw || matchup, matchup, week: week ? Number(week) : null };
}

const longDay = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

function shell({ sport, url, title, description, h1, intro, body, links }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XVWTMDNBJK"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XVWTMDNBJK');
</script>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${ORIGIN}${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Leo">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${ORIGIN}${url}">
<meta property="og:image" content="${ORIGIN}/img/og-card.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/css/style.css">
<style>
main { padding: 20px 16px; max-width: 900px; margin: 0 auto; }
.arch-group { margin: 26px 0 0; }
.arch-group h2 { font-size: 1.1rem; margin: 0 0 8px; }
.arch-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
.arch-list a { display: block; padding: 9px 12px; border: 1px solid var(--border, #e5ded3); border-radius: 10px; text-decoration: none; }
.arch-hubs { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 0; }
</style>
<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org", "@type": "CollectionPage", name: h1, url: ORIGIN + url, description,
    breadcrumb: { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Leo", item: ORIGIN + "/" },
      { "@type": "ListItem", position: 2, name: sport, item: `${ORIGIN}/${sport.toLowerCase()}/scoreboard/` },
      { "@type": "ListItem", position: 3, name: h1, item: ORIGIN + url }] },
  }).replace(/</g, "\\u003c")}</script>
</head>
<body>
<nav id="nav"></nav>
<main>
  <h1>${esc(h1)}</h1>
  <p class="lead">${intro}</p>
  <div class="arch-hubs">${links.map(([h, t]) => `<a class="btn secondary" href="${h}">${esc(t)}</a>`).join("")}</div>
${body}
</main>
<footer id="footer"></footer><script src="/js/app.js"></script>
<script>renderNav(location.pathname); renderFooter();</script>
</body>
</html>
`;
}

function nfl() {
  const dir = path.join(ROOT, "nfl");
  const games = listGames(dir).map(g => readGame(dir, g));
  const weeks = fs.existsSync(path.join(dir, "week"))
    ? fs.readdirSync(path.join(dir, "week")).filter(n => /^\d{4}-week-\d+$/.test(n)).sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()))
    : [];
  const groups = new Map();
  for (const g of games) {
    const key = g.week ? `Week ${g.week}` : longDay(g.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  }
  const weekSlug = w => weeks.find(s => s.endsWith(`-week-${w.replace("Week ", "")}`));
  let body = "";
  if (weeks.length) {
    body += `  <section class="arch-group"><h2>Every week&rsquo;s card</h2><ul class="arch-list">`
      + weeks.map(s => { const n = s.split("-").pop(), y = s.split("-")[0]; return `<li><a href="/nfl/week/${s}/">NFL Week ${n} Predictions ${y}</a></li>`; }).join("")
      + `</ul></section>\n`;
  }
  for (const [label, list] of groups) {
    const ws = label.startsWith("Week") ? weekSlug(label) : null;
    body += `  <section class="arch-group"><h2>${ws ? `<a href="/nfl/week/${ws}/">${esc(label)}</a>` : esc(label)}</h2><ul class="arch-list">`
      + list.map(g => `<li><a href="/nfl/${g.slug}/">${esc(g.title)}</a></li>`).join("")
      + `</ul></section>\n`;
  }
  const html = shell({
    sport: "NFL", url: "/nfl/games/",
    title: "NFL Predictions for Every Game in 2026 | Leo",
    description: `Every NFL game Leo has called in 2026, week by week: win chances, projected totals and the most likely touchdown scorers, each graded after the game. ${games.length} games so far.`,
    h1: "Every NFL game Leo has called",
    intro: "Each game page shows Leo&rsquo;s win chance for both teams, the projected total and the players most likely to score, frozen before kickoff and graded after the final.",
    links: [["/nfl/week/", "This week\u2019s card"], ["/nfl/teams/", "NFL team predictions"], ["/nfl/results/", "Leo\u2019s NFL record"], ["/nfl/scoreboard/", "NFL scoreboard"], ["/nba/games/", "Every NBA game"]],
    body,
  });
  fs.mkdirSync(path.join(dir, "games"), { recursive: true });
  fs.writeFileSync(path.join(dir, "games", "index.html"), html);
  return games.length;
}

function nba() {
  const dir = path.join(ROOT, "nba");
  const games = listGames(dir).map(g => readGame(dir, g));
  const groups = new Map();
  for (const g of games) { if (!groups.has(g.date)) groups.set(g.date, []); groups.get(g.date).push(g); }
  let body = "";
  for (const [date, list] of groups) {
    const dayPage = fs.existsSync(path.join(dir, "predictions", date, "index.html"));
    body += `  <section class="arch-group"><h2>${dayPage ? `<a href="/nba/predictions/${date}/">NBA predictions for ${esc(longDay(date))}</a>` : `NBA predictions for ${esc(longDay(date))}`}</h2><ul class="arch-list">`
      + list.map(g => `<li><a href="/nba/${g.slug}/">${esc(g.matchup)} Prediction</a></li>`).join("")
      + `</ul></section>\n`;
  }
  const html = shell({
    sport: "NBA", url: "/nba/games/",
    title: "NBA Predictions for Every Game, 2026-27 Season | Leo",
    description: `Every NBA game Leo has called this season, night by night: win chance and Leo's own spread beside the DraftKings line, each graded after the final. ${games.length} games so far.`,
    h1: "Every NBA game Leo has called",
    intro: "Each game page shows Leo&rsquo;s win chance and spread, the injury report Leo used, and how the read held up once the game was final.",
    links: [["/nba/scoreboard/", "Tonight\u2019s NBA card"], ["/nba/predictions/", "NBA predictions by night"], ["/nba/results/", "Leo\u2019s NBA record"], ["/nba/stats/", "NBA team stats"], ["/nfl/games/", "Every NFL game"]],
    body,
  });
  fs.mkdirSync(path.join(dir, "games"), { recursive: true });
  fs.writeFileSync(path.join(dir, "games", "index.html"), html);
  return games.length;
}

const only = process.argv[2];
if (!only || only === "nfl") console.log(`nfl/games: ${nfl()} games`);
if (!only || only === "nba") console.log(`nba/games: ${nba()} games`);
