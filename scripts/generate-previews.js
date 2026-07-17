#!/usr/bin/env node
/*
  LyDia preview renderer.
  Reads member brief and locked official picks. Does not calculate or overwrite picks.
*/
const fs = require("fs");
const path = require("path");
const LyDiaRead = require("../js/client-facing-read.js");

const SITE = "https://lydiaslab.com";
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
function prettyDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month:"short", day:"numeric", hour:"numeric", minute:"2-digit", timeZone:"America/New_York", timeZoneName:"short" });
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])); }
function pct(v, dp = 1) { return typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(dp)}%` : "-"; }
function edge(v) { return typeof v === "number" && Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${pct(v)}` : "-"; }
function labRating(v) { return LyDiaRead.labRating(v); }
function odds(v) { if (typeof v !== "number" || !Number.isFinite(v)) return "-"; return v > 0 ? `+${Math.round(v)}` : String(Math.round(v)); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function statusLabel(s) { if (s === "official_pick") return "Official Pick"; if (s === "value_watch") return "Value Watch"; if (s === "watchlist") return "Watchlist"; return "Pass"; }
function statusClass(s) { if (s === "official_pick") return "official"; if (s === "pass") return "pass"; return "watch"; }
function opponentName(g) {
  if (g.pick_team === g.away_team) return g.home_team || "Opponent";
  if (g.pick_team === g.home_team) return g.away_team || "Opponent";
  return "Opponent";
}
function bullpenAnalysis(g) {
  const bp = g.bullpen || {};
  const pick = bp.pick_team || null;
  const opp = bp.opponent || null;
  if (!pick || !opp || typeof pick.score !== "number" || typeof opp.score !== "number") return "Bullpen workload data unavailable.";

  const team = g.pick_team || "LyDia side";
  const opponent = opponentName(g);
  const pickScore = Math.round(pick.score);
  const oppScore = Math.round(opp.score);
  const pickIp = typeof pick.last3_bp_ip === "number" ? pick.last3_bp_ip.toFixed(1) : null;
  const oppIp = typeof opp.last3_bp_ip === "number" ? opp.last3_bp_ip.toFixed(1) : null;
  const pickB2b = Number(pick.back_to_back_arms || 0);
  const oppB2b = Number(opp.back_to_back_arms || 0);

  if (pickScore >= 78 && oppScore >= 78) return `Both bullpens are heavily taxed. ${team} is ${(pickScore/10).toFixed(1)}/10 and ${opponent} is ${(oppScore/10).toFixed(1)}/10, so late-game volatility is elevated on both sides.`;
  if (pickScore + 15 < oppScore) {
    const detail = oppIp !== null ? `${opponent} has used ${oppIp} bullpen innings over the last three days${oppB2b ? ` with ${oppB2b} back-to-back arm${oppB2b === 1 ? "" : "s"}` : ""}.` : "";
    return `${team} has the fresher bullpen, ${(pickScore/10).toFixed(1)}/10 versus ${(oppScore/10).toFixed(1)}/10. ${detail}`.trim();
  }
  if (pickScore > oppScore + 15) {
    const detail = pickIp !== null ? `${team} has used ${pickIp} bullpen innings over the last three days${pickB2b ? ` with ${pickB2b} back-to-back arm${pickB2b === 1 ? "" : "s"}` : ""}.` : "";
    return `${team} carries the heavier bullpen workload, ${(pickScore/10).toFixed(1)}/10 versus ${(oppScore/10).toFixed(1)}/10, which adds late-game risk. ${detail}`.trim();
  }
  if (pickScore >= 60 || oppScore >= 60) return `Bullpen workload is elevated but not decisive. ${team} is ${(pickScore/10).toFixed(1)}/10 and ${opponent} is ${(oppScore/10).toFixed(1)}/10.`;
  return `No meaningful bullpen fatigue edge. ${team} is ${(pickScore/10).toFixed(1)}/10 and ${opponent} is ${(oppScore/10).toFixed(1)}/10.`;
}
function pitcherSentence(g) {
  const p = g.pitcher_edge || {};
  if (!p.team || p.team === "No clear SP edge") return "The starting pitching matchup does not create a clear advantage.";
  if (p.team === g.pick_team) return `${g.pick_team} has the stronger starting pitcher matchup${p.gap ? ` by ${p.gap} points` : ""}.`;
  return `${p.team} has the starting pitcher advantage${p.gap ? ` by ${p.gap} points` : ""}, which works against LyDia's side.`;
}
function clientRead(g) {
  const m = g.market || {};
  const team = g.pick_team || "This side";
  const modelProb = pct(g.model_probability);
  const marketProb = pct(m.no_vig_probability);
  const price = odds(m.best_price);
  const pitcher = pitcherSentence(g);
  const bullpen = bullpenAnalysis(g);

  if (g.status === "official_pick") {
    return `${team} is an official moneyline pick because LyDia gives it a ${modelProb} chance to win, compared with the market's ${marketProb} no-vig probability. ${pitcher} ${bullpen} At ${price}, the price still offers enough value for the play to qualify as official.`;
  }
  if (g.status === "value_watch") {
    return `${team} grades as a strong setup because LyDia sees ${modelProb} win probability against a ${marketProb} market number. ${pitcher} ${bullpen} It stays a value watch instead of an official pick because the model probability does not reach the 72% official threshold.`;
  }
  if (g.status === "watchlist") {
    return `${team} is worth monitoring, but it does not clear every requirement for an official pick. LyDia projects ${modelProb} win probability against a ${marketProb} market number. ${pitcher} ${bullpen}`;
  }
  return g.pass_reason || `${team} does not have a strong enough overall setup for an official pick.`;
}
function riskNote(g) {
  const notes = [];
  if (g.pitcher_edge && g.pitcher_edge.conflict) notes.push("starting pitcher edge conflicts with the model side");
  if (g.bullpen && g.bullpen.major_caution) notes.push("bullpen fatigue adds late-game caution");
  if (g.market && g.market.books && g.market.books < 3) notes.push("limited sportsbook sample");
  if (!notes.length) return "No model can see every live lineup, injury, or late bullpen availability update. Recheck official news before first pitch.";
  return `Primary caution: ${notes.join("; ")}. Recheck official news before first pitch.`;
}

async function main() {
  const briefPath = path.join(ROOT, "data", "member-brief", `${DATE}.json`);
  const publishedPath = path.join(ROOT, "data", "published-picks", `${DATE}.json`);

  if (!fs.existsSync(briefPath)) throw new Error(`Missing member brief for ${DATE}. Run the source engine before rendering previews.`);
  if (!fs.existsSync(publishedPath)) throw new Error(`Missing locked official picks for ${DATE}. Run the source engine before rendering previews.`);

  const brief = readJson(briefPath);
  const published = readJson(publishedPath);
  if (!Array.isArray(brief.games)) throw new Error(`Member brief for ${DATE} does not contain a games array.`);
  if (!Array.isArray(published.picks)) throw new Error(`Official pick file for ${DATE} does not contain a picks array.`);
  if (!brief.games.length) throw new Error(`Preview guard: ${DATE} has zero games in the member brief. Refusing to publish an empty public preview page.`);

  fs.mkdirSync(path.join(ROOT, "previews"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "previews", `${DATE}.html`), renderPreviewPage(brief, published), "utf8");
  updatePreviewArchive(DATE);
  updateSitemap();
  console.log(`Rendered previews/${DATE}.html from source data. Official picks: ${published.picks.length}.`);
}

function renderPreviewPage(brief, published) {
  const rows = [...brief.games].sort((a, b) => (b.lab_score || 0) - (a.lab_score || 0));
  const official = rows.filter(r => r.status === "official_pick");
  const valueWatch = rows.filter(r => r.status === "value_watch");
  const watchlist = rows.filter(r => r.status === "watchlist");
  const passes = rows.filter(r => r.status === "pass");
  const titleDate = niceDate(brief.date || DATE);
  const cards = rows.map((g, i) => renderCard(g, i === 0 && g.status === "official_pick")).join("\n");
  const updated = prettyDateTime(brief.generated_at || published.generated_at || published.generated);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MLB Game Previews and Lab Ratings ${esc(titleDate)} | LyDia</title>
<meta name="description" content="LyDia MLB previews for ${esc(titleDate)} with bettor-friendly moneyline reasoning, model probability, pitcher matchup, bullpen workload, and market value.">
<link rel="canonical" href="${SITE}/previews/${esc(DATE)}.html">
<link rel="stylesheet" href="/css/style.css">
<style>
.pv{border:1px solid var(--border);border-radius:10px;background:var(--bg-card);padding:18px;margin:16px 0}.pv.featured{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}.pv h2{margin:0 0 4px;font-size:1.15rem}.pv .meta{color:var(--text-dim);font-size:.85rem;margin-bottom:8px}.featured-flag{display:inline-block;background:var(--accent);color:#fff;font-size:.75rem;font-weight:700;padding:2px 9px;border-radius:20px;margin-bottom:8px}.status-badge{display:inline-block;color:#fff;font-size:.75rem;font-weight:700;padding:3px 10px;border-radius:20px;margin:4px 0 8px;background:var(--accent2)}.status-badge.official{background:var(--good)}.status-badge.pass{background:var(--text-dim)}.status-badge.watch{background:var(--accent2)}.field-grid{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;font-size:.88rem;margin:10px 0;padding:10px 0;border-top:1px dashed var(--border);border-bottom:1px dashed var(--border)}.field-grid dt{color:var(--text-dim);margin:0}.field-grid dd{margin:0;font-weight:600}.why-block,.risk-block{font-size:.92rem;margin-top:12px;line-height:1.55}.why-block b,.risk-block b{display:block;margin-bottom:3px;color:var(--text)}
</style>
</head>
<body>
<nav id="nav"></nav>
<main>
<h1>MLB Game Previews | ${esc(titleDate)}</h1>
<p class="subtitle">The daily card in bettor-friendly language: what LyDia likes, what it does not, and the actual reason behind each decision.</p>
<div class="kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px">
  <div class="card"><div class="dim small">GAMES</div><div style="font-size:1.5rem;font-weight:800">${rows.length}</div></div>
  <div class="card"><div class="dim small">OFFICIAL PICKS</div><div style="font-size:1.5rem;font-weight:800">${official.length}</div></div>
  <div class="card"><div class="dim small">VALUE WATCH</div><div style="font-size:1.5rem;font-weight:800">${valueWatch.length}</div></div>
  <div class="card"><div class="dim small">WATCHLIST</div><div style="font-size:1.5rem;font-weight:800">${watchlist.length}</div></div>
  <div class="card"><div class="dim small">PASSES</div><div style="font-size:1.5rem;font-weight:800">${passes.length}</div></div>
</div>
<p class="dim small">${updated ? `Updated ${esc(updated)}.` : "Updated by LyDia Daily Engine."} Official picks are published before grading.</p>
<div class="lead-box" style="border-color:var(--accent2)"><h3 style="margin:0 0 4px">Get the organized member view</h3><p class="dim small" style="margin:0">Members get official picks first, value watch setups second, and clear pass reasons for the rest of the card.</p><p style="margin-top:10px"><a class="btn blue" href="/membership/">Join LyDia | $30/mo</a> <a class="btn secondary" href="/member-brief/">Open Member Brief</a></p></div>
${cards}
<p class="dim small">Model outputs, not promises. LyDia provides analysis and education only, not betting advice. Every official pick is graded on the <a href="/results/">Results page</a>.</p>
</main>
<footer id="footer"></footer>
<script src="/js/app.js"></script>
<script>renderNav("/previews/"); renderFooter();</script>
</body>
</html>`;
}

function renderCard(g, featured) {
  const pe = g.pitcher_edge || {};
  const m = g.market || {};
  const isPass = g.status === "pass";
  return `<div class="${featured ? "pv featured" : "pv"}" data-lab-score="${esc(g.lab_score ?? "")}">
  ${featured ? `<span class="featured-flag">Top Lab Rating</span>` : ""}<h2>${esc(g.game || "")}</h2>
  <div class="meta">${esc(g.time || "")} ET · ${esc(pe.away_pitcher || "TBD")} vs ${esc(pe.home_pitcher || "TBD")}</div>
  <span class="status-badge ${statusClass(g.status)}">${statusLabel(g.status)}</span>
  <dl class="field-grid">
    <dt>LyDia side</dt><dd>${esc(g.pick_team || "-")} Money Line</dd>
    <dt>Lab Rating</dt><dd>${labRating(g.lab_score)}</dd>
    <dt>Model probability</dt><dd>${pct(g.model_probability)}</dd>
    <dt>Market probability</dt><dd>${pct(m.no_vig_probability)}</dd>
    <dt>Model vs market</dt><dd>${edge(g.edge)}</dd>
    <dt>Current price</dt><dd>${odds(m.best_price)}</dd>
    <dt>Pitcher edge</dt><dd>${esc(pe.team || "-")}${pe.gap ? ` by ${esc(pe.gap)} points` : ""}</dd>
    <dt>Bullpen read</dt><dd>${esc(bullpenAnalysis(g))}</dd>
  </dl>
  <div class="why-block"><b>Why LyDia made this decision</b>${esc(LyDiaRead.clientRead(g))}</div>
  ${isPass ? `<div class="risk-block"><b>Pass reason</b>${esc(g.pass_reason || "No clear setup.")}</div>` : `<div class="risk-block"><b>Risk note</b>${esc(riskNote(g))}</div>`}
</div>`;
}

function updatePreviewArchive(date) {
  const file = path.join(ROOT, "previews", "index.html");
  const link = `<a href="/previews/${date}.html">Game Previews | ${niceDate(date)}</a>`;
  let links = [];
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf8");
    const matches = existing.match(/<a href="\/previews\/\d{4}-\d{2}-\d{2}\.html">[^<]+<\/a>/g) || [];
    links = matches.filter(x => !x.includes(`/previews/${date}.html`));
  }
  links.unshift(link);
  links = [...new Set(links)].slice(0, 60);
  fs.writeFileSync(file, `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>MLB Game Previews archive | LyDia</title><meta name="description" content="Daily MLB game previews with bettor-friendly reasoning, model probability, pitcher matchup, bullpen workload, and market context."><link rel="stylesheet" href="/css/style.css"><style>.archive-list a{display:block;padding:8px 0;border-bottom:1px solid var(--border)}</style></head><body><nav id="nav"></nav><main><h1>Game Previews</h1><p class="subtitle">Daily MLB previews with the reason behind every official pick, value watch, watchlist, and pass.</p><div class="card archive-list">
${links.join("\n")}
</div></main><footer id="footer"></footer><script src="/js/app.js"></script><script>renderNav("/previews/"); renderFooter();</script></body></html>`, "utf8");
}

function updateSitemap() {
  const staticPages = ["", "dashboard/", "picks/", "odds/", "tools/", "stats/", "recaps/", "articles/", "membership/", "results/", "previews/", "member-brief/",
    "mlb-betting-edge-explained/", "no-vig-odds-calculator-guide/", "how-to-find-value-in-mlb-moneylines/",
    "closing-line-value-mlb-betting/", "mlb-run-line-vs-moneyline/", "mlb-bullpen-fatigue-betting/",
    "mlb-park-factors-betting-guide/", "mlb-pitching-metrics-for-betting/", "how-to-bet-on-mlb/", "tools/offense-matchups/", "tools/pitcher-matchups/", "tools/bullpen-fatigue/", "tools/strikeout-projections/"];
  const recapsDir = path.join(ROOT, "recaps");
  const previewsDir = path.join(ROOT, "previews");
  const recapPosts = fs.existsSync(recapsDir) ? fs.readdirSync(recapsDir).filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).map(f => `recaps/${f}`) : [];
  const previewPosts = fs.existsSync(previewsDir) ? fs.readdirSync(previewsDir).filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).map(f => `previews/${f}`) : [];
  const urls = staticPages.map(p => `${SITE}/${p}`).concat(recapPosts.map(p => `${SITE}/${p}`)).concat(previewPosts.map(p => `${SITE}/${p}`));
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` + [...new Set(urls)].map(u => `  <url><loc>${u}</loc></url>`).join("\n") + `\n</urlset>\n`;
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), sitemap);
}
