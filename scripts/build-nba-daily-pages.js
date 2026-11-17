#!/usr/bin/env node
/*
  Permanent daily NBA pages: /nba/predictions/<date>/ (SEO-06, 2026-11-02).

  People search "NBA predictions November 2" and "NBA picks today". The only
  NBA page for a night was the scoreboard, which changes every night, so a
  night's card had no address of its own. This writes one page per slate
  date from data/nba/picks-<date>.json: a written intro, then every game with
  Leo's win chance, Leo's spread beside DraftKings in the same plain words as
  the scoreboard (scripts/lib/nba-why.js), the Leo Pick, the final and whether
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
const SW = require("./lib/nba-swing");   // "Depends on <player>" line (HO-0097)
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
  }
  if (res.length) {
    const w = res.filter(r => r.leo_winner_correct === 1).length, l = res.filter(r => r.leo_winner_correct === 0).length;
    const pk = res.filter(r => r.pick_result && !r.pick_replay), pw = pk.filter(r => r.pick_result === "win").length;
    const pu = pk.reduce((t, r) => t + (r.pick_units || 0), 0);
    out.push(`Graded: Leo had the winner in ${w} of ${w + l}${pk.length ? `, the Leo Picks went ${pw}-${pk.length - pw} (${pu >= 0 ? "+" : ""}${pu.toFixed(2)} units)` : ""}.`);
  }
  return out.join(" ");
}

// One game in the card email's look (Lynold, 2026-11-17: "The predictions page should look like the
// email format we send out"): team colour stripe, time and arena, the call badge, both teams with logo
// and Leo's win chance, the bar, the three boxes (Leo spread, DraftKings, Call), the pick line, the
// depends line, Leo vs DraftKings in words, the why line, then the final once graded. Nicknames in text.
const COLOR = require("./lib/nba-card-email").COLOR;
const col = t => "#" + (COLOR[t] || "1A2535");
const logo = t => `https://a.espncdn.com/i/teamlogos/nba/500/${String(t).toLowerCase()}.png`;
function nickFor(g) {
  const N = { [g.home]: nick(g.home_name) || g.home, [g.away]: nick(g.away_name) || g.away };
  return s => String(s == null ? "" : s).replace(/\b[A-Z]{2,4}\b/g, c => N[c] || c);
}
function card(g, r) {
  const L = g.leo || {}, mk = g.market || {}, nk = nickFor(g), tracked = g.date >= PKS.TRACK_FROM;
  if (L.p_home == null) return `<article class="nc"><div class="nc-body"><h3><a href="${gameUrl(g)}">${esc(g.away_name)} at ${esc(g.home_name)}</a></h3><p class="nc-dim">No Leo read for this game.</p></div></article>`;
  const PT = tracked ? PKS.pickText(g) : null, CB = tracked ? PKS.callBox(g) : null, isPick = !!(PT && PT.ok);
  const LS = WHY.leoLine(g), W = WHY.why(g);
  const team = side => { const p = side === "home" ? L.p_home : 1 - L.p_home;
    return `<div class="nc-team"><img src="${logo(g[side])}" alt="" width="36" height="36" loading="lazy"><span class="nc-name">${esc(g[side + "_name"] || g[side])}</span><span class="nc-pct"><b>${pct(p)}</b><small>Leo win chance</small></span></div>`; };
  const pa = Math.max(1, Math.min(99, Math.round((1 - L.p_home) * 100)));
  const box = (lab, val, sub, gold) => `<div class="nc-box${gold ? " gold" : ""}"><small>${lab}</small><b>${esc(val)}</b><span>${esc(sub)}</span></div>`;
  const done = r || (g.completed && g.hs != null);
  let final = "";
  if (r) final = `<div class="nc-final"><b>Final: ${esc(nick(g.away_name))} ${r.away_score}, ${esc(nick(g.home_name))} ${r.home_score}.</b> ${r.leo_winner_correct === 1 ? '<span class="ok">Leo had the winner.</span>' : r.leo_winner_correct === 0 ? '<span class="no">Leo had the other team.</span>' : ""}${r.pick_result && !r.pick_replay ? ` Leo Pick ${esc(nk(r.pick_team))}: <span class="${r.pick_result === "win" ? "ok" : r.pick_result === "loss" ? "no" : ""}">${r.pick_result === "win" ? "Won" : r.pick_result === "loss" ? "Lost" : "Push"}, ${r.pick_units >= 0 ? "+" : ""}${(+r.pick_units).toFixed(2)}u</span>.` : ""}</div>`;
  else if (g.completed && g.hs != null) final = `<div class="nc-final"><b>Final: ${esc(nick(g.away_name))} ${g.as}, ${esc(nick(g.home_name))} ${g.hs}.</b> Grading pending.</div>`;
  return `<article class="nc">
    <div class="nc-stripe"><i style="background:${col(g.away)}"></i><i style="background:${col(g.home)}"></i></div>
    <div class="nc-body">
      <div class="nc-top"><div><b class="nc-time">${esc(tip(g.tip_utc))}</b><span class="nc-dim">${esc(g.venue || "")}</span></div><span class="nc-badge${isPick ? " on" : ""}">${isPick ? esc(nk(PT.badge)) : "No call"}</span></div>
      <h3 class="nc-h"><a href="${gameUrl(g)}">${esc(g.away_name)} at ${esc(g.home_name)}</a></h3>
      ${team("away")}${team("home")}
      <div class="nc-bar"><i style="width:${pa}%"></i></div>
      <div class="nc-boxes">${box("Leo spread", LS == null ? "n/a" : nk(WHY.favLine(g, LS)), "Leo's favorite, by", true)}${box("DraftKings", mk.home_spread == null ? "no line" : nk(WHY.favLine(g, mk.home_spread)), mk.p_home != null ? `market ${nick(g.home_name)} ${pct(mk.p_home)}` : "")}${CB ? box("Call", nk(CB.value), nk(CB.sub)) : ""}</div>
      ${PT ? `<p class="nc-pick${isPick ? " on" : ""}">${esc(nk(PT.line))}</p>` : ""}
      ${!done && SW.line(g) ? `<p class="nc-dep">${esc(nk(SW.line(g)))}</p>` : ""}
      ${WHY.compare(g) ? `<p class="nc-cmp">${esc(nk(WHY.compare(g)))}</p>` : ""}
      ${W && W.summary ? `<p class="nc-why">${esc(nk(W.summary))}</p>` : ""}
      ${final}
      <a class="nc-more" href="${gameUrl(g)}">Full preview: why Leo has this number &rarr;</a>
    </div>
  </article>`;
}

/** Tiles and the picks panel above the games, as in the card email. */
function topPanels(date, games, res) {
  const tracked = date >= PKS.TRACK_FROM;
  const picks = tracked ? games.filter(g => (PKS.pickText(g) || {}).ok) : [];
  const rec = (readJson(path.join(DATA, "results.json")) || {}).season;
  const P = rec && rec.picks;
  const first = games.map(g => g.tip_utc).filter(Boolean).sort()[0];
  const tile = (l, v, s) => `<div class="nc-tile"><small>${l}</small><b>${v}</b><span>${s}</span></div>`;
  const tiles = `<section class="nc-tiles">${tile("Games", games.length, first ? "first tip " + esc(tip(first)) : "")}${tracked ? tile("Leo Picks tonight", picks.length, "60%+, better than -230") : ""}${P && P.n ? tile("Leo Picks so far", `${P.won}-${P.lost}`, `${P.units > 0 ? "+" : ""}${(+P.units).toFixed(2)} units since Nov 2`) : ""}</section>`;
  if (!tracked) return tiles;
  const rows = picks.length ? picks.map(g => { const nk = nickFor(g), pk = g.leo.pick || {};
      return `<div class="nc-prow"><b>${esc(nk(PKS.pickText(g).badge.replace(/^Pick /, "")))}</b><span>${esc(nick(g.away_name))} at ${esc(nick(g.home_name))} &middot; ${esc(tip(g.tip_utc))}<br>Leo ${Math.round((pk.p || Math.max(g.leo.p_home, 1 - g.leo.p_home)) * 100)}% to win</span></div>`; }).join("")
    : `<p class="nc-dim" style="margin:0">No team tonight is 60%+ with Leo at a price better than -230, so there is no Leo Pick.</p>`;
  return tiles + `<section class="nc-panel"><h2>Tonight&rsquo;s Leo Picks (moneyline)</h2>${rows}${picks.length ? `<p class="nc-dim" style="margin:8px 0 0">Graded at this price. It locks when Leo first makes the pick.</p>` : ""}</section>`;
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
<meta property="og:url" content="${ORIGIN}${url}"><meta property="og:image" content="${ORIGIN}/img/leo-card.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/css/style.css">
<link rel="stylesheet" href="/css/scoreboard.css">
<style>
.dn-grid{display:grid;gap:14px;margin-top:14px}
.nc{background:var(--bg-card);border:1px solid rgba(26,37,53,.16);border-radius:20px;overflow:hidden;box-shadow:var(--shadow-sm)}
.nc-stripe{display:flex;height:6px}.nc-stripe i{flex:1}
.nc-body{padding:14px 16px 16px}
.nc-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.nc-time{display:block;font-size:.95rem}.nc-dim{color:var(--text-dim);font-size:.8rem}
.nc-badge{font-size:.7rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:5px 10px;border-radius:999px;background:var(--bg);color:var(--text-dim);white-space:nowrap}
.nc-badge.on{background:#E6EFE6;color:var(--good)}
.nc-h{font-size:.82rem;margin:8px 0 2px;font-weight:700}.nc-h a{color:var(--text-dim);text-decoration:none}
.nc-team{display:flex;align-items:center;gap:10px;padding:6px 0}
.nc-team img{width:36px;height:36px;object-fit:contain;flex:none}
.nc-name{flex:1;font-weight:600;font-size:1rem}
.nc-pct{text-align:right;white-space:nowrap}.nc-pct b{display:block;font-size:1.05rem}.nc-pct small{color:var(--text-dim);font-size:.72rem}
.nc-bar{height:8px;border-radius:999px;background:var(--navy,#1A2535);margin:10px 0 12px;overflow:hidden}.nc-bar i{display:block;height:100%;background:var(--gold,#C9A84C)}
.nc-boxes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
.nc-box{border:1px solid var(--border);border-radius:12px;padding:9px 4px;text-align:center;background:#fff}
.nc-box.gold{background:#FBF5E4;border-color:#E7D8AC}
.nc-box small{display:block;font-size:.62rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim)}
.nc-box b{display:block;font-size:.95rem;margin:4px 0 2px}.nc-box span{font-size:.68rem;color:var(--text-dim)}
.nc-pick{margin:12px 0 0;font-size:.9rem;color:var(--text-dim)}.nc-pick.on{background:#E6EFE6;color:var(--text);font-weight:700;border-radius:10px;padding:9px 12px}
.nc-dep{margin:10px 0 0;border-left:3px solid var(--gold,#C9A84C);padding:2px 0 2px 10px;font-size:.9rem}
.nc-cmp{margin:12px 0 0;font-size:.9rem}
.nc-why{margin:12px 0 0;padding-top:11px;border-top:1px solid var(--border);color:var(--text-dim);font-size:.88rem;line-height:1.55}
.nc-final{margin:12px 0 0;padding:9px 12px;border-radius:10px;background:var(--bg);font-size:.9rem}
.nc-final .ok{color:var(--good);font-weight:800}.nc-final .no{color:var(--danger);font-weight:800}
.nc-more{display:inline-block;margin-top:11px;font-weight:800;font-size:.88rem;text-decoration:none}
.nc-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:14px}
.nc-tile{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:12px 14px}
.nc-tile small{display:block;font-size:.64rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--text-dim)}
.nc-tile b{display:block;font-size:1.5rem;margin:2px 0}.nc-tile span{font-size:.78rem;color:var(--text-dim)}
.nc-panel{background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:14px 16px;margin-top:12px}
.nc-panel h2{font-size:.72rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--text-dim);margin:0 0 6px}
.nc-prow{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid var(--border)}.nc-prow:first-of-type{border-top:0}
.nc-prow b{font-size:1rem;white-space:nowrap}.nc-prow span{text-align:right;font-size:.8rem;color:var(--text-dim)}
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
  // Leo Picks first, then by tip, as in the card email.
  const isPk = g => g.date >= PKS.TRACK_FROM && !!(PKS.pickText(g) || {}).ok;
  games.sort((x, y) => (isPk(y) - isPk(x)) || String(x.tip_utc).localeCompare(String(y.tip_utc)));
  if (!games.length) return false;
  const res = results.filter(r => r.date === date);
  const byId = Object.fromEntries(res.map(r => [String(r.game_id), r]));
  const i = all.indexOf(date), prevD = all[i - 1], nextD = all[i + 1];
  const url = `/nba/predictions/${date}/`;
  const title = `NBA Predictions for ${monthDay(date)}: Picks, Spreads and Win Chances | Leo`;
  const desc = `Leo's NBA predictions for ${longDay(date)}: a win chance and spread for all ${games.length} games beside the DraftKings line, graded after the final.`;
  const nav = `<p class="small" style="margin:10px 0 0">${prevD ? `<a href="/nba/predictions/${prevD}/">&larr; ${esc(monthDay(prevD))}</a> &middot; ` : ""}<a href="/nba/predictions/">Every night</a> &middot; <a href="/nba/scoreboard/">Tonight's NBA card</a> &middot; <a href="/nba/results/">Leo's NBA record</a>${nextD ? ` &middot; <a href="/nba/predictions/${nextD}/">${esc(monthDay(nextD))} &rarr;</a>` : ""}</p>`;
  const body = `${topPanels(date, games, res)}
  ${require("./lib/nba-signup-box").box("night")}
  <section class="dn-grid">
${games.map(g => card(g, byId[String(g.game_id)])).join("\n")}
  </section>
  <section class="card" style="margin-top:14px"><p style="margin:0">${esc(intro(date, games, res))}</p>${nav}</section>`;
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
  const desc = "Every night of Leo's NBA predictions this season: win chance and spread for every game beside the DraftKings line, with the Leo Picks and the graded results.";
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
