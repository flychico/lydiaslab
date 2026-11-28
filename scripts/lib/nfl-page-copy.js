/*
  Written copy for NFL game pages (SEO-14, 2026-11-02).

  The NFL pages were mostly tables. Search results for "Eagles vs Commanders
  prediction" are won by pages that explain the game in sentences, and the
  NBA pages already do this ("Why Leo has BOS by 3.5"). This writes:
    summary(m)  an opening paragraph: Leo's winner and chance, the total and
                margin beside the posted lines, the calls, the most likely
                touchdown scorers and the starting quarterbacks; plus the
                result once the game is final
    why(m)      "Why Leo has X": how many points of win chance home field,
                the quarterbacks, the offenses and the defenses each added,
                split exactly from the moneyline model's frozen inputs; who
                is out; and a note when the win chance and the margin (two
                separate models) do not agree
  Every sentence is built from the game's frozen record in
  data/nfl/matchups/<date>.json, so the words can never disagree with the
  numbers on the page. Display only: reads the record, changes nothing.
  Public copy rule: no dashes, no exclamation marks.
*/
"use strict";
const TEAMS = require("./nfl-teams");

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = p => `${Math.round(p * 100)}%`;
const r1 = x => Math.round(x * 10) / 10;
const city = abbr => TEAMS.nick(abbr);   // nicknames, since two teams can share a city

// HO-0086: when the quarterback in Leo's read is not the one who started the
// team's last game, say so, so readers see why the number looks the way it
// does. Starts = games he led the team in pass attempts, from the weekly stats.
function qbChangeLine(m, side) {
  const c = m.sides && m.sides[side] && m.sides[side].qb_change;
  if (!c || !c.starter) return "";
  const nick = city(m[side]);
  const earlier = (c.earlier || []).map(x => `${x.name} (${x.starts} ${x.starts === 1 ? "start" : "starts"})`);
  let out = `${c.starter} starts for the ${nick} in Leo's read, in place of ${c.last_starter}, who started their last game.`;
  if (earlier.length) out += ` ${nick} starters this season: ${list(earlier)}.`;
  out += ` The injury report lists only weekly game statuses, so a quarterback on injured reserve or out long term does not appear on it.`;
  return out;
}
const aPct = p => { const n = Math.round(p * 100); return `${/^(8|11|18)/.test(String(n)) && (n < 100) && (String(n).startsWith("8") || n === 11 || n === 18) ? "an" : "a"} ${n}%`; };
const the = abbr => `the ${TEAMS.full(abbr)}`;
const longDate = d => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
const pickPaused = d => d >= "2026-10-17" && d <= "2026-10-31";

function partOfDay(m) {
  const h = Number(String(m.kickoff || "").split(":")[0]);
  if (!Number.isFinite(h)) return m.weekday || "";
  return `${m.weekday || ""} ${h >= 19 ? "night" : h >= 12 ? "afternoon" : "morning"}`.trim();
}
// A home-stated line or margin as "Commanders by 6" / "Commanders -6".
function byTeam(m, x) { if (x == null) return null; if (x === 0) return "even"; return `${TEAMS.nick(x > 0 ? m.home : m.away)} by ${r1(Math.abs(x))}`; }
function lineTeam(m, x) { if (x == null) return null; if (x === 0) return "a pick'em"; return `${TEAMS.nick(x > 0 ? m.home : m.away)} ${"−"}${Math.abs(x)}`; }
const nickLabel = (m, t) => String(t || "").replace(new RegExp(`\\b(${m.away}|${m.home})\\b`, "g"), a => TEAMS.nick(a));
function list(a) { return a.length <= 1 ? (a[0] || "") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }

function topTd(m, n) {
  const all = [];
  for (const k of Object.keys(m.td_props || {})) for (const p of m.td_props[k] || []) if (p && p.prob != null) all.push(p);
  return all.sort((a, b) => b.prob - a.prob).slice(0, n);
}

function finalSentence(m) {
  const F = m.final_report, g = m.leo && m.leo.game;
  if (!F || F.home_score == null) return "";
  const hs = F.home_score, as = F.away_score;
  const win = hs === as ? null : (hs > as ? m.home : m.away), lose = win === m.home ? m.away : m.home;
  const score = win ? `${city(win)} ${Math.max(hs, as)}, ${city(lose)} ${Math.min(hs, as)}` : `${city(m.away)} ${as}, ${city(m.home)} ${hs}`;
  const out = [`Final: ${score}${F.overtime ? " in overtime" : ""}.`];
  if (g && g.pick && g.prob != null && win) out.push(`Leo gave ${the(g.pick)} ${aPct(g.prob)} chance, so the winner read was ${g.pick === win ? "right" : "wrong"}.`);
  if (g && g.proj_total != null) out.push(`The ${city(m.away)} and ${city(m.home)} combined for ${hs + as} points against Leo's ${g.proj_total}${m.total_line != null ? ` and the posted ${m.total_line}` : ""}.`);
  const C = g && g.calls;
  if (C) {
    const graded = [];
    const res = (key, c) => {
      if (!c || !c.call) return null;
      if (key === "ml") return hs === as ? "push" : ((hs > as ? m.home : m.away) === c.call ? "right" : "wrong");
      if (key === "spread") { const l = +g.spread_line, mg = hs - as; return mg === l ? "push" : ((c.call === m.home) === (mg > l) ? "right" : "wrong"); }
      const l = +g.total_line, t = hs + as; return t === l ? "push" : ((t > l) === (c.call === "Over") ? "right" : "wrong");
    };
    for (const [key, name] of [["ml", "moneyline"], ["spread", "spread"], ["total", "total"]]) {
      const c = C[key], r = res(key, c);
      if (r) graded.push(`${name} ${nickLabel(m, c.label)} ${r}`);
    }
    if (graded.length) out.push(`Leo's calls: ${list(graded)}.`);
  }
  const scored = Object.entries(F.td_scored || {}).filter(([, n]) => n > 0).map(([p, n]) => n > 1 ? `${p} (${n})` : p);
  if (scored.length) out.push(`Touchdowns: ${list(scored.slice(0, 8))}.`);
  return out.join(" ");
}

// Under the analysis panel (Lynold, 2026-11-25: the summary repeated the panel): only what the panel
// does not say. Recent form, the last meeting, the biggest absence, the total, touchdown chances, quarterbacks.
function shortSummary(m) {
  const g = m.leo && m.leo.game, out = [];
  const fa = form(m.away, m.date), fh = form(m.home, m.date);
  if (fa) out.push(fa); if (fh) out.push(fh);
  const lm = lastMeeting(m); if (lm) out.push(lm);
  const ab = biggestAbsence(m); if (ab) out.push(ab);
  const rest = [];
  if (g && g.proj_total != null) rest.push(`Leo projects ${g.proj_total} total points${m.total_line != null ? ` against a posted total of ${m.total_line}` : ""}; the total is shown for information, not called.`);
  const td = topTd(m, 2);
  if (td.length) rest.push(`The players Leo thinks are most likely to score a touchdown: ${list(td.map(p => `${p.player} (${pct(p.prob)})`))}.`);
  if (m.away_qb_name && m.home_qb_name) rest.push(`Starting quarterbacks: ${m.away_qb_name} for the ${city(m.away)} and ${m.home_qb_name} for the ${city(m.home)}.`);
  for (const side of ["away", "home"]) { const q = qbChangeLine(m, side); if (q) rest.push(q); }
  if (!out.length && !rest.length) return "";
  return `<section class="card summary">${out.length ? `
  <p style="margin:0 0 10px">${esc(out.join(" "))}</p>` : ""}${rest.length ? `
  <p style="margin:0">${esc(rest.join(" "))}</p>` : ""}
</section>`;
}

function summary(m, o = {}) {
  const g = m.leo && m.leo.game;
  if (o.short) return shortSummary(m);
  const parts = [];
  if (g && g.pick && g.prob != null) {
    const opp = g.pick === m.home ? m.away : m.home;
    const venue = m.stadium ? ` at ${m.stadium}` : "";
    parts.push(`Leo gives ${the(g.pick)} ${aPct(g.prob)} chance to beat ${the(opp)} on ${partOfDay(m)}, ${longDate(m.date)},${venue}${m.week ? `, in Week ${m.week}` : ""}.`);
    // Three calls (DEC-20261102-01): the moneyline call also needs a price better than -230.
    if (g.calls) parts.push(g.calls.ml.call ? "That is above 60% at a price better than -230, so the moneyline is a call." : g.prob > 0.60 ? "That is above 60%, but the price is past the -230 limit, so the moneyline is a PASS." : "Neither team is above 60%, so the moneyline is a PASS.");
    else if (!pickPaused(m.date)) parts.push(g.call === "leo_pick" ? "That is above 60%, so it counts as a Leo pick." : "Neither team is above 60%, so Leo calls it too close to call.");
    const tot = g.proj_total != null ? `Leo projects ${g.proj_total} total points${m.total_line != null ? ` (posted total ${m.total_line})` : ""}` : "";
    const mar = g.proj_spread != null ? `expects ${byTeam(m, g.proj_spread) === "even" ? "an even game" : "the " + byTeam(m, g.proj_spread)}${m.spread_line != null ? ` (posted spread ${lineTeam(m, m.spread_line)})` : ""}` : "";
    if (tot || mar) parts.push(`${tot}${tot && mar ? " and " : ""}${tot ? mar : mar.charAt(0).toUpperCase() + mar.slice(1)}.`);
    const C = g.calls;
    if (C) {
      // Lynold (Nov 15): "PASS" read as jargon; say what Leo called and which markets have no call.
      const mk = [["moneyline", C.ml], ["spread", C.spread], ["total", C.total]].filter(([, x]) => x && !x.info);   // totals are information only (DEC-20261119-01)
      const on = mk.filter(([, x]) => x.call).map(([k, x]) => `${k} ${nickLabel(m, x.label)}`);
      const off = mk.filter(([, x]) => !x.call).map(([k]) => k);
      if (on.length) parts.push(`Leo's calls: ${list(on)}${off.length ? `; no call on the ${list(off)}` : ""}.`);
      else if (off.length) parts.push(`Leo makes no call on this game.`);
    }
  } else {
    parts.push(`${TEAMS.full(m.away)} at ${TEAMS.full(m.home)} on ${partOfDay(m)}, ${longDate(m.date)}${m.stadium ? ` at ${m.stadium}` : ""}.`);
  }
  const td = topTd(m, 2);
  if (td.length) parts.push(`The players Leo thinks are most likely to score a touchdown: ${list(td.map(p => `${p.player} (${pct(p.prob)})`))}.`);
  if (m.away_qb_name && m.home_qb_name) parts.push(`Starting quarterbacks: ${m.away_qb_name} for the ${city(m.away)} and ${m.home_qb_name} for the ${city(m.home)}.`);
  for (const side of ["away", "home"]) { const q = qbChangeLine(m, side); if (q) parts.push(q); }
  const open = opening(m);
  return `<section class="card summary">${open.length ? `
  <p style="margin:0 0 10px">${esc(open.join(" "))}</p>` : ""}
  <p style="margin:0">${esc(parts.join(" "))}</p>
</section>`;
}

// The moneyline model (leo-nflml-v2) is a logistic fit on three home-minus-
// away inputs: quarterback, offense and defense (scripts/lib/nfl-moneyline.js,
// data/nfl/moneyline-v2-model.json). Its frozen inputs for every game are in
// data/nfl/ml-inputs-history.csv. Splitting the log-odds into home field and
// the three inputs says exactly how much each moved Leo's win chance. If the
// saved inputs do not reproduce the published chance (model retrained, row
// missing), no numbers are shown.
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..", "..");
let MODEL = null, INPUTS = null;
function loadModel() {
  if (MODEL === null) { try { MODEL = JSON.parse(fs.readFileSync(path.join(ROOT, "data/nfl/moneyline-v2-model.json"), "utf8")); } catch (e) { MODEL = false; } }
  if (INPUTS === null) {
    INPUTS = {};
    try {
      const lines = fs.readFileSync(path.join(ROOT, "data/nfl/ml-inputs-history.csv"), "utf8").trim().split(/\r?\n/);
      const head = lines.shift().split(",");
      for (const l of lines) {
        const c = l.split(","), r = Object.fromEntries(head.map((h, k) => [h, c[k]]));
        if (r.kickoff_utc && r.captured_at >= r.kickoff_utc) continue;      // frozen before kickoff only
        const prev = INPUTS[r.game_id];
        if (!prev || r.captured_at > prev.captured_at) INPUTS[r.game_id] = r;
      }
    } catch (e) { /* no inputs: why() falls back to words only */ }
  }
  return MODEL && INPUTS;
}

// row: optional inputs from the same read (picks-<date>.json ml_inputs, used
// by the member brief); the check below still requires they reproduce the
// published chance.
// Reads made before a refit are explained with the model they were made with: the old file is kept as
// data/nfl/moneyline-<model_version>-model.json (leo-nflml-v2 before the Nov 27 QB prior refit, DEC-20261127-02).
const OLD_MODELS = {};
function modelFor(v) {
  if (!v || v === MODEL.model_version) return MODEL;
  if (!(v in OLD_MODELS)) { try { OLD_MODELS[v] = JSON.parse(fs.readFileSync(path.join(ROOT, `data/nfl/moneyline-${v}-model.json`), "utf8")); } catch (e) { OLD_MODELS[v] = null; } }
  return OLD_MODELS[v] && OLD_MODELS[v].model_version === v ? OLD_MODELS[v] : null;
}
function drivers(m, row) {
  if (!loadModel() || !MODEL.features) return null;
  const r = row || INPUTS[m.game_id];
  if (!r) return null;
  const MODEL_ = modelFor(r.model_version);
  if (!MODEL_ || !MODEL_.features) return null;
  return driversWith(MODEL_, m, r);
}
function driversWith(MODEL, m, r) {
  const parts = { home: MODEL.intercept };
  MODEL.features.forEach((f, k) => { parts[f] = MODEL.beta[k] * (Number(r[f]) - MODEL.scaler.mean[f]) / MODEL.scaler.sd[f]; });
  const eta = Object.values(parts).reduce((a, b) => a + b, 0);
  const homeProb = 1 / (1 + Math.exp(-eta));
  const g = m.leo.game;
  const published = g.pick === m.home ? g.prob : 1 - g.prob;
  if (!Number.isFinite(homeProb) || Math.abs(homeProb - published) > 0.01) return null;
  // Share out the distance from 50% in proportion to each part's log-odds.
  const pts = {};
  for (const k of Object.keys(parts)) pts[k] = eta === 0 ? 0 : (homeProb - 0.5) * 100 * parts[k] / eta;
  return { pts, row: r };
}

function why(m) {
  const g = m.leo && m.leo.game;
  if (!g || !g.pick) return "";
  const D = driversAny(m);
  const items = [];
  const push = (label, p, words) => {
    if (p == null) return;
    const team = p > 0 ? m.home : m.away, n = Math.abs(p);
    const k = Math.round(n);
    items.push(`<li><b>${esc(label)}:</b> ${esc(words)}${n < 1 ? " Barely moves Leo's number." : ` Adds about ${k}% to the ${esc(TEAMS.nick(team))}' win chance.`}</li>`);
  };
  if (D) {
    const hq = D.row.home_qb_name || m.home_qb_name, aq = D.row.away_qb_name || m.away_qb_name;
    const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
    const better = (x, h, a) => Math.abs(x) < 0.15 ? `${cap(h)} and ${a} rate about the same in Leo's model.` : `${cap(x > 0 ? h : a)} rates ahead of ${x > 0 ? a : h} in Leo's model.`;
    push("Home field", D.pts.home, `${TEAMS.nick(m.home)} at home${m.div_game ? " in a division game" : ""}.`);
    push("Quarterback", D.pts.qb_diff, hq && aq ? better(Number(D.row.qb_diff), hq, aq) : "Starting quarterbacks compared.");
    push("Offense", D.pts.off_diff, better(Number(D.row.off_diff), `the ${TEAMS.nick(m.home)} offense`, `the ${TEAMS.nick(m.away)} offense`));
    push("Defense", D.pts.def_diff, better(Number(D.row.def_diff), `the ${TEAMS.nick(m.home)} defense`, `the ${TEAMS.nick(m.away)} defense`));
  } else {
    items.push(`<li>Leo's win chance comes from four things: home field, the starting quarterbacks, each offense and each defense, all measured from games before this one.</li>`);
  }
  const SKILL = /^(QB|RB|WR|TE)$/;
  const outs = side => ((m.injuries && m.injuries[side] && m.injuries[side].listed) || []).filter(p => SKILL.test(p.pos) && /^(Out|Doubtful)$/i.test(p.status));
  const missing = ["away", "home"].map(side => { const o = outs(side); return o.length ? `${city(side === "away" ? m.away : m.home)}: ${list(o.map(p => `${p.pos} ${p.player}${/doubtful/i.test(p.status) ? " (doubtful)" : ""}`))}` : null; }).filter(Boolean);
  if (missing.length) items.push(`<li><b>Who is out:</b> ${esc(missing.join("; "))}.</li>`);
  const marginTeam = g.proj_spread > 0 ? m.home : g.proj_spread < 0 ? m.away : null;
  let note = "";
  if (g.proj_spread != null && (marginTeam !== g.pick || Math.abs(g.proj_spread) < 1.5)) {
    const C = g.calls;
    note = `<p class="dim" style="margin:8px 0 0">Leo's win chance and its expected margin come from two separate models. Here the win chance favours ${esc(the(g.pick))} at ${pct(g.prob)}, while the margin model has ${marginTeam ? esc(byTeam(m, g.proj_spread)) : "an even game"}. Read it as a closer game than ${pct(g.prob)} suggests${C && C.spread && !C.spread.call ? ", which is why Leo makes no spread call" : ""}.</p>`;
  }
  const when = m.leo.captured_at ? new Date(m.leo.captured_at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET" : "";
  return `
  <h2 class="sec">Why Leo has the ${esc(TEAMS.nick(g.pick))} at ${pct(g.prob)}</h2>
  <p class="sub">What moved ${esc(TEAMS.nick(m.away))} at ${esc(TEAMS.nick(m.home))} away from a coin flip${m.leo.early ? ", early read" : ""}.</p>
  <ul style="margin:0 0 6px;padding-left:20px;line-height:1.7">${items.join("")}</ul>${note}
  <p class="dim" style="margin:8px 0 0">As of ${esc(when || "the last read")}. <a href="/nfl/how-leo-works/#read">What Leo knows</a></p>`;
}

// drivers() with the picks file's ml_inputs as a fallback, so early reads
// (which write no ml-inputs-history row) still get the split. Same check.
function driversAny(m) {
  const D = drivers(m);
  if (D) return D;
  try {
    const P = JSON.parse(fs.readFileSync(path.join(ROOT, "data/nfl", `picks-${m.date}.json`), "utf8")).find(p => p.game_id === m.game_id || p.matchup === m.matchup);
    if (P && P.ml_inputs) return drivers(m, { ...P.ml_inputs, model_version: P.ml_inputs.model_version || P.model_version, home_qb_name: P.home_qb, away_qb_name: P.away_qb });
  } catch (e) { /* no picks file */ }
  return null;
}

/* ---- HO-0069: an opening only true of this game, and "What happened". ---- */

// Every completed 2026 game, from the results-<date>.json files (each holds
// the games finished before that slate). Deduplicated by game_id.
let GAMES = null;
function games() {
  if (GAMES) return GAMES;
  const by = new Map();
  try {
    for (const f of fs.readdirSync(path.join(ROOT, "data/nfl"))) {
      if (!/^results-\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
      let rows; try { rows = JSON.parse(fs.readFileSync(path.join(ROOT, "data/nfl", f), "utf8")); } catch (e) { continue; }
      for (const r of Array.isArray(rows) ? rows : []) if (r.game_id && r.home_score != null && r.away_score != null) by.set(r.game_id, r);
    }
  } catch (e) { /* none */ }
  GAMES = [...by.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return GAMES;
}
const words = ["no", "one", "two", "three"];
function form(team, before) {
  const last = games().filter(g => g.date < before && (g.home === team || g.away === team)).slice(-3);
  if (!last.length) return "";
  const res = last.map(g => {
    const us = g.home === team ? g.home_score : g.away_score, them = g.home === team ? g.away_score : g.home_score;
    const opp = city(g.home === team ? g.away : g.home);
    return us === them ? `tied the ${opp} ${us} to ${them}` : us > them ? `beat the ${opp} ${us} to ${them}` : `lost to the ${opp} ${them} to ${us}`;
  }).reverse();
  const w = last.filter(g => (g.home === team ? g.home_score > g.away_score : g.away_score > g.home_score)).length;
  const head = w === last.length ? `have won ${last.length === 1 ? "their last game" : `${words[last.length]} straight`}`
    : w === 0 ? `have lost ${last.length === 1 ? "their last game" : `${words[last.length]} straight`}`
    : `are ${w} and ${last.length - w} in their last ${words[last.length]}`;
  return `The ${city(team)} ${head}: they ${list(res)}.`;
}
function lastMeeting(m) {
  const g = games().filter(x => x.date < m.date && ((x.home === m.home && x.away === m.away) || (x.home === m.away && x.away === m.home))).pop();
  if (!g) return "";
  const w = g.home_score === g.away_score ? null : g.home_score > g.away_score ? g.home : g.away;
  const hi = Math.max(g.home_score, g.away_score), lo = Math.min(g.home_score, g.away_score);
  return w ? `They met in Week ${g.week}, when the ${city(w)} won ${hi} to ${lo}${w === g.home ? " at home" : " on the road"}.` : `They met in Week ${g.week} and tied ${hi} to ${lo}.`;
}
// The absence that matters most: a starting quarterback first, then the most
// used back, receiver or tight end listed Out or Doubtful. Only the
// quarterback moves the win chance; the others move the player projections.
function biggestAbsence(m) {
  const best = [];
  for (const side of ["away", "home"]) {
    const team = m[side], listed = (m.injuries && m.injuries[side] && m.injuries[side].listed) || [];
    const S = (m.sides && m.sides[side] && m.sides[side].this_season) || {};
    const usage = {};
    for (const k of Object.keys(S)) { const p = S[k]; if (p && p.name) usage[p.name] = { pos: p.pos, touches: (p.att || 0) * (p.pos === "QB" ? 1 : 0) + (p.car || 0) + (p.tgt || 0), games: p.games, p }; }
    for (const x of listed) {
      if (!/^(Out|Doubtful)$/i.test(x.status) || !/^(QB|RB|WR|TE)$/.test(x.pos)) continue;
      const u = usage[x.player]; if (!u) continue;
      best.push({ team, x, u, score: (x.pos === "QB" ? 1e6 : 0) + u.touches });
    }
  }
  best.sort((a, b) => b.score - a.score);
  const B = best[0]; if (!B) return "";
  const st = /doubtful/i.test(B.x.status) ? "doubtful" : "out";
  const posName = { QB: "quarterback", RB: "running back", WR: "receiver", TE: "tight end" }[B.x.pos];
  if (B.x.pos === "QB") {
    const qb = B.team === m.home ? m.home_qb_name : m.away_qb_name;
    return `The biggest absence is ${posName} ${B.x.player}, ${st} for the ${city(B.team)}${qb && qb !== B.x.player ? `, so Leo's win chance is built on ${qb} instead` : ""}.`;
  }
  const P = B.u.p, vol = B.x.pos === "RB" ? `${P.car || 0} carries and ${P.tgt || 0} targets` : `${P.tgt || 0} targets`;
  return `The biggest absence is ${posName} ${B.x.player}, ${st} for the ${city(B.team)} after ${vol} in ${B.u.games} games; that moves the projections for the ${city(B.team)} players, not the win chance.`;
}
// The biggest driver of Leo's number in one sentence (also used on the week card).
// The biggest reason for Leo's number, in plain words (Lynold, Nov 21: the week page repeated "The offenses
// are the biggest reason for Leo's number" on 6 games and "worth about 10 points of win chance" meant nothing
// to a reader). The sentence names the biggest input (drivers() shares Leo's edge above 50% out among the
// inputs) and Leo's chance, without points. Several wordings per kind so a week page reads like writing.
// Wordings are handed out in turn within one build (each game keeps the one it got), so the games on a
// week page, built in one run, do not repeat a wording until a kind has more games than wordings.
const WORDING = new Map(), TURN = {};
function pickOf(list, key, kind) {
  const id = kind + "|" + key;
  if (!WORDING.has(id)) { TURN[kind] = (TURN[kind] || 0); WORDING.set(id, TURN[kind]++); }
  return list[WORDING.get(id) % list.length];
}
function biggestDriver(m) {
  const g = m.leo && m.leo.game;
  const D = g && g.pick ? driversAny(m) : null;
  if (!D) return "";
  const k = ["qb_diff", "off_diff", "def_diff", "home"].sort((a, b) => Math.abs(D.pts[b] || 0) - Math.abs(D.pts[a] || 0))[0];
  const p = D.pts[k], n = Math.round(Math.abs(p));
  if (n < 1) return "";
  const team = p > 0 ? m.home : m.away, other = team === m.home ? m.away : m.home;
  const fav = g.pick, P = Math.round(g.prob * 100), E = P - 50;
  const T = city(team), O = city(other), F = city(fav);
  const hq = D.row.home_qb_name || m.home_qb_name, aq = D.row.away_qb_name || m.away_qb_name;
  const myQb = team === m.home ? hq : aq, theirQb = team === m.home ? aq : hq;
  const key = m.game_id || m.matchup || (m.away + m.home + m.date);
  if (k === "qb_diff" && !(hq && aq)) return "";
  // The input favours the underdog: say it keeps the game closer.
  if (team !== fav) {
    const what = k === "qb_diff" ? `${myQb} rates ahead of ${theirQb}` : k === "off_diff" ? `the ${T} have the better offense` : k === "def_diff" ? `the ${T} have the better defense` : `the ${T} are at home`;
    return `Leo has the ${F} at ${P}%, but ${what}, which keeps it closer.`;
  }
  // Lynold, Nov 21: no points in the sentence, just the reason (he chose "Simpler wording").
  const S = {
    qb_diff: [
      `${myQb} over ${theirQb} is the biggest reason Leo has the ${T} at ${P}%.`,
      `Leo's ${P}% on the ${T} starts at quarterback: ${myQb} rates well ahead of ${theirQb}.`,
      `The quarterbacks decide this one for Leo. ${myQb} against ${theirQb} is why the ${T} sit at ${P}%.`,
      `Most of Leo's lean comes from under center, with ${myQb} rated well above ${theirQb}. The ${T} are at ${P}%.`,
      `Leo likes the ${T} at ${P}%, mainly because ${myQb} is the better quarterback than ${theirQb}.`],
    off_diff: [
      `The ${T} offense is the biggest reason Leo has them at ${P}%.`,
      `With the ball, the ${T} rate clearly ahead of the ${O}. That is why Leo has them at ${P}%.`,
      `Leo's ${P}% on the ${T} starts with their offense.`,
      `Scoring is the gap here: the ${T} offense rates well ahead of the ${O}, so Leo has them at ${P}%.`,
      `Leo likes the ${T} at ${P}%, mainly because they move the ball better than the ${O}.`],
    def_diff: [
      `The ${T} defense is the biggest reason Leo has them at ${P}%.`,
      `Without the ball, the ${T} rate clearly ahead of the ${O}. That is why Leo has them at ${P}%.`,
      `Leo's ${P}% on the ${T} starts with their defense.`,
      `Stopping the other side is the gap here: the ${T} defense rates well ahead, so Leo has them at ${P}%.`,
      `Leo likes the ${T} at ${P}%, mainly because their defense is the better unit.`],
    home: [
      `The teams rate close, so home field is the biggest reason Leo has the ${T} at ${P}%.`,
      `Take away home field and this is close to even. Playing at home puts the ${T} at ${P}%.`,
      `Leo's ${P}% on the ${T} leans on home field; otherwise these teams rate about the same.`]
  };
  return pickOf(S[k], key, k);
}
/** The biggest input behind Leo's number: { k: "qb_diff"|"off_diff"|"def_diff"|"home", team } or null (the analysis panel, 2026-11-25). */
function driverKind(m) {
  const g = m.leo && m.leo.game;
  const D = g && g.pick ? driversAny(m) : null;
  if (!D) return null;
  const k = ["qb_diff", "off_diff", "def_diff", "home"].sort((a, b) => Math.abs(D.pts[b] || 0) - Math.abs(D.pts[a] || 0))[0];
  const p = D.pts[k];
  if (Math.round(Math.abs(p)) < 1) return null;
  return { k, team: p > 0 ? m.home : m.away };
}

function opening(m) {
  const out = [], d = biggestDriver(m);
  if (d) out.push(d);
  const fa = form(m.away, m.date), fh = form(m.home, m.date);
  if (fa) out.push(fa);
  if (fh) out.push(fh);
  const lm = lastMeeting(m); if (lm) out.push(lm);
  const ab = biggestAbsence(m); if (ab) out.push(ab);
  return out;
}

// After the game: the score, Leo right or wrong, the calls, and the miss
// reason with its evidence, from data/nfl/results-review.json (the labels of
// /nfl/results/). Shown near the top once the game is final.
let REVIEW = null;
function reviewFor(m) {
  if (REVIEW === null) { try { REVIEW = JSON.parse(fs.readFileSync(path.join(ROOT, "data/nfl/results-review.json"), "utf8")); } catch (e) { REVIEW = false; } }
  if (!REVIEW) return null;
  return REVIEW.games.find(x => x.date === m.date && x.away === m.away && x.home === m.home) || null;
}
const REASON = { injury_input: "Injury input", market_knew: "The market knew", overtime: "Overtime", blowout: "Blowout", variance: "Variance", model_error: "Leo's error" };
function whatHappened(m) {
  const fin = finalSentence(m);
  if (!fin) return "";
  const R = reviewFor(m), miss = R && R.miss;
  const why = miss ? `<p style="margin:10px 0 0"><b>Why Leo missed: ${esc(REASON[miss.reason] || miss.reason)}.</b> ${esc(miss.evidence)} <a href="/nfl/results/">Leo&rsquo;s record</a></p>`
    : R ? `<p style="margin:10px 0 0">No miss for Leo in this game. <a href="/nfl/results/">Leo&rsquo;s record</a></p>` : "";
  return `<section class="card summary">
  <h2 class="sec" style="margin-top:0">What happened</h2>
  <p style="margin:0">${esc(fin)}</p>${why}
</section>`;
}

module.exports = { driverKind, summary, why, finalSentence, drivers, opening, whatHappened, biggestDriver };
