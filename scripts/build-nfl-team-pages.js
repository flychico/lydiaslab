#!/usr/bin/env node
/*
  Leo NFL team pages (2026-11-02, Leo Manager chat on Lynold's instruction;
  business/SEO_GROWTH_LOG.md SEO-07). One page per team at /nfl/teams/<nick>/
  plus a hub at /nfl/teams/.

  What each game row shows, kept apart on purpose (Lynold found the MLB team
  page unclear about whose win or loss a column meant):
    - Leo's win chance FOR THIS TEAM, from the read of record: the last
      capture in data/nfl/prediction-history.csv before kickoff (freeze rule).
    - Leo favored: the team Leo gave more than 50%.
    - Final score, then "<Team> result" (the team's own win or loss).
    - Leo's read: Right when the side Leo favored won, Wrong when it lost.
  Games still to be played show the latest read, marked as not frozen yet.

  Display only: reads frozen reads and finals, changes no number.
  Usage: node scripts/build-nfl-team-pages.js [--season 2026]
*/
"use strict";
const fs = require("fs");
const path = require("path");
const { GA_HEAD } = require("./lib/ga");
const TEAMS = require("./lib/nfl-teams");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const SEASON = args.includes("--season") ? args[args.indexOf("--season") + 1] : "2026";
const ORIGIN = "https://ndhorizon.com";

const DIVISIONS = [
  ["AFC East", ["BUF", "MIA", "NE", "NYJ"]], ["AFC North", ["BAL", "CIN", "CLE", "PIT"]],
  ["AFC South", ["HOU", "IND", "JAX", "TEN"]], ["AFC West", ["DEN", "KC", "LAC", "LV"]],
  ["NFC East", ["DAL", "NYG", "PHI", "WAS"]], ["NFC North", ["CHI", "DET", "GB", "MIN"]],
  ["NFC South", ["ATL", "CAR", "NO", "TB"]], ["NFC West", ["ARI", "LA", "SEA", "SF"]],
];
const teamSlug = abbr => TEAMS.nick(abbr).toLowerCase().replace(/[^a-z0-9]+/g, "-");
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// One decimal near a coin flip, so "50%" never sits beside a team Leo favored.
const pct = p => (Math.round(p * 100) === 50 && p !== 0.5) ? `${(p * 100).toFixed(1)}%` : `${Math.round(p * 100)}%`;
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

// Read of record per game: last capture before kickoff. Latest capture for
// games not yet kicked off (shown as not frozen).
function loadReads() {
  const file = path.join(ROOT, "data", "nfl", "prediction-history.csv");
  const frozen = new Map(), latest = new Map();
  if (!fs.existsSync(file)) return { frozen, latest };
  for (const r of parseCsv(fs.readFileSync(file, "utf8"))) {
    const prob = Number(r.model_prob);
    if (!r.game_id || !r.pick || !Number.isFinite(prob)) continue;
    const t = Date.parse(r.captured_at), k = Date.parse(r.kickoff_utc);
    const keep = (m) => { const o = m.get(r.game_id); if (!o || Date.parse(o.captured_at) <= t) m.set(r.game_id, r); };
    keep(latest);
    if (Number.isFinite(k) && t < k) keep(frozen);
  }
  return { frozen, latest };
}

function loadGames() {
  const dir = path.join(ROOT, "data", "nfl", "matchups");
  const out = new Map();
  for (const f of fs.readdirSync(dir).filter(f => f.startsWith(SEASON) && f.endsWith(".json")).sort()) {
    let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { continue; }
    for (const g of Array.isArray(d) ? d : (d.games || [])) {
      if (!g.game_id) continue;
      const url = g.url && fs.existsSync(path.join(ROOT, g.url.replace(/^\/|\/$/g, ""), "index.html")) ? g.url : null;
      out.set(g.game_id, { ...g, pageUrl: url });   // a later file for the same game wins
    }
  }
  return [...out.values()];
}

function teamGames(all, abbr, reads, now) {
  const out = [];
  for (const g of all) {
    if (g.away !== abbr && g.home !== abbr) continue;
    const side = g.home === abbr ? "home" : "away";
    const opp = side === "home" ? g.away : g.home;
    const F = g.final_report && Number.isFinite(Number(g.final_report.home_score)) ? g.final_report : null;
    const kickoff = Date.parse(`${g.date}T${g.kickoff || "13:00"}:00-05:00`);
    const played = !!F;
    const r = reads.frozen.get(g.game_id) || (!played && kickoff > now ? reads.latest.get(g.game_id) : null);
    const chance = r ? (r.pick === abbr ? Number(r.model_prob) : 1 - Number(r.model_prob)) : null;
    const teamPts = F ? Number(side === "home" ? F.home_score : F.away_score) : null;
    const oppPts = F ? Number(side === "home" ? F.away_score : F.home_score) : null;
    const result = F ? (teamPts > oppPts ? "W" : teamPts < oppPts ? "L" : "T") : null;
    const favored = chance === null ? null : chance > 0.5 ? abbr : chance < 0.5 ? opp : null;
    let right = null;
    if (F && favored && result !== "T") right = (favored === abbr) === (result === "W");
    out.push({ date: g.date, week: g.week, opp, at: side === "away", chance, favored, frozen: !!reads.frozen.get(g.game_id),
      played, teamPts, oppPts, result, right, url: g.pageUrl });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

function summary(games) {
  const done = games.filter(g => g.played);
  const w = done.filter(g => g.result === "W").length, l = done.filter(g => g.result === "L").length, t = done.filter(g => g.result === "T").length;
  const judged = done.filter(g => g.right !== null);
  const right = judged.filter(g => g.right).length;
  const fav = done.filter(g => g.chance !== null && g.chance > 0.5);
  const dog = done.filter(g => g.chance !== null && g.chance < 0.5);
  const withChance = done.filter(g => g.chance !== null);
  const avg = withChance.length ? withChance.reduce((s, g) => s + g.chance, 0) / withChance.length : null;
  return { done, w, l, t, judged, right, fav, favW: fav.filter(g => g.result === "W").length, dog, dogW: dog.filter(g => g.result === "W").length, avg,
    upcoming: games.filter(g => !g.played) };
}
const rec = (w, l, t) => `${w}-${l}${t ? `-${t}` : ""}`;

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
<div class="notice warn" style="margin-top:28px">For entertainment and informational purposes. Leo&rsquo;s win chances are information, not betting advice, and no model can promise outcomes. 21+. If gambling stops being fun, call 1-800-MY-RESET.</div>
</main>
<footer id="footer"></footer><script src="/js/app.js"></script><script>renderNav("/nfl/teams/"); renderFooter();</script>
</body>
</html>
`;
}

function teamPage(abbr, division, games) {
  const s = summary(games);
  const name = TEAMS.full(abbr), nick = TEAMS.nick(abbr);
  const url = `/nfl/teams/${teamSlug(abbr)}/`;
  const title = `${name} Predictions ${SEASON}: Every Game Leo Analyzed | Leo`;
  const desc = `${name} predictions for ${SEASON}: Leo's win chance before every ${nick} game, who Leo favored, the final score and whether Leo's read was right.`;
  const rivals = DIVISIONS.find(d => d[0] === division)[1].filter(t => t !== abbr);
  const next = s.upcoming.length ? s.upcoming[s.upcoming.length - 1] : null;

  const say = [];
  if (s.done.length) {
    say.push(`The ${nick} went ${rec(s.w, s.l, s.t)} in the ${s.done.length} games Leo analyzed between ${longDate(s.done[s.done.length - 1].date)} and ${longDate(s.done[0].date)}.`);
    if (s.judged.length) say.push(`The side Leo favored won ${s.right} of ${s.judged.length} of those games.`);
    if (s.fav.length) say.push(`When Leo favored the ${nick}, they went ${rec(s.favW, s.fav.length - s.favW, 0)}.`);
    if (s.dog.length) say.push(`When Leo favored their opponent, the ${nick} went ${rec(s.dogW, s.dog.length - s.dogW, 0)}.`);
  }
  if (next) say.push(`Next: ${next.at ? "at" : "vs"} the ${TEAMS.nick(next.opp)} on ${longDate(next.date)}${next.chance !== null ? `, with Leo at ${pct(next.chance)} for the ${nick} so far` : ""}.`);

  const rows = games.map(g => {
    const opp = `${g.at ? "at" : "vs"} ${esc(TEAMS.nick(g.opp))}`;
    const oppCell = g.url ? `<a href="${g.url}">${opp}</a>` : opp;
    const chance = g.chance === null ? `<span class="dim">No read before kickoff</span>`
      : `${pct(g.chance)}${g.played || g.frozen ? "" : ` <span class="dim small">latest, freezes at kickoff</span>`}`;
    const favored = g.chance === null ? "" : g.favored ? esc(TEAMS.nick(g.favored)) : "Even";
    const score = g.played ? `${esc(TEAMS.nick(abbr))} ${g.teamPts}, ${esc(TEAMS.nick(g.opp))} ${g.oppPts}` : `<span class="dim">Not played yet</span>`;
    const result = !g.played ? "" : g.result === "W" ? `<span class="w">Won</span>` : g.result === "L" ? `<span class="l">Lost</span>` : "Tie";
    const right = g.right === null ? "" : g.right ? `<span class="w">Right</span>` : `<span class="l">Wrong</span>`;
    return `<tr><td>${esc(niceDate(g.date))}<span class="dim small"> Wk ${esc(g.week)}</span></td><td>${oppCell}</td><td>${chance}</td><td>${favored}</td><td class="hide-sm">${score}</td><td>${result}</td><td>${right}</td></tr>`;
  }).join("");

  const body = `<article>
  <p class="eyebrow"><a href="/nfl/teams/">NFL teams</a> &middot; ${esc(division)} &middot; ${SEASON} season</p>
  <h1>${esc(name)} predictions ${SEASON}</h1>
  <p class="subtitle">${esc(say.join(" "))}</p>
  <div class="stat-row">
    <div class="card"><div class="v">${rec(s.w, s.l, s.t)}</div><div class="k">${esc(nick)} record in games Leo analyzed</div></div>
    <div class="card"><div class="v">${s.right}-${s.judged.length - s.right}</div><div class="k">Leo&rsquo;s reads on ${esc(nick)} games (right&#8209;wrong)</div></div>
    <div class="card"><div class="v">${s.avg === null ? "" : pct(s.avg)}</div><div class="k">Leo&rsquo;s average win chance for the ${esc(nick)}</div></div>
  </div>
  <h2>Every ${esc(nick)} game</h2>
  <ul class="key dim small">
    <li><b>Leo&rsquo;s chance</b> is Leo&rsquo;s win chance for the ${esc(nick)}, from its last read saved before kickoff.</li>
    <li><b>Leo favored</b> is the team Leo gave the better chance to win.</li>
    <li><b>${esc(nick)} result</b> is whether the ${esc(nick)} won or lost.</li>
    <li><b>Leo&rsquo;s read</b> is Right when the team Leo favored won, and Wrong when it lost.</li>
  </ul>
  <div class="table-wrap"><table class="team-table"><thead><tr><th>Date</th><th>Opponent</th><th>Leo&rsquo;s chance (${esc(nick)})</th><th>Leo favored</th><th class="hide-sm">Final score</th><th>${esc(nick)} result</th><th>Leo&rsquo;s read</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="dim small">Opponents link to Leo&rsquo;s full game analysis: spread, total, quarterbacks and touchdown scorer chances.</p>
  <h2>More from the ${esc(division)}</h2>
  <p>${rivals.map(t => `<a href="/nfl/teams/${teamSlug(t)}/">${esc(TEAMS.full(t))}</a>`).join(" &middot; ")}</p>
  <p class="dim small">See <a href="/nfl/teams/">all 32 teams</a>, <a href="/nfl/week/">this week&rsquo;s NFL predictions</a>, <a href="/nfl/games/">every NFL game page</a> and <a href="/nfl/results/">Leo&rsquo;s NFL record</a>.</p>
</article>`;
  const jsonld = { "@context": "https://schema.org", "@graph": [
    { "@type": "CollectionPage", "@id": `${ORIGIN}${url}#page`, name: title.replace(/ \| Leo$/, ""), description: desc, url: ORIGIN + url,
      about: { "@type": "SportsTeam", name, sport: "American football", memberOf: { "@type": "SportsOrganization", name: "National Football League" } },
      publisher: { "@type": "Organization", "@id": `${ORIGIN}/#organization`, name: "Leo", url: `${ORIGIN}/` } },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Leo", item: `${ORIGIN}/` },
      { "@type": "ListItem", position: 2, name: "NFL teams", item: `${ORIGIN}/nfl/teams/` },
      { "@type": "ListItem", position: 3, name, item: ORIGIN + url } ] } ] };
  return { html: shell({ title, desc, url, jsonld, body }), record: rec(s.w, s.l, s.t) };
}

function hubPage(records) {
  const url = "/nfl/teams/";
  const title = `NFL Team Predictions ${SEASON}: Every Game Leo Analyzed, by Team | Leo`;
  const desc = `Predictions for all 32 NFL teams in ${SEASON}: Leo's win chance before every game, who Leo favored, the final score and whether Leo's read was right.`;
  const body = `<h1>NFL team predictions ${SEASON}</h1>
  <p class="subtitle">Pick a team to see every ${SEASON} game Leo analyzed: Leo&rsquo;s win chance before kickoff, the team Leo favored, the final score and whether Leo&rsquo;s read was right. The record beside each team is that team&rsquo;s own record in the games Leo analyzed. Leo&rsquo;s NFL reads start in Week 2 of the ${SEASON} season.</p>
  <div class="div-grid">${DIVISIONS.map(([div, teams]) => `<div class="card"><h2 style="margin:0;font-size:1.05rem">${esc(div)}</h2><ul>${teams.map(t =>
    `<li><a href="/nfl/teams/${teamSlug(t)}/">${esc(TEAMS.full(t))}</a> <span class="dim small">${esc(records[t] || "")}</span></li>`).join("")}</ul></div>`).join("")}</div>
  <p class="dim small" style="margin-top:18px">This week: <a href="/nfl/week/">NFL predictions and touchdown scorers</a> &middot; <a href="/nfl/games/">every NFL game page</a> &middot; <a href="/nfl/results/">Leo&rsquo;s NFL record</a>.</p>`;
  const jsonld = { "@context": "https://schema.org", "@graph": [
    { "@type": "CollectionPage", "@id": `${ORIGIN}${url}#page`, name: title.replace(/ \| Leo$/, ""), description: desc, url: ORIGIN + url },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Leo", item: `${ORIGIN}/` },
      { "@type": "ListItem", position: 2, name: "NFL teams", item: ORIGIN + url } ] } ] };
  return shell({ title, desc, url, jsonld, body });
}

function main() {
  const all = loadGames();
  const reads = loadReads();
  const now = Date.now();
  const records = {}; let n = 0;
  for (const [division, teams] of DIVISIONS) {
    for (const abbr of teams) {
      const games = teamGames(all, abbr, reads, now);
      if (!games.length) { console.log(`No games for ${abbr}`); continue; }
      const { html, record } = teamPage(abbr, division, games);
      const dir = path.join(ROOT, "nfl", "teams", teamSlug(abbr));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "index.html"), html);
      records[abbr] = record; n++;
    }
  }
  fs.writeFileSync(path.join(ROOT, "nfl", "teams", "index.html"), hubPage(records));
  console.log(`NFL team pages: ${n} teams + hub written to nfl/teams/`);
}
if (require.main === module) main();
module.exports = { teamSlug };
