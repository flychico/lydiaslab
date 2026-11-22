#!/usr/bin/env node
/**
 * Leo's NFL weekly card: one page with every game of a week.
 *
 *   /nfl/week/                      the current week (latest week with data)
 *   /nfl/week/<season>-week-<n>/    a permanent page per week
 *
 *   node scripts/generate-nfl-week-card.js [YYYY-MM-DD]
 *
 * Built only from data/nfl/matchups/<date>.json (the frozen pre-kickoff reads
 * the matchup pages show) and data/nfl/tracker.json (the graded record), so it
 * can never show a number the game pages do not. render-nfl-matchup-pages.js
 * calls build() after every render, which keeps it current through the
 * prepare, publish and grade runs without a workflow change.
 *
 * Per game: kickoff, Leo's win chance (information only; winner picks were
 * retired 2026-10-17), Leo's projected total, the two most likely touchdown
 * scorers, and the final score once it is in.
 */
const fs = require("fs"), path = require("path");
// Thanksgiving 2026 (SEO-26 part A, OD-06, Lynold Nov 19 and Nov 22): until the first Thanksgiving kickoff the free
// card box on every Week 12 page says the free list gets the full member brief on Thursday. Pages re-rendered after
// the kickoff go back to the usual copy by themselves.
const TG_UNTIL = Date.parse("2026-11-26T18:00:00Z");   // Bears at Lions, 1:00pm ET
const isThanksgivingWeek = (season, week) => +season === 2026 && +week === 12 && Date.now() < TG_UNTIL;
const TG_BOX = {
  head: "Free on Thanksgiving: the full member brief",
  line: "Join the free list and on Thursday you get the brief Leo members receive: every call on the Thanksgiving games, the reasoning and the inputs behind it. After that, the free card before every slate.",
  thanks: "You are on the list. Thursday&rsquo;s brief arrives before the first kickoff."
};
const ROOT = path.join(__dirname, "..");
const TEAMS = require("./lib/nfl-teams");
const { GA_HEAD } = require("./lib/ga");

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = p => p == null ? "" : `${Math.round(p * 100)}%`;
function clock(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  if (!Number.isFinite(h)) return "";
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, "0")}${h < 12 ? "am" : "pm"} ET`;
}
const dayLabel = d => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

function loadWeek(targetDate) {
  const dir = path.join(ROOT, "data/nfl/matchups");
  const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const read = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { return []; } };
  const target = read(`${targetDate}.json`);
  if (!target.length) return null;
  const week = String(target[0].week), season = targetDate.slice(0, 4);
  // Same season: September to February.
  const sameSeason = f => { const d = f.slice(0, 10); const y = +d.slice(0, 4), mo = +d.slice(5, 7);
    const s = mo >= 3 ? y : y - 1; return String(s) === (+targetDate.slice(5, 7) >= 3 ? season : String(+season - 1)); };
  const games = [], prev = [];
  const byWeek = new Map();   // week -> { dates, graded, early }
  let latestWeek = 0;
  for (const f of files.filter(sameSeason)) {
    for (const m of read(f)) {
      // SEO-18 (DEC-20261107-51): early reads for next week do not make it
      // "the latest week", so /nfl/week/ keeps the week still being played.
      if (!(m.leo && m.leo.early)) latestWeek = Math.max(latestWeek, Number(m.week) || 0);
      const w = Number(m.week) || 0, e = byWeek.get(w) || { dates: new Set(), all: 0, graded: 0 };
      e.dates.add(m.date); e.all++; if (m.final_report && m.final_report.home_score != null) e.graded++;
      byWeek.set(w, e);
      if (String(m.week) === week) games.push(m);
      if (Number(m.week) === Number(week) - 1) prev.push(m);
    }
  }
  games.sort((a, b) => a.date.localeCompare(b.date) || String(a.kickoff).localeCompare(String(b.kickoff)));
  const seasonYear = +targetDate.slice(5, 7) >= 3 ? season : String(+season - 1);
  const early = games.some(m => m.leo && m.leo.early);
  // SEO-19 (DEC-20261110-50): /nfl/week/ moves to the next week as soon as
  // the latest frozen week is fully graded (normally Tuesday, after Monday
  // night) and the next week's early reads exist; until then it stays on the
  // week being played. latestWeek (the SEO-12 guard) is unchanged.
  const lw = byWeek.get(latestWeek), nx = byWeek.get(latestWeek + 1);
  const currentWeek = latestWeek && lw && lw.graded === lw.all && nx ? latestWeek + 1 : latestWeek;
  const cur = byWeek.get(currentWeek);
  const currentDate = cur ? [...cur.dates].sort()[0] : null;
  return { week, season: seasonYear, games, prev, latestWeek, currentWeek, currentDate, early, isLatest: Number(week) === Number(currentWeek) };
}

function record() {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(ROOT, "data/nfl/tracker.json"), "utf8"));
    const s = t.summary || {}, v2 = s.moneyline_v2 || s.moneyline, pr = s.props && s.props.all;
    return { v2, props: pr, through: t.through };
  } catch (e) { return null; }
}

// HO-0073 (DEC-20261115-50): each game is a card like the NFL card email
// (scripts/lib/email-cards.js look): team colour stripe, logos, win chance
// bar, the three calls with their result once graded, one sentence of why,
// starting quarterbacks and a button to the game page.
const CALLS = require("./lib/nfl-calls");
const COPY = require("./lib/nfl-page-copy");
const { NFL_COLORS, pairColors } = require("./lib/email-cards");
let REVIEW = null;
function reviewGame(m) {
  if (REVIEW === null) { try { REVIEW = JSON.parse(fs.readFileSync(path.join(ROOT, "data/nfl/results-review.json"), "utf8")); } catch (e) { REVIEW = false; } }
  return REVIEW ? REVIEW.games.find(x => x.date === m.date && x.away === m.away && x.home === m.home) || null : null;
}
const nickify = (m, t) => String(t == null ? "" : t).replace(new RegExp(`\\b(${m.away}|${m.home})\\b`, "g"), a => TEAMS.nick(a));
function callsOf(m) {
  const g = m.leo && m.leo.game;
  if (!g || m.date < CALLS.RULES.FROM) return null;
  return CALLS.current(g.calls || CALLS.calls({ ...g, away: m.away, home: m.home, model_prob: g.prob }), g);
}
const MK = { ml: "Moneyline", spread: "Spread", total: "Total" };
function gameCard(m) {
  const g = m.leo && m.leo.game, F = m.final_report;
  const final = F && F.away_score != null && F.home_score != null;
  const [ac, hc] = pairColors(NFL_COLORS, m.away, m.home);
  const pHome = g && g.prob != null ? (g.pick === m.home ? g.prob : 1 - g.prob) : null;
  const C = callsOf(m), R = final ? reviewGame(m) : null;
  const res = mk => { const c = R && R.three && (R.calls || []).find(x => x.market === mk); return c ? c.result : null; };
  const tag = r => r === "W" ? '<span class="wc-tag ok">Won</span>' : r === "L" ? '<span class="wc-tag no">Lost</span>' : r === "P" ? '<span class="wc-tag">Push</span>' : "";
  const box = mk => {
    const c = C && C[mk];
    if (!c) return `<div class="wc-box"><span class="wc-k">${MK[mk]}</span><b>n/a</b></div>`;
    // Totals are information only (DEC-20261119-01): Leo's number, never a call.
    if (c.info) return `<div class="wc-box"><span class="wc-k">Leo&rsquo;s total</span><b>${c.proj != null ? esc(String(c.proj)) : "n/a"}</b><span class="wc-s">${c.line != null ? "line " + esc(String(c.line)) + ", " : ""}information</span></div>`;
    const r = c.call ? res(mk) : null;
    return `<div class="wc-box${c.call ? " on" : ""}${r === "W" ? " win" : r === "L" ? " loss" : ""}"><span class="wc-k">${MK[mk]}</span><b>${c.call ? esc(nickify(m, c.label)) : "No call"}</b><span class="wc-s">${c.call ? tag(r) : esc(nickify(m, c.short || c.pass || ""))}</span></div>`;
  };
  const side = t => {
    const p = pHome == null ? null : (t === m.home ? pHome : 1 - pHome);
    const qb = t === m.home ? m.home_qb_name : m.away_qb_name;
    const score = final ? (t === m.home ? F.home_score : F.away_score) : null;
    const won = final && score > (t === m.home ? F.away_score : F.home_score);
    return `<div class="wc-team"><img src="/img/nfl/${encodeURIComponent(t)}.png" alt="" loading="lazy" width="34" height="34">
      <div class="wc-name"><b>${esc(TEAMS.full(t))}</b>${qb ? `<span>QB ${esc(qb)}</span>` : ""}</div>
      <div class="wc-num">${final ? `<b class="${won ? "" : "dim"}">${score}</b>` : ""}${p != null ? `<span>${final ? "Leo " : ""}${pct(p)}</span>` : ""}</div></div>`;
  };
  const badge = final ? '<span class="wc-badge">Final</span>' : m.leo && m.leo.early ? '<span class="wc-badge">Early read</span>'
    : C ? `<span class="wc-badge${C.count ? " on" : ""}">${C.count ? `${C.count} call${C.count === 1 ? "" : "s"}` : "No calls"}</span>` : "";
  const why = g ? COPY.biggestDriver(m) : "";
  const miss = R && R.miss ? ` Why Leo missed: ${({ injury_input: "injury input", market_knew: "the market knew", overtime: "overtime", blowout: "blowout", variance: "variance", model_error: "Leo's error" })[R.miss.reason] || R.miss.reason}.` : "";
  return `<article class="wc">
    <div class="wc-stripe" style="background:linear-gradient(90deg,${ac} 0 50%,${hc} 50% 100%)"></div>
    <div class="wc-top"><span>${esc(dayLabel(m.date))} &middot; ${esc(clock(m.kickoff))}${m.stadium ? " &middot; " + esc(m.stadium) : ""}</span>${badge}</div>
    ${side(m.away)}
    ${side(m.home)}
    ${pHome != null ? `<div class="wc-bar" role="img" aria-label="Leo win chance: ${esc(TEAMS.nick(m.away))} ${pct(1 - pHome)}, ${esc(TEAMS.nick(m.home))} ${pct(pHome)}"><i style="width:${Math.round((1 - pHome) * 100)}%;background:${ac}"></i><i style="width:${100 - Math.round((1 - pHome) * 100)}%;background:${hc}"></i></div>` : '<p class="dim small">No pre-game read yet.</p>'}
    ${C ? `<div class="wc-boxes">${box("ml")}${box("spread")}${box("total")}</div>` : ""}
    ${why || miss ? `<p class="wc-why">${esc(why)}${esc(miss)}</p>` : ""}
    <a class="btn wc-btn" href="${esc(m.url)}">Full game page &rarr;</a>
  </article>`;
}

// "This week's calls": counts this week, results so far, and the season
// record since Nov 2 from data/nfl/results-review.json with its early read label.
function callsSummary(games) {
  const n = Object.fromEntries(CALLS.MARKETS.map(k => [k, 0])), so = { w: 0, l: 0, p: 0 };
  for (const m of games) {
    const C = callsOf(m); if (!C) continue;
    for (const k of Object.keys(n)) if (C[k] && C[k].call) n[k]++;
    const R = reviewGame(m);
    if (R && R.three) for (const c of R.calls || []) c.result === "W" ? so.w++ : c.result === "L" ? so.l++ : c.result === "P" && so.p++;
  }
  if (!Object.values(n).reduce((a, b) => a + b, 0) && !games.some(m => callsOf(m))) return "";
  reviewGame({});
  const T = REVIEW && REVIEW.three;
  const rec = t => `${t.w}-${t.l}${t.p ? `-${t.p}` : ""}`;
  const u = v => (v > 0 ? "+" : v < 0 ? "-" : "") + Math.abs(v).toFixed(2) + "u";
  const season = T ? CALLS.MARKETS.map(k => { const t = T[k], c = t.w + t.l + t.p; return `<div class="wc-tile"><span class="wc-k">${MK[k]}</span><b>${n[k]}</b><span>${n[k] === 1 ? "call" : "calls"}</span><span class="dim">${rec(t)}, ${u(t.units)}</span></div>`; }).join("") : "";
  const counted = T ? CALLS.MARKETS.map(k => T[k].w + T[k].l + T[k].p) : [];
  const early = counted.some(c => c < 50) ? ` Early read: ${counted.every(c => c < 50) ? "each" : "some"} under 50 graded calls.` : "";
  const done = so.w + so.l + so.p;
  return `<section class="card wc-sum">
    <h2 class="sec" style="margin-top:0">This week&rsquo;s calls</h2>
    <div class="wc-tiles">${season}</div>
    ${T ? `<p class="small dim" style="margin:8px 0 0">Calls this week, and each record since Nov 2.${early}</p>` : ""}
    ${done ? `<p class="small" style="margin:10px 0 0">Graded so far this week: <b>${rec(so)}</b>. <a href="/nfl/results/">Leo&rsquo;s record</a></p>` : `<p class="small dim" style="margin:10px 0 0"><a href="/nfl/how-leo-works/#calls">How calls work</a></p>`}
  </section>`;
}

// SEO-16 (2026-11-02): each week gets its own written intro and an anytime
// touchdown scorer table, so the page is not the same text every week. Built
// only from the frozen game records; no dashes or exclamation marks.
const pausedDate = d => d >= "2026-10-17" && d <= "2026-10-31";
const nameOf = (m, t) => TEAMS.nick(t);
const longDay = d => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const aPct = p => { const n = Math.round(p * 100); return `${(String(n).startsWith("8") || n === 11 || n === 18) ? "an" : "a"} ${n}%`; };
function readRecord(games) {
  // Leo picks (above 60%) from Nov 1; winner reads in the paused weeks.
  // A week that touches the paused days counts every winner read, so the
  // whole week is counted one way.
  let w = 0, l = 0;
  const paused = games.some(m => pausedDate(m.date));
  for (const m of games) {
    const g = m.leo && m.leo.game, F = m.final_report;
    if (!g || !F || F.home_score == null || F.home_score === F.away_score) continue;
    if (!paused && (m.date >= CALLS.RULES.FROM ? !(g.calls && g.calls.ml && g.calls.ml.call) : g.call !== "leo_pick")) continue;
    const won = (F.home_score > F.away_score ? m.home : m.away) === g.pick;
    won ? w++ : l++;
  }
  return w + l ? { w, l, label: paused ? "winner reads" : games.some(m => m.date >= CALLS.RULES.FROM) ? "moneyline calls" : "picks" } : null;
}
function intro({ week, season, games, prev }) {
  const read = games.filter(m => m.leo && m.leo.game && m.leo.game.prob != null);
  const out = [];
  const days = [...new Set(games.map(m => m.date))].sort();
  out.push(`Week ${week} of the ${season} NFL season has ${games.length} game${games.length === 1 ? "" : "s"}${days.length > 1 ? `, from ${longDay(days[0])} to ${longDay(days[days.length - 1])}` : days.length ? `, on ${longDay(days[0])}` : ""}.`);
  if (read.length) {
    const top = [...read].sort((a, b) => b.leo.game.prob - a.leo.game.prob)[0], tg = top.leo.game;
    const opp = tg.pick === top.home ? top.away : top.home;
    out.push(`Leo's strongest read is the ${TEAMS.nick(tg.pick)} over the ${TEAMS.nick(opp)} at ${Math.round(tg.prob * 100)}%.`);
    const close = [...read].sort((a, b) => a.leo.game.prob - b.leo.game.prob)[0];
    if (close !== top) out.push(`The closest game is the ${TEAMS.nick(close.away)} at the ${TEAMS.nick(close.home)}, where Leo gives the ${TEAMS.nick(close.leo.game.pick)} ${Math.round(close.leo.game.prob * 100)}%.`);
    const calls = read.filter(m => m.date >= CALLS.RULES.FROM && m.leo.game.calls && m.leo.game.calls.ml && m.leo.game.calls.ml.call).length;
    if (read.some(m => m.date >= CALLS.RULES.FROM)) out.push(`${calls === 0 ? "No game has" : calls + " game" + (calls === 1 ? " has" : "s have")} a moneyline call, a team above 60% at a price better than -230.`);
    const tot = read.filter(m => m.leo.game.proj_total != null).sort((a, b) => b.leo.game.proj_total - a.leo.game.proj_total);
    if (tot.length > 1) out.push(`Leo's highest projected total is the ${TEAMS.nick(tot[0].away)} at the ${TEAMS.nick(tot[0].home)} at ${tot[0].leo.game.proj_total} points, and the lowest is the ${TEAMS.nick(tot[tot.length - 1].away)} at the ${TEAMS.nick(tot[tot.length - 1].home)} at ${tot[tot.length - 1].leo.game.proj_total}.`);
  }
  const td = tdRows(games)[0];
  if (td) out.push(`The most likely touchdown scorer this week is ${td.player} of the ${TEAMS.nick(td.team)} (${Math.round(td.prob * 100)}%).`);
  const now = readRecord(games), last = readRecord(prev || []);
  if (now) out.push(`So far this week Leo's ${now.label} are ${now.w}-${now.l}.`);
  if (last) out.push(`Last week (Week ${Number(week) - 1}) Leo's ${last.label} went ${last.w}-${last.l}.`);
  return out.join(" ");
}
function tdRows(games) {
  const rows = [];
  for (const m of games) for (const t of Object.keys(m.td_props || {})) for (const p of m.td_props[t] || []) {
    if (p && p.prob != null) rows.push({ ...p, team: p.team || t, m });
  }
  return rows.sort((a, b) => b.prob - a.prob);
}
function tdTable({ week, games }) {
  const rows = tdRows(games).slice(0, 15);
  if (!rows.length) return "";
  const res = r => { const s = r.m.final_report && r.m.final_report.td_scored; if (!s) return ""; return (s[r.player] || 0) > 0 ? '<span class="ok">scored</span>' : '<span class="no">no TD</span>'; };
  return `
  <details class="wk-more"><summary>Week ${esc(week)} anytime touchdown scorer predictions</summary>
  <p class="sub">The 15 players Leo gives the best chance to score a touchdown this week, from the frozen pre-game read. Chances, not promises; each game page has its own table.</p>
  <div class="fxw"><table class="fx"><thead><tr><th>Player</th><th>Game</th><th>Leo chance</th><th>Result</th></tr></thead><tbody>
${rows.map(r => `    <tr><td><b>${esc(r.player)}</b> <span class="dim">${esc(r.team)} ${esc(r.depth || "")}</span></td><td><a href="${esc(r.m.url)}">${esc(TEAMS.nick(r.m.away))} at ${esc(TEAMS.nick(r.m.home))}</a></td><td>${Math.round(r.prob * 100)}%</td><td>${res(r)}</td></tr>`).join("\n")}
  </tbody></table></div></details>`;
}

function slateLine(games) {
  const days = [...new Set(games.map(m => m.date))].sort(), f = games[0];
  return `${games.length} game${games.length === 1 ? "" : "s"}${days.length > 1 ? `, ${dayLabel(days[0])} to ${dayLabel(days[days.length - 1])}` : `, ${dayLabel(days[0])}`}. First kickoff ${dayLabel(f.date)} at ${clock(f.kickoff)}.`;
}
function page({ week, season, games, prev, early }, rec, canonical) {
  const title = `NFL Week ${week} Predictions ${season}: Win Chances, Spreads and Graded Calls | Leo`;
  const desc = `Leo's full Week ${week} NFL card: win chances, spreads, totals and the likeliest touchdown scorers for all ${games.length} games, plus the graded record. Every number frozen before kickoff.`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
${GA_HEAD}
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="https://ndhorizon.com${canonical}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Leo">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="https://ndhorizon.com${canonical}">
<meta property="og:image" content="https://ndhorizon.com/img/leo-card.png">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>&#127944;</text></svg>">
<link rel="stylesheet" href="/css/style.css">
<link rel="stylesheet" href="/css/scoreboard.css">
<style>
.wc-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px;margin-top:16px}
.wc{background:var(--bg-card);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-sm);overflow:hidden;display:flex;flex-direction:column;gap:10px;padding:0 16px 16px}
.wc-stripe{height:5px;margin:0 -16px}
.wc-top{display:flex;justify-content:space-between;align-items:center;gap:8px;color:var(--text-dim);font-size:.74rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.wc-badge{flex:none;border:1px solid var(--border);border-radius:999px;padding:2px 9px;font-size:.7rem}.wc-badge.on{border-color:var(--good);color:var(--good)}
.wc-team{display:grid;grid-template-columns:34px 1fr auto;gap:10px;align-items:center}
.wc-team img{width:34px;height:34px;object-fit:contain}
.wc-name{display:flex;flex-direction:column;min-width:0}.wc-name b{font-size:1rem;line-height:1.2}.wc-name span{color:var(--text-dim);font-size:.78rem}
.wc-num{text-align:right;display:flex;flex-direction:column;align-items:flex-end}.wc-num b{font-size:1.25rem}.wc-num span{font-weight:800;font-size:.95rem}
.wc-bar{display:flex;height:8px;border-radius:999px;overflow:hidden;background:var(--border)}.wc-bar i{display:block;height:100%}
.wc-boxes{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.wc-box{border:1px solid var(--border);border-radius:12px;padding:8px;display:flex;flex-direction:column;gap:2px;min-width:0}
.wc-box b{font-size:.92rem;overflow-wrap:anywhere}.wc-box.on{border-color:var(--good)}.wc-box.win{background:rgba(46,125,50,.08)}.wc-box.loss{border-color:var(--danger);background:rgba(198,40,40,.06)}
.wc-k{color:var(--text-dim);font-size:.66rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em}
.wc-s{color:var(--text-dim);font-size:.74rem;line-height:1.3}
.wc-tag{font-weight:800}.wc-tag.ok{color:var(--good)}.wc-tag.no{color:var(--danger)}
.wc-why{margin:0;font-size:.9rem;line-height:1.5}
.wc-btn{align-self:stretch;text-align:center;margin-top:auto}
.wc-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.wc-tile{border:1px solid var(--border);border-radius:12px;padding:10px;display:flex;flex-direction:column;gap:2px;font-size:.8rem}.wc-tile b{font-size:1.4rem}
.ok{color:var(--good);font-weight:800}.no{color:var(--danger);font-weight:800}.dim{color:var(--text-dim)}
.wk-rec{margin:8px 0 0}
details.wk-more{margin-top:24px}details.wk-more summary{cursor:pointer;font-weight:800}
.fxw{overflow-x:auto}.fx{width:100%;border-collapse:collapse;font-size:.9rem}.fx th,.fx td{padding:7px 8px;border-bottom:1px solid var(--border);text-align:left}.fx th{font-size:.74rem;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim)}
.nfl-signup{display:grid;grid-template-columns:1.2fr 1fr;gap:14px;align-items:center;background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:16px 18px;margin:4px 0 16px;box-shadow:var(--shadow-sm)}
.nfl-signup p{margin:4px 0 0;color:var(--text-dim);font-size:.86rem}
.nfl-signup form{display:flex;gap:8px}.nfl-signup input[type=email]{flex:1;min-width:0}
@media (max-width:640px){.nfl-signup{grid-template-columns:1fr}.wc-list{grid-template-columns:1fr}.wc-tile{padding:8px}}
</style>
</head>
<body>
<nav id="nav"></nav>
<main class="scoreboard-shell">
  <section class="score-hero">
    <p class="eyebrow">NFL ${esc(season)} &middot; Week ${esc(week)}</p>
    <h1>Leo&rsquo;s Week ${esc(week)} card</h1>
    <p class="subtitle">${esc(slateLine(games))}</p>
    ${early ? `<p class="wk-rec small">Games marked Early read update every morning; the last read before kickoff is the one graded.</p>` : ""}
  </section>

  <div class="nfl-signup">
    ${isThanksgivingWeek(season, week)
      ? `<div><b>${TG_BOX.head}</b><p>${TG_BOX.line}</p></div>
    <form class="lydia-signup-form" data-list="free-preview" data-thanks="${TG_BOX.thanks}">`
      : `<div><b>Get Leo&rsquo;s card before every slate</b><p>Free by email: Leo&rsquo;s calls for every NFL and NBA game before kickoff or tip, graded the next morning.</p></div>
    <form class="lydia-signup-form" data-list="free-preview" data-thanks="You are on the list. The next card arrives before the next slate.">`}
      <input type="email" name="email" required placeholder="you@email.com" aria-label="Email address">
      <input type="hidden" name="bot-field">
      <button class="btn blue" type="submit">Send me the free card</button>
    </form>
  </div>

${callsSummary(games)}

  <section class="wc-list">
${games.map(gameCard).join("\n")}
  </section>

  <section class="card" style="margin-top:18px"><h2 class="sec" style="margin-top:0">Week ${esc(week)} at a glance</h2><p style="margin:0">${esc(intro({ week, season, games, prev }))}</p></section>

${tdTable({ week, games })}

  <p class="small dim" style="margin-top:14px"><a href="/nfl/how-leo-works/">How Leo works</a>: what each number means, when it freezes and how calls are graded.</p>
  <p class="data-note">Player and team statistics from the open nflverse dataset. For entertainment and information only. 21+. If you or someone you know has a gambling problem, call 1-800-MY-RESET.</p>
</main>
<footer id="footer"></footer><script src="/js/app.js"></script>
<script>renderNav("/nfl/scoreboard/"); renderFooter();</script>
</body>
</html>`;
}

// opts.permalinkOnly (early reads, SEO-18): write /nfl/week/<season>-week-N/
// only, never /nfl/week/index.html.
function build(targetDate, opts = {}) {
  const wk = loadWeek(targetDate);
  if (!wk || !wk.games.length) { console.log(`  week card: no matchup data for ${targetDate}`); return null; }
  const rec = record();
  const slug = `${wk.season}-week-${wk.week}`;
  const dir = path.join(ROOT, "nfl/week", slug);
  // SEO-12 (2026-11-02): only the current week and the week just finished
  // are ever rewritten, the finished one only while it has ungraded games.
  // Rerunning an old date rewrote that week with today's
  // record and labels, changing what was published at the time.
  const exists = fs.existsSync(path.join(dir, "index.html"));
  const pending = wk.games.some(m => !(m.final_report && m.final_report.home_score != null));
  // opts.force: a rule change that must reach finished weeks too (DEC-20261119-01: the total record left the site).
  if (!opts.force && exists && (Number(wk.week) < Number(wk.latestWeek) - 1 || (Number(wk.week) < Number(wk.latestWeek) && !pending))) {
    console.log(`  week card: Week ${wk.week} is a past week, left as published`);
    return slug;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), page(wk, rec, `/nfl/week/${slug}/`));
  // /nfl/week/ is the same page as this week's permalink, so it points search
  // engines at the permalink (one URL per week ranks; no duplicate).
  // Early runs (opts.permalinkOnly) write /nfl/week/ only when their week is
  // the current week under SEO-19, i.e. the week before is fully graded.
  const main = wk.isLatest;
  if (main) fs.writeFileSync(path.join(ROOT, "nfl/week/index.html"), page(wk, rec, `/nfl/week/${slug}/`));
  console.log(`  week card: Week ${wk.week} (${wk.games.length} games) -> /nfl/week/${slug}/${main ? " and /nfl/week/" : ""}`);
  // The grade run that finishes a week re-renders that week, not the next:
  // write the current week's card too, so /nfl/week/ switches right then.
  if (!main && !opts.nested && wk.currentDate && Number(wk.currentWeek) > Number(wk.week)) build(wk.currentDate, { nested: true });
  return slug;
}

if (require.main === module) {
  build(process.argv[2] || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }), { force: process.argv.includes("--force") });
}
module.exports = { build };
