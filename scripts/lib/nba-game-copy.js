/**
 * Leo NBA game pages: the words that make each page its own (HO-0069 part B).
 *
 *   opening(g, { sched, lostCoef })      -> [sentence, ...]   two to four sentences only true of this game
 *   whatHappened(g, res, miss)           -> [sentence, ...]   after the final: score, Leo right or wrong, miss reason
 *   names(g)                             -> s => s with g.home / g.away codes written as nicknames
 *
 * Reads only what the card froze (leo.parts, leo.missing, leo.p_home, the
 * DraftKings line is never used here) plus finals already in
 * data/nba/schedule.json and the grader's miss label (data/nba/misses).
 * Every number is one the page already shows or the injury value Leo used;
 * nothing is recomputed. No dashes, no exclamation marks.
 */
const URLS = require("./nba-urls");
const WHY = require("./nba-why");

const f1 = x => (Math.round(Math.abs(x) * 10) / 10).toFixed(1);
const nk = (g, side) => URLS.nick(g[side], g[side + "_name"]);
const pct = p => Math.round(p * 100) + "%";
const shortDate = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

/** Replace the two team codes with nicknames in a sentence written by nba-why.js. */
function names(g) {
  const map = { [g.home]: nk(g, "home"), [g.away]: nk(g, "away") };
  const rx = new RegExp(`\\b(${[g.home, g.away].map(c => c.replace(/[^A-Z0-9]/g, "")).join("|")})\\b`, "g");
  return s => String(s || "").replace(rx, c => map[c] || c);
}

/** Finals before this game's date, from the season schedule. */
function finalsBefore(sched, date) {
  const out = [];
  for (const d of (sched && sched.days) || []) {
    if (d.date >= date) continue;
    for (const x of d.games || []) if (x.final && x.hs != null && x.as != null) out.push({ ...x, date: d.date });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || String(a.tip_utc).localeCompare(String(b.tip_utc)));
}

function lastThree(g, side, finals) {
  const t = g[side], name = nk(g, side);
  const gs = finals.filter(x => x.home === t || x.away === t).slice(-3).reverse();   // most recent first
  if (!gs.length) return "";
  const w = gs.map(x => {
    const home = x.home === t, us = home ? x.hs : x.as, them = home ? x.as : x.hs;
    const opp = URLS.nick(home ? x.away : x.home, home ? x.away_name : x.home_name);
    return `${us > them ? "beat" : "lost to"} the ${opp} ${Math.max(us, them)} to ${Math.min(us, them)}${home ? " at home" : " on the road"}`;
  });
  const wins = gs.filter(x => (x.home === t ? x.hs > x.as : x.as > x.hs)).length;
  return `The ${name} are ${wins} and ${gs.length - wins} in their last ${["", "game", "two", "three"][gs.length]}${gs.length > 1 ? ", most recent first" : ""}: they ${w.length > 1 ? w.slice(0, -1).join(", ") + " and " + w[w.length - 1] : w[0]}.`;
}

function lastMeeting(g, finals) {
  const m = finals.filter(x => (x.home === g.home && x.away === g.away) || (x.home === g.away && x.away === g.home)).pop();
  if (!m) return `This is the first meeting between the ${nk(g, "away")} and the ${nk(g, "home")} this season.`;
  const win = m.hs > m.as ? m.home : m.away, hi = Math.max(m.hs, m.as), lo = Math.min(m.hs, m.as);
  const wName = win === g.home ? nk(g, "home") : nk(g, "away"), lName = win === g.home ? nk(g, "away") : nk(g, "home");
  const where = m.home === win ? "at home" : "on the road";
  return `They last met on ${shortDate(m.date)}, when the ${wName} beat the ${lName} ${hi} to ${lo} ${where}.`;
}

const DRIVER = {
  ratings: (g, d, fav, dog) => `the ${fav} rate ${f1(d.pts)} points better than the ${dog} on results so far`,
  home_court: (g, d) => `home court, worth ${f1(d.pts)} points to the ${nk(g, "home")}`,
  missing_players: (g, d) => `injuries: the ${d.pts > 0 ? nk(g, "away") : nk(g, "home")} are missing more, worth ${f1(d.pts)} points to the ${d.pts > 0 ? nk(g, "home") : nk(g, "away")}`,
  back_to_back: (g, d) => `the back to back, worth ${f1(d.pts)} points to the ${d.pts > 0 ? nk(g, "home") : nk(g, "away")}`,
  rest: (g, d) => `rest, worth ${f1(d.pts)} points to the ${d.pts > 0 ? nk(g, "home") : nk(g, "away")}`
};

/** The one counted player whose absence moves Leo's number most, or null. */
function topInjury(g, lostCoef) {
  let best = null;
  for (const side of ["home", "away"]) for (const p of ((g.leo.missing || {})[side] || [])) {
    const pts = (p.value || 0) * (p.weight ?? 1) * lostCoef;
    if (!best || pts > best.pts) best = { side, p, pts };
  }
  return best && best.pts >= 0.3 ? best : null;
}

function opening(g, o = {}) {
  const L = g.leo || {}, P = L.parts || {}, lostCoef = Math.abs(o.lostCoef ?? 0.2209);
  if (L.p_home == null || L.home_margin == null) return [];
  const homeFav = L.p_home >= 0.5, fs = homeFav ? "home" : "away", ds = homeFav ? "away" : "home";
  const fav = nk(g, fs), dog = nk(g, ds), chance = homeFav ? L.p_home : L.p_away;
  const shown = WHY.leoLine(g), m = Math.abs(shown == null ? L.home_margin : shown);   // the number the page shows
  const out = [];
  const where = fs === "home" ? `at home against the ${dog}` : `on the road at the ${dog}`;
  // Biggest driver of Leo's number, by size, with the team it helps.
  const drivers = Object.entries(P).filter(([k, v]) => DRIVER[k] && v != null && Math.abs(v) >= 0.5)
    .map(([key, pts]) => ({ key, pts })).sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts));
  const d = drivers[0];
  const dTxt = d ? DRIVER[d.key](g, d, d.pts > 0 ? nk(g, "home") : nk(g, "away"), d.pts > 0 ? nk(g, "away") : nk(g, "home")) : "";
  const helps = d && ((d.pts > 0) === (fs === "home"));
  out.push(m === 0
    ? `Leo sees the ${nk(g, "away")} at the ${nk(g, "home")} as close to even, ${pct(L.p_home)} for the ${nk(g, "home")}.`
    : `Leo gives the ${fav} ${/^(8|11|18)/.test(pct(chance)) ? "an" : "a"} ${pct(chance)} chance ${where} and has them winning by ${m % 1 ? m.toFixed(1) : m} points.`);
  if (d) out.push(helps || m === 0
    ? `The biggest reason${d.key === "ratings" ? " is that" : " is"} ${dTxt}.`
    : `The biggest single factor, ${dTxt}, points the other way, and the rest of Leo's inputs outweigh it.`);
  const ti = topInjury(g, lostCoef);
  if (ti) {
    const p = ti.p, st = p.status === "day-to-day" ? `day to day, counted at ${Math.round((p.weight ?? 1) * 100)}%` : p.status || "out";
    out.push(`The injury that moves Leo's number most is ${p.name} of the ${nk(g, ti.side)} (${st}${p.detail ? ", " + String(p.detail).toLowerCase() : ""}), worth about ${f1(ti.pts)} points.`);
  } else out.push(`Neither the ${nk(g, "away")} nor the ${nk(g, "home")} had a regular on the injury report when Leo made the read.`);
  out.push(null);   // the render splits here: the read first, then form and the last meeting
  const finals = finalsBefore(o.sched, g.date);
  for (const side of ["away", "home"]) { const s = lastThree(g, side, finals); if (s) out.push(s); }
  out.push(lastMeeting(g, finals));
  return out;
}

function whatHappened(g, res, miss) {
  if (!res) return [];
  const H = nk(g, "home"), A = nk(g, "away"), hw = res.home_score > res.away_score;
  const winN = hw ? H : A, loseN = hw ? A : H, hi = Math.max(res.home_score, res.away_score), lo = Math.min(res.home_score, res.away_score);
  const leoN = res.leo_p_home >= 0.5 ? H : A;
  const out = [`The ${winN} beat the ${loseN} ${hi} to ${lo}${miss && miss.overtime ? " in overtime" : ""}.`];
  out.push(res.leo_winner_correct ? `Leo had the ${leoN} and was right.` : `Leo had the ${leoN} and was wrong.`);
  const ms = miss && miss.miss;
  if (ms && ms.label) out.push(`Why it counts as a miss: ${ms.label.toLowerCase()}. ${names(g)(ms.evidence || "")}`.trim());
  else if (miss) out.push(`Not a miss: Leo's margin was within 10 points of the result.`);
  return out;
}

module.exports = { opening, whatHappened, names, finalsBefore };
