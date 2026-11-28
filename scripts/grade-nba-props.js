#!/usr/bin/env node
/**
 * Grades Leo's NBA player projections (data/nba/prop-proj/<date>.csv, from project-nba-props.js) against what
 * happened and against the saved DraftKings line. Private test (DEC-20261126-03 step 2): not on the site, not in
 * posts or emails.
 *
 *   node scripts/grade-nba-props.js
 *
 * For each date with a box score (data/nba/boxscores/<date>.json) and projections:
 *   projection: the last row saved before tip (a backfill row when that is all there is, marked as such)
 *   line: the last line saved before tip (data/nba/prop-lines/<date>.csv), the closing line we compare against
 *   actual: the box score; a player who did not play is a void (left out), as at the book
 *   error = projection - actual; line_error = line - actual; closer = which of the two was nearer the actual
 * Leans (over or under) are not graded: which price is the over is inferred from line moves, not confirmed against
 * the book, and the bar says leans wait until the projection's error is no worse than the line's over 3+ weeks.
 *
 * Writes data/nba/prop-proj/graded.csv (rows for a graded game are kept as first written: graded records never
 * change) and data/nba/prop-proj/summary.json. Never fails the run.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "data/nba/prop-proj");
const COLS = ["date", "game_id", "player_id", "player", "team", "opp", "market", "source", "projected_at", "projection", "minutes",
  "line", "line_captured_at", "actual", "actual_minutes", "error", "line_error", "closer"];
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const r2 = x => Math.round(x * 100) / 100;
const cell = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const read = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean); if (!lines.length) return [];
  const head = lines.shift().split(",");
  return lines.map(l => { const c = []; let cur = "", q = false;
    for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ",") { c.push(cur); cur = ""; } else cur += ch; }
    c.push(cur); return Object.fromEntries(head.map((h, i) => [h, c[i] ?? ""])); });
}

function gradeDate(date) {
  const box = read(path.join(ROOT, "data/nba/boxscores", `${date}.json`));
  if (!box || !box.games) return null;
  const act = new Map();
  for (const g of box.games) for (const p of g.players || []) {
    if (p.dnp || !(+p.minutes > 0)) continue;
    const s = p.stats || {}, pts = +s.points || 0, reb = +s.rebounds || 0, ast = +s.assists || 0;
    act.set(`${g.game_id}|${p.id}`, { min: +p.minutes, pts, reb, ast, pra: pts + reb + ast });
  }
  const finals = new Set(box.games.filter(g => g.home_score != null && g.away_score != null).map(g => String(g.game_id)));
  // Last projection before tip per player and market (live rows first; backfill only when no live row exists).
  const proj = new Map();
  for (const r of parseCsv(fs.readFileSync(path.join(DIR, `${date}.csv`), "utf8"))) {
    const before = r.source === "backfill" || !r.tip_utc || r.projected_at < new Date(r.tip_utc).toISOString();
    if (!before) continue;
    const k = `${r.game_id}|${r.player_id}|${r.market}`, o = proj.get(k);
    const rank = x => (x.source === "live" ? 1 : 0);
    if (!o || rank(r) > rank(o) || (rank(r) === rank(o) && r.projected_at >= o.projected_at)) proj.set(k, r);
  }
  // Closing line: the last saved before tip.
  const close = new Map(), lf = path.join(ROOT, "data/nba/prop-lines", `${date}.csv`);
  if (fs.existsSync(lf)) for (const r of parseCsv(fs.readFileSync(lf, "utf8"))) {
    if (r.tip_utc && r.captured_at >= new Date(r.tip_utc).toISOString()) continue;
    const k = `${r.game_id}|${r.athlete_id}|${r.market}`, o = close.get(k);
    if (!o || r.captured_at >= o.captured_at) close.set(k, r);
  }
  const rows = [];
  for (const [k, p] of proj) {
    if (!finals.has(String(p.game_id))) continue;
    const a = act.get(`${p.game_id}|${p.player_id}`); if (!a) continue;   // did not play: void
    const L = close.get(k), line = L ? num(L.line) : null, pr = num(p.projection), y = a[p.market];
    if (pr == null || y == null) continue;
    const e = r2(pr - y), le = line == null ? null : r2(line - y);
    rows.push({ date, game_id: p.game_id, player_id: p.player_id, player: p.player, team: p.team, opp: p.opp, market: p.market, source: p.source,
      projected_at: p.projected_at, projection: pr, minutes: num(p.minutes), line: line == null ? "" : line, line_captured_at: L ? L.captured_at : "",
      actual: y, actual_minutes: a.min, error: e, line_error: le == null ? "" : le,
      closer: le == null ? "" : Math.abs(e) < Math.abs(le) ? "leo" : Math.abs(e) > Math.abs(le) ? "line" : "tie" });
  }
  return rows;
}

function main() {
  if (!fs.existsSync(DIR)) { console.log("prop grade: no projections yet"); return; }
  const gf = path.join(DIR, "graded.csv");
  const kept = fs.existsSync(gf) ? parseCsv(fs.readFileSync(gf, "utf8")) : [];
  // Graded per game: a box score file saved before the late games end gets the rest on a later run.
  const done = new Set(kept.map(r => String(r.game_id)));
  const added = [];
  for (const f of fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort()) {
    const rows = gradeDate(f.slice(0, 10)); if (rows) added.push(...rows.filter(r => !done.has(String(r.game_id))));
  }
  const all = [...kept, ...added];
  if (added.length) {
    if (!kept.length) fs.writeFileSync(gf, COLS.join(",") + "\n");
    fs.appendFileSync(gf, added.map(r => COLS.map(c => cell(r[c])).join(",")).join("\n") + "\n");
  }
  const sum = rs => {
    const w = rs.filter(r => num(r.line) != null), n = rs.length;
    const mae = (xs, f) => xs.length ? r2(xs.reduce((s, r) => s + Math.abs(f(r)), 0) / xs.length) : null;
    return { graded: n, leo_mae: mae(rs, r => num(r.error)), leo_bias: n ? r2(rs.reduce((s, r) => s + num(r.error), 0) / n) : null,
      with_line: w.length, leo_mae_with_line: mae(w, r => num(r.error)), line_mae: mae(w, r => num(r.line_error)),
      leo_closer: w.filter(r => r.closer === "leo").length, line_closer: w.filter(r => r.closer === "line").length, ties: w.filter(r => r.closer === "tie").length };
  };
  const dates = [...new Set(all.map(r => r.date))].sort();
  const summary = { built_at: new Date().toISOString(), tracking: "private test, not on the site", decision: "DEC-20261126-03 step 2",
    dates: dates.length ? `${dates[0]} to ${dates[dates.length - 1]} (${dates.length} nights)` : "none",
    backfill_rows: all.filter(r => r.source === "backfill").length,
    note: "MAE = mean absolute error vs the box score. Line = the last DraftKings line saved before tip. Bar (2): Leo's MAE no worse than the line's in a market over 3+ weeks before that market is considered for leans. Leans are not graded: which price is the over is inferred (price_1, from line moves), not yet confirmed against the book.",
    markets: {} };
  for (const k of ["pts", "reb", "ast", "pra"]) summary.markets[k] = sum(all.filter(r => r.market === k));
  fs.writeFileSync(path.join(DIR, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  for (const [k, s] of Object.entries(summary.markets)) console.log(`prop grade ${k}: ${s.graded} graded, Leo MAE ${s.leo_mae}; with a line ${s.with_line}: Leo ${s.leo_mae_with_line} vs line ${s.line_mae} (Leo closer ${s.leo_closer}, line closer ${s.line_closer})`);
  console.log(`prop grade: ${added.length} new rows, ${summary.dates}`);
}

try { main(); } catch (e) { console.error("prop grade: " + (e && e.message)); }
