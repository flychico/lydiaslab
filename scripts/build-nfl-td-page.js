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
const NOW = Number(process.env.TD_NOW_MS) || Date.now();   // TD_NOW_MS: previews only
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
  return best ? { price: american(best.p), p: best.p } : null;
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
    // Game-day rows saved before td_stats existed (Thanksgiving 2026) borrow the early read's stats for the same player.
    if (source === "game day" && early && early.props) {
      const st = new Map(early.props.filter(p => p.td_stats).map(p => [`${p.game_id}|${norm(p.player)}`, p.td_stats]));
      rows = rows.map(p => p.td_stats ? p : { ...p, td_stats: st.get(`${p.game_id}|${norm(p.player)}`) || null });
    }
    if (!rows.length) continue;
    const picks = readJson(path.join(DIR, "td-picks", `${d}.json`));
    for (const m of games) {
      const ko = kickUtc(d, m.kickoff);
      const players = rows.filter(p => p.game_id === m.game_id && p.projection > 0)
        .sort((a, b) => b.projection - a.projection)
        .map(p => { const mk = marketPrice(d, p.player, ko); return { ...p, leo_odds: fairOdds(p.projection), market: mk ? mk.price : null, market_p: mk ? mk.p : null, result: scored(d, p.player, m.game_id) }; });
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

/** The public touchdown picks record (record.json "public", from PICKS_FROM; build-nfl-td-picks.js). */
const PUB = (() => { const r = readJson(path.join(DIR, "td-picks", "record.json")); return (r && r.public) || null; })();
const su = u => `${u >= 0 ? "+" : ""}${Number(u).toFixed(2)}u`;
function dayLine(d) {
  const day = PUB && PUB.days.find(x => x.date === d.date);
  return day && day.graded ? ` This day: ${day.won}-${day.lost}${day.void ? `, ${day.void} void` : ""}, ${su(day.units)}.` : "";
}
function publicFoot() {
  if (!PUB || !PUB.graded) return `Leo's touchdown picks record starts with these. <a href="/nfl/results/">Every result</a>`;
  return `Leo's touchdown picks since Dec 3: <strong>${PUB.won}-${PUB.lost}, ${su(PUB.units)}</strong>${PUB.void ? `, ${PUB.void} void` : ""}${PUB.graded < 50 ? `, early read (${PUB.graded} of 50)` : ""}. <a href="/nfl/results/">Every result</a>`;
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
      return { player: p.player, team: p.team || live.team, projection: p.chance, leo_odds: fairOdds(p.chance), market: p.price ?? live.market, result: p.result || live.result, units: p.units, frozen: true, g };
    }) : gs.flatMap(g => g.players.map(p => ({ ...p, g }))).sort((a, b) => b.projection - a.projection).slice(0, 3);
    out.push({ date: d, top, picks: d >= PICKS_FROM });
  }
  return out;
}

function last5(st) {
  if (!st || !st.last5 || !st.last5.length) return "";
  return `<span class="td-dots">${st.last5.map(x => `<span class="td-dot${x.td ? " y" : ""}" title="Week ${x.wk}${x.opp ? " vs " + esc(x.opp) : ""}: ${x.td} TD">${x.td || ""}</span>`).join("")}</span>`;
}

function gameTable(g, avg) {
  const m = g.m, away = TEAMS.nick(m.away), home = TEAMS.nick(m.home);
  const hasStats = g.players.some(p => p.td_stats && p.td_stats.games);
  const rows = g.players.slice(0, TOP_N).map(p => {
    const st = p.td_stats || {};
    const res = p.result === "W" ? '<span class="td-res w">Scored</span>' : p.result === "L" ? '<span class="td-res l">No TD</span>' : "";
    return `<tr>
<td><strong>${esc(p.player)}</strong> <span class="dim">${esc(p.position || "")}, ${esc(TEAMS.nick(p.team))}</span>${res ? " " + res : ""}</td>
<td class="num"><strong>${pct(p.projection)}</strong> <span class="dim small">${esc(p.leo_odds)}</span>${BAR(p.projection)}</td>
<td class="num hide-sm">${p.market != null ? esc(fmtPrice(p.market)) : '<span class="dim">game day</span>'}</td>
${hasStats ? `<td class="num">${st.games ? `${st.tds}<div class="dim small">scored in ${st.td_games} of ${st.games}</div>` : ""}</td>
<td class="hide-sm">${last5(st)}</td>
<td class="num hide-sm">${st.games ? `${st.car_pg} car, ${st.tgt_pg} tgt` : ""}</td>
<td class="num hide-sm">${st.opp_allowed_pg != null ? st.opp_allowed_pg.toFixed(2) : ""}</td>` : ""}
</tr>`;
  }).join("\n");
  return `<section class="td-game" id="${esc(m.slug || m.game_id)}">
<h2>${esc(away)} vs ${esc(home)} anytime touchdown odds</h2>
<p class="dim">${esc(whenText(g.date, m.kickoff))}${g.source === "early" ? " · early read, updated on game day" : ""} · <a href="/nfl/${esc(m.slug)}/">full ${esc(away)} vs ${esc(home)} prediction</a></p>
${avg ? whyText(g, avg) : ""}
<div class="table-wrap"><table class="td-table">
<thead><tr><th>Player</th><th class="num">Leo chance</th><th class="num hide-sm">Market</th>${hasStats ? '<th class="num">Season TDs</th><th class="hide-sm">Last 5</th><th class="num hide-sm">Per game</th><th class="num hide-sm">Opp. allows</th>' : ""}</tr></thead>
<tbody>
${rows}
</tbody></table></div>
</section>`;
}

// Lynold, 2026-11-27 (outside review): a "Top 20 Leo chances this week" table up top, the biggest gaps between
// Leo's chance and the market's implied chance once prices are in (numbers side by side, no "edge" or "value"
// wording), and one line pointing to the free card email under the intro and at the bottom.
const DAY = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
function matchup(p) {
  const m = p.g.m, home = p.team === m.home;
  return `${home ? "vs" : "at"} ${TEAMS.nick(home ? m.away : m.home)}, ${DAY(p.g.date)}`;
}
function top20Table(all) {
  const top = all.slice().sort((a, b) => b.projection - a.projection || a.player.localeCompare(b.player)).slice(0, 20);
  if (!top.length) return "";
  const hasStats = top.some(p => p.td_stats && p.td_stats.games);
  const rows = top.map((p, i) => { const st = p.td_stats || {};
    return `<tr data-chance="${p.projection.toFixed(4)}" data-tds="${st.games ? st.tds : -1}" data-rank="${i}">
<td class="num dim">${i + 1}</td>
<td><span class="td-pl">${LOGO(p.team)}<span><strong>${esc(p.player)}</strong> <span class="dim">${esc(p.position || "")}</span><div class="dim small">${esc(TEAMS.nick(p.team))} ${esc(matchup(p))}</div></span></span></td>
<td class="num"><strong>${pct(p.projection)}</strong> <span class="dim small">${esc(p.leo_odds)}</span>${BAR(p.projection)}</td>
${hasStats ? `<td class="num">${st.games ? `${st.tds}<div class="dim small">in ${st.games} games</div>` : ""}</td>` : ""}
<td class="num hide-sm">${p.market != null ? esc(fmtPrice(p.market)) : '<span class="dim">game day</span>'}</td>
</tr>`; }).join("\n");
  return `<section id="top20">
<h2>Top 20 Leo chances this week</h2>
<p class="dim small">Every game, highest chance first. Tap a heading to sort.</p>
<div class="table-wrap"><table class="td-table td-sort">
<thead><tr><th class="num"><button type="button" data-sort="rank">#</button></th><th>Player and game</th><th class="num"><button type="button" data-sort="chance">Leo chance</button></th>${hasStats ? '<th class="num"><button type="button" data-sort="tds">Season TDs</button></th>' : ""}<th class="num hide-sm">Market</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>
<script>(function(){var t=document.currentScript.previousElementSibling.querySelector("table");if(!t)return;var b=t.tBodies[0],dir={};t.querySelectorAll("button[data-sort]").forEach(function(btn){btn.addEventListener("click",function(){var k=btn.getAttribute("data-sort"),asc=k==="rank"?true:!!dir[k];dir[k]=!asc;var rows=[].slice.call(b.rows);rows.sort(function(x,y){var a=+x.getAttribute("data-"+k),c=+y.getAttribute("data-"+k);return asc?a-c:c-a});rows.forEach(function(r){b.appendChild(r)});});});})();</script>
</section>`;
}
function gapsTable(all) {
  const priced = all.filter(p => p.market_p > 0 && p.market_p < 1);
  if (priced.length < 3) return `<section id="market"><h2>Leo and the market, side by side</h2><p class="dim">Market prices post on game day. This table then lists the players where Leo's chance and the market's implied chance are furthest apart.</p></section>`;
  const top = priced.map(p => ({ ...p, diff: p.projection - p.market_p })).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.player.localeCompare(b.player)).slice(0, 5);
  const rows = top.map(p => { const d = Math.round(p.diff * 100);
    return `<tr>
<td><strong>${esc(p.player)}</strong> <span class="dim">${esc(TEAMS.nick(p.team))}</span><div class="dim small">${esc(matchup(p))}</div></td>
<td class="num"><strong>${pct(p.projection)}</strong><div class="dim small">${esc(p.leo_odds)}</div></td>
<td class="num">${pct(p.market_p)}<div class="dim small">${esc(fmtPrice(p.market))}</div></td>
<td class="num"><strong>${d === 0 ? "0" : `${d > 0 ? "+" : "&minus;"}${Math.abs(d)}`}</strong><div class="dim small">pts</div></td>
</tr>`; }).join("\n");
  return `<section id="market">
<h2>Leo and the market, side by side</h2>
<p class="dim small">The five players where Leo's chance and the market's implied chance are furthest apart, either way: a plus means Leo's chance is higher, a minus means it is lower. The market chance comes from the average price and includes the bookmaker's margin. Leo never uses the market's numbers.</p>
<div class="table-wrap"><table class="td-table">
<thead><tr><th>Player and game</th><th class="num">Leo</th><th class="num">Market</th><th class="num" style="white-space:normal">Leo minus market</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>
</section>`;
}
const LOGO = t => `<img class="td-logo" src="/img/nfl/${encodeURIComponent(t)}.png" alt="" width="28" height="28" loading="lazy">`;
const BAR = p => `<span class="td-bar"><span style="width:${Math.round(Math.min(1, p) * 100)}%"></span></span>`;
// Lynold, 2026-11-27: "you have good content here but i do think people are reading it because the appearnace".
// The page opens with a visual leaderboard instead of a paragraph, the free card box right under it, and bars for chances.
function leaderboard(best, W) {
  const rows = best.map((p, i) => { const st = p.td_stats || {};
    return `<li class="ldr-row">
<span class="ldr-rank">${i + 1}</span>${LOGO(p.team)}
<span class="ldr-who"><span class="ldr-name">${esc(p.player)}</span><span class="ldr-meta">${esc(p.position || "")} · ${esc(TEAMS.nick(p.team))} ${esc(matchup(p))}${st.games ? ` · ${st.tds} TD in ${st.games} games` : ""}</span></span>
<span class="ldr-num"><span class="ldr-pct">${pct(p.projection)}</span><span class="ldr-odds">${esc(p.leo_odds)}</span></span>
<span class="ldr-bar"><span style="width:${Math.round(p.projection * 100)}%"></span></span>
</li>`; }).join("\n");
  return `<section class="ldr" id="leaders">
<p class="ldr-eye">Week ${W.week} · Most likely to score</p>
<ol class="ldr-list">
${rows}
</ol>
<p class="ldr-foot"><a href="#top20">See the top 20</a> · <a href="#how">How Leo works this out</a></p>
</section>`;
}
// Lynold, 2026-11-27, liking Covers' weekly anytime touchdown article: a "likeliest scorer in every game" table up
// top and a short written read per game, built only from the numbers on the page (not graded picks: the graded
// ones are Leo's top 3 of the day). No photos, no grades, no betting asks.
const PLURAL = { RB: "running backs", WR: "receivers", TE: "tight ends", QB: "quarterbacks", FB: "fullbacks" };
const r1 = x => (Math.round(x * 10) / 10).toString();
function posAvg(W) {
  const acc = {};
  for (const g of W.games) for (const p of g.players) { const st = p.td_stats; if (!st || st.opp_allowed_pg == null) continue;
    (acc[p.position] = acc[p.position] || []).push(st.opp_allowed_pg); }
  const out = {}; for (const [k, v] of Object.entries(acc)) out[k] = v.reduce((a, b) => a + b, 0) / v.length; return out;
}
function whyText(g, avg) {
  const [a, b] = g.players, m = g.m;
  if (!a) return "";
  const st = a.td_stats || {}, opp = TEAMS.nick(a.team === m.home ? m.away : m.home), team = TEAMS.nick(a.team);
  const out = [`${esc(a.player)} is Leo's likeliest scorer in this game at ${pct(a.projection)}, fair odds ${esc(a.leo_odds)}.`];
  if (st.games) {
    let t = `He has ${st.tds} touchdown${st.tds === 1 ? "" : "s"} this season and has scored in ${st.td_games} of ${st.games} games`;
    if (st.games < 6 && st.prior_games) t += `, after ${st.prior_tds} in ${st.prior_games} games last season`;
    const l5 = (st.last5 || []), k = l5.filter(x => x.td > 0).length;
    if (l5.length >= 3) t += `, including ${k} of his last ${l5.length}`;
    out.push(t + ".");
    const use = [st.car_pg >= 1 ? `${r1(st.car_pg)} carries` : null, st.tgt_pg >= 1 ? `${r1(st.tgt_pg)} targets` : null].filter(Boolean);
    if (use.length) out.push(`He averages ${use.join(" and ")} a game.`);
  }
  if (st.opp_allowed_pg != null && PLURAL[a.position]) {
    const av = avg[a.position], x = st.opp_allowed_pg;
    const cmp = av ? (x >= av * 1.15 ? ", more than most defenses on this week's slate" : x <= av * 0.85 ? ", fewer than most defenses on this week's slate" : ", about the slate average") : "";
    out.push(`The ${esc(opp)} allow ${x.toFixed(2)} touchdowns a game to ${PLURAL[a.position]}${cmp}.`);
  }
  if (a.team_ppg && a.opp_allowed) out.push(`The ${esc(team)} score ${r1(a.team_ppg)} points a game and the ${esc(opp)} allow ${r1(a.opp_allowed)}.`);
  if (a.market != null && a.market_p) out.push(`The market price is ${esc(fmtPrice(a.market))}, an implied ${pct(a.market_p)} with the bookmaker's margin.`);
  if (b) { const sb = b.td_stats || {}; out.push(`Next in this game: ${esc(b.player)} at ${pct(b.projection)} (${esc(b.leo_odds)})${sb.games ? `, ${sb.tds} touchdown${sb.tds === 1 ? "" : "s"} in ${sb.games} games` : ""}.`); }
  return `<p class="td-why">${out.join(" ")}</p>`;
}
function everyGameTable(games) {
  if (!games.length) return "";
  const rows = games.map(g => { const a = g.players[0], m = g.m;
    return `<tr>
<td><span class="td-pl td-pair">${LOGO(m.away)}${LOGO(m.home)}<span><a href="#${esc(m.slug || m.game_id)}">${esc(TEAMS.nick(m.away))} at ${esc(TEAMS.nick(m.home))}</a><div class="dim small">${esc(DAY(g.date))}</div></span></span></td>
<td><span class="td-pl">${LOGO(a.team)}<span><strong>${esc(a.player)}</strong> <span class="dim">${esc(a.position || "")}</span></span></span></td>
<td class="num"><strong>${pct(a.projection)}</strong> <span class="dim small">${esc(a.leo_odds)}</span>${BAR(a.projection)}</td>
</tr>`; }).join("\n");
  return `<section id="every-game">
<h2>Leo's likeliest scorer in every game</h2>
<div class="table-wrap"><table class="td-table">
<thead><tr><th>Game</th><th>Player</th><th class="num">Leo</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>
<p class="dim small">Information, not graded picks. Leo's graded touchdown picks are his top 3 of each game day.</p>
</section>`;
}
const CARD_LINE = `<p class="td-next"><a class="td-cta" href="#free-card">Get the final game-day numbers free by email &rarr;</a></p>`;

function page(W, { hub, prev, next, current }) {
  const permanent = `/nfl/anytime-touchdowns/${W.season}-week-${W.week}/`;
  // The hub is the page to rank (Lynold, Nov 27: "make sure this page gets indexed asap"): it and the current week's
  // own page point their canonical at the hub; a week's own page points at itself once it is no longer current.
  const canon = (hub || current) ? HUB : permanent;
  const url = hub ? HUB : permanent;
  const upcoming = W.games.filter(g => Date.parse(g.ko) > NOW), played = W.games.filter(g => !(Date.parse(g.ko) > NOW)).reverse();
  const focus = upcoming.length ? upcoming : W.games;
  const all = focus.flatMap(g => g.players.map(p => ({ ...p, g })));
  const best = all.slice().sort((a, b) => b.projection - a.projection).slice(0, 5);
  const upDates = new Set(upcoming.map(g => g.date));
  const days = dayTop3(W).sort((a, b) => (upDates.has(b.date) - upDates.has(a.date)) || (upDates.has(a.date) ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)));
  const early = W.games.some(g => g.source === "early");
  const AVG = posAvg(W);
  const firstDate = days[0].date;
  const title = `NFL Anytime Touchdown Predictions Week ${W.week} ${W.season}: Leo's Odds for Every Player | Leo by ND Horizon`;
  const desc = `Week ${W.week} anytime touchdown odds from Leo: ${best.slice(0, 3).map(p => `${p.player} ${pct(p.projection)}`).join(", ")}. Every player's chance, recent touchdowns and matchup.`;
  const updated = new Date(NOW).toISOString();
  const shownDays = days.filter(d => upDates.has(d.date) || !upcoming.length);
  const laterDays = shownDays.slice(1);
  const laterLine = laterDays.length ? `<p class="td-later"><strong>Leo's top 3 on later days:</strong> ${laterDays.map(d => `${esc(new Date(d.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }))}: ${esc(d.top.map(p => `${p.player} ${pct(p.projection)}`).join(", "))}`).join(" · ")}</p>` : "";
  const top3Box = shownDays.slice(0, 1).map(d => SEO.analysisBox({
    id: `top-${d.date}`,
    eyebrow: `${d.picks ? "Leo's touchdown picks" : "Leo's top 3"} · ${new Date(d.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" })}`,
    headline: d.top.map(p => p.player.split(" ").slice(-1)[0]).join(", "),
    sub: d.picks ? `Graded at 1 unit each at the market price at Leo's read.${dayLine(d)}` : "The three players Leo gives the best chance to score. Leo's touchdown picks are graded publicly from Week 13.",
    chips: d.top.map(p => ({ label: `${p.player} (${TEAMS.nick(p.team)})`, value: `${pct(p.projection)} · ${p.leo_odds}`, on: true,
      note: [p.market != null ? `market ${fmtPrice(p.market)}` : "market price on game day", d.picks && p.result === "void" ? "did not play, void" : null, d.picks && p.units != null && /^[WL]$/.test(p.result || "") ? `${p.units >= 0 ? "+" : ""}${p.units.toFixed(2)}u` : null].filter(Boolean).join(" · "),
      result: /^[WL]$/.test(p.result || "") ? p.result : null })),
    foot: d.picks ? publicFoot() : ""
  })).join("\n");
  const faq = [
    { q: `Who is most likely to score a touchdown in Week ${W.week}?`, a: `In Leo's read, ${best.slice(0, 3).map(p => `${p.player} (${pct(p.projection)})`).join(", ")}.` },
    { q: "What are Leo's odds?", a: "Leo's chance turned into a fair American price with no bookmaker margin. A 60% chance is -150; a 25% chance is +300. When the market's price is longer than Leo's odds, Leo rates the player above the market." },
    { q: "How does Leo work out a touchdown chance?", a: "From each player's share of his team's carries and targets, his touchdown rate this season and last, his team's scoring, the opponent's points allowed, home field and his place on the depth chart. Players listed out or doubtful are left out." },
    { q: "When does this page update?", a: "It goes up days before the games from Leo's early read and updates on game day with the final read and the market prices. After the games, each player shows whether he scored." }
  ];
  const jump = SEO.jumpBar([["top-" + firstDate, "Leo's top 3"], ["every-game", "Every game"], ["top20", "Top 20"], ["market", "Leo and the market"], ...upcoming.map(g => [g.m.slug || g.m.game_id, `${TEAMS.nick(g.m.away)} vs ${TEAMS.nick(g.m.home)}`]), played.length ? ["played", "Already played"] : null, ["faq", "FAQ"]]);
  const body = `
<p class="eyebrow"><a href="/nfl/">NFL</a> · Anytime touchdowns</p>
<h1>NFL anytime touchdown predictions, Week ${W.week}</h1>
<p class="td-dek">Leo's chance that each player scores, set before kickoff and graded after.${early ? " Early read, final numbers on game day." : ""}</p>
<p class="byline" style="text-align:center;color:var(--text-dim);font-size:.84rem;margin:4px 0 14px">By <a href="/nfl/how-leo-works/">Leo</a>, the New Dawn Horizon sports model · Updated ${esc(new Date(NOW).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))} ET</p>
${leaderboard(best, W)}
<div id="free-card">${SIGNUP.box("night")}</div>
${jump}
${top3Box}
${laterLine}
${everyGameTable(upcoming.length ? upcoming : W.games)}
${top20Table(all)}
${gapsTable(all)}
${upcoming.map(g => gameTable(g, AVG)).join("\n")}
${played.length ? `<h2 id="played">Already played in Week ${W.week}</h2>\n<p class="dim">Leo's read before kickoff and who scored.</p>\n${played.map(g => gameTable(g)).join("\n")}` : ""}
<section id="how">
<h2>How to read the table</h2>
<p>Leo's most likely touchdown scorers for Week ${W.week}: ${best.map(p => `${esc(p.player)} ${pct(p.projection)} (${esc(p.leo_odds)})`).join(", ")}. Every player shows Leo's chance, Leo's odds, his touchdowns this season and in his last five games, and what his opponent allows to his position.${early ? " This is an early read: it updates on game day with the final read and the market prices." : ""}</p>
<ul class="key">
<li><strong>Leo chance</strong>: Leo's chance the player scores at least one rushing or receiving touchdown.</li>
<li><strong>Leo odds</strong>: that chance as a fair price with no bookmaker margin. <strong>Market</strong>: the average market price at Leo's latest read, shown for comparison only. Leo never uses it.</li>
<li><strong>TDs this season</strong>: rushing plus receiving touchdowns, and in how many games he scored. <strong>Last 5</strong>: touchdowns in each of his last five games, newest first (gold = scored).</li>
<li><strong>Per game</strong>: carries and targets a game this season. <strong>Opp. allows</strong>: touchdowns a game the opponent has allowed to his position this season.</li>
</ul>
</section>
${SEO.faqHtml(faq, `Questions about Week ${W.week} touchdowns`)}
<section class="td-more"><h2>More Week ${W.week} NFL from Leo</h2><ul>
<li><a href="/nfl/week/">Every Week ${W.week} game: win chances, spreads and totals</a></li>
<li><a href="/nfl/previews/">Leo's moneyline and spread calls this week</a></li>
<li><a href="/nfl/scoreboard/">Live scores and Leo's read on each game</a></li>
<li><a href="/nfl/results/">Leo's graded record, wins and losses</a></li>
</ul></section>
${CARD_LINE}
<p class="dim">${prev ? `<a href="${prev}">Previous week</a>` : ""}${prev && next ? " · " : ""}${next ? `<a href="${next}">Next week</a>` : ""}${prev || next ? " · " : ""}<a href="/nfl/previews/">This week's picks</a> · <a href="/nfl/results/">Leo's record</a></p>`;
  const pub = { "@type": "Organization", name: "New Dawn Horizon", url: ORIGIN + "/" };
  const jsonld = { "@context": "https://schema.org", "@graph": [
    { "@type": "Article", headline: title.replace(/\s*\|.*$/, ""), description: desc, url: ORIGIN + url, mainEntityOfPage: ORIGIN + url, author: pub, publisher: pub, dateModified: updated, isAccessibleForFree: true },
    { "@type": "FAQPage", mainEntity: faq.map(x => ({ "@type": "Question", name: x.q, acceptedAnswer: { "@type": "Answer", text: x.a } })) },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Leo", item: ORIGIN + "/" },
      { "@type": "ListItem", position: 2, name: "NFL", item: ORIGIN + "/nfl/scoreboard/" },
      { "@type": "ListItem", position: 3, name: "Anytime touchdowns", item: ORIGIN + HUB }] }] };
  // Share card (render-td-share.js draws it in prerender-hubs.yml): a new file name each week so X fetches it fresh.
  const image = `/img/share/nfl-td-${W.season}-w${W.week}.png`;
  const share = {
    week: W.week, season: W.season, image, updated: `Updated ${new Date(NOW).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}`,
    top: best.map(p => ({ player: p.player, team: p.team, chance: p.projection, meta: `${p.position || ""} · ${TEAMS.nick(p.team)} ${matchup(p)}` }))
  };
  const html = shell({ title, desc, url, canonical: canon, jsonld, body: SEO.withReadTime(body), image,
    imageAlt: `Week ${W.week} anytime touchdown odds: ${best.slice(0, 3).map(p => `${p.player} ${pct(p.projection)}`).join(", ")}`,
    shareTitle: `Week ${W.week} anytime touchdown odds: who's most likely to score` });
  return { url, canonical: canon, html, share };
}

function shell({ title, desc, url, canonical, jsonld, body, image = "/img/leo-card.png", imageAlt = "Leo by New Dawn Horizon", shareTitle = title }) {
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
<meta property="og:image" content="${ORIGIN}${image}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(imageAlt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${ORIGIN}${image}">
<meta name="twitter:title" content="${esc(shareTitle)}">
<meta name="twitter:description" content="${esc(desc)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico" sizes="any"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/css/style.css">
<style>
.td-table{width:100%;border-collapse:collapse;font-size:.9rem}
.td-table th,.td-table td{padding:8px 8px;border-bottom:1px solid var(--border);text-align:left;vertical-align:middle}
.td-table th{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim);white-space:nowrap}
.td-table .num{text-align:right;white-space:nowrap}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
.td-game{margin:26px 0}
.td-sort th button{all:unset;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px}
.td-table .small{font-size:.75rem;line-height:1.3}
.td-sort td:nth-child(2){min-width:0;white-space:normal}
.td-table th[style]{min-width:64px}
@media (max-width:560px){.td-sort th,.td-sort td{padding:7px 5px}.td-sort th{white-space:normal}}
.td-next{margin:22px 0;text-align:center}
.td-cta{display:inline-block;background:#1A2535;color:#F5F0E8!important;font-weight:700;padding:12px 18px;border-radius:999px;text-decoration:none!important;box-shadow:0 0 0 2px #C9A84C inset}
.td-dek{font-size:1.12rem;text-align:center;color:var(--text-dim);margin:6px auto 4px;max-width:560px}
.ldr{background:#1A2535;color:#F5F0E8;border-radius:18px;padding:18px 16px 14px;margin:8px 0 16px;border-top:4px solid #C9A84C;box-shadow:var(--shadow-sm)}
.ldr-eye{margin:0 0 10px;color:#C9A84C;font-weight:800;font-size:.74rem;letter-spacing:.12em;text-transform:uppercase}
.ldr-list{list-style:none;margin:0;padding:0}
.ldr-row{display:grid;grid-template-columns:22px 32px 1fr auto;grid-template-rows:auto 6px;align-items:center;column-gap:10px;row-gap:6px;padding:11px 0;border-bottom:1px solid rgba(245,240,232,.10)}
.ldr-row:last-child{border-bottom:0}
.ldr-rank{font-family:Georgia,serif;font-size:1.35rem;color:#C9A84C;font-weight:700;text-align:center}
.ldr-row .td-logo{width:32px;height:32px;background:#F5F0E8;border-radius:50%;padding:3px;box-sizing:border-box}
.ldr-who{display:flex;flex-direction:column;min-width:0}
.ldr-name{font-weight:800;font-size:1.02rem;line-height:1.2}
.ldr-meta{font-size:.78rem;color:rgba(245,240,232,.68);line-height:1.35}
.ldr-num{display:flex;flex-direction:column;align-items:flex-end}
.ldr-pct{font-size:1.45rem;font-weight:800;line-height:1}
.ldr-odds{font-size:.78rem;color:#C9A84C;font-weight:700;margin-top:3px}
.ldr-bar{grid-column:3 / 5;height:6px;border-radius:3px;background:rgba(245,240,232,.12);overflow:hidden}
.ldr-bar span{display:block;height:100%;background:linear-gradient(90deg,#9c7f33,#C9A84C,#E8CF86);border-radius:3px}
.ldr-foot{margin:10px 0 0;font-size:.85rem;text-align:center}.ldr-foot a{color:#C9A84C}
.td-bar{display:block;height:4px;border-radius:2px;background:var(--border);margin-top:5px;min-width:56px;overflow:hidden}
.td-bar span{display:block;height:100%;background:#C9A84C}
.td-pl{display:flex;gap:8px;align-items:center}.td-pl .td-logo{width:24px;height:24px;flex:none}
.td-pair{gap:4px}.td-pair .td-logo{width:18px;height:18px}.td-pair>span{margin-left:4px}
.td-why{margin:6px 0 12px;line-height:1.6;max-width:720px}
.td-more ul{padding-left:18px;line-height:1.8}
.td-later{font-size:.9rem;color:var(--text-dim);margin:-4px 0 18px;line-height:1.5}
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
  // Link a neighbouring week only when its page exists or is built this run (Week 11 was linked before it existed).
  const willBuild = W => !(NOW > Math.max(...W.games.map(g => Date.parse(g.ko))) + 3 * 864e5);
  const linkable = W => { const u = permanentOf(W); return willBuild(W) || fs.existsSync(path.join(ROOT, u, "index.html")) ? u : null; };
  // This week: the earliest week with a game not yet started; else the latest week.
  const cur = weeks.find(W => W.games.some(g => Date.parse(g.ko) > NOW)) || weeks[weeks.length - 1];
  const shares = [];
  weeks.forEach((W, i) => {
    const lastKick = Math.max(...W.games.map(g => Date.parse(g.ko)));
    const dir = path.join(ROOT, permanentOf(W));
    const file = path.join(dir, "index.html");
    // A finished week's page is kept once all its results are in (never rewritten later in the season).
    if (NOW > lastKick + 3 * 864e5) return;   // finished weeks keep the page they had (or never get one if they ended before the page existed)
    const prev = i > 0 ? linkable(weeks[i - 1]) : null, next = i < weeks.length - 1 ? linkable(weeks[i + 1]) : null;
    const pg = page(W, { hub: false, prev, next, current: W === cur });
    shares.push(pg.share);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, pg.html);
    console.log(`  ${pg.url}: ${W.games.length} games, ${W.games.reduce((s, g) => s + g.players.length, 0)} players${W.games.some(g => g.source === "early") ? " (early read)" : ""}`);
  });
  const ci = weeks.indexOf(cur);
  const hub = page(cur, { hub: true, prev: ci > 0 ? linkable(weeks[ci - 1]) : null, next: ci < weeks.length - 1 ? linkable(weeks[ci + 1]) : null });
  fs.mkdirSync(path.join(ROOT, HUB), { recursive: true });
  fs.writeFileSync(path.join(ROOT, HUB, "index.html"), hub.html);
  // Share card data for every week page built this run (the hub uses its week's card); render-td-share.js draws them.
  fs.writeFileSync(path.join(DIR, "td-share.json"), JSON.stringify({ cards: shares }, null, 1) + "\n");
  console.log(`NFL touchdown page: ${HUB} shows Week ${cur.week}`);
}

if (require.main === module) main();
module.exports = { fairOdds, collect };
