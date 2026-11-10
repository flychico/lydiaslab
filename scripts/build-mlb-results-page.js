#!/usr/bin/env node
/*
  Leo MLB results page for a finished season (business/RESULTS_DESIGN.md,
  HO-0033; built in the Leo Manager chat on Lynold's instruction, 2026-11-09).

  Writes /results/index.html from the season review, day by day: the record,
  the upsets, what Leo got right, and what Leo missed and why.

  The record shown is the FROZEN record only (DEC-20261031-13): a pick counts
  only if it was first published before the scheduled first pitch. Picks added
  after the start are listed as a number, never counted.

  Inputs (read only):
    data/review/mlb-<season>/freeze_audit.csv   every official pick and when it was published
    data/review/mlb-<season>/game_review.csv    every game Leo analyzed, with Leo's last read before first pitch

  Miss reasons come straight from the season review's lesson tags:
    starter_changed   the starter Leo's read used did not start
    starter           Leo's side's starter gave up the game
    bullpen           Leo's side's bullpen gave up more earned runs
    variance          Leo and the market had the same side, and it lost
    model_error       Leo disagreed with the market, and lost

  Display only: changes no number, pick or grade.
  Usage: node scripts/build-mlb-results-page.js [--season 2026]
*/
"use strict";
const fs = require("fs");
const path = require("path");
const { GA_HEAD } = require("./lib/ga");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const SEASON = args.includes("--season") ? args[args.indexOf("--season") + 1] : "2026";
const DIR = path.join(ROOT, "data", "review", `mlb-${SEASON}`);
const ORIGIN = "https://ndhorizon.com";
const NEXT_OPENING_DAY = "March 25, 2027";

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TWO_WORD = ["Red Sox", "White Sox", "Blue Jays"];
const nick = n => TWO_WORD.find(t => String(n).endsWith(t)) || String(n).split(" ").pop();
// One decimal near a coin flip, so "50%" never sits beside a favorite.
const pct = p => (Math.round(p * 100) === 50 && p !== 0.5) ? `${(p * 100).toFixed(1)}%` : `${Math.round(p * 100)}%`;
const num = v => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const u = v => (v > 0 ? "+" : "") + v.toFixed(2);
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = d => { const x = new Date(d + "T12:00:00Z"); return `${DAYS[x.getUTCDay()]}, ${MONTHS[x.getUTCMonth()]} ${x.getUTCDate()}`; };

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
  const head = rows.shift() || [];
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
const pickUnits = p => { const price = num(p.price); if (p.result === "W") return price == null ? 0 : (price < 0 ? 100 / -price : price / 100); return p.result === "L" ? -1 : 0; };
const rec = (w, l) => `${w}-${l}`;
function tally(picks) {
  const w = picks.filter(p => p.result === "W").length, l = picks.filter(p => p.result === "L").length;
  return { w, l, units: picks.reduce((s, p) => s + pickUnits(p), 0) };
}

const REASON = { starter_changed: "Starter changed", starter: "Starter", bullpen: "Bullpen", variance: "Variance", model_error: "Leo’s error" };
const REASON_HELP = {
  starter_changed: "the starter Leo’s read used did not start",
  starter: "the starter on Leo’s side gave up the game",
  bullpen: "the bullpen on Leo’s side gave up more earned runs",
  variance: "Leo and the market had the same side, and it lost",
  model_error: "Leo disagreed with the market, and lost",
};
const reasonTag = r => `<span class="reason r-${r}">${REASON[r]}</span>`;

/* One reason per game Leo's side lost. */
function reasonFor(g) {
  const side = nick(g.leo_side_team);
  if (g.starter_changed === "1") return { reason: "starter_changed", evidence: `Leo’s read used ${g.leo_side_pitcher || "a starter"} for the ${side}, and the starter changed before first pitch.` };
  if (g.lesson_tag === "lost_starter_failed") return { reason: "starter", evidence: `${g.leo_side_pitcher || "The starter"} did not hold up for the ${side}${g.pitcher_gap ? `, though Leo rated the pitching matchup ${g.pitcher_gap} points in their favor` : ""}.` };
  if (g.lesson_tag === "lost_bullpen") return { reason: "bullpen", evidence: `The ${side} bullpen gave up ${g.leo_side_bullpen_er || "more"} earned runs${g.opp_bullpen_er !== "" ? ` to the other bullpen’s ${g.opp_bullpen_er}` : ""}.` };
  const mp = num(g.market_prob);
  if (g.lesson_tag === "lost_disagreed_with_market") return { reason: "model_error", evidence: `Leo gave the ${side} ${pct(num(g.leo_prob))}${mp != null ? ` and the market gave them ${pct(mp)}` : ""}. The market had the right side.` };
  return { reason: "variance", evidence: `Leo gave the ${side} ${pct(num(g.leo_prob))}${mp != null ? ` and the market gave them ${pct(mp)}` : ""}. The favorite lost.` };
}

function load() {
  const games = parseCsv(fs.readFileSync(path.join(DIR, "game_review.csv"), "utf8")).filter(g => g.leo_side_won !== "").map(g => {
    const [away, home] = g.matchup.split(" @ ");
    const leoTeam = g.leo_side_team, opp = leoTeam === home ? away : home;
    const won = g.leo_side_won === "1";
    const mp = num(g.market_prob);
    const fav = mp == null ? null : mp > 0.5 ? leoTeam : mp < 0.5 ? opp : null;
    const winner = won ? leoTeam : opp;
    return { ...g, away, home, leoTeam, opp, won, winner, loser: won ? opp : leoTeam, mp, fav,
      favProb: fav == null ? null : (fav === leoTeam ? mp : 1 - mp),
      upset: fav != null && fav !== winner,
      miss: won ? null : reasonFor(g) };
  });
  const picks = parseCsv(fs.readFileSync(path.join(DIR, "freeze_audit.csv"), "utf8"));
  return { games, picks };
}

function pickText(p, gameByPk) {
  const g = gameByPk.get(p.game_pk);
  const where = g ? ` (${nick(g.away)} at ${nick(g.home)})` : "";
  const price = num(p.price) == null ? "" : ` at ${num(p.price) > 0 ? "+" : ""}${num(p.price)}`;
  if (p.market === "moneyline") return `${nick(p.pick)} to win${price}${where}`;
  return `${p.pitcher} ${String(p.pick).toLowerCase()} ${p.line} strikeouts${price}${where}`;
}

function dayBlock(date, games, picks, gameByPk, running, open) {
  const ml = picks.filter(p => p.market === "moneyline"), ks = picks.filter(p => p.market !== "moneyline");
  const t = tally(picks), sideW = games.filter(g => g.won).length, sideL = games.length - sideW;
  const upsets = games.filter(g => g.upset);
  const won = picks.filter(p => p.result === "W"), lost = picks.filter(p => p.result === "L");
  const lostPks = new Set(lost.filter(p => p.market === "moneyline").map(p => p.game_pk));
  const misses = games.filter(g => g.miss);

  const upHtml = upsets.length ? `<ul>${upsets.map(g => `<li>The ${esc(nick(g.winner))} beat the ${esc(nick(g.loser))}. The market had the ${esc(nick(g.fav))} at ${pct(g.favProb)}. Leo gave the ${esc(nick(g.winner))} ${pct(g.won ? num(g.leo_prob) : 1 - num(g.leo_prob))}: ${g.won ? '<span class="ok">Leo saw it</span>' : '<span class="no">Leo missed it</span>'}.</li>`).join("")}</ul>`
    : `<p class="none">No upsets among the games with a market price.</p>`;
  const rightHtml = won.length ? `<ul>${won.map(p => `<li><span class="ok">&#10004;</span> ${esc(pickText(p, gameByPk))}, ${u(pickUnits(p))} units.</li>`).join("")}</ul>`
    : `<p class="none">${picks.length ? "No official pick won on this day." : "No official picks on this day."}</p>`;
  const lostKs = lost.filter(p => p.market !== "moneyline");
  const missHtml = (misses.length || lostKs.length) ? [
    ...misses.map(g => `<div class="miss${lostPks.has(g.game_pk) ? " official" : ""}"><div class="t">${esc(nick(g.away))} at ${esc(nick(g.home))}${lostPks.has(g.game_pk) ? ' <span class="small no">official pick lost</span>' : ""}</div>
      <div>The ${esc(nick(g.winner))} won. Leo gave the ${esc(nick(g.leoTeam))} ${pct(num(g.leo_prob))}${g.leo_side_pitcher ? ` behind ${esc(g.leo_side_pitcher)}` : ""}.</div>
      <div style="margin-top:5px">${reasonTag(g.miss.reason)}${esc(g.miss.evidence)}</div></div>`),
    lostKs.length ? `<div class="miss official"><div class="t">Strikeout picks that lost</div><ul style="margin:4px 0 0">${lostKs.map(p => `<li>${esc(pickText(p, gameByPk))}</li>`).join("")}</ul></div>` : "",
  ].join("") : `<p class="none">Nothing missed on this day.</p>`;
  const everyHtml = `<ul>${games.map(g => `<li>${esc(nick(g.away))} at ${esc(nick(g.home))}: the ${esc(nick(g.winner))} won. Leo gave the ${esc(nick(g.leoTeam))} ${pct(num(g.leo_prob))} &middot; ${g.won ? '<span class="ok">Right</span>' : '<span class="no">Wrong</span>'}</li>`).join("")}</ul>`;

  return `<details class="day"${open ? " open" : ""}><summary>${esc(longDate(date))}<span class="cnt">${games.length} ${games.length === 1 ? "game" : "games"} &middot; Leo&rsquo;s side ${rec(sideW, sideL)}${picks.length ? ` &middot; official picks ${rec(t.w, t.l)}, ${u(t.units)} units` : " &middot; no official picks"} &middot; season picks ${rec(running.w, running.l)}, ${u(running.units)} units after this day</span></summary><div class="day-body">
<h3>Upsets</h3>${upHtml}
<h3>What Leo got right</h3>${rightHtml}
<h3>What Leo missed and why</h3>${missHtml}
<h3>Every game</h3>${everyHtml}</div></details>`;
}

function build() {
  const { games, picks } = load();
  const frozen = picks.filter(p => p.status === "frozen" && (p.result === "W" || p.result === "L"));
  const late = picks.filter(p => p.status === "added_after_start" && (p.result === "W" || p.result === "L"));
  const gameByPk = new Map(games.map(g => [g.game_pk, g]));
  const ML = tally(frozen.filter(p => p.market === "moneyline")), KS = tally(frozen.filter(p => p.market !== "moneyline"));
  const sideW = games.filter(g => g.won).length, sideL = games.length - sideW;
  const ups = games.filter(g => g.upset), seen = ups.filter(g => g.won).length;

  // Reason tally by month and season.
  const keys = ["model_error", "variance", "starter", "bullpen", "starter_changed"];
  const months = [...new Set(games.map(g => g.date.slice(0, 7)))].sort();
  const count = (list, k) => list.filter(g => g.miss && g.miss.reason === k).length;
  const learnRows = keys.map(k => count(games, k) ? `<tr><td>${reasonTag(k)}<span class="small dim">${REASON_HELP[k]}</span></td>${months.map(m => `<td class="n">${count(games.filter(g => g.date.startsWith(m)), k)}</td>`).join("")}<td class="n">${count(games, k)}</td></tr>` : "").join("");
  const misses = games.filter(g => g.miss).length;
  const top = keys.map(k => [k, count(games, k)]).sort((a, b) => b[1] - a[1])[0];

  // Day blocks, newest first, with the running frozen record after each day.
  const dates = [...new Set([...games.map(g => g.date), ...frozen.map(p => p.date)])].sort();
  const run = { w: 0, l: 0, units: 0 }, after = {};
  for (const d of dates) { const t = tally(frozen.filter(p => p.date === d)); run.w += t.w; run.l += t.l; run.units += t.units; after[d] = { ...run }; }
  let body = "", curMonth = "";
  const latest = dates[dates.length - 1];
  for (const d of dates.slice().reverse()) {
    const m = d.slice(0, 7);
    if (m !== curMonth) {
      curMonth = m;
      const mg = games.filter(g => g.date.startsWith(m)), mt = tally(frozen.filter(p => p.date.startsWith(m)));
      const mw = mg.filter(g => g.won).length;
      body += `<div class="wk-head"><h2>${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}</h2><span class="cnt">${mg.length} games &middot; Leo&rsquo;s side ${rec(mw, mg.length - mw)} &middot; official picks ${rec(mt.w, mt.l)}, ${u(mt.units)} units</span></div>`;
    }
    body += dayBlock(d, games.filter(g => g.date === d), frozen.filter(p => p.date === d), gameByPk, after[d], d === latest);
  }

  const title = `MLB Results ${SEASON}: Leo's Record, Day by Day | Leo`;
  const desc = `Leo's ${SEASON} MLB record, day by day: official picks frozen before first pitch, the upsets, what Leo got right, and what Leo missed and why.`;
  const tile = (k, v, sub) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
${GA_HEAD}
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${ORIGIN}/results/">
<meta property="og:type" content="website"><meta property="og:site_name" content="Leo"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${ORIGIN}/results/"><meta property="og:image" content="${ORIGIN}/img/og-card.png"><meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/css/style.css">
<style>
.stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:16px 0}
.stat-row .card{padding:12px 14px}.stat-row .v{font-size:1.5rem;font-weight:800;font-variant-numeric:tabular-nums}
.stat-row .k{font-size:.66rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--text-dim)}.stat-row .s{font-size:.78rem;color:var(--text-dim)}
.ok{color:var(--good);font-weight:800}.no{color:var(--danger);font-weight:800}
.wk-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin:26px 0 8px;padding-bottom:7px;border-bottom:1.5px solid var(--border)}
.wk-head h2{font-size:1.25rem;margin:0}.wk-head .cnt{font-size:.82rem;color:var(--text-dim);font-variant-numeric:tabular-nums}
details.day{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;margin:0 0 10px}
details.day>summary{cursor:pointer;padding:12px 16px;font-weight:800;display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline}
details.day>summary .cnt{font-weight:500;font-size:.82rem;color:var(--text-dim);font-variant-numeric:tabular-nums}
.day-body{padding:2px 16px 14px}
.day-body h3{font-size:.72rem;font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:var(--text-dim);margin:16px 0 6px}
.day-body ul{margin:0;padding-left:18px;line-height:1.6;font-size:.9rem}.day-body .none{font-size:.88rem;color:var(--text-dim)}
.miss{border:1px solid var(--border);border-left:4px solid var(--border);border-radius:10px;padding:9px 13px;margin:0 0 8px;font-size:.9rem;line-height:1.55}
.miss.official{border-left-color:var(--danger)}.miss .t{font-weight:800}
.reason{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.7rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--border);background:var(--bg-elev);color:var(--text);white-space:nowrap;margin-right:6px}
.reason.r-model_error{border-color:var(--danger);color:var(--danger)}
.learn{padding:14px 16px;margin:12px 0 16px}.learn h2{font-size:1.05rem;margin:0 0 4px}
.learn table{width:100%;border-collapse:collapse;font-size:.88rem;margin-top:8px}
.learn th,.learn td{padding:6px 8px;border-bottom:1px solid var(--border);text-align:left}
.learn th{font-size:.68rem;text-transform:uppercase;letter-spacing:.08em;color:var(--text-dim)}.learn td.n{font-variant-numeric:tabular-nums;font-weight:700}
.tbl-wrap{overflow-x:auto}
</style>
</head>
<body>
<nav id="nav"></nav>
<main>
<p class="eyebrow">Every pick, graded against what actually happened.</p>
<h1>Leo&rsquo;s MLB record, ${SEASON}</h1>
<p class="subtitle">The ${SEASON} season, day by day: the record, the upsets, what Leo got right, and what Leo missed and why. A pick counts only if it was published before first pitch. Losses stay on the record.</p>
<div class="stat-row">
${tile("Moneyline picks", rec(ML.w, ML.l), `${u(ML.units)} units, 1 unit each`)}
${tile("Strikeout picks", rec(KS.w, KS.l), `${u(KS.units)} units, 1 unit each`)}
${tile("Leo&rsquo;s side, every game", rec(sideW, sideL), `${pct(sideW / games.length)} of ${games.length.toLocaleString("en-US")} games analyzed`)}
${tile("Upsets", `${ups.length}`, `market favorite lost; Leo saw ${seen}`)}
</div>
<div class="notice" style="margin-bottom:16px"><b>How this record is counted.</b> Only picks first published before the scheduled first pitch count. ${late.length} picks that were added to the card after a game had started (${rec(late.filter(p => p.result === "W").length, late.filter(p => p.result === "L").length)}) are left out, so this record is lower than the one this page showed during the season. Strikeout picks are retired for ${Number(SEASON) + 1}.</div>
<section class="card learn"><h2>What Leo learned</h2>
<p class="small dim" style="margin:0">Every game Leo&rsquo;s side lost gets one reason, taken from the season review. Across ${misses} losses the most common is <b>${REASON[top[0]]}</b> (${top[1]}). Only losses that are Leo&rsquo;s own error point to a model change, and changes are made one at a time, each backed by a backtest.</p>
<div class="tbl-wrap"><table><thead><tr><th>Why Leo&rsquo;s side lost</th>${months.map(m => `<th>${MONTHS[Number(m.slice(5)) - 1].slice(0, 3)}</th>`).join("")}<th>Season</th></tr></thead><tbody>${learnRows}</tbody></table></div></section>
${body}
<p class="dim small" style="margin-top:18px">The ${Number(SEASON) + 1} season starts ${NEXT_OPENING_DAY}. Until then, see <a href="/mlb/teams/">all 30 teams</a> and <a href="/mlb/matchups/">every MLB game page</a>. Leo&rsquo;s current records: <a href="/nfl/results/">NFL</a> and <a href="/nba/results/">NBA</a>.</p>
<div class="notice warn" style="margin-top:18px">For entertainment and informational purposes. Leo&rsquo;s picks are analysis, not betting advice, and no model can promise outcomes. 21+. If gambling stops being fun, call 1-800-MY-RESET.</div>
</main>
<footer id="footer"></footer><script src="/js/app.js"></script><script>renderNav("/results/"); renderFooter();</script>
</body>
</html>
`;
  fs.writeFileSync(path.join(ROOT, "results", "index.html"), html);
  console.log(`MLB results page: ${games.length} games, ${dates.length} days, moneyline ${rec(ML.w, ML.l)} ${u(ML.units)}u, strikeouts ${rec(KS.w, KS.l)} ${u(KS.units)}u, ${misses} losses, ${ups.length} upsets (${seen} seen), ${(html.length / 1024).toFixed(0)} KB`);
}
if (require.main === module) build();
module.exports = { build, reasonFor };
