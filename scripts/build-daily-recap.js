#!/usr/bin/env node
/**
 * The daily recap artifact behind Lynold's one morning email (Lynold, 2026-11-22: "Single Daily Owner Email
 * Spec"). Shared (Manager's file). Runs after grading in nba-grade.yml and nfl-grade-results.yml; each run
 * rebuilds the whole file from every sport's graded files, so the last run of the night has everything.
 *
 *   node scripts/build-daily-recap.js [YYYY-MM-DD]     (default: yesterday, New York time)
 *
 * Writes data/daily-recap-latest.json and data/daily-recap/<date>.md:
 *   - graded outcomes per market (NBA Leo Picks, NFL moneyline and spread, the Leo Parlay): W-L-P, units,
 *     the running record and its sample out of 50;
 *   - every graded loss with its miss tag (injury input, market knew, overtime, blowout, variance, model error)
 *     and one sentence of evidence, from the results pages' own data;
 *   - two X post options of 280 characters or less, taken from the posts the sport builders already wrote
 *     (A: results, B: slate or model), so the brand rules they follow carry over;
 *   - the public prediction feeds' status.
 * The repo is public, so nothing private goes in this file: no subscriber counts, no emails, no PayPal events.
 * The Leo morning brief (a Claude scheduled task) reads it, adds the workflow status, the private funnel counts
 * and today's priority, and sends the one email.
 */
"use strict";
const fs = require("fs");
const path = require("path");
let EX = null; try { EX = require("./lib/extra-posts"); } catch (e) {}

const ROOT = path.join(__dirname, "..");
const rj = f => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch (e) { return null; } };
const etDate = (ms = Date.now()) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const DATE = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || etDate(Date.now() - 864e5);
const TAG = { injury_input: "injury input", market_knew: "market knew", overtime: "overtime", blowout: "blowout", variance: "variance", model_error: "model error" };
const tag = r => TAG[r] || String(r || "unlabelled").replace(/_/g, " ");
const u = x => `${x >= 0 ? "+" : ""}${(+x || 0).toFixed(2)}u`;
const rec = o => o ? `${o.w || 0}-${o.l || 0}${o.p ? "-" + o.p : ""}` : "0-0";
const xlen = t => EX && EX.xlen ? EX.xlen(t) : String(t).length;

const out = { date: DATE, built_at: new Date().toISOString(), markets: [], misses: [], posts: [], feeds: [] };

// ---------- NBA Leo Picks ----------
const nbaDays = (rj("data/nba/results-days.json") || {}).days || [];
const nbaDay = nbaDays.find(d => d.date === DATE);
if (nbaDay && nbaDay.calls && nbaDay.calls.n) {
  out.markets.push({ sport: "NBA", market: "Leo Picks", day: rec(nbaDay.calls), units: +nbaDay.calls.units || 0,
    season: rec(nbaDay.running), season_units: +(nbaDay.running || {}).units || 0, sample: (nbaDay.running || {}).n || 0 });
  for (const g of nbaDay.games || []) {
    if (!g.pick || g.pick.result !== "loss") continue;
    const team = g.pick.team;
    const m = g.miss || {};
    out.misses.push({ sport: "NBA", call: `${team} ML ${g.pick.price > 0 ? "+" : ""}${g.pick.price}`, tag: m.reason ? tag(m.reason) : String(m.label || "unlabelled").toLowerCase(),
      why: m.evidence || `Final ${g.away} ${g.as}, ${g.home} ${g.hs}.` });
  }
}

// ---------- NFL calls ----------
const rv = rj("data/nfl/results-review.json");
const nflGames = rv ? rv.games.filter(g => g.date === DATE && (g.calls || []).some(c => c.result)) : [];
if (nflGames.length) {
  const waves = rj(`data/nfl/waves/${DATE}.json`);
  const S = (waves && waves.season) || {};
  for (const [mk, label, key] of [["ml", "moneyline", "moneyline"], ["spread", "spread", "spread"]]) {
    const cs = nflGames.flatMap(g => g.calls.filter(c => c.market === mk && c.result));
    if (!cs.length) continue;
    const t = { w: cs.filter(c => c.result === "W").length, l: cs.filter(c => c.result === "L").length, p: cs.filter(c => c.result === "P").length };
    const s = S[key] || {};
    out.markets.push({ sport: "NFL", market: label, day: rec(t), units: cs.reduce((a, c) => a + (+c.units || 0), 0),
      season: rec(s), season_units: +s.units || 0, sample: s.n || 0 });
  }
  for (const g of nflGames) for (const c of g.calls.filter(c => c.result === "L")) {
    const m = g.miss || {};
    out.misses.push({ sport: "NFL", call: String(c.text || "").split(",")[0], tag: tag(m.reason), why: m.evidence || `Final ${g.away_name} ${g.score && g.score.away}, ${g.home_name} ${g.score && g.score.home}.` });
  }
}

// ---------- Leo Parlay ----------
const pl = rj(`data/parlay/${DATE}.json`), prec = rj("data/parlay/record.json");
if (pl && pl.result) {
  out.markets.push({ sport: "Parlay", market: "Leo Parlay", day: pl.result === "W" ? "1-0" : pl.result === "L" ? "0-1" : "0-0-1",
    units: pl.result === "W" ? +pl.decimal - 1 : pl.result === "L" ? -1 : 0, season: rec(prec), season_units: +(prec || {}).units || 0, sample: (prec || {}).n || 0 });
  if (pl.result === "L") {
    const lost = (pl.legs || []).filter(l => l.result === "L").map(l => `${l.team} ML ${l.price > 0 ? "+" : ""}${l.price}`);
    out.misses.push({ sport: "Parlay", call: `Leo Parlay ${pl.price}`, tag: "leg lost", why: `Lost on ${lost.join(" and ") || "a leg"}.` });
  }
}

// ---------- post menu (from the posts the builders wrote; brand rules already applied there) ----------
const posts = sp => ((rj(`data/${sp}/social/${DATE}.json`) || {}).posts || []).filter(p => p.text && xlen(p.text) <= 280);
const nba = posts("nba"), nfl = posts("nfl");
const find = (list, ids) => { for (const id of ids) { const p = list.find(x => x.id === id); if (p) return p; } return null; };
const lastWave = list => list.filter(p => /^wave-\d+$/.test(p.id)).slice(-1)[0] || null;
const A = (nflGames.length && (find(nfl, ["day"]) || lastWave(nfl))) || find(nba, ["day"]) || find(nfl, ["rday"]) || find(nba, ["rday"]);
if (A) out.posts.push({ option: "A", kind: "Results", sport: nfl.includes(A) ? "NFL" : "NBA", id: A.id, text: A.text, reply: EX && EX.replyText ? EX.replyText(A) : "", chars: xlen(A.text) });
const B = find(nba, ["stat"]) || find(nfl, ["stat"]) || (A && A.id !== "rday" ? (find(nba, ["rday"]) || find(nfl, ["rday"])) : null) || find(nfl, ["qbfacts", "reads"]);
if (B) out.posts.push({ option: "B", kind: "Slate / Model", sport: nfl.includes(B) ? "NFL" : "NBA", id: B.id, text: B.text, reply: EX && EX.replyText ? EX.replyText(B) : "", chars: xlen(B.text) });

// ---------- public feeds ----------
for (const sp of ["nfl", "nba"]) {
  const f = path.join(ROOT, "data", "predictions", `${sp}.csv`);
  if (!fs.existsSync(f)) { out.feeds.push({ feed: `${sp}.csv`, ok: false, note: "missing" }); continue; }
  const lines = fs.readFileSync(f, "utf8").trim().split("\n");
  const cols = lines[0].split(",").length;
  const bad = lines.slice(1).filter(l => l.split(",").length !== cols).length;
  out.feeds.push({ feed: `${sp}.csv`, ok: bad === 0 && lines.length > 1, rows: lines.length - 1, bad_rows: bad, note: bad ? `${bad} broken rows` : "ok" });
}

// ---------- write ----------
const graded = out.markets.map(m => `${m.sport === "Parlay" ? "Parlay" : m.sport + " " + m.market} ${m.day} ${u(m.units)}`);
out.graded_summary = graded.length ? graded.join(" | ") : "no graded calls";
fs.writeFileSync(path.join(ROOT, "data", "daily-recap-latest.json"), JSON.stringify(out, null, 1) + "\n");
const md = [
  `# Leo daily recap, ${DATE}`, "",
  "## Graded", ...(out.markets.length ? out.markets.map(m => `- ${m.sport} ${m.market}: ${m.day}, ${u(m.units)} (season ${m.season}, ${u(m.season_units)}, ${m.sample}/50 early read)`) : ["- No graded calls."]), "",
  "## Misses and why", ...(out.misses.length ? out.misses.map(m => `- ${m.sport} ${m.call} [${m.tag}]: ${m.why}`) : ["- None."]), "",
  "## Post options", ...out.posts.map(p => `### Option ${p.option} (${p.kind}, ${p.sport}, ${p.chars} characters)\n\n${p.text}\n`), "",
  "## Feeds", ...out.feeds.map(f => `- ${f.feed}: ${f.note}${f.rows != null ? `, ${f.rows} rows` : ""}`), ""
].join("\n");
fs.mkdirSync(path.join(ROOT, "data", "daily-recap"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "data", "daily-recap", `${DATE}.md`), md);
console.log(`daily recap ${DATE}: ${out.graded_summary}; ${out.misses.length} misses; ${out.posts.length} post options`);
