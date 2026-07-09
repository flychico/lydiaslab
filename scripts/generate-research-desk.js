#!/usr/bin/env node
/*
  LyDia Research Desk generator.
  Pulls recent public MLB betting coverage, shows source links, and adds original LyDia context.
  It never changes official picks.
*/
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SITE = "https://mlbedges.com";
const MAX_ITEMS = 12;
const QUERIES = [
  "MLB betting picks Action Network",
  "MLB betting picks Covers",
  "MLB betting picks BettingPros",
  "MLB betting picks Sportsbook Review",
  "MLB betting picks VSiN"
];
const ALLOWED_SOURCE_HINTS = ["action network", "covers", "bettingpros", "sportsbook review", "vsin", "fanduel research", "rotowire"];

function etToday() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone:"America/New_York" }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])); }
function decodeXml(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function stripHtml(s) { return decodeXml(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return m ? decodeXml(m[1]).trim() : "";
}
function sourceTag(block) {
  const m = block.match(/<source(?:\s[^>]*)?>([\s\S]*?)<\/source>/i);
  return m ? stripHtml(m[1]) : "";
}
function parseItems(xml) {
  const blocks = String(xml || "").match(/<item>[\s\S]*?<\/item>/gi) || [];
  return blocks.map(block => ({
    title: stripHtml(tag(block, "title")),
    link: stripHtml(tag(block, "link")),
    published_at: stripHtml(tag(block, "pubDate")),
    description: stripHtml(tag(block, "description")),
    source: sourceTag(block)
  })).filter(x => x.title && x.link);
}
function cleanTitle(title, source) {
  let out = String(title || "").trim();
  if (source && out.toLowerCase().endsWith(` - ${source.toLowerCase()}`)) out = out.slice(0, -(source.length + 3)).trim();
  return out;
}
function readJsonSafe(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")); } catch (e) { return null; }
}
function currentBrief() {
  const today = etToday();
  const dated = readJsonSafe(`data/member-brief/${today}.json`);
  if (dated && dated.date === today && Array.isArray(dated.games)) return dated;
  const mirror = readJsonSafe("data/member-brief/today.json");
  if (mirror && mirror.date === today && Array.isArray(mirror.games)) return mirror;
  return null;
}
function teamNames(brief) {
  const names = new Set();
  for (const g of (brief && brief.games) || []) {
    if (g.away_team) names.add(g.away_team);
    if (g.home_team) names.add(g.home_team);
  }
  return [...names].sort((a, b) => b.length - a.length);
}
function matchedGame(title, brief) {
  if (!brief) return null;
  const lower = title.toLowerCase();
  const teams = teamNames(brief).filter(t => lower.includes(t.toLowerCase()) || lower.includes(shortTeam(t).toLowerCase()));
  if (!teams.length) return null;
  return brief.games.find(g => teams.includes(g.away_team) || teams.includes(g.home_team)) || null;
}
function shortTeam(name) {
  const two = ["Red Sox", "White Sox", "Blue Jays"].find(x => String(name).endsWith(x));
  if (two) return two;
  const parts = String(name || "").split(" ");
  return parts[parts.length - 1] || name;
}
function pct(v) { return typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "-"; }
function labelStatus(s) { return s === "official_pick" ? "official pick" : s === "value_watch" ? "value watch" : s === "watchlist" ? "watchlist" : "pass"; }
function genericTakeaway(title) {
  const t = title.toLowerCase();
  if (/injury|lineup|scratch|out of lineup|activated|il\b/.test(t)) return "Lineup and availability news can materially change a moneyline read. Recheck the confirmed lineup and price before first pitch.";
  if (/pitcher|pitching|strikeout|starter|era|whip/.test(t)) return "This is a pitching-focused angle. Compare the claimed starter advantage with LyDia's pitcher matchup, model probability, and bullpen condition before treating it as actionable.";
  if (/bullpen|reliever|closer/.test(t)) return "Bullpen context matters most when recent workload is concentrated in the arms likely to pitch again. Compare the article's angle with LyDia's fatigue score and back-to-back usage.";
  if (/odds|pick|prediction|best bet|moneyline/.test(t)) return "This is an external market opinion. Agreement is useful context, but LyDia only makes an official pick when probability, price, Lab Score, pitcher support, and bullpen risk all clear the required checks.";
  return "Useful outside context, but not an official LyDia signal by itself. Compare it with model probability, market price, starting pitching, and bullpen workload.";
}
function lydiaTakeaway(item, brief) {
  const game = matchedGame(item.title, brief);
  if (!game) return genericTakeaway(item.title);
  const m = game.market || {};
  return `This coverage relates to ${game.game}. LyDia's current side is ${game.pick_team} Money Line at ${pct(game.model_probability)} model probability, ${game.lab_score}/100 Lab Score, and ${labelStatus(game.status)} status. The external article is context, not a reason to change the official pick by itself.`;
}
function normalizeDate(s) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      headers: { "user-agent":"Mozilla/5.0 LyDiaResearchDesk/1.0" },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  } finally {
    clearTimeout(timer);
  }
}
function buildUrl(q) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
}
function allowed(item) {
  const hay = `${item.source} ${item.title}`.toLowerCase();
  return ALLOWED_SOURCE_HINTS.some(s => hay.includes(s));
}
function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = cleanTitle(item.title, item.source).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
function renderPage(data) {
  const cards = data.items.length ? data.items.map(item => `
  <article class="card desk-card">
    <div class="source-row"><span class="badge neutral">${esc(item.source || "External source")}</span><span class="small dim">${esc(item.published_label || "Recent")}</span></div>
    <h2><a href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a></h2>
    <div class="takeaway"><strong>LyDia takeaway</strong><p>${esc(item.lydia_takeaway)}</p></div>
  </article>`).join("\n") : `<div class="notice">No recent market coverage was available when this page was generated. LyDia's official picks and model pages remain independent of external sources.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LyDia Research Desk | MLB betting market intelligence</title>
<meta name="description" content="Recent public MLB betting coverage from major market sources, organized with original LyDia context and model comparisons.">
<link rel="canonical" href="${SITE}/articles/">
<link rel="stylesheet" href="/css/style.css">
<style>
.desk-grid{display:grid;gap:14px;margin-top:18px}.desk-card h2{font-size:1.08rem;margin:10px 0}.source-row{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}.takeaway{margin-top:12px;padding:12px 14px;border-left:3px solid var(--accent2);background:var(--bg-elev);border-radius:6px}.takeaway p{margin:4px 0 0;line-height:1.55}.library{margin-top:30px}
</style>
</head>
<body>
<nav id="nav"></nav>
<main>
  <p class="eyebrow">Market intelligence</p>
  <h1>LyDia Research Desk</h1>
  <p class="subtitle">Recent public MLB betting coverage from major market sources, filtered through LyDia's own model context. We link to the original source, then explain what matters for our process.</p>
  <div class="notice"><strong>Independence rule:</strong> Competitor posts are research inputs only. They do not create, change, or override LyDia's official picks.</div>
  <div class="desk-grid">${cards}</div>

  <section class="library">
    <h2>LyDia's research library</h2>
    <p class="subtitle">Evergreen guides that explain the math behind the model and market.</p>
    <div class="grid grid-3">
      <div class="card"><h3><a href="/mlb-betting-edge-explained/">What Is Edge in MLB Betting?</a></h3><p>What edge means, where it comes from, and how LyDia compares probability with price.</p></div>
      <div class="card"><h3><a href="/no-vig-odds-calculator-guide/">No-Vig Odds Calculator Guide</a></h3><p>How to remove the sportsbook margin and estimate the market's true probability.</p></div>
      <div class="card"><h3><a href="/closing-line-value-mlb-betting/">Closing Line Value</a></h3><p>Why price movement matters when judging process over time.</p></div>
      <div class="card"><h3><a href="/mlb-bullpen-fatigue-betting/">Bullpen Fatigue</a></h3><p>How recent innings and back-to-back arms can change the late-game outlook.</p></div>
      <div class="card"><h3><a href="/mlb-pitching-metrics-for-betting/">Pitching Metrics</a></h3><p>ERA, WHIP, strikeouts, walks, and how pitcher context affects a moneyline.</p></div>
      <div class="card"><h3><a href="/how-to-find-value-in-mlb-moneylines/">Finding Moneyline Value</a></h3><p>A repeatable framework for comparing a win probability with the available price.</p></div>
    </div>
  </section>
  <p class="dim small" style="margin-top:24px">Last refreshed ${esc(data.generated_at)}. External sources remain responsible for their own content and opinions.</p>
</main>
<footer id="footer"></footer><script src="/js/app.js"></script><script>renderNav("/articles/"); renderFooter();</script>
</body>
</html>`;
}

async function main() {
  const brief = currentBrief();
  const fetched = [];
  const warnings = [];
  for (const query of QUERIES) {
    try {
      const xml = await fetchText(buildUrl(query));
      fetched.push(...parseItems(xml));
    } catch (err) {
      warnings.push(`${query}: ${err.message}`);
    }
  }

  let items = dedupe(fetched.filter(allowed)).map(item => {
    const source = item.source || "External source";
    const published = normalizeDate(item.published_at);
    return {
      title: cleanTitle(item.title, source),
      source,
      link: item.link,
      published_at: published,
      published_label: published ? new Date(published).toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric", timeZone:"America/New_York" }) : "Recent",
      lydia_takeaway: lydiaTakeaway(item, brief)
    };
  }).sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || ""))).slice(0, MAX_ITEMS);

  if (!items.length) {
    const prior = readJsonSafe("data/research-desk.json");
    if (prior && Array.isArray(prior.items) && prior.items.length) items = prior.items;
  }

  const out = {
    date: etToday(),
    generated_at: new Date().toISOString(),
    mode: "external-market-coverage-with-original-lydia-context",
    note: "External posts are research inputs only and never create or change official picks.",
    warnings,
    items
  };

  fs.mkdirSync(path.join(ROOT, "data"), { recursive:true });
  fs.mkdirSync(path.join(ROOT, "articles"), { recursive:true });
  fs.writeFileSync(path.join(ROOT, "data", "research-desk.json"), JSON.stringify(out, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(ROOT, "articles", "index.html"), renderPage(out), "utf8");
  console.log(`Research Desk refreshed. Items: ${items.length}. Warnings: ${warnings.length}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
