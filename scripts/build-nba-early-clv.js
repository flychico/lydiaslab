#!/usr/bin/env node
/**
 * Private test: do Leo's NBA sides from the early read (the night before, 9:47pm ET, or up to 3 days ahead) beat
 * the closing line? Lynold, 2026-11-27, after a capper posted an 11-play card at 1:33am and 8 of his 9 spread
 * numbers moved his way by tip: "Yes" to testing whether Leo's early sides beat the close before any early post.
 *
 *   node scripts/build-nba-early-clv.js            (writes data/nba/early-clv/summary.json and games.csv)
 *   node scripts/build-nba-early-clv.js --backfill (first fills data/nba/early-reads/ from git history)
 *
 * For each game and each early read saved before its game day (data/nba/early-reads/<date>.json):
 *   Leo's side: the home team when Leo's home margin is above the line's (margin > -home_spread), else the away team;
 *   gap = how far Leo is from the line, in points.
 *   Closing line value (points, from Leo's side): home side = early spread minus closing spread; away side = the
 *   reverse. Positive means the market moved toward Leo after the read. Close: close_home_spread in
 *   data/nba/results-ledger.csv (ESPN's closing DraftKings line, else Leo's last capture).
 *   Cover at the early line (push = 0), from the final score.
 * Two views: "night before" (the last early read before game day) and "first" (the earliest early read).
 * Never shown on the site; never a Leo Pick; the line is never a model input (it is only what this test measures).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "data/nba");
const EDIR = path.join(DIR, "early-reads");
const OUT = path.join(DIR, "early-clv");
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const r2 = x => Math.round(x * 100) / 100;

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean), head = lines.shift().split(",");
  return lines.map(l => { const c = []; let cur = "", q = false;
    for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ",") { c.push(cur); cur = ""; } else cur += ch; }
    c.push(cur); return Object.fromEntries(head.map((h, i) => [h, c[i] ?? ""])); });
}

/** Rebuild early-reads files from every committed early version of data/nba/picks-<date>.json. */
function backfill() {
  const git = args => cp.execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  const files = git(["log", "--since=2026-11-23", "--name-only", "--format=", "--", "data/nba/"]).split("\n").filter(f => /data\/nba\/picks-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  let added = 0;
  for (const f of [...new Set(files)]) {
    const date = f.match(/(\d{4}-\d{2}-\d{2})/)[1];
    const ef = path.join(EDIR, `${date}.json`);
    const doc = fs.existsSync(ef) ? JSON.parse(fs.readFileSync(ef, "utf8")) : { date, reads: [] };
    const have = new Set(doc.reads.map(r => r.captured_at));
    for (const sha of git(["log", "--format=%H", "--", f]).split("\n").filter(Boolean).reverse()) {
      let j; try { j = JSON.parse(git(["show", `${sha}:${f}`])); } catch (e) { continue; }
      if (!j || !j.early || !j.generated_at || have.has(j.generated_at)) continue;
      doc.reads.push({ captured_at: j.generated_at, model_version: j.model_version, from_git: sha.slice(0, 9), games: (j.games || []).map(g => ({
        game_id: g.game_id, home: g.home, away: g.away, tip_utc: g.tip_utc,
        leo_home_margin: g.leo && g.leo.home_margin, leo_p_home: g.leo && g.leo.p_home, leo_total: g.leo && g.leo.projected && g.leo.projected.total,
        home_spread: g.market && g.market.home_spread, total: g.market && g.market.total, home_ml: g.market && g.market.home_ml, away_ml: g.market && g.market.away_ml })) });
      have.add(j.generated_at); added++;
    }
    if (doc.reads.length) { doc.reads.sort((a, b) => a.captured_at.localeCompare(b.captured_at)); fs.mkdirSync(EDIR, { recursive: true }); fs.writeFileSync(ef, JSON.stringify(doc, null, 1) + "\n"); }
  }
  console.log(`early clv: backfilled ${added} early reads from git history`);
}

function build() {
  if (!fs.existsSync(EDIR)) { console.log("early clv: no early reads yet"); return; }
  const ledger = new Map(parseCsv(fs.readFileSync(path.join(DIR, "results-ledger.csv"), "utf8")).map(r => [String(r.game_id), r]));
  const rows = [];
  for (const f of fs.readdirSync(EDIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()) {
    const doc = JSON.parse(fs.readFileSync(path.join(EDIR, f), "utf8"));
    // Only reads saved before game day (ET): the date's own morning reads are not "early".
    const reads = (doc.reads || []).filter(r => new Date(r.captured_at).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) < doc.date)
      .sort((a, b) => a.captured_at.localeCompare(b.captured_at));
    if (!reads.length) continue;
    // Lines post about a day before tip, so reads 2 or 3 days out usually have none: "first" is the earliest read with a line.
    const lined = reads.filter(r => (r.games || []).some(g => num(g.home_spread) != null));
    if (!lined.length) continue;
    const views = { first: lined[0], night_before: lined[lined.length - 1] };
    for (const [view, read] of Object.entries(views)) for (const g of read.games || []) {
      const L = ledger.get(String(g.game_id)); if (!L) continue;
      const m = num(g.leo_home_margin), s = num(g.home_spread), close = num(L.close_home_spread);
      const hs = num(L.home_score), as = num(L.away_score);
      if (m == null || s == null) continue;
      const home = m > -s, gap = Math.abs(m + s);
      const clv = close == null ? null : r2(home ? s - close : close - s);
      let cover = null;
      if (hs != null && as != null) { const res = (hs - as) + s; const v = home ? res : -res; cover = v > 0 ? 1 : v < 0 ? 0 : 0.5; }
      rows.push({ view, date: doc.date, game_id: g.game_id, matchup: `${g.away} @ ${g.home}`, read_at: read.captured_at, side: home ? g.home : g.away,
        leo_home_margin: m, early_home_spread: s, close_home_spread: close, gap: r2(gap), clv, cover });
    }
  }
  const sum = (rs) => {
    const c = rs.filter(r => r.clv != null), v = rs.filter(r => r.cover != null);
    const w = v.filter(r => r.cover === 1).length, l = v.filter(r => r.cover === 0).length, p = v.filter(r => r.cover === 0.5).length;
    return { games: rs.length, avg_clv_pts: c.length ? r2(c.reduce((a, r) => a + r.clv, 0) / c.length) : null,
      beat_close: c.filter(r => r.clv > 0).length, same_as_close: c.filter(r => r.clv === 0).length, worse_than_close: c.filter(r => r.clv < 0).length,
      covers: `${w}-${l}${p ? `-${p}` : ""}`, cover_pct: w + l ? r2(100 * w / (w + l)) : null, units_at_110: r2(w * (100 / 110) - l) };
  };
  const summary = { built_at: new Date().toISOString(), tracking: "private test, not on the site", started: "2026-11-27 (backfilled from Nov 24 early reads)",
    note: "Positive CLV means the line moved toward Leo's early side by the close. Break-even cover at -110 is 52.4%.", views: {} };
  for (const view of ["night_before", "first"]) {
    const rs = rows.filter(r => r.view === view);
    summary.views[view] = { all: sum(rs), gap_2_plus: sum(rs.filter(r => r.gap >= 2)), gap_4_plus: sum(rs.filter(r => r.gap >= 4)) };
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  const cols = Object.keys(rows[0] || { view: 1 });
  fs.writeFileSync(path.join(OUT, "games.csv"), [cols.join(","), ...rows.map(r => cols.map(c => r[c] == null ? "" : String(r[c]).includes(",") ? `"${r[c]}"` : r[c]).join(","))].join("\n") + "\n");
  for (const [v, s] of Object.entries(summary.views)) console.log(`early clv ${v}: ${s.all.games} games, CLV ${s.all.avg_clv_pts} pts (beat ${s.all.beat_close}, worse ${s.all.worse_than_close}), covers ${s.all.covers}; gap 2+: ${s.gap_2_plus.games} games, CLV ${s.gap_2_plus.avg_clv_pts}, covers ${s.gap_2_plus.covers}`);
}

if (process.argv.includes("--backfill")) backfill();
build();
