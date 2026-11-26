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
  <h2 class="sec" id="h2h">${esc(A)} vs ${esc(H)} head to head</h2>
  <p class="sub">${list.length ? `${esc(A)} and ${esc(H)} since 2016, playoffs included: <b>${esc(lead)}</b>${R.t ? `, ${R.t} tied` : ""}, ${list.length} ${list.length === 1 ? "game" : "games"}.${m.div_game === "True" || m.div_game === "1" ? " Division rivals, so they meet twice a season." : ""}` : `No meetings since 2016.`}</p>
  <p class="sub" style="margin:6px 0 0"><a href="${require("../build-matchup-pages").matchupUrl("nfl", A, H)}">Every ${esc(A)} vs ${esc(H)} game Leo has read &rarr;</a></p>
  ${last5.length ? `<p class="sub" style="margin-top:8px">${list.length > 5 ? "The last 5 meetings:" : list.length === 1 ? "The meeting:" : "Every meeting:"}</p><ul class="h2h">${last5.map(meetLine).join("")}</ul>` : ""}
  <h2 class="sec" id="rest">${esc(A)} and ${esc(H)} rest and schedule</h2>
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


/*
  Competitor review (Lynold, 2026-11-25): one shareable "stat to know" line and
  a kickoff weather box for outdoor games, as Covers runs. Display only.
*/
function statToKnow(m) {
  const A = TEAMS.nick(m.away), H = TEAMS.nick(m.home);
  const list = meetings(m);
  // 1. A run in the series: the same winner in the last 3+ meetings.
  if (list.length >= 3) {
    const w = g => g.as === g.hs ? null : fr(g.as > g.hs ? g.away : g.home);
    const first = w(list[0]); let k = 0;
    while (first && k < list.length && w(list[k]) === first) k++;
    if (k >= 3) return `The ${TEAMS.nick(first)} have won the last ${k} meetings with the ${TEAMS.nick(first === m.home ? m.away : m.home)}${k === list.length ? `, every game since 2016` : ""}.`;
  }
  // 2. Rest: one side off the bye or on a short week and the other not.
  const ra = restOf(m, "away").rest, rh = restOf(m, "home").rest;
  if (ra != null && rh != null) {
    if (ra >= 13 && rh < 13) return `The ${A} come off their bye; the ${H} played ${rh} days ago.`;
    if (rh >= 13 && ra < 13) return `The ${H} come off their bye; the ${A} played ${ra} days ago.`;
    if (ra <= 5 && rh >= 7) return `The ${A} are on a short week: ${ra} days since their last game, against ${rh} for the ${H}.`;
    if (rh <= 5 && ra >= 7) return `The ${H} are on a short week: ${rh} days since their last game, against ${ra} for the ${A}.`;
  }
  // 3. The biggest gap in Leo's team ratings, if it is a real one.
  const R = m.ratings && m.ratings.this_season;
  if (R && R.away && R.home) {
    const parts = [["qb_rating", "quarterback play"], ["off_rating", "offense"], ["def_rating", "defense"]]
      .map(([k, label]) => ({ label, a: R.away[k], h: R.home[k] })).filter(x => x.a != null && x.h != null)
      .sort((x, y) => Math.abs(y.a - y.h) - Math.abs(x.a - x.h));
    const b = parts[0];
    if (b && Math.abs(b.a - b.h) >= 8) {
      const hi = b.a > b.h ? A : H, lo = b.a > b.h ? H : A;
      return `Leo rates the ${hi} ${b.label} ${Math.round(Math.max(b.a, b.h))} out of 100, the ${lo} ${Math.round(Math.min(b.a, b.h))}.`;
    }
  }
  return "";
}

// Open air stadiums only; a dome or a roof that may close gets no forecast.
const OPEN_AIR = {
  "Acrisure Stadium": [40.4468, -80.0158], "Bank of America Stadium": [35.2258, -80.8528], "Empower Field at Mile High": [39.7439, -105.0201],
  "Estadio Banorte": [19.3029, -99.1505], "EverBank Stadium": [30.3239, -81.6373], "GEHA Field at Arrowhead Stadium": [39.0489, -94.4839],
  "Gillette Stadium": [42.0909, -71.2643], "Hard Rock Stadium": [25.958, -80.2389], "Highmark Stadium": [42.7738, -78.787],
  "Huntington Bank Field": [41.5061, -81.6995], "Lambeau Field": [44.5013, -88.0622], "Levi's Stadium": [37.403, -121.9698],
  "Lincoln Financial Field": [39.9008, -75.1675], "Lumen Field": [47.5952, -122.3316], "M&T Bank Stadium": [39.278, -76.6227],
  "MetLife Stadium": [40.8135, -74.0745], "Nissan Stadium": [36.1665, -86.7713], "Northwest Stadium": [38.9078, -76.8645],
  "Paycor Stadium": [39.0955, -84.516], "Raymond James Stadium": [27.9759, -82.5033], "Soldier Field": [41.8623, -87.6167],
  "Tottenham Hotspur Stadium": [51.6043, -0.0664], "Wembley Stadium": [51.556, -0.2796]
};
const WCODE = c => c == null ? "" : c === 0 ? "Clear" : c <= 3 ? "Partly cloudy" : c <= 48 ? "Fog" : c <= 57 ? "Drizzle" : c <= 67 ? "Rain" : c <= 77 ? "Snow" : c <= 82 ? "Showers" : c <= 86 ? "Snow showers" : "Thunderstorms";

/** Forecast at kickoff from Open-Meteo (free, no key), for open air games up to 10 days out. Never throws. */
async function kickoffWeather(m) {
  try {
    const at = OPEN_AIR[m.stadium];
    if (!at || String(m.roof || "").toLowerCase() !== "outdoors" || m.final_report) return null;
    const [h] = String(m.kickoff || "").split(":").map(Number);
    if (!Number.isFinite(h)) return null;
    const days = (Date.parse(m.date + "T12:00:00Z") - Date.now()) / 864e5;
    if (days < -1 || days > 10) return null;
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${at[0]}&longitude=${at[1]}&hourly=temperature_2m,precipitation_probability,wind_speed_10m,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York&start_date=${m.date}&end_date=${m.date}`;
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(u, { signal: ctl.signal }).finally(() => clearTimeout(t));
    if (!r.ok) return null;
    const j = await r.json(), H = j.hourly || {};
    const i = (H.time || []).findIndex(x => Number(String(x).slice(11, 13)) === h);
    if (i < 0) return null;
    return { temp: Math.round(H.temperature_2m[i]), wind: Math.round(H.wind_speed_10m[i]), rain: H.precipitation_probability ? H.precipitation_probability[i] : null,
      sky: WCODE(H.weather_code && H.weather_code[i]), at: new Date().toISOString() };
  } catch (e) { return null; }
}

function weatherHtml(m) {
  const w = m.weather; if (!w) return "";
  const A = TEAMS.nick(m.away), H = TEAMS.nick(m.home);
  const note = w.wind >= 15 ? " Wind of 15 mph or more tends to cut into passing and kicking." : w.temp <= 32 ? " Freezing at kickoff." : "";
  return `
  <h2 class="sec" id="weather">${esc(A)} vs ${esc(H)} weather</h2>
  <p class="sub">Forecast for kickoff at ${esc(m.stadium)}, open air. Source: Open-Meteo, ${esc(new Date(w.at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))} ET. Leo's number does not use the weather.</p>
  <div class="mkt" style="margin:8px 0 0"><div class="box"><span class="lbl">Temperature</span><span class="val">${w.temp}&deg;F</span></div>
  <div class="box"><span class="lbl">Wind</span><span class="val">${w.wind} mph</span></div>
  ${w.rain != null ? `<div class="box"><span class="lbl">Chance of rain</span><span class="val">${w.rain}%</span></div>` : ""}
  ${w.sky ? `<div class="box"><span class="lbl">Sky</span><span class="val" style="font-size:1rem">${esc(w.sky)}</span></div>` : ""}</div>
  ${note ? `<p class="sub" style="margin-top:8px">${esc(note.trim())}</p>` : ""}`;
}

/** Points scored and allowed per game this season before the date, from games-lite (the analysis panel, 2026-11-25). */
function scoring(team, date) {
  const season = +String(date).slice(0, 4) - (+String(date).slice(5, 7) <= 2 ? 1 : 0);
  const gs = GAMES.filter(g => g.season === season && g.type === "REG" && final(g) && g.date < date && (fr(g.home) === team || fr(g.away) === team));
  if (!gs.length) return null;
  let f = 0, a = 0;
  for (const g of gs) { const home = fr(g.home) === team; f += home ? g.hs : g.as; a += home ? g.as : g.hs; }
  return { games: gs.length, pf: Math.round(f / gs.length * 10) / 10, pa: Math.round(a / gs.length * 10) / 10 };
}

module.exports = { scoring, h2hRest, faqItems, meetings, restOf, statToKnow, kickoffWeather, weatherHtml, OPEN_AIR };
