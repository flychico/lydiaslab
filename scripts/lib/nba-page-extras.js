/**
 * More on every NBA game page (Lynold, 2026-11-24: "make the analysis page
 * better, make it content rich"): a team stat comparison, head to head and
 * rest, and a short FAQ with FAQPage markup. Display only: nothing here feeds
 * Leo's numbers, and the sportsbook line is shown as the market, never an input.
 *
 * Sources, all already in the repo:
 *   data/nba/team-stats.json          record, home and road, last 10, pace, ratings
 *   scripts/lib/nba-team-analysis.js  shooting from the saved ESPN box scores
 *   data/nba/schedule.json            this season's finals and the schedule (rest)
 *   data/nba/last-season-games.json   last season's finals (scripts/build-nba-last-season.js)
 */
const fs = require("fs");
const path = require("path");
const URLS = require("./nba-urls");
const WHY = require("./nba-why");
const PKS = require("./nba-picks");
const DIR = path.join(__dirname, "..", "..", "data", "nba");

const load = f => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch (e) { return null; } };
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const STATS = load("team-stats.json");
const SCHED = load("schedule.json");
const LAST = load("last-season-games.json");
let ANALYSIS;
const analysis = () => {
  if (ANALYSIS === undefined) { try { ANALYSIS = require("./nba-team-analysis").build(); } catch (e) { ANALYSIS = null; } }
  return ANALYSIS;
};

const day = d => Date.parse(d + "T12:00:00Z") / 864e5;
const short = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const longD = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const f1 = x => x == null || !Number.isFinite(+x) ? "&mdash;" : (+x).toFixed(1);
const pc = x => x == null || !Number.isFinite(+x) ? "&mdash;" : (x * 100).toFixed(1) + "%";
const rec = r => r ? `${r.w}-${r.l}` : "&mdash;";
const sg = x => x == null ? "&mdash;" : (x > 0 ? "+" : "") + (+x).toFixed(1);
const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");

/** League rank of a team on one number, 1 = best. */
function rank(team, key, higherBetter = true) {
  const rows = ((STATS && STATS.teams) || []).filter(t => t[key] != null);
  const me = rows.find(t => t.team === team); if (!me) return null;
  return 1 + rows.filter(t => higherBetter ? t[key] > me[key] : t[key] < me[key]).length;
}
const teamRow = ab => ((STATS && STATS.teams) || []).find(t => t.team === ab) || null;

/* ---------- Team stat comparison ---------- */

function statTable(g) {
  const A = teamRow(g.away), H = teamRow(g.home);
  if (!A || !H) return "";
  const an = analysis(), As = an && an.teams[g.away] && an.teams[g.away].shooting, Hs = an && an.teams[g.home] && an.teams[g.home].shooting;
  const NA = esc(URLS.nick(g.away, g.away_name)), NH = esc(URLS.nick(g.home, g.home_name));
  // lead: which side the cell favours (higher or lower is better), shown in bold.
  const row = (label, a, h, fmt, higherBetter = true, note = "") => {
    const ok = a != null && h != null && a !== h, aw = ok && (higherBetter ? a > h : a < h);
    return `<tr><td class="${ok && aw ? "lead" : ""}">${fmt(a)}</td><th>${label}${note ? `<span>${note}</span>` : ""}</th><td class="${ok && !aw ? "lead" : ""}">${fmt(h)}</td></tr>`;
  };
  const txt = (a, h, label) => `<tr><td>${a}</td><th>${label}</th><td>${h}</td></tr>`;
  const rk = (ab, key, hb) => { const r = rank(ab, key, hb); return r ? ord(r) : "&mdash;"; };
  const through = STATS.data_through ? short(STATS.data_through) : "";
  return `<h2 id="stats">${NA} vs ${NH} team stats</h2>
  <p class="dim">${NA} left, ${NH} right. This season through ${esc(through)}; the better number is in bold. Ratings are points per 100 possessions.</p>
  <div class="card tbl"><table class="cmp">
    <thead><tr><th>${NA}</th><th></th><th>${NH}</th></tr></thead><tbody>
    ${txt(`<b>${rec(A)}</b>`, `<b>${rec(H)}</b>`, "Record")}
    ${txt(rec(A.away), rec(H.home), `Road / home<span>${NA} on the road, ${NH} at home</span>`)}
    ${txt(rec(A.last10), rec(H.last10), "Last 10")}
    ${txt(esc(A.streak || ""), esc(H.streak || ""), "Streak")}
    ${row("Points scored", A.ppg, H.ppg, f1)}
    ${row("Points allowed", A.opp_ppg, H.opp_ppg, f1, false)}
    ${row("Average margin", A.margin, H.margin, sg)}
    ${row("Offensive rating", A.off_rtg, H.off_rtg, f1, true, `${rk(g.away, "off_rtg", true)} and ${rk(g.home, "off_rtg", true)} in the league`)}
    ${row("Defensive rating", A.def_rtg, H.def_rtg, f1, false, `${rk(g.away, "def_rtg", false)} and ${rk(g.home, "def_rtg", false)}, lower is better`)}
    ${txt(f1(A.pace), f1(H.pace), `Pace<span>possessions per 48 minutes</span>`)}
    ${As && Hs ? `
    ${row("Field goal %", As.fg, Hs.fg, pc)}
    ${row("Three point %", As.three, Hs.three, pc)}
    ${row("Threes made per game", As.threes, Hs.threes, f1)}
    ${row("Free throw %", As.ft, Hs.ft, pc)}
    ${row("Rebounds per game", As.reb, Hs.reb, f1)}
    ${row("Assists per game", As.ast, Hs.ast, f1)}
    ${row("Turnovers per game", As.tov, Hs.tov, f1, false)}` : ""}
    ${txt(sg(A.leo_rating) + (A.leo_rank ? ` <span class="dim">(${ord(A.leo_rank)})</span>` : ""), sg(H.leo_rating) + (H.leo_rank ? ` <span class="dim">(${ord(H.leo_rank)})</span>` : ""), `Leo rating<span>points better than an average team</span>`)}
  </tbody></table></div>
  <p class="dim">${statLine(g, A, H)} <a href="/nba/stats/">Every team&rsquo;s stats</a></p>`;
}

/** One plain sentence on where the matchup tilts, from the table. */
function statLine(g, A, H) {
  const NA = URLS.nick(g.away, g.away_name), NH = URLS.nick(g.home, g.home_name);
  const bits = [];
  if (A.off_rtg != null && H.def_rtg != null) {
    const ro = rank(g.away, "off_rtg", true), rd = rank(g.home, "def_rtg", false);
    if (ro && rd) bits.push(`The ${NA} offense ranks ${ord(ro)} and meets the ${ord(rd)} ranked ${NH} defense.`);
  }
  if (A.pace != null && H.pace != null && Math.abs(A.pace - H.pace) >= 2)
    bits.push(`The ${A.pace > H.pace ? NA : NH} play faster, by ${Math.abs(A.pace - H.pace).toFixed(1)} possessions a game, so watch who sets the tempo.`);
  return esc(bits.join(" "));
}

/* ---------- Head to head and rest ---------- */

function seasonFinals() {
  const out = [];
  for (const d of (SCHED && SCHED.days) || []) for (const x of d.games) if (x.final && x.hs != null) out.push({ date: d.date, home: x.home, away: x.away, hs: x.hs, as: x.as });
  return out;
}
let FINALS;
const finals = () => FINALS || (FINALS = seasonFinals());

function meetings(g) {
  const pair = x => (x.home === g.home && x.away === g.away) || (x.home === g.away && x.away === g.home);
  return {
    now: finals().filter(x => pair(x) && x.date < g.date),
    last: ((LAST && LAST.games) || []).filter(pair),
    lastSeason: LAST && LAST.season,
  };
}

function restOf(team, date) {
  const all = [];
  for (const d of (SCHED && SCHED.days) || []) for (const x of d.games) if (x.home === team || x.away === team) all.push({ date: d.date, ...x });
  const before = all.filter(x => x.date < date), after = all.filter(x => x.date > date);
  const prev = before[before.length - 1] || null, next = after[0] || null;
  const week = before.filter(x => day(date) - day(x.date) <= 7).length;
  return { prev, next, rest: prev ? day(date) - day(prev.date) - 1 : null, week, b2bNext: next ? day(next.date) - day(date) === 1 : false };
}

function meetLine(x) {
  const aw = x.as > x.hs, W = URLS.nick(aw ? x.away : x.home), Lz = URLS.nick(aw ? x.home : x.away);
  const yr = new Date(x.date + "T12:00:00Z").getUTCFullYear();
  return `<li><span class="dim">${esc(short(x.date))}, ${yr}</span> ${esc(W)} beat the ${esc(Lz)} ${Math.max(x.hs, x.as)}-${Math.min(x.hs, x.as)} ${aw ? "on the road" : "at home"}</li>`;
}

function h2hRest(g) {
  const M = meetings(g), NA = URLS.nick(g.away, g.away_name), NH = URLS.nick(g.home, g.home_name);
  const wins = (list, ab) => list.filter(x => (x.home === ab ? x.hs > x.as : x.as > x.hs)).length;
  const sum = (list, label) => {
    if (!list.length) return `<p class="dim">No meetings ${label}.</p>`;
    const a = wins(list, g.away), h = list.length - a;
    return `<p><b>${a === h ? `Split ${a}-${h}` : `${esc(a > h ? NA : NH)} ${Math.max(a, h)}-${Math.min(a, h)}`}</b> ${label}</p><ul class="last5">${list.map(x => meetLine(x)).join("")}</ul>`;
  };
  const side = ab => {
    const R = restOf(ab, g.date), nm = esc(URLS.nick(ab));
    if (!R.prev) return `<p class="dim">First game of the season.</p>`;
    const p = R.prev, home = p.home === ab, opp = URLS.nick(home ? p.away : p.home);
    const res = p.final && p.hs != null ? (() => { const us = home ? p.hs : p.as, them = home ? p.as : p.hs; return `, ${us > them ? "won" : "lost"} ${Math.max(us, them)}-${Math.min(us, them)}`; })() : "";
    const restTxt = R.rest === 0 ? "<b>Second night of a back to back.</b>" : `<b>${R.rest} ${R.rest === 1 ? "day" : "days"} of rest.</b>`;
    const nx = R.next ? `Next: ${R.next.home === ab ? "vs" : "at"} ${esc(URLS.nick(R.next.home === ab ? R.next.away : R.next.home))}, ${esc(short(R.next.date))}${R.b2bNext ? " (back to back)" : ""}.` : "";
    return `<p>${restTxt}</p><p class="dim">Last game: ${home ? "vs" : "at"} ${esc(opp)}, ${esc(short(p.date))}${esc(res)}. ${R.week} ${R.week === 1 ? "game" : "games"} in the last 7 days. ${nx}</p>`;
  };
  return `<h2 id="h2h">${esc(URLS.nick(g.away, g.away_name))} vs ${esc(URLS.nick(g.home, g.home_name))} head to head</h2>
  <p class="dim" style="margin:0 0 8px"><a href="${require("../build-matchup-pages").matchupUrl("nba", URLS.nick(g.away, g.away_name), URLS.nick(g.home, g.home_name))}">Every ${esc(URLS.nick(g.away, g.away_name))} vs ${esc(URLS.nick(g.home, g.home_name))} game Leo has read &rarr;</a></p>
  <div class="two"><div><b>This season</b>${sum(M.now, "this season")}</div><div><b>Last season</b>${M.lastSeason ? sum(M.last, "last season") : `<p class="dim">Not loaded.</p>`}</div></div>
  <h2 id="rest">${esc(URLS.nick(g.away, g.away_name))} and ${esc(URLS.nick(g.home, g.home_name))} rest and schedule</h2>
  <p class="dim">Days off before this game. Leo counts rest and back to backs in its number (see What moves Leo&rsquo;s number).</p>
  <div class="two"><div><b>${esc(g.away_name)}</b>${side(g.away)}</div><div><b>${esc(g.home_name)}</b>${side(g.home)}</div></div>`;
}

/* ---------- FAQ ---------- */

const tipTxt = iso => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";

/** [{ q, a }] in plain text. Answers come from the page's own numbers. */
function faqItems(g, res) {
  const L = g.leo || {}, mk = g.market || {}, NA = URLS.nick(g.away, g.away_name), NH = URLS.nick(g.home, g.home_name);
  const lbl = c => URLS.nick(c, c === g.home ? g.home_name : g.away_name);
  const fav = L.p_home >= 0.5 ? NH : NA, fp = Math.round(Math.max(L.p_home, 1 - L.p_home) * 100);
  const P = WHY.projScore(g), LS = WHY.leoLine(g);
  const out = [];
  if (res) {
    const hw = res.home_score > res.away_score;
    out.push({ q: `Who won ${NA} vs ${NH}?`, a: `The ${hw ? NH : NA} won, ${Math.max(res.home_score, res.away_score)} to ${Math.min(res.home_score, res.away_score)}, on ${longD(g.date)}. Leo had given the ${fav} a ${fp}% chance before the game.` });
  } else if (L.p_home != null) {
    out.push({ q: `Who will win ${NA} vs ${NH}?`, a: `Leo gives the ${fav} a ${fp}% chance to win${P ? `, with a projected score of ${NA} ${P.away}, ${NH} ${P.home}` : ""}. ${fp < 55 ? "That is close to a coin flip." : fp >= 70 ? "That is a clear favorite, but about 1 in " + Math.round(100 / (100 - fp)) + " games like this goes the other way." : "A lean, not a sure thing."}` });
  }
  if (mk.home_spread != null || LS != null) {
    const m = mk.home_spread != null ? WHY.favLine(g, mk.home_spread, lbl) : null, l = LS != null ? WHY.favLine(g, LS, lbl) : null;
    out.push({ q: `What is the spread for ${NA} vs ${NH}?`, a: `${m ? `DraftKings has ${m}.` : "No market spread yet."} ${l ? `Leo's own number is ${l}, worked out from team ratings, home court, rest and injuries, never from the market.` : ""}`.trim() });
  }
  if (mk.total != null || (P && P.total)) out.push({ q: `What is the over/under for ${NA} vs ${NH}?`, a: `${mk.total != null ? `The DraftKings total is ${mk.total}.` : ""} ${P && P.total ? `Leo projects ${P.total} points. Leo's total is for information only; Leo does not make total picks.` : ""}`.trim() });
  const outList = side => ((g.context && g.context[side] && g.context[side].injuries) || []).filter(p => p.status === "out").map(p => p.name);
  const ao = outList("away"), ho = outList("home");
  out.push({ q: `Who is injured for ${NA} vs ${NH}?`, a: `As of Leo's read: ${ao.length ? `the ${NA} are without ${ao.join(", ")}` : `the ${NA} list nobody out`}; ${ho.length ? `the ${NH} are without ${ho.join(", ")}` : `the ${NH} list nobody out`}. Day to day players are on the injury report above.` });
  const M = meetings(g), w = (list, ab) => list.filter(x => (x.home === ab ? x.hs > x.as : x.as > x.hs)).length;
  if (M.now.length || M.last.length) {
    const parts = [];
    if (M.now.length) parts.push(`This season: ${NA} ${w(M.now, g.away)}, ${NH} ${w(M.now, g.home)}.`);
    if (M.last.length) parts.push(`Last season: ${NA} ${w(M.last, g.away)}, ${NH} ${w(M.last, g.home)}.`);
    out.push({ q: `How have the ${NA} and ${NH} done against each other?`, a: parts.join(" ") });
  }
  if (g.tip_utc) out.push({ q: `When and where is ${NA} vs ${NH}?`, a: `${longD(g.date)}, ${tipTxt(g.tip_utc)}${g.venue ? `, at ${g.venue}` : ""}.` });
  const PT = PKS.pickText(g);
  if (PT) out.push({ q: `Does Leo have a pick on ${NA} vs ${NH}?`, a: require("./nba-game-copy").names(g)(PT.line) });
  return out;
}


/* One shareable line (competitor review, Lynold 2026-11-25): a back to back,
   a run of wins or losses, or a one-sided series. Display only. */
function statToKnow(g) {
  const nm = ab => URLS.nick(ab, ab === g.home ? g.home_name : g.away_name);
  const ra = restOf(g.away, g.date), rh = restOf(g.home, g.date);
  if (ra.rest === 0 && rh.rest > 0) return `The ${nm(g.away)} play the second night of a back to back; the ${nm(g.home)} had ${rh.rest} ${rh.rest === 1 ? "day" : "days"} off.`;
  if (rh.rest === 0 && ra.rest > 0) return `The ${nm(g.home)} play the second night of a back to back; the ${nm(g.away)} had ${ra.rest} ${ra.rest === 1 ? "day" : "days"} off.`;
  for (const side of ["away", "home"]) {
    const f = g.context && g.context[side] && g.context[side].form, l5 = f && f.last5 || [];
    if (l5.length === 5 && l5.every(x => x.won)) return `The ${nm(g[side])} have won their last 5 games.`;
    if (l5.length === 5 && l5.every(x => !x.won)) return `The ${nm(g[side])} have lost their last 5 games.`;
  }
  const M = meetings(g), all = [...M.now].sort((a, b) => b.date.localeCompare(a.date)).concat([...M.last].sort((a, b) => b.date.localeCompare(a.date)));
  const w = x => x.hs > x.as ? x.home : x.away;
  if (all.length >= 3) { const f = w(all[0]); let k = 0; while (k < all.length && w(all[k]) === f) k++;
    if (k >= 3) return `The ${nm(f)} have won the last ${k} meetings with the ${nm(f === g.home ? g.away : g.home)}.`; }
  return "";
}

module.exports = { statTable, h2hRest, faqItems, restOf, meetings, statToKnow };
