#!/usr/bin/env node
/*
  LyDia preview renderer.
  This file no longer calculates official picks and no longer writes data/picks.
  It renders previews from data/member-brief/<date>.json and data/published-picks/<date>.json.
*/
const fs = require("fs");
const path = require("path");

const SITE = "https://mlbedges.com";
const ROOT = path.join(__dirname, "..");
const DATE = process.argv[2] || etToday();

if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error("Bad date:", DATE);
  process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });

function etToday() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}
function niceDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" });
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function pct(v, dp = 1) { return typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(dp)}%` : "—"; }
function edge(v) { return typeof v === "number" && Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${pct(v)}` : "—"; }
function odds(v) { if (typeof v !== "number" || !Number.isFinite(v)) return "—"; return v > 0 ? `+${Math.round(v)}` : String(Math.round(v)); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function exists(file) { return fs.existsSync(path.join(ROOT, file)); }

async function main() {
  const briefPath = path.join(ROOT, "data", "member-brief", `${DATE}.json`);
  const publishedPath = path.join(ROOT, "data", "published-picks", `${DATE}.json`);

  if (!fs.existsSync(briefPath)) {
    throw new Error(`Missing data/member-brief/${DATE}.json. Run scripts/generate-member-lab.js first.`);
  }
  if (!fs.existsSync(publishedPath)) {
    throw new Error(`Missing data/published-picks/${DATE}.json. Run scripts/generate-member-lab.js first.`);
  }

  const brief = readJson(briefPath);
  const published = readJson(publishedPath);
  if (!Array.isArray(brief.games)) throw new Error(`${briefPath} does not contain games array.`);
  if (!Array.isArray(published.picks)) throw new Error(`${publishedPath} does not contain picks array.`);

  fs.mkdirSync(path.join(ROOT, "previews"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "previews", `${DATE}.html`), renderPreviewPage(brief, published), "utf8");
  updatePreviewArchive(DATE);
  updateSitemap();

  console.log(`Rendered previews/${DATE}.html from member brief and published-picks. Official picks: ${published.picks.length}.`);
}

function statusLabel(s) {
  if (s === "official_pick") return "Official Pick";
  if (s === "watchlist") return "Watchlist";
  return "Pass";
}
function statusClass(s) {
  if (s === "official_pick") return "official";
  if (s === "pass") return "pass";
  return "watch";
}
function riskNote(g) {
  const notes = [];
  if (g.pitcher_edge && g.pitcher_edge.conflict) notes.push("starting pitcher edge conflicts with the model side");
  if (g.bullpen && g.bullpen.major_caution) notes.push("bullpen fatigue adds late-game caution");
  if (g.bullpen && g.bullpen.label === "Both bullpens stressed") notes.push("both bullpens show elevated recent workload");
  else if (g.bullpen && g.bullpen.label === "Elevated volatility") notes.push("bullpen workload adds late-game volatility");
  if (g.market && g.market.books && g.market.books < 3) notes.push("limited sportsbook sample");
  if (!notes.length) return "No model can see every live lineup, injury, or late bullpen availability update. Recheck official news before first pitch.";
  return `Primary caution: ${notes.join("; ")}. Recheck official news before first pitch.`;
}

function renderPreviewPage(brief, published) {
  const rows = [...brief.games].sort((a, b) => (b.lab_score || 0) - (a.lab_score || 0));
  const official = rows.filter(r => r.status === "official_pick");
  const watchlist = rows.filter(r => r.status === "watchlist");
  const passes = rows.filter(r => r.status === "pass");
  const titleDate = niceDate(brief.date || DATE);
  const cards = rows.map((g, i) => renderCard(g, i === 0 && g.status === "official_pick")).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MLB Game Previews &amp; Lab Scores ${esc(titleDate)} | LyDia</title>
<meta name="description" content="LyDia MLB previews for ${esc(titleDate)} with Lab Score, pitcher matchup, bullpen fatigue, market edge, official picks, watchlist, and pass reasons.">
<link rel="canonical" href="${SITE}/previews/${esc(DATE)}.html">
<link rel="stylesheet" href="/css/style.css">
<style>
.pv{border:1px solid var(--border);border-radius:10px;background:var(--bg-card);padding:18px;margin:16px 0}.pv.featured{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}.pv h2{margin:0 0 4px;font-size:1.15rem}.pv .meta{color:var(--text-dim);font-size:.85rem;margin-bottom:8px}.featured-flag{display:inline-block;background:var(--accent);color:#fff;font-size:.75rem;font-weight:700;padding:2px 9px;border-radius:20px;margin-bottom:8px}.status-badge{display:inline-block;color:#fff;font-size:.75rem;font-weight:700;padding:3px 10px;border-radius:20px;margin:4px 0 8px;background:var(--accent2)}.status-badge.official{background:var(--good)}.status-badge.pass{background:var(--text-dim)}.status-badge.watch{background:var(--accent2)}.field-grid{display:grid;grid-template-columns:auto 1fr;gap:3px 14px;font-size:.85rem;margin:10px 0;padding:10px 0;border-top:1px dashed var(--border);border-bottom:1px dashed var(--border)}.field-grid dt{color:var(--text-dim);margin:0}.field-grid dd{margin:0;font-weight:600}.why-block,.risk-block{font-size:.88rem;margin-top:10px;line-height:1.45}.why-block b,.risk-block b{display:block;margin-bottom:3px;color:var(--text)}
</style>
</head>
<body>
<nav id="nav"></nav>
<main>
<h1>MLB Game Previews — ${esc(titleDate)}</h1>
<p class="subtitle">Rendered from LyDia's source-of-truth member brief and dated published-picks file. This page does not create or overwrite official picks.</p>
<div class="kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px">
  <div class="card"><div class="dim small">GAMES</div><div style="font-size:1.5rem;font-weight:800">${rows.length}</div></div>
  <div class="card"><div class="dim small">OFFICIAL PICKS</div><div style="font-size:1.5rem;font-weight:800">${official.length}</div></div>
  <div class="card"><div class="dim small">WATCHLIST</div><div style="font-size:1.5rem;font-weight:800">${watchlist.length}</div></div>
  <div class="card"><div class="dim small">PASSES</div><div style="font-size:1.5rem;font-weight:800">${passes.length}</div></div>
</div>
<p class="dim small">Generated ${esc(brief.generated_at || published.generated_at || published.generated || "")} · Official record source: <code>data/published-picks/${esc(DATE)}.json</code>.</p>
<div class="lead-box" style="border-color:var(--accent2)"><h3 style="margin:0 0 4px">Get the organized member view</h3><p class="dim small" style="margin:0">Members get the Daily Member Brief: official picks first, watchlist second, pass reasons third, and market tracking as prices change.</p><p style="margin-top:10px"><a class="btn blue" href="/membership/">Join LyDia — $30/mo →</a> <a class="btn secondary" href="/member-brief/">Open Member Brief</a></p></div>
${cards}
<p class="dim small">Model outputs, not guarantees. LyDia provides analysis and education only, not betting advice. Every official pick is graded on the <a href="/results/">Results page</a>.</p>
</main>
<footer id="footer"></footer>
<script src="/js/app.js"></script>
<script>renderNav("/previews/"); renderFooter();</script>
</body>
</html>
`;
}

function renderCard(g, featured) {
  const pe = g.pitcher_edge || {};
  const bp = g.bullpen || {};
  const m = g.market || {};
  const isPass = g.status === "pass";
  return `<div class="${featured ? "pv featured" : "pv"}" data-lab-score="${esc(g.lab_score ?? "")}">
  ${featured ? `<span class="featured-flag">Top Lab Score</span>` : ""}<h2>${esc(g.game || "")}</h2>
  <div class="meta">${esc(g.time || "")} ET · ${esc(pe.away_pitcher || "TBD")} vs ${esc(pe.home_pitcher || "TBD")}</div>
  <span class="status-badge ${statusClass(g.status)}">${statusLabel(g.status)}</span>
  <dl class="field-grid">
    <dt>LyDia side</dt><dd>${esc(g.pick_team || "—")}</dd>
    <dt>Lab Score</dt><dd>${esc(g.lab_score ?? "—")}/100</dd>
    <dt>Model probability</dt><dd>${pct(g.model_probability)}</dd>
    <dt>Market probability</dt><dd>${pct(m.no_vig_probability)}</dd>
    <dt>Model vs market</dt><dd>${edge(g.edge)}</dd>
    <dt>Current price</dt><dd>${odds(m.best_price)}</dd>
    <dt>Pitcher edge</dt><dd>${esc(pe.team || "—")}${pe.gap ? ` (gap ${esc(pe.gap)})` : ""}</dd>
    <dt>Bullpen read</dt><dd>${esc(bp.label || "—")}</dd>
  </dl>
  <div class="why-block"><b>Read</b>${esc(g.read || "")}</div>
  ${isPass ? `<div class="risk-block"><b>Pass reason</b>${esc(g.pass_reason || "No clear setup.")}</div>` : `<div class="risk-block"><b>Risk note</b>${esc(riskNote(g))}</div>`}
</div>`;
}

function updatePreviewArchive(date) {
  const file = path.join(ROOT, "previews", "index.html");
  const link = `<a href="/previews/${date}.html">Game Previews — ${niceDate(date)}</a>`;
  let links = [];
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf8");
    const matches = existing.match(/<a href="\/previews\/\d{4}-\d{2}-\d{2}\.html">[^<]+<\/a>/g) || [];
    links = matches.filter(x => !x.includes(`/previews/${date}.html`));
  }
  links.unshift(link);
  links = [...new Set(links)].slice(0, 60);
  fs.writeFileSync(file, `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>MLB Game Previews — archive | LyDia</title><meta name="description" content="Daily MLB game previews generated after LyDia's Lab Score, pitcher matchup, bullpen fatigue, and market checks."><link rel="stylesheet" href="/css/style.css"><style>.archive-list a{display:block;padding:8px 0;border-bottom:1px solid var(--border)}</style></head><body><nav id="nav"></nav><main><h1>Game Previews</h1><p class="subtitle">Daily previews rendered from LyDia's source-of-truth engine.</p><div class="card archive-list">
${links.join("\n")}
</div></main><footer id="footer"></footer><script src="/js/app.js"></script><script>renderNav("/previews/"); renderFooter();</script></body></html>
`, "utf8");
}

function updateSitemap() {
  const staticPages = ["", "dashboard/", "picks/", "odds/", "tools/", "stats/", "recaps/", "articles/", "membership/", "results/", "previews/", "member-brief/", "tools/market/",
    "mlb-betting-edge-explained/", "no-vig-odds-calculator-guide/", "how-to-find-value-in-mlb-moneylines/",
    "closing-line-value-mlb-betting/", "mlb-run-line-vs-moneyline/", "mlb-bullpen-fatigue-betting/",
    "mlb-park-factors-betting-guide/", "mlb-pitching-metrics-for-betting/"];
  const recapsDir = path.join(ROOT, "recaps");
  const previewsDir = path.join(ROOT, "previews");
  const recapPosts = fs.existsSync(recapsDir) ? fs.readdirSync(recapsDir).filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).map(f => `recaps/${f}`) : [];
  const previewPosts = fs.existsSync(previewsDir) ? fs.readdirSync(previewsDir).filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).map(f => `previews/${f}`) : [];
  const urls = staticPages.map(p => `${SITE}/${p}`).concat(recapPosts.map(p => `${SITE}/${p}`)).concat(previewPosts.map(p => `${SITE}/${p}`));
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` + urls.map(u => `  <url><loc>${u}</loc></url>`).join("\n") + `\n</urlset>\n`, "utf8");
}
