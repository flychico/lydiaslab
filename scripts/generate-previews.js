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
function slug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }
function mlbPitcherUrl(name, id) {
  return id ? `https://www.mlb.com/player/${slug(name)}-${id}` : null;
}
function pitcherLink(name, id) {
  const label = esc(name || "TBD");
  const url = mlbPitcherUrl(name, id);
  return url ? `<a class="pitcher-link" href="${url}" target="_blank" rel="noopener">${label}</a>` : label;
}
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
  return `No meaningful bullpen fatigue edge — both pens come in comparable (${team} ${(pickScore/10).toFixed(1)}/10, ${opponent} ${(oppScore/10).toFixed(1)}/10${pickScore < 35 && oppScore < 35 ? ", both fresh" : ""}).`;
}
function pitcherSentence(g) {
  const p = g.pitcher_edge || {};
  if (!p.team || p.team === "No clear SP edge") return "The starting pitching matchup does not create a clear advantage.";
  if (p.team === g.pick_team) return `${g.pick_team} has the stronger starting pitcher matchup${p.gap ? ` by ${p.gap} points` : ""}.`;
  return `${p.team} has the starting pitcher advantage${p.gap ? ` by ${p.gap} points` : ""}, which works against LyDia's side.`;
}
function pitcherPlan(pitcher) {
  const p = pitcher || {};
  const role = p.role || {};
  return {
    name: p.name || "TBD",
    expected_innings: Number.isFinite(p.expectedInnings) ? p.expectedInnings
      : Number.isFinite(role.expectedInnings) ? role.expectedInnings : null,
    bullpen_innings: Number.isFinite(p.bullpenInnings) ? p.bullpenInnings
      : Number.isFinite(role.bullpenInnings) ? role.bullpenInnings : null,
    bullpen_game: Boolean(p.bullpenGame || role.bullpenGame)
  };
}
function bullpenGameAnalysis(g) {
  const plan = g.pitching_plan || {};
  const bullpen = g.bullpen || {};
  const pickIsAway = g.pick_team === g.away_team;
  const sides = [
    { team:g.away_team, plan:plan.away || {}, pen:pickIsAway ? bullpen.pick_team : bullpen.opponent, picked:pickIsAway },
    { team:g.home_team, plan:plan.home || {}, pen:pickIsAway ? bullpen.opponent : bullpen.pick_team, picked:!pickIsAway }
  ];
  const bullpenSides = sides.filter(item => item.plan.bullpen_game);
  if (!bullpenSides.length) return "";

  const describe = item => {
    const allocation = Number.isFinite(item.plan.expected_innings) && Number.isFinite(item.plan.bullpen_innings)
      ? `${item.plan.name} is expected to cover about ${item.plan.expected_innings.toFixed(1)} innings, leaving roughly ${item.plan.bullpen_innings.toFixed(1)} innings to the bullpen.`
      : "The relief staff is expected to cover most of the game.";
    const risk = item.pen && Number.isFinite(item.pen.risk_index)
      ? `The pen carries ${(item.pen.risk_index/10).toFixed(1)}/10 risk`
      : "";
    const efficiency = item.pen && Number.isFinite(item.pen.efficiency_score)
      ? `${risk ? " with" : "The pen has"} ${(item.pen.efficiency_score/10).toFixed(1)}/10 recent efficiency`
      : "";
    const impact = item.picked
      ? "Because this is LyDia's side, bullpen quality is central to the pick."
      : `That heavy bullpen exposure strengthens the case for ${g.pick_team}.`;
    return `${item.team} is using a bullpen game. ${allocation} ${risk}${efficiency ? efficiency : ""}${risk || efficiency ? "." : ""} ${impact}`;
  };

  let text = bullpenSides.map(describe).join(" ");
  if (bullpen.pick_team && bullpen.opponent &&
      Number.isFinite(bullpen.pick_team.efficiency_score) &&
      Number.isFinite(bullpen.opponent.efficiency_score)) {
    text += ` The bullpen efficiency comparison is ${(bullpen.pick_team.efficiency_score/10).toFixed(1)}/10 for ${g.pick_team} versus ${(bullpen.opponent.efficiency_score/10).toFixed(1)}/10 for ${opponentName(g)}.`;
  }
  return text.trim();
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

  // Use the canonical pitcher source for IDs so every displayed starter links
  // to the official MLB player page, including briefs created before IDs were
  // added directly to pitcher_edge.
  const pitcherPath = path.join(ROOT, "data", "pitcher-matchups", `${DATE}.json`);
  const pitcherGames = fs.existsSync(pitcherPath) ? (readJson(pitcherPath).games || {}) : {};
  for (const game of brief.games) {
    const canonical = pitcherGames[String(game.game_pk)] || pitcherGames[game.game_pk];
    if (!canonical || !game.pitcher_edge) continue;
    game.pitcher_edge.away_pitcher_id = game.pitcher_edge.away_pitcher_id || (canonical.away && canonical.away.id) || null;
    game.pitcher_edge.home_pitcher_id = game.pitcher_edge.home_pitcher_id || (canonical.home && canonical.home.id) || null;
    game.pitching_plan = {
      away: pitcherPlan(canonical.away),
      home: pitcherPlan(canonical.home)
    };
    game.bullpen_game = Boolean(game.pitching_plan.away.bullpen_game || game.pitching_plan.home.bullpen_game);
  }

  fs.mkdirSync(path.join(ROOT, "previews"), { recursive: true });
  const page = renderPreviewPage(brief, published);
  fs.writeFileSync(path.join(ROOT, "previews", `${DATE}.html`), page, "utf8");
  fs.writeFileSync(path.join(ROOT, "previews", "index.html"), page, "utf8");
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
<title>MLB Picks and Full-Card Analysis ${esc(titleDate)} | LyDia</title>
<meta name="description" content="LyDia MLB picks for ${esc(titleDate)} with model probability, author attribution, pitcher matchup, bullpen workload, market value, and a documented reason for every decision.">
<link rel="canonical" href="${SITE}/previews/${esc(DATE)}.html">
<link rel="stylesheet" href="/css/style.css">
<style>
.picks-hero{text-align:center;max-width:820px;margin:0 auto 22px}.picks-hero .subtitle{margin-left:auto;margin-right:auto}.pv{border:1px solid var(--border);border-radius:18px;background:linear-gradient(145deg,var(--bg-card),var(--bg-elev));padding:22px;margin:18px auto;max-width:1040px;text-align:center;box-shadow:0 12px 30px rgba(23,25,46,.06)}.pv.featured{border-color:var(--accent);box-shadow:0 12px 34px rgba(109,94,252,.16)}.pv h2{margin:0 0 5px;font-size:1.25rem}.pv .meta{color:var(--text-dim);font-size:.88rem;margin-bottom:10px}.featured-flag{display:inline-block;background:linear-gradient(90deg,var(--accent),var(--accent2));color:#fff;font-size:.75rem;font-weight:800;padding:4px 11px;border-radius:20px;margin-bottom:9px}.status-badge{display:inline-block;color:#fff;font-size:.75rem;font-weight:800;padding:4px 11px;border-radius:20px;margin:4px 0 10px;background:var(--accent2)}.status-badge.official{background:var(--good)}.status-badge.pass{background:var(--text-dim)}.status-badge.watch{background:var(--accent2)}.author-row{display:flex;align-items:center;justify-content:center;gap:9px;margin:7px auto 12px}.author-row img{width:38px;height:38px;border-radius:50%;object-fit:cover;object-position:center 24%;border:1px solid var(--border)}.author-row .byline{text-align:left;line-height:1.2}.pitcher-link{font-weight:750}.field-grid{display:grid;grid-template-columns:minmax(145px,.8fr) minmax(180px,1.2fr);gap:7px 16px;font-size:.9rem;margin:12px auto;padding:14px 0;border-top:1px dashed var(--border);border-bottom:1px dashed var(--border);max-width:760px;text-align:center}.field-grid dt{color:var(--text-dim);margin:0;font-weight:700}.field-grid dd{margin:0;font-weight:700}.why-block,.risk-block{font-size:.94rem;margin:14px auto 0;line-height:1.6;max-width:840px}.why-block b,.risk-block b{display:block;margin-bottom:3px;color:var(--text)}.archive-link{text-align:center;margin:10px 0 22px}@media(max-width:620px){.pv{padding:18px 14px}.field-grid{grid-template-columns:1fr}.field-grid dt{margin-top:5px}}
</style>
</head>
<body>
<nav id="nav"></nav>
<main>
<div class="picks-hero">
<p class="eyebrow">LyDia daily card</p>
<h1>MLB Picks | ${esc(titleDate)}</h1>
<p class="subtitle">One authoritative page for every official pick, research setup, and pass. Each decision includes the model probability, matchup evidence, risk, and author.</p>
</div>
<div class="kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px">
  <div class="card"><div class="dim small">GAMES</div><div style="font-size:1.5rem;font-weight:800">${rows.length}</div></div>
  <div class="card"><div class="dim small">OFFICIAL PICKS</div><div style="font-size:1.5rem;font-weight:800">${official.length}</div></div>
  <div class="card"><div class="dim small">VALUE WATCH</div><div style="font-size:1.5rem;font-weight:800">${valueWatch.length}</div></div>
  <div class="card"><div class="dim small">WATCHLIST</div><div style="font-size:1.5rem;font-weight:800">${watchlist.length}</div></div>
  <div class="card"><div class="dim small">PASSES</div><div style="font-size:1.5rem;font-weight:800">${passes.length}</div></div>
</div>
<p class="dim small">${updated ? `Updated ${esc(updated)}.` : "Updated by LyDia Daily Engine."} Official picks are published before grading.</p>
<p class="archive-link"><a href="/previews/archive.html">View previous daily cards &rarr;</a></p>
<div class="lead-box" style="margin-bottom:12px"><h3 style="margin:0 0 4px">Get tomorrow's MLB model card free</h3><p class="dim small" style="margin:0">One email, every morning. No payment required.</p><form name="newsletter" method="POST" data-netlify="true" netlify-honeypot="bot-field" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center"><p style="display:none"><input name="bot-field"></p><input type="hidden" name="form-name" value="newsletter"><input type="email" name="email" required placeholder="you@example.com" style="flex:1;min-width:200px"><button type="submit" class="secondary">Subscribe free</button></form></div>
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
  <div class="meta">${esc(g.time || "")} ET · ${pitcherLink(pe.away_pitcher, pe.away_pitcher_id)} vs ${pitcherLink(pe.home_pitcher, pe.home_pitcher_id)}</div>
  <div class="author-row">
    <img src="/img/lynold-mercado-headshot.jpg" alt="Lynold Mercado" width="38" height="38">
    <div class="byline small"><strong><a href="/writers/lynold/">Lynold Mercado</a></strong><br><span class="dim">Founder and Model Developer</span></div>
  </div>
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
  <div class="why-block"><b>Why LyDia made this decision</b>${bullpenGameAnalysis(g) ? `<strong>Bullpen game impact</strong><br>${esc(bullpenGameAnalysis(g))}<br><br>` : ""}${esc(LyDiaRead.clientRead(g))}</div>
  ${isPass ? `<div class="risk-block"><b>Pass reason</b>${esc(g.pass_reason || "No clear setup.")}</div>` : `<div class="risk-block"><b>Risk note</b>${esc(riskNote(g))}</div>`}
</div>`;
}

function updatePreviewArchive(date) {
  const file = path.join(ROOT, "previews", "archive.html");
  const dates = fs.readdirSync(path.join(ROOT, "previews"))
    .filter(name => /^\d{4}-\d{2}-\d{2}\.html$/.test(name))
    .map(name => name.slice(0, 10))
    .sort()
    .reverse()
    .slice(0, 60);
  const links = dates.map(day => `<a href="/previews/${day}.html">MLB Picks | ${niceDate(day)}</a>`);
  fs.writeFileSync(file, `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>MLB Picks archive | LyDia</title><meta name="description" content="LyDia's dated MLB picks and full-card analysis archive."><link rel="stylesheet" href="/css/style.css"><style>main{text-align:center}.archive-list{max-width:820px;margin:auto}.archive-list a{display:block;padding:10px 0;border-bottom:1px solid var(--border)}</style></head><body><nav id="nav"></nav><main><h1>MLB Picks Archive</h1><p class="subtitle">Previous daily cards with every official pick, research setup, and pass.</p><div class="card archive-list">
${links.join("\n")}
</div></main><footer id="footer"></footer><script src="/js/app.js"></script><script>renderNav("/previews/"); renderFooter();</script></body></html>`, "utf8");
}

function updateSitemap() {
  const staticPages = ["", "dashboard/", "picks/", "odds/", "tools/", "stats/", "recaps/", "articles/", "membership/", "results/", "previews/", "previews/archive.html", "member-brief/",
    "mlb-betting-edge-explained/", "no-vig-odds-calculator-guide/", "how-to-find-value-in-mlb-moneylines/",
    "closing-line-value-mlb-betting/", "mlb-run-line-vs-moneyline/", "mlb-bullpen-fatigue-betting/",
    "mlb-park-factors-betting-guide/", "mlb-pitching-metrics-for-betting/", "how-to-bet-on-mlb/", "tools/offense-matchups/", "tools/pitcher-matchups/", "tools/bullpen-fatigue/", "tools/strikeout-projections/", "tools/totals-projections/"];
  const recapsDir = path.join(ROOT, "recaps");
  const previewsDir = path.join(ROOT, "previews");
  const recapPosts = fs.existsSync(recapsDir) ? fs.readdirSync(recapsDir).filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).map(f => `recaps/${f}`) : [];
  const previewPosts = fs.existsSync(previewsDir) ? fs.readdirSync(previewsDir).filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).map(f => `previews/${f}`) : [];
  // Keep pages owned by other generators alive: the author entity page, the
  // matchup archive, and every indexable matchup page from the manifests.
  // Without this, whichever sitemap writer runs last silently drops them.
  const extraPages = ["writers/lynold/", "mlb/matchups/"];
  const matchupManifestDir = path.join(ROOT, "data", "matchup-pages");
  const matchupUrls = fs.existsSync(matchupManifestDir)
    ? fs.readdirSync(matchupManifestDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .flatMap(f => { try { return (JSON.parse(fs.readFileSync(path.join(matchupManifestDir, f), "utf8")).pages || []); } catch (e) { return []; } })
        .filter(p => p.indexable && p.url).map(p => p.url)
    : [];
  const urls = staticPages.map(p => `${SITE}/${p}`).concat(recapPosts.map(p => `${SITE}/${p}`)).concat(previewPosts.map(p => `${SITE}/${p}`)).concat(extraPages.map(p => `${SITE}/${p}`)).concat(matchupUrls);
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` + [...new Set(urls)].map(u => `  <url><loc>${u}</loc></url>`).join("\n") + `\n</urlset>\n`;
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), sitemap);
}
