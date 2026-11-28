#!/usr/bin/env node
/**
 * NFL anytime touchdown picks, tracked and graded privately from Thanksgiving (2026-11-26).
 * Lynold, 2026-11-26: "for week 13 we are going to launch the anytime touchdown picks. so for this week
 * lets start grading and tracking". Nothing here is shown on the site yet and nothing feeds Leo.
 *
 *   node scripts/build-nfl-td-picks.js [YYYY-MM-DD ...]   (default: yesterday and today, Eastern)
 *
 * Two rules, written down before the first tracked game (business/TD_PICKS_TEST_2026-11-26.md):
 *   top3_day  Leo's three highest anytime touchdown chances of the game day, from the last read saved
 *             before the day's first kickoff (the same three the TOUCHDOWN WATCH post shows).
 *   leo50     every player Leo gives 50% or more, from the last read saved before his own kickoff.
 * Leo's chance: data/nfl/prop-prediction-history.csv (ANYTIME_TD, captured strictly before kickoff).
 * Price: the books' average implied chance (vig included) in data/nfl/odds-history-props.csv at the
 * last capture saved no later than that read (15 minute allowance, never after kickoff), as American odds.
 * The price is a grading benchmark only; it never feeds Leo (the line is never a model input).
 * Result: data/nfl/nfl-props-graded.csv (ANYTIME_TD actual, after the morning grade). 1 unit a pick at
 * the price; a player with no graded row (did not play) is void; a pick with no price counts as
 * scored or not but carries no units.
 * Picks freeze at kickoff (top3_day at the day's first kickoff) and are never rewritten after; results are
 * filled in when graded.
 * Writes data/nfl/td-picks/<date>.json and data/nfl/td-picks/record.json.
 *
 * Public from Week 13 (N6, built 2026-11-27): top3_day picks from PUBLIC_FROM (Thu Dec 3, the first Week 13 game)
 * are Leo's touchdown picks, shown and graded publicly: record.json gains a "public" block (top3_day from that date
 * only; the Thanksgiving to Dec 2 test stays private), and /nfl/results/ gets a touchdown picks tile between the
 * <!--leo-td--> markers, kept apart from the moneyline and spread record. Nothing public is written before the
 * first public pick exists.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "data/nfl");
const OUT = path.join(DIR, "td-picks");
const TRACK_FROM = "2026-11-26";
const PUBLIC_FROM = "2026-12-03";   // first Week 13 game (DEC-20261126-08)
const RESULTS_PAGE = path.join(ROOT, "nfl/results/index.html");
const RULES = {
  top3_day: "Leo's top 3 anytime touchdown chances of the game day (read before the first kickoff)",
  leo50: "Every player Leo gives 50% or more (read before his kickoff)",
};
const ALLOW_MS = 15 * 60 * 1000;
const NOW = Date.now();

function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
const readCsv = f => fs.existsSync(f) ? parseCsv(fs.readFileSync(f, "utf8")) : [];
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };
const norm = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "").replace(/(jr|sr|ii|iii|iv)$/, "");
const american = p => !(p > 0 && p < 1) ? null : p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
const payout = price => price == null ? null : price > 0 ? price / 100 : 100 / -price;
const etDate = ms => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

let PROPS = null, ODDS = null, GRADED = null;
function load() {
  if (PROPS) return;
  PROPS = readCsv(path.join(DIR, "prop-prediction-history.csv")).filter(r => r.market === "ANYTIME_TD");
  ODDS = readCsv(path.join(DIR, "odds-history-props.csv")).filter(r => r.market === "ANYTIME_TD");
  GRADED = readCsv(path.join(DIR, "nfl-props-graded.csv")).filter(r => r.market === "ANYTIME_TD");
}

/** Last capture per player strictly before `cutoff(kickoff)`. */
function reads(date, cutoffFor) {
  const best = new Map();
  for (const r of PROPS) {
    if (r.date !== date) continue;
    const cap = Date.parse(r.captured_at), kick = Date.parse(r.kickoff_utc);
    if (!Number.isFinite(cap) || !Number.isFinite(kick) || !(cap < cutoffFor(kick))) continue;
    const p = +r.projection; if (!Number.isFinite(p)) continue;
    const k = `${r.game_id}|${norm(r.player)}`;
    const prev = best.get(k);
    if (!prev || cap > prev._cap) best.set(k, { ...r, _cap: cap, _kick: kick, chance: p });
  }
  return [...best.values()];
}

function priceAt(date, player, readCap, kick) {
  let best = null;
  for (const o of ODDS) {
    if (o.date !== date || norm(o.player) !== norm(player)) continue;
    const t = Date.parse(o.captured_at);
    if (!(t <= readCap + ALLOW_MS) || !(t <= kick)) continue;
    const p = +(o.implied_prob_raw || o.implied_prob);
    if (!(p > 0 && p < 1)) continue;
    if (!best || t > best.t) best = { t, p, books: +o.books || null };
  }
  return best ? { book_chance: Math.round(best.p * 1000) / 1000, price: american(best.p), books: best.books, price_at: new Date(best.t).toISOString() } : { book_chance: null, price: null, books: null, price_at: null };
}

const pick = (date, r) => ({
  game_id: r.game_id, matchup: r.matchup, kickoff_utc: r.kickoff_utc, player: r.player, team: r.team, position: r.position,
  chance: Math.round(r.chance * 1000) / 1000, read_at: r.captured_at, model_version: r.model_version,
  ...priceAt(date, r.player, r._cap, r._kick),
});

function grade(p, date) {
  const g = GRADED.find(x => x.date === date && norm(x.player) === norm(p.player) && x.game_id === p.game_id && !x.excluded);
  if (!g || g.actual === "") {
    // Graded the morning after; a player with no row once his game's date is graded is void.
    const dayGraded = GRADED.some(x => x.date === date && x.game_id === p.game_id);
    return dayGraded ? { ...p, result: "void", units: 0 } : { ...p, result: null, units: null };
  }
  const scored = +g.actual > 0;
  const units = p.price == null ? null : Math.round((scored ? payout(p.price) : -1) * 100) / 100;
  return { ...p, result: scored ? "W" : "L", units };
}

function build(date) {
  if (date < TRACK_FROM) return null;
  load();
  const file = path.join(OUT, `${date}.json`);
  const old = readJson(file) || { date, rules: RULES, picks: {} };
  const all = reads(date, kick => kick);
  if (!all.length && !Object.keys(old.picks || {}).length) { console.log(`td picks ${date}: no touchdown reads.`); return null; }
  const firstKick = Math.min(...PROPS.filter(r => r.date === date).map(r => Date.parse(r.kickoff_utc)).filter(Number.isFinite));
  const picks = { top3_day: old.picks.top3_day || [], leo50: old.picks.leo50 || [] };

  // top3_day: frozen as a set at the first kickoff of the day.
  const top3Frozen = (old.picks.top3_day || []).length && NOW >= firstKick;
  if (!top3Frozen) {
    const before = reads(date, () => firstKick);
    picks.top3_day = before.sort((a, b) => b.chance - a.chance || a.player.localeCompare(b.player)).slice(0, 3).map(r => pick(date, r));
  }
  // leo50: each game frozen at its own kickoff; games not started yet follow the latest read.
  const kept = (old.picks.leo50 || []).filter(p => NOW >= Date.parse(p.kickoff_utc));
  const keptGames = new Set(kept.map(p => p.game_id));
  const fresh = all.filter(r => r.chance >= 0.5 && !keptGames.has(r.game_id) && !(NOW >= r._kick && (old.picks.leo50 || []).length))
    .map(r => pick(date, r));
  picks.leo50 = [...kept, ...fresh].sort((a, b) => a.kickoff_utc.localeCompare(b.kickoff_utc) || b.chance - a.chance);

  for (const k of Object.keys(picks)) picks[k] = picks[k].map(p => grade(p, date));
  const doc = { date, built_at: new Date(NOW).toISOString(), tracking: date >= PUBLIC_FROM ? "top3_day public (Leo's touchdown picks); leo50 private" : "private test, not on the site", rules: RULES, first_kickoff_utc: new Date(firstKick).toISOString(), picks };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 1) + "\n");
  console.log(`td picks ${date}: top3_day ${picks.top3_day.map(p => `${p.player} ${Math.round(p.chance * 100)}% ${p.price ?? "no price"}${p.result ? " " + p.result : ""}`).join(", ")}; leo50 ${picks.leo50.length}`);
  return doc;
}

function record() {
  if (!fs.existsSync(OUT)) return;
  const out = { since: TRACK_FROM, built_at: new Date(NOW).toISOString(), tracking: "private test, not on the site", rules: {} };
  for (const k of Object.keys(RULES)) out.rules[k] = { label: RULES[k], picks: 0, graded: 0, won: 0, lost: 0, void: 0, priced: 0, units: 0, avg_chance: null, avg_book_chance: null };
  for (const f of fs.readdirSync(OUT).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()) {
    const d = readJson(path.join(OUT, f)); if (!d) continue;
    for (const [k, ps] of Object.entries(d.picks || {})) {
      const R = out.rules[k]; if (!R) continue;
      for (const p of ps) {
        R.picks++;
        if (p.result === "void") { R.void++; continue; }
        if (!p.result) continue;
        R.graded++; p.result === "W" ? R.won++ : R.lost++;
        if (p.units != null) { R.priced++; R.units = Math.round((R.units + p.units) * 100) / 100; }
        R._c = (R._c || 0) + p.chance; if (p.book_chance != null) { R._b = (R._b || 0) + p.book_chance; R._nb = (R._nb || 0) + 1; }
      }
    }
  }
  for (const R of Object.values(out.rules)) {
    if (R.graded) R.avg_chance = Math.round(1000 * R._c / R.graded) / 1000;
    if (R._nb) R.avg_book_chance = Math.round(1000 * R._b / R._nb) / 1000;
    delete R._c; delete R._b; delete R._nb;
  }
  out.public = publicRecord();
  fs.writeFileSync(path.join(OUT, "record.json"), JSON.stringify(out, null, 1) + "\n");
  if (out.public.picks) writeResultsTile(out.public);
  for (const [k, R] of Object.entries(out.rules)) console.log(`  ${k}: ${R.won}-${R.lost}${R.void ? `, ${R.void} void` : ""}, ${R.units >= 0 ? "+" : ""}${R.units}u on ${R.priced} priced`);
}

/** Leo's touchdown picks, public from PUBLIC_FROM: top3_day only, 1 unit at the price at Leo's read. */
function publicRecord() {
  const R = { since: PUBLIC_FROM, rule: "top3_day", label: "Leo's touchdown picks: his top 3 anytime touchdown chances of each game day, read before the first kickoff, 1 unit each at the market price at Leo's read",
    picks: 0, graded: 0, won: 0, lost: 0, void: 0, priced: 0, units: 0, days: [] };
  if (!fs.existsSync(OUT)) return R;
  for (const f of fs.readdirSync(OUT).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()) {
    const date = f.slice(0, 10); if (date < PUBLIC_FROM) continue;
    const d = readJson(path.join(OUT, f)); const ps = (d && d.picks && d.picks.top3_day) || [];
    if (!ps.length) continue;
    const day = { date, won: 0, lost: 0, void: 0, units: 0, graded: ps.every(p => p.result), picks: ps.map(p => ({ player: p.player, team: p.team, position: p.position, game_id: p.game_id, chance: p.chance, price: p.price, result: p.result, units: p.units })) };
    for (const p of ps) {
      R.picks++;
      if (p.result === "void") { R.void++; day.void++; continue; }
      if (!p.result) continue;
      R.graded++; if (p.result === "W") { R.won++; day.won++; } else { R.lost++; day.lost++; }
      if (p.units != null) { R.priced++; R.units = Math.round((R.units + p.units) * 100) / 100; day.units = Math.round((day.units + p.units) * 100) / 100; }
    }
    R.days.push(day);
  }
  return R;
}
const signed = u => `${u >= 0 ? "+" : ""}${Number(u).toFixed(2)}u`;
const lastName = n => String(n || "").replace(/\s+(Jr\.?|Sr\.?|II|III|IV)$/i, "").split(" ").pop();
/** The touchdown picks tile on /nfl/results/ (between <!--leo-td--> markers, after the Leo Parlay line). */
function writeResultsTile(P) {
  if (!fs.existsSync(RESULTS_PAGE)) return;
  const last = P.days.filter(d => d.graded).pop();
  const day = last ? new Date(last.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "";
  const mark = r => r === "W" ? " ✅" : r === "L" ? " ❌" : r === "void" ? " (did not play, void)" : "";
  const lastLine = last ? ` Last: ${day}, ${last.picks.map(p => `${lastName(p.player)}${mark(p.result)}`).join(", ")}.` : " First picks are being graded.";
  const rec = P.graded ? `${P.won}-${P.lost}` : "0-0";
  const tile = `<!--leo-td--><section class="rec-row" id="td-picks" aria-label="Touchdown picks" style="margin:6px 0 4px"><article class="rec"><span class="lab">Touchdown picks, since Dec 3</span><span class="big">${rec}</span><span class="beat"><b>${signed(P.units)}</b> · ${P.graded < 50 ? `early read, ${P.graded} of 50 picks` : `${P.graded} picks`}${P.void ? ` · ${P.void} void` : ""}</span></article></section><p class="small" id="td-picks-line" style="margin:6px 0 14px"><b>Touchdown picks</b> (Leo's top 3 anytime touchdown chances of each game day, 1 unit each at the market price at Leo's read, kept apart from this record).${lastLine} <a href="/nfl/anytime-touchdowns/">Every touchdown pick</a></p><!--/leo-td-->`;
  let html = fs.readFileSync(RESULTS_PAGE, "utf8");
  if (/<!--leo-td-->[\s\S]*?<!--\/leo-td-->/.test(html)) html = html.replace(/<!--leo-td-->[\s\S]*?<!--\/leo-td-->/, tile);
  else if (html.includes("<!--/leo-parlay-->")) html = html.replace("<!--/leo-parlay-->", "<!--/leo-parlay-->\n  " + tile);
  else return;
  fs.writeFileSync(RESULTS_PAGE, html);
}

if (require.main === module) {
  let dates = process.argv.slice(2).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!dates.length) dates = [etDate(NOW - 864e5), etDate(NOW)];
  for (const d of [...new Set(dates)]) build(d);
  record();
}
module.exports = { build, record, publicRecord, RULES, TRACK_FROM, PUBLIC_FROM };
