/**
 * More on every NFL game page (Lynold, 2026-11-24: "make the analysis page
 * better, make it content rich"): head to head, rest and schedule, and a
 * short FAQ with FAQPage markup. The team stat comparison was already on the
 * page. Display only: nothing here feeds Leo's numbers.
 *
 * Source: data/nfl/games-lite.json (scripts/build-nfl-games-lite.js, from
 * nflverse games.csv): every game since 2016 with scores and days of rest.
 */
const fs = require("fs");
const path = require("path");
const TEAMS = require("./nfl-teams");
const FILE = path.join(__dirname, "..", "..", "data", "nfl", "games-lite.json");
const GAMES = (() => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")).games; } catch (e) { return []; } })();

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Moved franchises keep one code across seasons.
const CODE = { OAK: "LV", SD: "LAC", STL: "LA" };
const fr = t => CODE[t] || t;
const nick = t => TEAMS.nick(fr(t));
const short = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const longD = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const final = g => g.as != null && g.hs != null;
const TYPE = { WC: "Wild Card", DIV: "Divisional round", CON: "Conference title game", SB: "Super Bowl" };
// Home-stated spread: positive = home favoured by that much.
const fav = (m, s) => s == null || s === "" || !Number.isFinite(+s) ? null : +s === 0 ? "Pick'em" : `${TEAMS.nick(+s > 0 ? m.home : m.away)} by ${Math.abs(+s)}`;
const favMk = (m, s) => s == null || s === "" || !Number.isFinite(+s) ? null : +s === 0 ? "Pick'em" : `${TEAMS.nick(+s > 0 ? m.home : m.away)} -${Math.abs(+s)}`;

function meetings(m) {
  const pair = g => (fr(g.home) === m.home && fr(g.away) === m.away) || (fr(g.home) === m.away && fr(g.away) === m.home);
  return GAMES.filter(g => pair(g) && final(g) && g.date < m.date).sort((a, b) => b.date.localeCompare(a.date));
}

function teamGames(t) { return GAMES.filter(g => fr(g.home) === t || fr(g.away) === t).sort((a, b) => a.date.localeCompare(b.date)); }

function restOf(m, side) {
  const t = m[side], season = +String(m.date).slice(0, 4) - (+String(m.date).slice(5, 7) <= 2 ? 1 : 0);
  const me = GAMES.find(g => g.id === m.game_id);
  const list = teamGames(t).filter(g => g.season === season);
  const prev = list.filter(g => g.date < m.date).pop() || null, next = list.find(g => g.date > m.date) || null;
  const rest = me ? (side === "home" ? me.hr : me.ar) : (prev ? Math.round((Date.parse(m.date) - Date.parse(prev.date)) / 864e5) : null);
  return { prev, next, rest };
}

function meetLine(g) {
  const tie = g.as === g.hs, aw = g.as > g.hs, W = nick(aw ? g.away : g.home), Lz = nick(aw ? g.home : g.away);
  const tag = g.type !== "REG" ? ` <span class="tag">${esc(TYPE[g.type] || "Playoffs")}</span>` : "";
  return `<li><span class="mut">${esc(short(g.date))}</span> ${tie ? `${esc(nick(g.away))} and ${esc(nick(g.home))} tied ${g.as}-${g.hs}`
    : `${esc(W)} beat the ${esc(Lz)} ${Math.max(g.as, g.hs)}-${Math.min(g.as, g.hs)}${g.ot ? " in overtime" : ""} ${aw ? "on the road" : "at home"}`}${tag}</li>`;
}

function record(list, m) {
  const w = t => list.filter(g => g.as !== g.hs && fr(g.as > g.hs ? g.away : g.home) === t).length;
  return { a: w(m.away), h: w(m.home), t: list.filter(g => g.as === g.hs).length };
}

function h2hRest(m) {
  const list = meetings(m), R = record(list, m), A = TEAMS.nick(m.away), H = TEAMS.nick(m.home);
  const lead = R.a === R.h ? `Even, ${R.a}-${R.h}` : `${R.a > R.h ? A : H} lead ${Math.max(R.a, R.h)}-${Math.min(R.a, R.h)}`;
  const last5 = list.slice(0, 5);
  const side = sd => {
    const t = m[sd], X = restOf(m, sd);
    if (!X.prev) return `<p class="mut">First game of the season.</p>`;
    const p = X.prev, home = fr(p.home) === t, us = home ? p.hs : p.as, them = home ? p.as : p.hs, opp = nick(home ? p.away : p.home);
    const res = final(p) ? `, ${us > them ? "won" : us < them ? "lost" : "tied"} ${Math.max(us, them)}-${Math.min(us, them)}` : "";
    const r = X.rest, tag = r == null ? "" : r >= 13 ? " Coming off the bye." : r <= 5 ? " Short week." : r >= 9 ? " Extra rest." : "";
    const nx = X.next ? `Next: ${fr(X.next.home) === t ? "vs" : "at"} ${esc(nick(fr(X.next.home) === t ? X.next.away : X.next.home))}, ${esc(short(X.next.date))}.` : "";
    return `<p><b>${r == null ? "" : `${r} days since the last game.`}</b>${esc(tag)}</p><p class="mut">Last game: ${home ? "vs" : "at"} ${esc(opp)}, Week ${p.week}${esc(res)}. ${nx}</p>`;
  };
  return `
  <h2 class="sec">Head to head</h2>
  <p class="sub">${list.length ? `${esc(A)} and ${esc(H)} since 2016, playoffs included: <b>${esc(lead)}</b>${R.t ? `, ${R.t} tied` : ""}, ${list.length} ${list.length === 1 ? "game" : "games"}.${m.div_game === "True" || m.div_game === "1" ? " Division rivals, so they meet twice a season." : ""}` : `No meetings since 2016.`}</p>
  ${last5.length ? `<p class="sub" style="margin-top:8px">${list.length > 5 ? "The last 5 meetings:" : list.length === 1 ? "The meeting:" : "Every meeting:"}</p><ul class="h2h">${last5.map(meetLine).join("")}</ul>` : ""}
  <h2 class="sec">Rest and schedule</h2>
  <p class="sub">Days between games. A short week is five days or fewer; ten or more is extra rest.</p>
  <div class="grid2"><div class="restbox"><b>${esc(TEAMS.full(m.away))}</b>${side("away")}</div><div class="restbox"><b>${esc(TEAMS.full(m.home))}</b>${side("home")}</div></div>
  <style>.h2h{margin:6px 0 0;padding-left:18px;line-height:1.7;font-size:.92rem}.h2h .mut{margin-right:4px}.restbox{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:12px 14px}.restbox p{margin:6px 0 0;font-size:.9rem;line-height:1.5}</style>`;
}

const kick = m => {
  const [h, mi] = String(m.kickoff || "").split(":").map(Number);
  if (!Number.isFinite(h)) return "";
  return `${((h + 11) % 12) + 1}:${String(mi || 0).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"} ET`;
};

/** [{ q, a }] in plain text, from the page's own numbers. */
function faqItems(m, topScorers) {
  const A = TEAMS.nick(m.away), H = TEAMS.nick(m.home), g = m.leo && m.leo.game, F = m.final_report, out = [];
  if (F && F.away_score != null) {
    const hw = F.home_score > F.away_score, tie = F.home_score === F.away_score;
    out.push({ q: `Who won ${A} vs ${H}?`, a: tie ? `They tied, ${F.away_score}-${F.home_score}.` : `The ${hw ? H : A} won, ${Math.max(F.home_score, F.away_score)} to ${Math.min(F.home_score, F.away_score)}.${g && g.pick && g.prob != null ? ` Leo had given the ${TEAMS.nick(g.pick)} a ${Math.round(g.prob * 100)}% chance before kickoff.` : ""}` });
  } else if (g && g.pick && g.prob != null) {
    const p = Math.round(g.prob * 100);
    out.push({ q: `Who will win ${A} vs ${H}?`, a: `Leo gives the ${TEAMS.nick(g.pick)} a ${p}% chance to win${fav(m, g.proj_spread) ? `, by about ${Math.abs(+g.proj_spread).toFixed(1)} points` : ""}. ${p < 55 ? "That is close to a coin flip." : p >= 70 ? `A clear favorite, but about 1 in ${Math.round(100 / (100 - p))} games like this goes the other way.` : "A lean, not a sure thing."}${m.leo.early ? " This is an early read; it updates until kickoff." : ""}` });
  }
  const mk = favMk(m, m.spread_line), lm = g ? fav(m, g.proj_spread) : null;
  if (mk || lm) out.push({ q: `What is the spread for ${A} vs ${H}?`, a: `${mk ? `The market has ${mk}.` : "No market spread yet."}${lm ? ` Leo's own expected margin is ${lm}, built from team ratings, the quarterbacks and injuries, never from the market.` : ""}` });
  const tl = m.total_line !== "" && m.total_line != null ? m.total_line : null;
  if (tl != null || (g && g.proj_total != null)) out.push({ q: `What is the over/under for ${A} vs ${H}?`, a: `${tl != null ? `The market total is ${tl}.` : ""}${g && g.proj_total != null ? ` Leo projects ${g.proj_total} points.` : ""}${g && g.calls && g.calls.total && g.calls.total.info ? " Leo's total is shown for information; Leo does not call totals." : ""}`.trim() });
  if (m.away_qb_name || m.home_qb_name) out.push({ q: `Who are the starting quarterbacks for ${A} vs ${H}?`, a: `${m.away_qb_name ? `${m.away_qb_name} for the ${A}` : `The ${A} starter is not listed yet`} and ${m.home_qb_name ? `${m.home_qb_name} for the ${H}` : `the ${H} starter is not listed yet`}, as of Leo's read.` });
  const I = m.injuries;
  if (I) {
    const outs = s => s.final ? s.listed.filter(x => x.status === "Out").map(x => `${x.player} (${x.pos})`) : [];
    const ao = outs(I.away), ho = outs(I.home);
    if (I.away.final || I.home.final) out.push({ q: `Who is out for ${A} vs ${H}?`, a: `${ao.length ? `${A}: ${ao.join(", ")}.` : `${A}: nobody ruled out.`} ${ho.length ? `${H}: ${ho.join(", ")}.` : `${H}: nobody ruled out.`} Doubtful and questionable players are on the injury report above.` });
  }
  const ts = typeof topScorers === "function" ? topScorers(m) : [];
  if (ts.length) out.push({ q: `Who will score a touchdown in ${A} vs ${H}?`, a: `Leo's two most likely scorers: ${ts.map(x => `${x.player} (${TEAMS.nick(x.team)}, ${Math.round(x.prob * 100)}%)`).join(" and ")}. Even the top name misses about half the time.` });
  const list = meetings(m);
  if (list.length) {
    const R = record(list, m), last = list[0], lw = last.as === last.hs ? null : nick(last.as > last.hs ? last.away : last.home);
    out.push({ q: `What is the ${A} vs ${H} head to head record?`, a: `Since 2016: ${A} ${R.a}, ${H} ${R.h}${R.t ? `, ${R.t} tied` : ""}. Last meeting: ${short(last.date)}, ${lw ? `${lw} won ${Math.max(last.as, last.hs)}-${Math.min(last.as, last.hs)}` : `a ${last.as}-${last.hs} tie`}.` });
  }
  out.push({ q: `When and where is ${A} vs ${H}?`, a: `${longD(m.date)}${kick(m) ? `, ${kick(m)}` : ""}${m.stadium ? `, at ${m.stadium}` : ""}. Week ${m.week}.` });
  return out;
}

module.exports = { h2hRest, faqItems, meetings, restOf };
