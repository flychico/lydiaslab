#!/usr/bin/env node
/*
  Permanent daily NBA pages: /nba/predictions/<date>/ (SEO-06, 2026-11-02).

  People search "NBA predictions November 2" and "NBA picks today". The only
  NBA page for a night was the scoreboard, which changes every night, so a
  night's card had no address of its own. This writes one page per slate
  date from data/nba/picks-<date>.json: a written intro, then every game with
  Leo's win chance, Leo's spread beside DraftKings in the same plain words as
  the scoreboard (scripts/lib/nba-why.js), the lean, the final and whether
  Leo had the winner. Plus /nba/predictions/ listing every night.

  Display only: reads the frozen slate and results.json, changes no number.
  Usage: node scripts/build-nba-daily-pages.js [date ...]   (default: all)
*/
"use strict";
const fs = require("fs");
const path = require("path");
const WHY = require("./lib/nba-why");
const PKS = require("./lib/nba-picks");   // Leo Picks (DEC-20261102-30); shown from PKS.TRACK_FROM

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data/nba");
const ORIGIN = "https://ndhorizon.com";
let GA_HEAD = "";
try { GA_HEAD = require("./lib/ga").GA_HEAD; } catch (e) { /* optional */ }

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nick = n => String(n || "").split(" ").pop() === "Blazers" ? "Trail Blazers" : String(n || "").split(" ").pop();
const longDay = d => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthDay = d => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const tip = iso => iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET" : "";
const pct = p => `${Math.round(p * 100)}%`;
const URLS = require("./lib/nba-urls");   // same address as the game page (SEO-09)
const gameUrl = g => g.url || URLS.gamePath(g);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };

function dates() {
  return fs.readdirSync(DATA).map(f => (f.match(/^picks-(\d{4}-\d{2}-\d{2})\.json$/) || [])[1]).filter(Boolean).sort();
}

function intro(date, games, res) {
  const read = games.filter(g => g.leo && g.leo.p_home != null);
  const out = [`Leo has a read on ${read.length} NBA game${read.length === 1 ? "" : "s"} on ${longDay(date)}.`];
  if (read.length) {
    const fav = g => (g.leo.p_home >= 0.5 ? { team: g.home_name, opp: g.away_name, p: g.leo.p_home } : { team: g.away_name, opp: g.home_name, p: 1 - g.leo.p_home });
    const top = read.map(g => ({ g, ...fav(g) })).sort((a, b) => b.p - a.p)[0];
    out.push(`Leo's strongest read is the ${nick(top.team)} over the ${nick(top.opp)} at ${pct(top.p)}.`);
    const close = read.map(g => ({ g, ...fav(g) })).sort((a, b) => a.p - b.p)[0];
    if (close.g !== top.g) out.push(`The closest game is the ${nick(close.g.away_name)} at the ${nick(close.g.home_name)}, ${pct(close.p)} for the ${nick(close.team)}.`);
    const picks = read.filter(g => g.date >= PKS.TRACK_FROM && (PKS.pickText(g) || {}).ok);
    if (read.length && read[0].date >= PKS.TRACK_FROM) out.push(picks.length
      ? `Leo Picks, teams Leo gives 60% or more at a price better than -230: ${picks.map(g => PKS.pickText(g).badge.replace(/^Pick /, "")).join(", ")}. Tracked in units, not bets.`
      : "No team tonight is 60% or more with Leo at a price better than -230, so there is no Leo Pick.");
    const leans = read.filter(g => g.leo.lean);
    out.push(leans.length
      ? `Leo is 4 or more points off the DraftKings spread in ${leans.length} game${leans.length === 1 ? "" : "s"}, so ${leans.length === 1 ? "that is a lean" : "those are leans"}: ${leans.map(g => `${g.leo.lean.team} ${g.leo.lean.line > 0 ? "+" : ""}${g.leo.lean.line}`).join(", ")}. Leans are a tracked test, not bets.`
      : "Leo is within 4 points of the DraftKings spread in every game, so there are no leans.");
  }
  if (res.length) {
    const w = res.filter(r => r.leo_winner_correct === 1).length, l = res.filter(r => r.leo_winner_correct === 0).length;
    const lw = res.filter(r => r.lean_result === "win").length, ll = res.filter(r => r.lean_result === "loss").length, lp = res.filter(r => r.lean_result === "push").length;
    const pk = res.filter(r => r.pick_result && !r.pick_replay), pw = pk.filter(r => r.pick_result === "win").length;
    const pu = pk.reduce((t, r) => t + (r.pick_units || 0), 0);
    out.push(`Graded: Leo had the winner in ${w} of ${w + l}${pk.length ? `, the Leo Picks went ${pw}-${pk.length - pw} (${pu >= 0 ? "+" : ""}${pu.toFixed(2)} units)` : ""}${lw + ll + lp ? `, and the leans went ${lw}-${ll}${lp ? "-" + lp : ""}` : ""}.`);
  }
  return out.join(" ");
}

function card(g, r) {
  const L = g.leo || {}, mk = g.market || {};
  const ph = L.p_home;
  const leoLine = WHY.leoLine(g);
  const leoTxt = leoLine == null ? "n/a" : leoLine === 0 ? "pick'em" : `${leoLine < 0 ? g.home : g.away} by ${Math.abs(leoLine)}`;
  const mkTxt = mk.home_spread == null ? "no line" : mk.home_spread === 0 ? "pick'em" : `${mk.home_spread < 0 ? g.home : g.away} by ${Math.abs(mk.home_spread)}`;
  const final = r ? `<p class="dn-final"><b>Final: ${esc(g.away)} ${r.away_score}, ${esc(g.home)} ${r.home_score}.</b> ${r.leo_winner_correct === 1 ? "Leo had the winner." : r.leo_winner_correct === 0 ? "Leo had the other team." : ""}${r.pick_result && !r.pick_replay ? ` Leo Pick ${esc(r.pick_team)} ${esc(r.pick_result)} (${r.pick_units >= 0 ? "+" : ""}${(+r.pick_units).toFixed(2)}u).` : ""}${r.lean_result ? ` Lean ${esc(r.lean_result)}.` : ""}</p>`
    : (g.completed && g.hs != null ? `<p class="dn-final"><b>Final: ${esc(g.away)} ${g.as}, ${esc(g.home)} ${g.hs}.</b> Grading pending.</p>` : "");
  return `<article class="dn-game">
    <div class="dn-when">${esc(tip(g.tip_utc))}${g.venue ? " &middot; " + esc(g.venue) : ""}</div>
    <h3><a href="${gameUrl(g)}">${esc(g.away_name)} at ${esc(g.home_name)} prediction</a></h3>
    ${ph != null ? `<p class="dn-line">Leo win chance: <b>${esc(g.away)} ${100 - Math.round(ph * 100)}%</b>, <b>${esc(g.home)} ${Math.round(ph * 100)}%</b>. Leo spread ${esc(leoTxt)}; DraftKings ${esc(mkTxt)}.${g.date >= PKS.TRACK_FROM && (PKS.pickText(g) || {}).ok ? ` <span class="dn-lean">${esc(PKS.pickText(g).badge)}</span>` : ""}${L.lean ? ` <span class="dn-lean">Lean ${esc(L.lean.team)} ${L.lean.line > 0 ? "+" : ""}${esc(L.lean.line)}</span>` : ""}</p>
    <p class="dn-why">${esc(WHY.compare(g))}</p>` : `<p class="dn-line">No Leo read for this game.</p>`}
    ${final}
    <a class="dn-more" href="${gameUrl(g)}">Full preview: why Leo has this number, injuries and box score &rarr;</a>
  </article>`;
}

function shell({ url, title, desc, h1, eyebrow, body, ld }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
${GA_HEAD}
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${ORIGIN}${url}">
<meta property="og:type" content="article"><meta property="og:site_name" content="Leo">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${ORIGIN}${url}"><meta property="og:image" content="${ORIGIN}/img/og-card.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/css/style.css">
<link rel="stylesheet" href="/css/scoreboard.css">
<style>
.dn-grid{display:grid;gap:12px;margin-top:16px}
.dn-game{background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:14px 16px;box-shadow:var(--shadow-sm)}
.dn-game h3{margin:2px 0 6px;font-size:1.05rem}
.dn-when{color:var(--text-dim);font-size:.76rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.dn-line,.dn-why,.dn-final{margin:4px 0;font-size:.92rem}.dn-why{color:var(--text-dim)}
.dn-lean{display:inline-block;margin-left:4px;padding:1px 8px;border-radius:999px;background:var(--bg);border:1px solid var(--border);font-weight:800;font-size:.8rem}
.dn-more{display:inline-block;margin-top:6px;font-weight:700;font-size:.86rem}
.dn-list{list-style:none;padding:0;display:grid;gap:6px}.dn-list a{display:block;padding:9px 12px;border:1px solid var(--border);border-radius:10px}
</style>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
</head>
<body>
<nav id="nav"></nav>
<main class="scoreboard-shell">
  <section class="score-hero">
    <p class="eyebrow">${esc(eyebrow)}</p>
    <h1>${esc(h1)}</h1>
  </section>
${body}
  <p class="data-note">Leo's win chance and spread come from team results, rest and the injury report, frozen before tip. The DraftKings line is shown for comparison and is never an input. Analysis only, not betting advice. 21+. If gambling stops being fun, call 1-800-MY-RESET.</p>
</main>
<footer id="footer"></footer><script src="/js/app.js"></script>
<script>renderNav("/nba/scoreboard/"); renderFooter();</script>
</body>
</html>
`;
}

function buildDay(date, all, results) {
  const slate = readJson(path.join(DATA, `picks-${date}.json`));
  const games = ((slate && slate.games) || []).filter(g => g.date === date || !g.date).sort((a, b) => String(a.tip_utc).localeCompare(String(b.tip_utc)));
  if (!games.length) return false;
  const res = results.filter(r => r.date === date);
  const byId = Object.fromEntries(res.map(r => [String(r.game_id), r]));
  const i = all.indexOf(date), prevD = all[i - 1], nextD = all[i + 1];
  const url = `/nba/predictions/${date}/`;
  const title = `NBA Predictions for ${monthDay(date)}: Picks, Spreads and Win Chances | Leo`;
  const leans = games.filter(g => g.leo && g.leo.lean).length;
  const desc = `Leo's NBA predictions for ${longDay(date)}: a win chance and spread for all ${games.length} games beside the DraftKings line${leans ? `, ${leans} lean${leans === 1 ? "" : "s"}` : ""}, graded after the final.`;
  const nav = `<p class="small" style="margin:10px 0 0">${prevD ? `<a href="/nba/predictions/${prevD}/">&larr; ${esc(monthDay(prevD))}</a> &middot; ` : ""}<a href="/nba/predictions/">Every night</a> &middot; <a href="/nba/scoreboard/">Tonight's NBA card</a> &middot; <a href="/nba/results/">Leo's NBA record</a>${nextD ? ` &middot; <a href="/nba/predictions/${nextD}/">${esc(monthDay(nextD))} &rarr;</a>` : ""}</p>`;
  const body = `  <section class="card"><p style="margin:0">${esc(intro(date, games, res))}</p>${nav}</section>
  <section class="dn-grid">
${games.map(g => card(g, byId[String(g.game_id)])).join("\n")}
  </section>`;
  const ld = { "@context": "https://schema.org", "@type": "CollectionPage", name: title.replace(/ \| Leo$/, ""), url: ORIGIN + url, description: desc,
    breadcrumb: { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Leo", item: ORIGIN + "/" },
      { "@type": "ListItem", position: 2, name: "NBA", item: ORIGIN + "/nba/scoreboard/" },
      { "@type": "ListItem", position: 3, name: `NBA predictions ${monthDay(date)}`, item: ORIGIN + url }] } };
  const dir = path.join(ROOT, "nba/predictions", date);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), shell({ url, title, desc, h1: `NBA predictions for ${longDay(date)}`, eyebrow: "NBA · Leo's read for the night", body, ld }));
  return true;
}

function buildIndex(all) {
  const url = "/nba/predictions/";
  const list = [...all].reverse().map(d => `<li><a href="/nba/predictions/${d}/">NBA predictions for ${esc(longDay(d))}</a></li>`).join("");
  const title = "NBA Predictions by Night, 2026-27 Season | Leo";
  const desc = "Every night of Leo's NBA predictions this season: win chance and spread for every game beside the DraftKings line, with the leans and the graded results.";
  const body = `  <section class="card"><p style="margin:0">Leo's NBA read for every night of the season, newest first. Each night lists every game with Leo's win chance, Leo's spread beside DraftKings and how it turned out.</p>
  <p class="small" style="margin:10px 0 0"><a href="/nba/scoreboard/">Tonight's NBA card</a> &middot; <a href="/nba/games/">Every NBA game</a> &middot; <a href="/nba/results/">Leo's NBA record</a></p></section>
  <ul class="dn-list">${list}</ul>`;
  const ld = { "@context": "https://schema.org", "@type": "CollectionPage", name: "NBA predictions by night", url: ORIGIN + url, description: desc };
  fs.mkdirSync(path.join(ROOT, "nba/predictions"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "nba/predictions/index.html"), shell({ url, title, desc, h1: "NBA predictions by night", eyebrow: "NBA · Every night this season", body, ld }));
}

function main() {
  const all = dates();
  const results = ((readJson(path.join(DATA, "results.json")) || {}).games) || [];
  const only = process.argv.slice(2);
  let n = 0;
  for (const d of (only.length ? only.filter(d => all.includes(d)) : all)) if (buildDay(d, all, results)) n++;
  // Neighbours link forward, so yesterday's page gains a link to today's.
  if (only.length) for (const d of only) { const i = all.indexOf(d); if (i > 0 && buildDay(all[i - 1], all, results)) n++; }
  buildIndex(all);
  console.log(`nba/predictions: ${n} night page(s), index of ${all.length}`);
}
main();
