#!/usr/bin/env node
/*
  Leo MLB season review (DEC-20261031-15).

  Rebuilds, from the repo's own git history, what Leo actually said BEFORE
  each game started, then lines it up with what happened. Read-only on the
  model: it changes no pick, gate, weight or record.

  Writes data/review/mlb-<season>/:
    freeze_audit.csv   every graded official pick (results_log.csv) with the
                       time it first appeared on the published card, plus picks
                       removed from the card after first pitch and never graded
    game_review.csv    one row per game: Leo's last read committed before the
                       scheduled start (data/member-brief history), the market
                       in that read, the closing proxy (last data/moneyline-odds
                       snapshot before start), the result and a lesson tag
    kprop_review.csv   one row per pitcher start with a line: the last
                       data/k-props capture before the start and the actual Ks
    summary.json       headline numbers (record, wins vs market, Brier, K miss)

  Rule of record: a read counts only if the commit that holds it landed before
  the scheduled start ("time" / game_time_iso). Commit time is when it became
  public. Scheduled start, not actual first pitch: a rain delay can only make a
  late read look frozen, never the reverse.

  Needs full git history (GitHub Desktop clones have it; on Actions use
  actions/checkout with fetch-depth: 0). Node built-ins only.

  Usage: node scripts/build-mlb-season-review.js [--season 2026]
*/
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const SEASON = (args[args.indexOf("--season") + 1] && args.includes("--season")) ? args[args.indexOf("--season") + 1] : "2026";
const POSTSEASON_FROM = { "2026": "2026-09-28" }[SEASON] || `${SEASON}-09-28`;
const OUT = path.join(ROOT, "data", "review", `mlb-${SEASON}`);

// ---------- helpers ----------
function git(...a) {
  return execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}
function history(rel) {
  // oldest first: [{hash, time}]
  const out = git("log", "--reverse", "--format=%H %cI", "--", rel).trim();
  if (!out) return [];
  return out.split("\n").map(l => { const [hash, time] = l.split(" "); return { hash, time: new Date(time) }; });
}
function showJson(hash, rel) {
  try { return JSON.parse(git("show", `${hash}:${rel}`)); } catch (e) { return null; }
}
function parseCsv(text) {
  const rows = []; let row = []; let f = ""; let q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f.replace(/\r$/, "")); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f.replace(/\r$/, "")); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? "" : r[i]])));
}
function readCsv(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? parseCsv(fs.readFileSync(p, "utf8")) : [];
}
function isoDate(s) {
  s = String(s || "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}
const num = x => (x === null || x === undefined || x === "" || isNaN(Number(x))) ? null : Number(x);
const r4 = x => x === null ? null : Math.round(x * 10000) / 10000;
function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(file, rows) {
  if (!rows.length) { fs.writeFileSync(file, ""); return; }
  const cols = Object.keys(rows[0]);
  fs.writeFileSync(file, [cols.join(","), ...rows.map(r => cols.map(c => csvCell(r[c])).join(","))].join("\n") + "\n");
}
function units(price, won) {
  if (price === null) return null;
  if (!won) return -1;
  return price > 0 ? price / 100 : 100 / Math.abs(price);
}
const phase = d => d >= POSTSEASON_FROM ? "postseason" : "regular";
function seasonFiles(dir) {
  const p = path.join(ROOT, "data", dir);
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p).filter(f => f.startsWith(`${SEASON}-`) && f.endsWith(".json")).sort().map(f => `data/${dir}/${f}`);
}

// ---------- 1. freeze audit of official picks ----------
function buildFreezeAudit() {
  const first = new Map(); // key -> info
  for (const rel of seasonFiles("published-picks")) {
    for (const { hash, time } of history(rel)) {
      const d = showJson(hash, rel); if (!d) continue;
      const present = new Set();
      for (const p of d.picks || []) {
        const items = [];
        const ml = p.moneyline || {};
        if (ml.pick && !ml.isPass) items.push([`ml|${d.date}|${p.gamePk}|${ml.pick}`, { price: num(ml.bestAm), line: null }]);
        for (const k of p.strikeouts || []) items.push([`k|${d.date}|${p.gamePk}|${k.pitcher}|${k.pick}`, { price: num(k.bestAm), line: num(k.line) }]);
        for (const [key, v] of items) {
          present.add(key);
          if (!first.has(key)) first.set(key, { firstCommit: time, start: new Date(p.time), first: v, date: d.date });
        }
      }
      for (const [key, info] of first) if (info.date === d.date && !present.has(key) && !info.removed) info.removed = time;
    }
  }
  const out = []; const graded = new Set();
  for (const r of readCsv("data/results_log.csv")) {
    if (!r.date.startsWith(SEASON)) continue;
    let key;
    if (r.market === "moneyline") key = `ml|${r.date}|${r.game_pk}|${r.pick}`;
    else if (r.market === "pitcher_strikeouts") key = `k|${r.date}|${r.game_pk}|${r.pitcher}|${r.pick}`;
    else continue;
    graded.add(key);
    const info = first.get(key);
    const mins = info ? Math.round((info.firstCommit - info.start) / 6000) / 10 : null;
    out.push({
      date: r.date, phase: phase(r.date), game_pk: r.game_pk, market: r.market, pitcher: r.pitcher, pick: r.pick,
      line: r.line, price: r.price, result: r.result,
      scheduled_start_utc: info ? info.start.toISOString() : "", first_published_utc: info ? info.firstCommit.toISOString() : "",
      minutes_after_start: mins, status: !info ? "no_card_history" : (info.firstCommit < info.start ? "frozen" : "added_after_start"),
    });
  }
  for (const [key, info] of first) {
    if (graded.has(key) || !info.removed || info.removed < info.start) continue;
    const p = key.split("|");
    out.push({
      date: p[1], phase: phase(p[1]), game_pk: p[2], market: p[0] === "ml" ? "moneyline" : "pitcher_strikeouts",
      pitcher: p[0] === "k" ? p[3] : "", pick: p[0] === "k" ? p[4] : p[3], line: info.first.line ?? "", price: info.first.price ?? "",
      result: "not_graded", scheduled_start_utc: info.start.toISOString(), first_published_utc: info.firstCommit.toISOString(),
      minutes_after_start: null, status: `removed_after_start ${info.removed.toISOString()}`,
    });
  }
  return out;
}

// ---------- 2. per-game review ----------
function frozenReads(dir, perItem) {
  // last capture committed before each item's scheduled start
  const frozen = new Map(); const seen = new Map();
  for (const rel of seasonFiles(dir)) {
    for (const { hash, time } of history(rel)) {
      const d = showJson(hash, rel); if (!d) continue;
      for (const [key, item, start] of perItem(d)) {
        if (!start) continue;
        seen.set(key, (seen.get(key) || 0) + 1);
        if (time < start) frozen.set(key, { time, item, start, doc: d });
      }
    }
  }
  return { frozen, seen };
}
function keyed(rel, gk) {
  const m = new Map();
  for (const r of readCsv(rel)) m.set(`${isoDate(r.date)}|${r[gk]}`, r);
  return m;
}
function buildGameReview() {
  const { frozen, seen } = frozenReads("member-brief", d => (d.games || []).map(g => [`${d.date}|${g.game_pk}`, g, g.game_time_iso ? new Date(g.game_time_iso) : null]));
  const att = keyed("data/calibration/attribution_model_log.csv", "gamePk");
  const sh = keyed("data/calibration/shadow_model_log.csv", "gamePk");
  const cal = keyed("data/calibration/calibration_model_log.csv", "gamePk");
  const rec = keyed("data/calibration/recap_components.csv", "game_pk");
  const tot = keyed("data/calibration/totals_model_log.csv", "gamePk");
  const voided = new Set(readCsv("data/calibration/voided_log.csv").map(r => `${r.date}|${r.gamePk}`));

  // closing proxy snapshots, per date
  const oddsCache = new Map();
  function oddsSnaps(date) {
    if (!oddsCache.has(date)) {
      const rel = `data/moneyline-odds/${date}.json`;
      oddsCache.set(date, history(rel).map(h => ({ time: h.time, doc: showJson(h.hash, rel) })).filter(s => s.doc));
    }
    return oddsCache.get(date);
  }

  const rows = [];
  for (const [key, { time, item: g, start }] of [...frozen].sort()) {
    const [date, pk] = key.split("|");
    const side = g.side; const mp = num(g.model_probability);
    if (!["home", "away"].includes(side) || mp === null) continue;
    const opp = side === "home" ? "away" : "home";
    const mkt = g.market || {}; const pe = g.pitcher_edge || {}; const off = g.offense_form || {};
    const bp = g.bullpen || {}; const lb = g.lab_score_breakdown || {};
    const mktSide = num(mkt[`${side}_no_vig`]);
    // result
    let winner = null, wsrc = null;
    const a = att.get(key), s = sh.get(key), c = cal.get(key);
    if (a && ["home", "away"].includes(a.winner)) { winner = a.winner; wsrc = "attribution"; }
    else if (s && ["1", "0", "true", "false", "True", "False"].includes(s.home_won)) { winner = ["1", "true", "True"].includes(s.home_won) ? "home" : "away"; wsrc = "shadow"; }
    else if (c && ["W", "L"].includes(c.result)) { const sideHome = c.model_side === g.home_team; winner = (sideHome === (c.result === "W")) ? "home" : "away"; wsrc = "calibration"; }
    // closing proxy
    let closeProb = null, closeMins = null;
    const mk = String(g.game || "").replace(" @ ", "@");
    const pre = oddsSnaps(date).filter(x => x.time < start && x.doc.games && x.doc.games[mk]);
    if (pre.length) {
      const last = pre[pre.length - 1]; const gg = last.doc.games[mk];
      closeProb = r4(side === "home" ? gg.pHome : gg.pAway); closeMins = Math.round((start - last.time) / 60000);
    }
    const rc = rec.get(key) || {}; const t = tot.get(key) || {};
    const r = {
      date, phase: phase(date), game_pk: pk, matchup: g.game, captured_utc: time.toISOString(), start_utc: g.game_time_iso,
      captures_before_start: null, captures_total: seen.get(key) || 0,
      model_source: g.model_source || "unlabelled", status: g.status, leo_side_team: g.pick_team, leo_side: side,
      leo_prob: mp, leo_prob_pre_bullpen: num(g.model_probability_pre_bullpen),
      market_prob: mktSide, price: num(mkt[`${side}_price`]), books: mkt.books ?? null,
      edge: mktSide === null ? null : r4(mp - mktSide), close_prob: closeProb, close_mins_before_start: closeMins,
      lab_score: num(g.lab_score), lab_pitching_pts: num(lb.pitching_plan_points), lab_offense_pts: num(lb.offense_points),
      lab_conviction_pts: num(lb.conviction_points), lab_bullpen_pts: num(lb.bullpen_points),
      pitcher_edge_team: pe.team ?? null, pitcher_gap: num(pe.gap),
      leo_side_pitcher: pe[`${side}_pitcher`] ?? null, opp_pitcher: pe[`${opp}_pitcher`] ?? null,
      leo_side_pitcher_score: num(pe[`${side}_score`]), opp_pitcher_score: num(pe[`${opp}_score`]),
      leo_side_era: num(pe[`${side}_era`]), opp_era: num(pe[`${opp}_era`]),
      leo_side_woba_delta: num((off[side] || {}).delta_woba), opp_woba_delta: num((off[opp] || {}).delta_woba),
      leo_side_bullpen_score: num((bp.pick_team || {}).score), opp_bullpen_score: num((bp.opponent || {}).score),
      bullpen_logodds_adj: num(g.bullpen_log_odds_adjustment), bullpen_game: g.bullpen_game ?? null,
      winner_side: winner, winner_source: wsrc, leo_side_won: winner ? (winner === side ? 1 : 0) : null,
      total_runs: num(t.actual_total),
      starter_favored_team: rc.starter_favored_team ?? null, starter_held_up: rc.starter_held_up ?? null,
      leo_side_bullpen_er: num(rc[`${side}_bullpen_actual_er`]), opp_bullpen_er: num(rc[`${opp}_bullpen_actual_er`]),
      starter_changed: voided.has(key) ? 1 : 0,
    };
    Object.assign(r, lessonTag(r));
    rows.push(r);
  }
  const noRead = [...seen.keys()].filter(k => !frozen.has(k));
  return { rows, noRead };
}
// Diagnostic tag, written after the result is known. Not a model input.
function lessonTag(r) {
  if (r.leo_side_won === null) return { lesson_tag: "no_result", lesson_notes: "" };
  const won = r.leo_side_won === 1; const notes = [];
  const leoHasStarterEdge = r.pitcher_edge_team === r.leo_side_team;
  if (r.starter_changed) notes.push("starter changed after the read");
  if (r.bullpen_game === true) notes.push("bullpen game");
  if (r.edge !== null && r.edge >= 0.10) notes.push(`Leo ${Math.round(100 * r.edge)} pts above market`);
  if (leoHasStarterEdge && r.starter_held_up === "0") notes.push("Leo-side starter did not hold up");
  if (leoHasStarterEdge && r.starter_held_up === "1") notes.push("Leo-side starter held up");
  if (r.leo_side_bullpen_er !== null && r.leo_side_bullpen_er >= 3) notes.push(`Leo-side bullpen allowed ${r.leo_side_bullpen_er} ER`);
  let tag;
  if (won) tag = (r.market_prob !== null && r.market_prob < 0.5) ? "won_as_market_underdog" : "won_with_market";
  else if (r.starter_changed) tag = "lost_input_error";
  else if (leoHasStarterEdge && r.starter_held_up === "0") tag = "lost_starter_failed";
  else if (r.leo_side_bullpen_er !== null && r.leo_side_bullpen_er >= 3) tag = "lost_bullpen";
  else if (r.market_prob !== null && r.market_prob < 0.5) tag = "lost_disagreed_with_market";
  else tag = "lost_favorite_upset";
  return { lesson_tag: tag, lesson_notes: notes.join("; ") };
}

// ---------- 3. K prop review ----------
function buildKReview(gameStarts) {
  const actual = new Map();
  for (const r of readCsv("data/calibration/kprops_log.csv")) if (r.actual_k !== "") actual.set(`${isoDate(r.date)}|${r.pitcher}`, num(r.actual_k));
  const { frozen } = frozenReads("k-props", d => Object.values(d.pitchers || {}).map(p => {
    const s = gameStarts.get(`${d.date}|${p.game}`);
    return [`${d.date}|${p.name}`, p, s ? new Date(s.start) : null];
  }));
  const rows = [];
  for (const [key, { time, item: p, start }] of [...frozen].sort()) {
    if (p.line === null || p.line === undefined) continue;
    const date = key.split("|")[0]; const rf = p.recent_form || {};
    const a = actual.has(key) ? actual.get(key) : null; const proj = num(p.projection); const line = num(p.line);
    rows.push({
      date, phase: phase(date), game_pk: (gameStarts.get(`${date}|${p.game}`) || {}).pk ?? null, game: p.game, pitcher: p.name,
      captured_utc: time.toISOString(), start_utc: start.toISOString(), line, over_price: num(p.over), under_price: num(p.under), books: num(p.books),
      projection: proj, projection_raw: num(p.projection_raw), calibration_bias: num(p.calibration_bias), calibration_band: p.calibration_band ?? null,
      gap_vs_line: proj === null ? null : r4(proj - line),
      k_rate_season: num(p.k_rate_season), k_rate_used: num(p.k_rate_used), recent_k_rate: num(rf.recent_k_rate), recent_weight: num(rf.weight), recent_starts: num(rf.starts),
      expected_innings: num(p.expected_innings), bf_per_ip: num(p.bf_per_ip), opp_k_adjustment: num(p.opp_k_adjustment), opp_k_source: p.opp_k_source ?? null,
      opp_lineup_source: p.opp_lineup_source ?? null, whiff_leverage: num(p.whiff_leverage), bullpen_game: p.bullpen_game ?? null,
      actual_k: a, error: (a !== null && proj !== null) ? r4(a - proj) : null, line_error: a !== null ? r4(a - line) : null,
    });
  }
  return rows;
}

// ---------- summary ----------
function summarize(audit, games, krows, noRead) {
  const rec = rs => {
    const g = rs.filter(r => r.result === "W" || r.result === "L");
    const w = g.filter(r => r.result === "W").length;
    const u = g.reduce((s, r) => s + units(num(r.price), r.result === "W"), 0);
    return { record: `${w}-${g.length - w}`, n: g.length, units: Math.round(u * 100) / 100, roi_pct: g.length ? Math.round(1000 * u / g.length) / 10 : null };
  };
  const official = {};
  for (const m of ["moneyline", "pitcher_strikeouts"]) {
    const A = audit.filter(r => r.market === m && r.result !== "not_graded");
    const F = A.filter(r => r.status === "frozen");
    official[m] = { all_graded: rec(A), frozen: rec(F), added_after_start: rec(A.filter(r => r.status === "added_after_start")),
      frozen_by_month: Object.fromEntries([...new Set(F.map(r => r.date.slice(0, 7)))].sort().map(mo => [mo, rec(F.filter(r => r.date.startsWith(mo)))])),
      frozen_by_phase: { regular: rec(F.filter(r => r.phase === "regular")), postseason: rec(F.filter(r => r.phase === "postseason")) },
      removed_after_start: audit.filter(r => r.market === m && r.result === "not_graded").length };
  }
  const vsMarket = (rs, probKey) => {
    rs = rs.filter(r => r.leo_side_won !== null && r[probKey] !== null);
    const n = rs.length; if (!n) return { n: 0 };
    const won = rs.reduce((s, r) => s + r.leo_side_won, 0); const exp = rs.reduce((s, r) => s + r[probKey], 0);
    const sd = Math.sqrt(rs.reduce((s, r) => s + r[probKey] * (1 - r[probKey]), 0));
    const brier = k => Math.round(10000 * rs.reduce((s, r) => s + (r[k] - r.leo_side_won) ** 2, 0) / n) / 10000;
    return { n, leo_side_won: won, market_expected: Math.round(exp * 10) / 10, wins_vs_market: Math.round((won - exp) * 10) / 10, sd: Math.round(sd * 10) / 10,
      leo_said: Math.round(1000 * rs.reduce((s, r) => s + r.leo_prob, 0) / n) / 1000, brier_leo: brier("leo_prob"), brier_market: brier(probKey) };
  };
  const leo = games.filter(r => r.model_source === "leo");
  const kd = krows.filter(r => r.actual_k !== null && r.projection !== null);
  const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  return {
    season: SEASON, generated_at: new Date().toISOString(),
    rule: "A read counts only if committed before the scheduled start.",
    official_picks: official,
    leo_moneyline_every_game: { vs_capture_market: vsMarket(leo, "market_prob"), vs_closing_proxy: vsMarket(leo, "close_prob"),
      by_month: Object.fromEntries([...new Set(leo.map(r => r.date.slice(0, 7)))].sort().map(mo => [mo, vsMarket(leo.filter(r => r.date.startsWith(mo)), "market_prob")])) },
    lesson_tags: leo.reduce((o, r) => (o[r.lesson_tag] = (o[r.lesson_tag] || 0) + 1, o), {}),
    games_without_pre_start_read: noRead.length,
    kprops_every_start: kd.length ? { n: kd.length, avg_miss_leo: Math.round(100 * mean(kd.map(r => Math.abs(r.error)))) / 100,
      avg_miss_line: Math.round(100 * mean(kd.map(r => Math.abs(r.line_error)))) / 100,
      leo_closer_share: Math.round(1000 * kd.filter(r => Math.abs(r.error) < Math.abs(r.line_error)).length / kd.length) / 1000 } : null,
  };
}

// ---------- main ----------
function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const audit = buildFreezeAudit();
  const { rows: games, noRead } = buildGameReview();
  const starts = new Map(games.map(g => [`${g.date}|${g.matchup}`, { start: g.start_utc, pk: g.game_pk }]));
  const krows = buildKReview(starts);
  writeCsv(path.join(OUT, "freeze_audit.csv"), audit);
  writeCsv(path.join(OUT, "game_review.csv"), games);
  writeCsv(path.join(OUT, "kprop_review.csv"), krows);
  const summary = summarize(audit, games, krows, noRead);
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`MLB ${SEASON} review: ${audit.length} official picks audited, ${games.length} games, ${krows.length} K starts -> ${path.relative(ROOT, OUT)}`);
  const ml = summary.official_picks.moneyline.frozen, k = summary.official_picks.pitcher_strikeouts.frozen, v = summary.leo_moneyline_every_game.vs_capture_market;
  console.log(`Frozen official: moneyline ${ml.record} ${ml.units}u (${ml.roi_pct}%), K ${k.record} ${k.units}u (${k.roi_pct}%). Every game: Leo side ${v.leo_side_won}/${v.n}, ${v.wins_vs_market} vs market.`);
}
main();
