#!/usr/bin/env node
/**
 * Permanent matchup pages (Lynold, 2026-11-25, from the VegasInsider review):
 * one address per pair of teams that never changes, so it can build search
 * authority every season, the way /nfl/matchups/bears-vs-lions/ does there.
 *
 *   /nfl/matchups/<team>-vs-<team>/   nicknames in alphabetical order
 *   /nba/matchups/<team>-vs-<team>/
 *
 *   node scripts/build-matchup-pages.js [nfl|nba]   (default both)
 *
 * Each page: the next meeting with Leo's read and a link to its game page,
 * every Leo read on the pair with how it went, and the series (NFL since 2016,
 * NBA this season and last). Built only for pairs that have a Leo game page
 * this season. Indexed only while a next meeting is on Leo's schedule
 * (noindex, follow otherwise), so Google spends its visits on games people
 * search now (DEC-20261122-05). Display only: nothing here feeds Leo's numbers.
 * Shared file, owned by the Leo Manager chat.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const SEO = require("./lib/game-page-seo");

const ROOT = path.join(__dirname, "..");
const ORIGIN = "https://ndhorizon.com";
const SEASON_FROM = { nfl: "2026-08-01", nba: "2026-10-01" };
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const longDate = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const shortDate = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const slugify = s => String(s).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const pct = p => Math.round(p * 100) + "%";

/** Alphabetical pair slug, the same whichever team is at home. */
const pairSlug = (a, b) => [slugify(a), slugify(b)].sort().join("-vs-");
const matchupUrl = (sport, nickA, nickB) => `/${sport}/matchups/${pairSlug(nickA, nickB)}/`;

function shell({ sport, url, title, desc, h1, body, crumbs, index }) {
  const ld = { "@context": "https://schema.org", "@graph": [
    { "@type": "CollectionPage", "@id": ORIGIN + url + "#page", url: ORIGIN + url, name: title.replace(/\s*\|.*$/, ""), description: desc,
      publisher: { "@type": "Organization", "@id": `${ORIGIN}/#organization`, name: "New Dawn Horizon" }, dateModified: new Date().toISOString() },
    { "@type": "BreadcrumbList", itemListElement: crumbs.map(([name, href], i) => ({ "@type": "ListItem", position: i + 1, name, item: ORIGIN + href })) }] };
  return `<!DOCTYPE html>
<html lang="en">
<head>
${require("./lib/ga").GA_HEAD}
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${ORIGIN}${url}">${index ? "" : `\n<meta name="robots" content="noindex, follow">`}
<meta property="og:type" content="website"><meta property="og:site_name" content="New Dawn Horizon">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${ORIGIN}${url}"><meta property="og:image" content="${ORIGIN}/img/leo-card.png">
<link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/css/style.css">
<style>
.mx{max-width:900px;margin:0 auto;padding:26px 16px 40px}
.mx h1{font-size:clamp(1.5rem,4vw,2.1rem);margin:6px 0 6px}
.mx h2{font-size:1.15rem;margin:28px 0 8px;padding-bottom:6px;border-bottom:1.5px solid var(--border)}
.eyebrow{font-size:.7rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--gold-deep)}
.dim{color:var(--text-dim);font-size:.88rem}
.next{display:block;background:var(--bg-card);border:1px solid var(--accent,#C9A84C);border-radius:16px;padding:16px 18px;margin:12px 0;text-decoration:none;color:inherit;box-shadow:var(--shadow-sm)}
.next span{display:block}
.next .when{font-size:.74rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim)}
.next .big{font-size:1.25rem;font-weight:800;margin:6px 0 4px}
.next .go{font-weight:700;margin-top:8px;display:block}
.reads{list-style:none;margin:0;padding:0}
.reads li{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:11px 14px;margin:0 0 8px;font-size:.92rem;line-height:1.5}
.ok{color:var(--good);font-weight:800}.no{color:var(--danger);font-weight:800}
.series{margin:6px 0 0;padding-left:18px;line-height:1.75;font-size:.92rem}
.tag{display:inline-block;padding:0 6px;border-radius:999px;font-size:.66rem;font-weight:800;background:var(--bg-elev);border:1px solid var(--border)}
.links a{margin-right:12px;font-weight:600}
</style>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
</head>
<body>
<nav id="nav"></nav>
<main class="mx">
  <p class="eyebrow"><a href="/${sport}/scoreboard/">${sport.toUpperCase()}</a> &middot; Matchup</p>
  <h1>${esc(h1)}</h1>
${body}
</main>
<footer id="footer"></footer><script src="/js/app.js"></script><script>renderNav("/${sport}/scoreboard/"); renderFooter();</script>
</body>
</html>
`;
}

function write(sport, url, html) {
  const dir = path.join(ROOT, url.replace(/^\//, ""));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), html);
}

/* ---------------- NFL ---------------- */
function nfl() {
  const TEAMS = require("./lib/nfl-teams");
  const EX = require("./lib/nfl-page-extras");
  const dir = path.join(ROOT, "data/nfl/matchups");
  const review = readJson(path.join(ROOT, "data/nfl/results-review.json")) || {};
  const graded = {};
  for (const g of review.games || []) graded[`${g.date}|${g.away}|${g.home}`] = g;
  const games = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort() : []) {
    if (f.slice(0, 10) < SEASON_FROM.nfl) continue;
    for (const m of readJson(path.join(dir, f)) || []) {
      if (!m.url || !fs.existsSync(path.join(ROOT, m.url.replace(/^\//, ""), "index.html"))) continue;
      games.push(m);
    }
  }
  const pairs = {};
  for (const m of games) {
    const key = [m.away, m.home].sort().join("|");
    (pairs[key] = pairs[key] || []).push(m);
  }
  const now = today(); let n = 0;
  for (const list of Object.values(pairs)) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const [t1, t2] = [list[0].away, list[0].home].sort((a, b) => TEAMS.nick(a).localeCompare(TEAMS.nick(b)));
    const N1 = TEAMS.nick(t1), N2 = TEAMS.nick(t2), F1 = TEAMS.full(t1), F2 = TEAMS.full(t2);
    const url = matchupUrl("nfl", N1, N2);
    const next = list.find(m => m.date >= now && !(m.final_report && m.final_report.away_score != null));
    const nextBox = next ? (() => {
      const g = next.leo && next.leo.game, C = g && g.calls;
      const calls = C ? [C.ml && C.ml.call ? `${C.ml.label} moneyline` : "", C.spread && C.spread.call ? `${C.spread.label} spread` : ""].filter(Boolean) : [];
      return `<a class="next" href="${next.url}"><span class="when">Next meeting &middot; ${esc(longDate(next.date))}${next.week ? ` &middot; Week ${esc(next.week)}` : ""}</span>
        <span class="big">${esc(TEAMS.nick(next.away))} at ${esc(TEAMS.nick(next.home))}</span>
        ${g && g.pick ? `<span>Leo gives the ${esc(TEAMS.nick(g.pick))} a ${pct(g.prob)} chance to win. ${calls.length ? `Leo&rsquo;s calls: ${esc(calls.join(", "))}.` : "No call yet."}${next.leo.early ? " Early read; it updates until kickoff." : ""}</span>` : ""}
        <span class="go">${esc(TEAMS.nick(next.away))} vs ${esc(TEAMS.nick(next.home))} prediction &rarr;</span></a>`;
    })() : `<p>The next ${esc(N1)} and ${esc(N2)} game is not on Leo&rsquo;s schedule yet. Leo&rsquo;s read goes up about a week before kickoff.</p>`;
    const reads = list.slice().reverse().map(m => {
      const g = m.leo && m.leo.game, F = m.final_report, R = graded[`${m.date}|${m.away}|${m.home}`];
      const score = F && F.away_score != null ? `${TEAMS.nick(m.away)} ${F.away_score}, ${TEAMS.nick(m.home)} ${F.home_score}` : "";
      const right = F && F.away_score != null && g && g.pick ? ((F.home_score > F.away_score ? m.home : m.away) === g.pick) : null;
      const calls = R && R.calls && R.calls.length ? " " + R.calls.map(c => `${esc(String(c.text).split(",")[0])} <span class="${c.result === "W" ? "ok" : c.result === "L" ? "no" : ""}">${c.result === "W" ? "won" : c.result === "L" ? "lost" : "push"}</span>`).join(", ") + "." : "";
      return `<li><a href="${m.url}"><b>${esc(shortDate(m.date))}: ${esc(TEAMS.nick(m.away))} at ${esc(TEAMS.nick(m.home))}</b></a><br>
        ${g && g.pick ? `Leo had the ${esc(TEAMS.nick(g.pick))} at ${pct(g.prob)}.` : ""} ${score ? `Final: ${esc(score)}${right == null ? "" : right ? ` <span class="ok">right winner</span>` : ` <span class="no">wrong winner</span>`}.` : `<span class="dim">Not played yet.</span>`}${calls}</li>`;
    }).join("");
    const series = EX.meetings({ away: t1, home: t2, date: "9999-12-31" });
    const w = g => g.as === g.hs ? null : (g.as > g.hs ? g.away : g.home);
    const fr = t => ({ OAK: "LV", SD: "LAC", STL: "LA" }[t] || t);
    const w1 = series.filter(g => fr(w(g)) === t1).length, w2 = series.filter(g => fr(w(g)) === t2).length, ties = series.length - w1 - w2;
    const lead = w1 === w2 ? `Even, ${w1}-${w2}` : `${w1 > w2 ? N1 : N2} lead ${Math.max(w1, w2)}-${Math.min(w1, w2)}`;
    const line = g => { const a = g.as, h = g.hs, W = w(g); const tag = g.type && g.type !== "REG" ? ` <span class="tag">Playoffs</span>` : "";
      return `<li><span class="dim">${esc(shortDate(g.date))}</span> ${W ? `${esc(TEAMS.nick(fr(W)))} beat the ${esc(TEAMS.nick(fr(W === g.home ? g.away : g.home)))} ${Math.max(a, h)}-${Math.min(a, h)}${g.ot ? " in overtime" : ""}` : `Tie, ${a}-${h}`}${tag}</li>`; };
    const team = t => `/nfl/teams/${require("./build-nfl-team-pages").teamSlug(t)}/`;
    const title = `${N1} vs ${N2} Prediction, Odds and Head to Head | Leo by ND Horizon`;
    const desc = next && next.leo && next.leo.game && next.leo.game.pick
      ? `${N1} vs ${N2}: Leo gives the ${TEAMS.nick(next.leo.game.pick)} a ${pct(next.leo.game.prob)} chance on ${shortDate(next.date)}. Every Leo read on the matchup and the series since 2016.`
      : `${N1} vs ${N2}: every Leo prediction on the matchup, how each one went, and the series since 2016 (${lead}).`;
    const body = `
  <p class="dim">Every ${esc(F1)} and ${esc(F2)} game Leo has read, the next one first. Leo&rsquo;s numbers are frozen before kickoff and graded after. <a href="/nfl/how-leo-works/">How Leo works</a></p>
  <h2 id="next">Next ${esc(N1)} vs ${esc(N2)} game</h2>
  ${nextBox}
  <h2 id="reads">Leo&rsquo;s ${esc(N1)} vs ${esc(N2)} predictions</h2>
  <ul class="reads">${reads}</ul>
  <h2 id="series">${esc(N1)} vs ${esc(N2)} head to head since 2016</h2>
  <p>${series.length ? `<b>${esc(lead)}</b>${ties ? `, ${ties} tied` : ""}, ${series.length} ${series.length === 1 ? "game" : "games"}, playoffs included.` : "No meetings since 2016."}</p>
  ${series.length ? `<ul class="series">${series.map(line).join("")}</ul>` : ""}
  <h2>More</h2>
  <p class="links"><a href="${team(t1)}">${esc(F1)} predictions</a> <a href="${team(t2)}">${esc(F2)} predictions</a> <a href="/nfl/week/">This week&rsquo;s NFL card</a> <a href="/nfl/results/">Leo&rsquo;s NFL record</a> <a href="/membership/#free">Free NFL card by email</a></p>`;
    write("nfl", url, shell({ sport: "nfl", url, title, desc, h1: `${N1} vs ${N2}: Prediction, Odds and Head to Head`, body, index: !!next,
      crumbs: [["Leo", "/"], ["NFL", "/nfl/scoreboard/"], [`${N1} vs ${N2}`, url]] }));
    n++;
  }
  return n;
}

/* ---------------- NBA ---------------- */
function nba() {
  const URLS = require("./lib/nba-urls");
  const EX = require("./lib/nba-page-extras");
  const dir = path.join(ROOT, "data/nba");
  const results = {};
  for (const g of (readJson(path.join(dir, "results.json")) || {}).games || []) results[g.game_id] = g;
  const games = [];
  for (const f of fs.readdirSync(dir).filter(n => /^picks-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort()) {
    const date = f.slice(6, 16); if (date < SEASON_FROM.nba) continue;
    for (const g of (readJson(path.join(dir, f)) || {}).games || []) {
      if (!g.leo) continue;
      const url = `/nba/${URLS.gameSlug(g)}/`;
      if (!fs.existsSync(path.join(ROOT, url.replace(/^\//, ""), "index.html"))) continue;
      games.push({ ...g, date, url });
    }
  }
  const pairs = {};
  for (const g of games) { const key = [g.away, g.home].sort().join("|"); (pairs[key] = pairs[key] || []).push(g); }
  const now = today(); let n = 0;
  for (const list of Object.values(pairs)) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const nm = (ab, full) => URLS.nick(ab, full);
    const sides = [[list[0].away, list[0].away_name], [list[0].home, list[0].home_name]].sort((a, b) => nm(...a).localeCompare(nm(...b)));
    const [[t1, F1], [t2, F2]] = sides, N1 = nm(t1, F1), N2 = nm(t2, F2);
    const url = matchupUrl("nba", N1, N2);
    const next = list.find(g => g.date >= now && !g.completed && !results[g.game_id]);
    const P = PKS(), nextBox = next ? (() => {
      const L = next.leo, fav = L.p_home >= 0.5 ? next.home : next.away, p = Math.max(L.p_home, 1 - L.p_home);
      const pt = P.pickText(next);
      return `<a class="next" href="${next.url}"><span class="when">Next meeting &middot; ${esc(longDate(next.date))}</span>
        <span class="big">${esc(nm(next.away, next.away_name))} at ${esc(nm(next.home, next.home_name))}</span>
        <span>Leo gives the ${esc(nm(fav, fav === next.home ? next.home_name : next.away_name))} a ${pct(p)} chance to win.${next.early ? " Early read: Leo Picks come with the graded card on game day." : pt && pt.ok ? ` ${esc(pt.line)}` : ""}</span>
        <span class="go">${esc(nm(next.away, next.away_name))} vs ${esc(nm(next.home, next.home_name))} prediction &rarr;</span></a>`;
    })() : `<p>The next ${esc(N1)} and ${esc(N2)} game is not on Leo&rsquo;s card yet. Leo&rsquo;s read goes up a few days before tip.</p>`;
    const reads = list.slice().reverse().map(g => {
      const r = results[g.game_id], L = g.leo, fav = L.p_home >= 0.5 ? g.home : g.away;
      const favN = nm(fav, fav === g.home ? g.home_name : g.away_name), p = Math.max(L.p_home, 1 - L.p_home);
      const fin = r && r.home_score != null ? `Final: ${nm(g.away, g.away_name)} ${r.away_score}, ${nm(g.home, g.home_name)} ${r.home_score}` : "";
      const right = fin ? ((r.home_score > r.away_score ? g.home : g.away) === fav) : null;
      const pick = r && r.pick_result && !r.pick_replay ? ` Leo Pick ${esc(URLS.nick(r.pick_team))} <span class="${r.pick_result === "win" ? "ok" : "no"}">${r.pick_result === "win" ? "won" : "lost"}</span>.` : "";
      return `<li><a href="${g.url}"><b>${esc(shortDate(g.date))}: ${esc(nm(g.away, g.away_name))} at ${esc(nm(g.home, g.home_name))}</b></a><br>
        Leo had the ${esc(favN)} at ${pct(p)}. ${fin ? `${esc(fin)}${right ? ` <span class="ok">right winner</span>` : ` <span class="no">wrong winner</span>`}.` : `<span class="dim">Not played yet.</span>`}${pick}</li>`;
    }).join("");
    const M = EX.meetings({ away: t1, home: t2, date: "9999-12-31" });
    const tally = arr => { const a = arr.filter(x => (x.hs > x.as ? x.home : x.away) === t1).length; return [a, arr.length - a]; };
    const line = x => { const aw = x.as > x.hs, W = aw ? x.away : x.home, Lz = aw ? x.home : x.away;
      return `<li><span class="dim">${esc(shortDate(x.date))}</span> ${esc(URLS.nick(W))} beat the ${esc(URLS.nick(Lz))} ${Math.max(x.hs, x.as)}-${Math.min(x.hs, x.as)}</li>`; };
    const block = (arr, label) => { if (!arr.length) return `<p class="dim">No meetings ${label}.</p>`; const [a, b] = tally(arr);
      return `<p><b>${a === b ? `Split ${a}-${b}` : `${esc(a > b ? N1 : N2)} ${Math.max(a, b)}-${Math.min(a, b)}`}</b> ${label}</p><ul class="series">${arr.slice().sort((x, y) => y.date.localeCompare(x.date)).map(line).join("")}</ul>`; };
    const team = (ab) => `/nba/teams/${URLS.slugify(URLS.nick(ab))}/`;
    const title = `${N1} vs ${N2} Prediction, Odds and Head to Head | Leo by ND Horizon`;
    const desc = next ? `${N1} vs ${N2}: Leo's win chance for the ${shortDate(next.date)} game, every Leo read on the matchup and the head to head this season and last.`
      : `${N1} vs ${N2}: every Leo prediction on the matchup, how each one went, and the head to head this season and last.`;
    const body = `
  <p class="dim">Every ${esc(F1)} and ${esc(F2)} game Leo has read, the next one first. Leo&rsquo;s numbers are graded after every game. <a href="/nba/how-leo-works/">How Leo works</a></p>
  <h2 id="next">Next ${esc(N1)} vs ${esc(N2)} game</h2>
  ${nextBox}
  <h2 id="reads">Leo&rsquo;s ${esc(N1)} vs ${esc(N2)} predictions</h2>
  <ul class="reads">${reads}</ul>
  <h2 id="series">${esc(N1)} vs ${esc(N2)} head to head</h2>
  ${block(M.now, "this season")}
  ${M.lastSeason ? block(M.last, "last season") : ""}
  <h2>More</h2>
  <p class="links"><a href="${team(t1)}">${esc(F1)} predictions</a> <a href="${team(t2)}">${esc(F2)} predictions</a> <a href="/nba/scoreboard/">Tonight&rsquo;s NBA predictions</a> <a href="/nba/results/">Leo&rsquo;s NBA record</a> <a href="/membership/#free">Free card by email</a></p>`;
    write("nba", url, shell({ sport: "nba", url, title, desc, h1: `${N1} vs ${N2}: Prediction, Odds and Head to Head`, body, index: !!next,
      crumbs: [["Leo", "/"], ["NBA", "/nba/scoreboard/"], [`${N1} vs ${N2}`, url]] }));
    n++;
  }
  return n;
}
let _pks; const PKS = () => _pks || (_pks = require("./lib/nba-picks"));

module.exports = { matchupUrl, pairSlug };

if (require.main === module) {
  const which = process.argv[2];
  if (!which || which === "nfl") console.log(`NFL matchup pages: ${nfl()}`);
  if (!which || which === "nba") console.log(`NBA matchup pages: ${nba()}`);
  console.log(`sitemap.xml: ${require("./lib/sitemap").writeSitemap(ROOT)} pages`);
}
