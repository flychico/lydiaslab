#!/usr/bin/env node
/**
 * NFL anytime touchdown page: /nfl/anytime-touchdowns/ (this week) and one permanent page per week,
 * /nfl/anytime-touchdowns/<season>-week-<n>/.
 * Lynold, 2026-11-27: "I want the any time touchdowns to be its own page and its own tab on the website menu.
 * we should be posting it a week / a few days in advance so google has enough time to index it. ... post the
 * any time touchdown scores with the odds leo rates them. maybe even throw in some recent stats".
 *
 * Data, per game date of the week:
 *   Leo's chance: the game-day read (data/nfl/props-<date>.json, ANYTIME_TD) when there is one, else the early
 *     read (data/nfl/td-early/<date>.json, from generate-nfl-props.js --early; never graded).
 *   Leo's odds: Leo's chance as a fair American price (no bookmaker margin).
 *   Market: the books' average price at the latest capture before kickoff (data/nfl/odds-history-props.csv),
 *     shown beside Leo's, never used by Leo.
 *   Stats: td_stats on each row (season touchdowns, games with one, last five games, usage, what the opponent
 *     allows to the position), from nflverse weekly stats.
 *   Result: data/nfl/nfl-props-graded.csv once graded.
 *   Leo's top 3: the TOUCHDOWN WATCH players (data/nfl/td-picks/<date>.json top3_day once frozen); graded picks
 *     publicly from Week 13 (2026-12-03, DEC-20261126-08), reads before that.
 *
 *   node scripts/build-nfl-td-page.js        builds every week with data from today back 7 days and ahead 9 days
 */
"use strict";
const fs = require("fs");
const path = require("path");
const TEAMS = require("./lib/nfl-teams");
const SEO = require("./lib/game-page-seo");
const { GA_HEAD } = require("./lib/ga");
const SIGNUP = require("./lib/nba-signup-box");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "data/nfl");
const ORIGIN = "https://ndhorizon.com";
const HUB = "/nfl/anytime-touchdowns/";
const PICKS_FROM = "2026-12-03";
const TOP_N = 8;   // players shown per game, highest chance first
const NOW = Date.now();
const todayET = new Date(NOW).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pct = p => `${Math.round(p * 100)}%`;
const norm = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "").replace(/(jr|sr|ii|iii|iv)$/, "");

function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  const h = rows.shift() || [];
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ""])));
}
const readCsv = f => fs.existsSync(f) ? parseCsv(fs.readFileSync(f, "utf8")) : [];

/** Leo's chance as a fair American price, rounded to 5. */
function fairOdds(p) {
  if (!(p > 0 && p < 1)) return "";
  const v = p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p;
  const r = Math.round(v / 5) * 5;
  return r > 0 ? `+${r}` : String(r);
}
const american = p => !(p > 0 && p < 1) ? null : p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
const fmtPrice = v => v == null ? "" : v > 0 ? `+${v}` : String(v);

function kickUtc(date, hhmm) { try { return SEO.easternToIso(date, hhmm || "13:00"); } catch (e) { return `${date}T18:00:00Z`; } }
function whenText(date, hhmm) {
  const d = new Date(kickUtc(date, hhmm));
  const day = d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric" });
  const t = d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  return `${day} · ${t} ET`;
}

let ODDS = null, GRADED = null;
function marketPrice(date, player, kickIso) {
  if (!ODDS) ODDS = readCsv(path.join(DIR, "odds-history-props.csv")).filter(r => r.market === "ANYTIME_TD");
  let best = null;
  const ko = Date.parse(kickIso);
  for (const o of ODDS) {
    if (o.date !== date || norm(o.player) !== norm(player)) continue;
    const t = Date.parse(o.captured_at); if (!(t <= ko)) continue;
    const p = +(o.implied_prob_raw || o.implied_prob); if (!(p > 0 && p < 1)) continue;
    if (!best || t > best.t) best = { t, p };
  }
  return best ? american(best.p) : null;
}
function scored(date, player, gameId) {
  if (!GRADED) GRADED = readCsv(path.join(DIR, "nfl-props-graded.csv")).filter(r => r.market === "ANYTIME_TD");
  const g = GRADED.find(r => r.date === date && r.game_id === gameId && norm(r.player) === norm(player) && r.actual !== "");
  return g ? (+g.actual > 0 ? "W" : "L") : null;
}

/** Every game of every date in [from, to] with touchdown reads, grouped by NFL week. */
function collect(from, to) {
  const weeks = new Map();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const games = readJson(path.join(DIR, "matchups", `${d}.json`));
    if (!Array.isArray(games) || !games.length) continue;
    const gameDay = readJson(path.join(DIR, `props-${d}.json`));
    const early = readJson(path.join(DIR, "td-early", `${d}.json`));
    let rows = Array.isArray(gameDay) ? gameDay.filter(p => p.market === "ANYTIME_TD") : [];
    let source = "game day";
    if (!rows.length && early && early.props) { rows = early.props; source = "early"; }
    if (!rows.length) continue;
    const picks = readJson(path.join(DIR, "td-picks", `${d}.json`));
    for (const m of games) {
      const ko = kickUtc(d, m.kickoff);
      const players = rows.filter(p => p.game_id === m.game_id && p.projection > 0)
        .sort((a, b) => b.projection - a.projection)
        .map(p => ({ ...p, leo_odds: fairOdds(p.projection), market: marketPrice(d, p.player, ko), result: scored(d, p.player, m.game_id) }));
      if (!players.length) continue;
      const w = m.week;
      const W = weeks.get(w) || weeks.set(w, { week: w, season: Number(String(m.game_id).slice(0, 4)) || 2026, games: [], dates: new Set() }).get(w);
      W.dates.add(d);
      W.games.push({ date: d, m, ko, source, players, top3: picks && picks.picks && picks.picks.top3_day });
    }
  }
  for (const W of weeks.values()) W.games.sort((a, b) => a.ko.localeCompare(b.ko));
  return [...weeks.values()].sort((a, b) => a.week - b.week);
}

/** Leo's top 3 of each game day: frozen picks when saved, else the three highest chances of that date. */
function dayTop3(W) {
  const out = [];
  for (const d of [...W.dates].sort()) {
    const gs = W.games.filter(g => g.date === d);
    const frozen = gs.find(g => g.top3 && g.top3.length);
    let top = frozen ? frozen.top3.map(p => {
      const g = gs.find(x => x.m.game_id === p.game_id) || gs[0];
      const live = g.players.find(x => norm(x.player) === norm(p.player)) || {};
      return { player: p.player, team: p.team || live.team, projection: p.chance, leo_odds: fairOdds(p.chance), market: p.price ?? live.market, result: p.result || live.result, g };
    }) : gs.flatMap(g => g.players.map(p => ({ ...p, g }))).sort((a, b) => b.projection - a.projection).slice(0, 3);
    out.push({ date: d, top, picks: d >= PICKS_FROM });
  }
  return out;
}

function last5(st) {
  if (!st || !st.last5 || !st.last5.length) return "";
  return `<span class="td-dots">${st.last5.map(x => `<span class="td-dot${x.td ? " y" : ""}" title="Week ${x.wk}${x.opp ? " vs " + esc(x.opp) : ""}: ${x.td} TD">${x.td || ""}</span>`).join("")}</span>`;
}

function gameTable(g) {
  const m = g.m, away = TEAMS.nick(m.away), home = TEAMS.nick(m.home);
  const hasStats = g.players.some(p => p.td_stats && p.td_stats.games);
  const rows = g.players.slice(0, TOP_N).map(p => {
    const st = p.td_stats || {};
    const res = p.result === "W" ? '<span class="td-res w">Scored</span>' : p.result === "L" ? '<span class="td-res l">No TD</span>' : "";
    return `<tr>
<td><strong>${esc(p.player)}</strong> <span class="dim">${esc(p.position || "")}, ${esc(TEAMS.nick(p.team))}</span>${res ? " " + res : ""}</td>
<td class="num"><strong>${pct(p.projection)}</strong></td>
<td class="num">${esc(p.leo_odds)}</td>
<td class="num hide-sm">${p.market != null ? esc(fmtPrice(p.market)) : '<span class="dim">soon</span>'}</td>
${hasStats ? `<td class="num">${st.games ? `${st.tds} <span class="dim">(${st.td_games} of ${st.games} games)</span>` : ""}</td>
<td>${last5(st)}</td>
<td class="num hide-sm">${st.games ? `${st.car_pg} car, ${st.tgt_pg} tgt` : ""}</td>
<td class="num hide-sm">${st.opp_allowed_pg != null ? st.opp_allowed_pg.toFixed(2) : ""}</td>` : ""}
</tr>`;
  }).join("\n");
  return `<section class="td-game" id="${esc(m.slug || m.game_id)}">
<h2>${esc(away)} vs ${esc(home)} anytime touchdown odds</h2>
<p class="dim">${esc(whenText(g.date, m.kickoff))}${g.source === "early" ? " · early read, updated on game day" : ""} · <a href="/nfl/${esc(m.slug)}/">full ${esc(away)} vs ${esc(home)} prediction</a></p>
<div class="table-wrap"><table class="td-table">
<thead><tr><th>Player</th><th class="num">Leo chance</th><th class="num">Leo odds</th><th class="num hide-sm">Market</th>${hasStats ? '<th class="num">TDs this season</th><th>Last 5</th><th class="num hide-sm">Per game</th><th class="num hide-sm">Opp. allows</th>' : ""}</tr></thead>
<tbody>
${rows}
</tbody></table></div>
</section>`;
}

function page(W, { hub, prev, next }) {
  const permanent = `/nfl/anytime-touchdowns/${W.season}-week-${W.week}/`;
  const url = hub ? HUB : permanent;
  const upcoming = W.games.filter(g => Date.parse(g.ko) > NOW), played = W.games.filter(g => !(Date.parse(g.ko) > NOW)).reverse();
  const focus = upcoming.length ? upcoming : W.games;
  const all = focus.flatMap(g => g.players.map(p => ({ ...p, g })));
  const best = all.slice().sort((a, b) => b.projection - a.projection).slice(0, 5);
  const upDates = new Set(upcoming.map(g => g.date));
  const days = dayTop3(W).sort((a, b) => (upDates.has(b.date) - upDates.has(a.date)) || (upDates.has(a.date) ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)));
  const early = W.games.some(g => g.source === "early");
  const firstDate = days[0].date;
  const title = `NFL Anytime Touchdown Predictions Week ${W.week} ${W.season}: Leo's Odds for Every Player | Leo by ND Horizon`;
  const desc = `Week ${W.week} anytime touchdown odds from Leo: ${best.slice(0, 3).map(p => `${p.player} ${pct(p.projection)}`).join(", ")}. Every player's chance, recent touchdowns and matchup.`;
  const updated = new Date(NOW).toISOString();
  const top3Box = days.filter(d => upDates.has(d.date) || !upcoming.length).map(d => SEO.analysisBox({
    id: `top-${d.date}`,
    eyebrow: `${d.picks ? "Leo's touchdown picks" : "Leo's top 3"} · ${new Date(d.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" })}`,
    headline: d.top.map(p => p.player.split(" ").slice(-1)[0]).join(", "),
    sub: d.picks ? "Graded at 1 unit each at the market price at Leo's read." : "The three players Leo gives the best chance to score. Leo's touchdown picks are graded publicly from Week 13.",
    chips: d.top.map(p => ({ label: `${p.player} (${TEAMS.nick(p.team)})`, value: `${pct(p.projection)} · ${p.leo_odds}`, on: true, note: p.market != null ? `market ${fmtPrice(p.market)}` : "market price on game day", result: p.result || null })),
    foot: ""
  })).join("\n");
  const faq = [
    { q: `Who is most likely to score a touchdown in Week ${W.week}?`, a: `In Leo's read, ${best.slice(0, 3).map(p => `${p.player} (${pct(p.projection)})`).join(", ")}.` },
    { q: "What are Leo's odds?", a: "Leo's chance turned into a fair American price with no bookmaker margin. A 60% chance is -150; a 25% chance is +300. When the market's price is longer than Leo's odds, Leo rates the player above the market." },
    { q: "How does Leo work out a touchdown chance?", a: "From each player's share of his team's carries and targets, his touchdown rate this season and last, his team's scoring, the opponent's points allowed, home field and his place on the depth chart. Players listed out or doubtful are left out." },
    { q: "When does this page update?", a: "It goes up days before the games from Leo's early read and updates on game day with the final read and the market prices. After the games, each player shows whether he scored." }
  ];
  const jump = SEO.jumpBar([["top-" + firstDate, "Leo's top 3"], ...upcoming.map(g => [g.m.slug || g.m.game_id, `${TEAMS.nick(g.m.away)} vs ${TEAMS.nick(g.m.home)}`]), played.length ? ["played", "Already played"] : null, ["faq", "FAQ"]]);
  const body = `
<p class="eyebrow"><a href="/nfl/">NFL</a> · Anytime touchdowns</p>
<h1>NFL anytime touchdown predictions, Week ${W.week}</h1>
${SEO.byline(updated)}
<p class="lede">Leo's most likely touchdown scorers for Week ${W.week}: ${best.map(p => `<strong>${esc(p.player)}</strong> ${pct(p.projection)} (${esc(p.leo_odds)})`).join(", ")}. Every player below shows Leo's chance, Leo's odds, his touchdowns this season and in his last five games, and what his opponent allows to his position.${early ? " Early read: it updates on game day with the final read and the market prices." : ""}</p>
${jump}
${top3Box}
${SIGNUP.box("night")}
${upcoming.map(gameTable).join("\n")}
${played.length ? `<h2 id="played">Already played in Week ${W.week}</h2>\n<p class="dim">Leo's read before kickoff and who scored.</p>\n${played.map(gameTable).join("\n")}` : ""}
<section id="how">
<h2>How to read the table</h2>
<ul class="key">
<li><strong>Leo chance</strong>: Leo's chance the player scores at least one rushing or receiving touchdown.</li>
<li><strong>Leo odds</strong>: that chance as a fair price with no bookmaker margin. <strong>Market</strong>: the average market price at Leo's latest read, shown for comparison only. Leo never uses it.</li>
<li><strong>TDs this season</strong>: rushing plus receiving touchdowns, and in how many games he scored. <strong>Last 5</strong>: touchdowns in each of his last five games, newest first (gold = scored).</li>
<li><strong>Per game</strong>: carries and targets a game this season. <strong>Opp. allows</strong>: touchdowns a game the opponent has allowed to his position this season.</li>
</ul>
</section>
${SEO.faqHtml(faq, `Questions about Week ${W.week} touchdowns`)}
<p class="dim">${prev ? `<a href="${prev}">Previous week</a>` : ""}${prev && next ? " · " : ""}${next ? `<a href="${next}">Next week</a>` : ""}${prev || next ? " · " : ""}<a href="/nfl/previews/">This week's picks</a> · <a href="/nfl/results/">Leo's record</a></p>`;
  const pub = { "@type": "Organization", name: "New Dawn Horizon", url: ORIGIN + "/" };
  const jsonld = { "@context": "https://schema.org", "@graph": [
    { "@type": "Article", headline: title.replace(/\s*\|.*$/, ""), description: desc, url: ORIGIN + url, mainEntityOfPage: ORIGIN + url, author: pub, publisher: pub, dateModified: updated, isAccessibleForFree: true },
    { "@type": "FAQPage", mainEntity: faq.map(x => ({ "@type": "Question", name: x.q, acceptedAnswer: { "@type": "Answer", text: x.a } })) },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Leo", item: ORIGIN + "/" },
      { "@type": "ListItem", position: 2, name: "NFL", item: ORIGIN + "/nfl/scoreboard/" },
      { "@type": "ListItem", position: 3, name: "Anytime touchdowns", item: ORIGIN + HUB }] }] };
  return { url, canonical: permanent, html: shell({ title, desc, url, canonical: permanent, jsonld, body: SEO.withReadTime(body) }) };
}

function shell({ title, desc, url, canonical, jsonld, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
${GA_HEAD}
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${ORIGIN}${canonical}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="New Dawn Horizon">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${ORIGIN}${url}">
<meta property="og:image" content="${ORIGIN}/img/leo-card.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico" sizes="any"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/css/style.css">
<style>
.td-table{width:100%;border-collapse:collapse;font-size:.9rem}
.td-table th,.td-table td{padding:8px 8px;border-bottom:1px solid var(--border);text-align:left;vertical-align:middle}
.td-table th{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim);white-space:nowrap}
.td-table .num{text-align:right;white-space:nowrap}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
.td-game{margin:26px 0}
.td-dots{display:inline-flex;gap:3px}
.td-dot{width:18px;height:18px;border-radius:50%;border:1px solid var(--border);display:inline-flex;align-items:center;justify-content:center;font-size:.66rem;font-weight:800;color:#1A2535}
.td-dot.y{background:#C9A84C;border-color:#C9A84C}
.td-res{font-size:.66rem;font-weight:800;padding:2px 7px;border-radius:999px;margin-left:4px}
.td-res.w{background:#2F6E4A;color:#fff}.td-res.l{background:#e9e4da;color:#5b5446}
.dim{color:var(--text-dim)}
.key{padding-left:18px;line-height:1.6}
@media (max-width:560px){.td-table .hide-sm{display:none}.td-table{font-size:.85rem}}
</style>
<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>
</head>
<body>
<nav id="nav"></nav>
<main>
${body}
<div class="notice warn" style="margin-top:28px">For entertainment and informational purposes. Leo&rsquo;s touchdown chances are information, not betting advice, and no model can promise outcomes. 21+. If gambling stops being fun, call 1-800-MY-RESET.</div>
</main>
<footer id="footer"></footer><script src="/js/app.js"></script><script>renderNav("${HUB}"); renderFooter();</script>
</body>
</html>
`;
}

function main() {
  const weeks = collect(addDays(todayET, -7), addDays(todayET, 9));
  if (!weeks.length) { console.log("NFL touchdown page: no touchdown reads in range."); return; }
  const permanentOf = W => `/nfl/anytime-touchdowns/${W.season}-week-${W.week}/`;
  // This week: the earliest week with a game not yet started; else the latest week.
  const cur = weeks.find(W => W.games.some(g => Date.parse(g.ko) > NOW)) || weeks[weeks.length - 1];
  weeks.forEach((W, i) => {
    const lastKick = Math.max(...W.games.map(g => Date.parse(g.ko)));
    const dir = path.join(ROOT, permanentOf(W));
    const file = path.join(dir, "index.html");
    // A finished week's page is kept once all its results are in (never rewritten later in the season).
    if (NOW > lastKick + 3 * 864e5) return;   // finished weeks keep the page they had (or never get one if they ended before the page existed)
    const prev = i > 0 ? permanentOf(weeks[i - 1]) : null, next = i < weeks.length - 1 ? permanentOf(weeks[i + 1]) : null;
    const pg = page(W, { hub: false, prev, next });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, pg.html);
    console.log(`  ${pg.url}: ${W.games.length} games, ${W.games.reduce((s, g) => s + g.players.length, 0)} players${W.games.some(g => g.source === "early") ? " (early read)" : ""}`);
  });
  const ci = weeks.indexOf(cur);
  const hub = page(cur, { hub: true, prev: ci > 0 ? permanentOf(weeks[ci - 1]) : null, next: ci < weeks.length - 1 ? permanentOf(weeks[ci + 1]) : null });
  fs.mkdirSync(path.join(ROOT, HUB), { recursive: true });
  fs.writeFileSync(path.join(ROOT, HUB, "index.html"), hub.html);
  console.log(`NFL touchdown page: ${HUB} shows Week ${cur.week}`);
}

if (require.main === module) main();
module.exports = { fairOdds, collect };
