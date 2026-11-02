#!/usr/bin/env node
/**
 * Leo NFL closing line value (DEC-20261101-02).
 *
 * The question behind every pick: if you had taken Leo's side when Leo first
 * published it, did the market move toward you by kickoff? Wins and losses
 * need 50+ games to mean anything; line movement shows an edge (or its
 * absence) within weeks, because the closing line is the sharpest number
 * there is. Private: the owner brief and audit use it, public pages do not
 * compare Leo with the book (DEC-20260926-01).
 *
 *   node scripts/generate-nfl-clv.js            all graded dates
 *
 * PROPS (QB pass, RB rush, WR rec yards)
 *   first read = Leo's first projection of the day that has a line, joined to
 *                the first odds capture at or before it plus 20 minutes
 *                (the same gather writes both)
 *   close      = the last odds capture strictly before kickoff
 *   side       = Leo's lean at the first read (5% of the line floor, the
 *                same floor the record uses)
 *   clv_pts    = over: close line - first line; under: first line - close
 *                (positive means the market moved toward Leo)
 *   graded     = the first-read side against the actual at the FIRST line,
 *                units at the first-read price, 1 unit a pick
 *
 * GAMES (Leo picks above 60%, and spread sides)
 *   first read = Leo's first capture of the day (prediction-history.csv)
 *   close      = nflverse games.csv closing moneyline and spread
 *   moneyline clv = closing no-vig probability of Leo's team minus the
 *                   market's probability at the first read
 *   spread clv    = points the closing spread moved toward Leo's side
 *
 * Every capture used is strictly before kickoff; odds rows after kickoff
 * (live lines) are ignored. Writes data/nfl/clv-log.csv (one row per call,
 * rebuilt each run from the append-only histories) and data/nfl/clv.json.
 *
 * Segments tracked as tests from 2026-11-01 (DEC-20261101-01, -03): Leo
 * picks, WR unders, RB unders. Earlier dates are shown as in-sample history.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { splitCsv } = require("./lib/odds-history");

const ROOT = path.join(__dirname, "..");
const D = p => path.join(ROOT, "data/nfl", p);
const FEED = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";
const TEST_FROM = "2026-11-01";
const PROP_FLOOR = 0.05, SPREAD_FLOOR = 1.0, JOIN_MS = 20 * 60e3;
const MK = { QB_PASS_YARDS: "QB", RB_RUSH_YARDS: "RB", WR_REC_YARDS: "WR" };

const num = v => { const x = Number.parseFloat(v); return Number.isFinite(x) ? x : null; };
const r2 = x => x == null ? null : Math.round(x * 100) / 100;
function readCsv(f) {
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean);
  const h = splitCsv(lines.shift());
  return lines.map(l => { const c = splitCsv(l), o = {}; h.forEach((k, i) => o[k] = c[i]); return o; });
}
const profit = am => am == null ? null : am > 0 ? am / 100 : 100 / -am;
const implied = am => am == null ? null : am > 0 ? 100 / (am + 100) : -am / (-am + 100);
function noVig(a, b) { const x = implied(a), y = implied(b); return x == null || y == null ? [null, null] : [x / (x + y), y / (x + y)]; }

// ---- props -----------------------------------------------------------------
function propCalls() {
  const odds = readCsv(D("odds-history-props.csv")).filter(r => MK[r.market] && num(r.line) != null);
  const proj = readCsv(D("prop-prediction-history.csv")).filter(r => MK[r.market] && num(r.projection) != null);
  const graded = readCsv(D("nfl-props-graded.csv")).filter(r => MK[r.market]);
  const actual = new Map();
  for (const g of graded) actual.set(`${g.date}|${g.market}|${g.player}`, g);

  const key = r => `${r.date}|${r.market}|${r.player}`;
  const oddsBy = new Map(), projBy = new Map();
  for (const r of odds) (oddsBy.get(key(r)) || oddsBy.set(key(r), []).get(key(r))).push(r);
  for (const r of proj) (projBy.get(key(r)) || projBy.set(key(r), []).get(key(r))).push(r);

  const out = [];
  for (const [k, ps] of projBy) {
    const kick = Date.parse(ps[0].kickoff_utc);
    if (!Number.isFinite(kick)) continue;
    const os = (oddsBy.get(k) || []).filter(o => Date.parse(o.captured_at) < kick)
      .sort((a, b) => a.captured_at.localeCompare(b.captured_at));
    if (!os.length) continue;
    const pre = ps.filter(p => Date.parse(p.captured_at) < kick).sort((a, b) => a.captured_at.localeCompare(b.captured_at));
    // First projection that has a line captured with it (same gather).
    let first = null, line0 = null;
    for (const p of pre) {
      const t = Date.parse(p.captured_at);
      const o = os.filter(o => Date.parse(o.captured_at) <= t + JOIN_MS).pop();
      if (o) { first = p; line0 = o; break; }
    }
    if (!first) continue;
    const close = os[os.length - 1];
    const L0 = num(line0.line), P0 = num(first.projection), LC = num(close.line);
    const gap = P0 - L0;
    const side = Math.abs(gap) >= PROP_FLOOR * Math.abs(L0) && gap !== 0 ? (gap > 0 ? "over" : "under") : "";
    const g = actual.get(k);
    const act = g && g.excluded !== "Y" ? num(g.actual) : null;
    const price0 = side ? num(side === "over" ? line0.over_price : line0.under_price) : null;
    const priceC = side ? num(side === "over" ? close.over_price : close.under_price) : null;
    let result = "";
    if (side && act != null) result = act === L0 ? "P" : ((act > L0) === (side === "over") ? "W" : "L");
    out.push({
      date: first.date, kind: "prop", market: first.market, group: MK[first.market], player: first.player,
      team: first.team, matchup: first.matchup, side,
      first_at: first.captured_at, first_line: L0, first_price: price0, projection: P0,
      close_at: close.captured_at, close_line: LC, close_price: priceC,
      clv_pts: side ? r2(side === "over" ? LC - L0 : L0 - LC) : null,
      minutes_before_kick_first: Math.round((kick - Date.parse(first.captured_at)) / 6e4),
      actual: act, result, units: result === "W" ? r2(profit(price0)) : result === "L" ? -1 : result === "P" ? 0 : null
    });
  }
  return out;
}

// ---- games -----------------------------------------------------------------
function gameCalls() {
  let feed = [];
  try { feed = parseFeed(execFileSync("curl", ["-sSL", "--fail", "--max-time", "120", FEED], { maxBuffer: 1 << 28, encoding: "utf8" })); }
  catch (e) { console.log(`  games.csv unavailable (${e.message.split("\n")[0]}); game CLV skipped`); return []; }
  const byId = new Map(feed.map(g => [g.game_id, g]));
  const hist = readCsv(D("prediction-history.csv"));
  const first = new Map();
  for (const r of hist.sort((a, b) => a.captured_at.localeCompare(b.captured_at))) {
    if (Date.parse(r.captured_at) >= Date.parse(r.kickoff_utc)) continue;
    if (!first.has(r.game_id)) first.set(r.game_id, r);
  }
  const out = [];
  for (const [id, r] of first) {
    const g = byId.get(id); if (!g || g.result === "" || g.home_score === "") continue;
    const hs = num(g.home_score), as = num(g.away_score), winner = hs > as ? g.home_team : as > hs ? g.away_team : "TIE";
    const [cAway, cHome] = noVig(num(g.away_moneyline), num(g.home_moneyline));
    const prob = num(r.model_prob), mprob0 = num(r.market_prob), price0 = num(r.price);
    const isHome = r.pick === r.home;
    const closeProb = isHome ? cHome : cAway;
    const paused = r.date >= "2026-10-17" && r.date <= "2026-10-31";
    // DEC-20261102-01: from Nov 5 the moneyline call also needs a price
    // better than -230 (scripts/lib/nfl-calls.js).
    const CALLS = require("./lib/nfl-calls");
    const isPick = prob != null && prob > 0.60 && String(r.model_version || "").startsWith("leo-nflml-v2")
      && (r.date < CALLS.RULES.FROM || !!CALLS.calls(r).ml.call);
    if (isPick) {
      const res = winner === "TIE" ? "P" : winner === r.pick ? "W" : "L";
      out.push({ date: r.date, kind: "moneyline", market: "MONEYLINE", group: "ML", player: "", team: r.pick, matchup: r.matchup,
        side: r.pick, first_at: r.captured_at, first_line: "", first_price: price0, projection: prob,
        close_at: "close", close_line: "", close_price: num(isHome ? g.home_moneyline : g.away_moneyline),
        clv_pts: closeProb == null || mprob0 == null ? null : r2(100 * (closeProb - mprob0)),
        minutes_before_kick_first: Math.round((Date.parse(r.kickoff_utc) - Date.parse(r.captured_at)) / 6e4),
        actual: winner, result: res, units: res === "W" ? r2(profit(price0)) : res === "L" ? -1 : 0, paused });
    }
    // Spread side at the first read: Leo's home margin against the home line.
    const m = num(r.exp_margin), l0 = num(r.spread_line), lc = num(g.spread_line);
    const spreadOk = r.date < require("./lib/nfl-calls").RULES.FROM || !!require("./lib/nfl-calls").calls(r).spread.call;
    if (m != null && l0 != null && Math.abs(m - l0) >= SPREAD_FLOOR && spreadOk) {
      const homeSide = m > l0, marg = hs - as;
      // home_line is stated as home favoured by +x; home covers if margin > line.
      const res = marg === l0 ? "P" : ((marg > l0) === homeSide ? "W" : "L");
      out.push({ date: r.date, kind: "spread", market: "SPREAD", group: "SP", player: "", team: homeSide ? r.home : r.away, matchup: r.matchup,
        side: homeSide ? r.home : r.away, first_at: r.captured_at, first_line: l0, first_price: -110, projection: m,
        close_at: "close", close_line: lc, close_price: -110,
        // Taking home at l0: a higher closing line means the market moved toward home.
        clv_pts: lc == null ? null : r2(homeSide ? lc - l0 : l0 - lc),
        minutes_before_kick_first: Math.round((Date.parse(r.kickoff_utc) - Date.parse(r.captured_at)) / 6e4),
        actual: marg, result: res, units: res === "W" ? r2(profit(-110)) : res === "L" ? -1 : 0 });
    }
  }
  return out;
}
function parseFeed(text) {
  const lines = text.split(/\r?\n/).filter(Boolean), h = splitCsv(lines.shift());
  return lines.map(l => { const c = splitCsv(l), o = {}; h.forEach((k, i) => o[k] = c[i]); return o; })
    .filter(g => Number(g.season) >= 2026);
}

// ---- summaries -------------------------------------------------------------
function summ(rows) {
  const s = rows.filter(r => r.side);
  const dec = s.filter(r => r.result === "W" || r.result === "L");
  const clv = s.filter(r => r.clv_pts != null);
  const u = s.filter(r => r.units != null);
  return {
    calls: s.length,
    record: `${s.filter(r => r.result === "W").length}-${s.filter(r => r.result === "L").length}${s.some(r => r.result === "P") ? "-" + s.filter(r => r.result === "P").length : ""}`,
    win_pct: dec.length ? r2(100 * s.filter(r => r.result === "W").length / dec.length) : null,
    units: r2(u.reduce((a, r) => a + r.units, 0)),
    roi_pct: u.length ? r2(100 * u.reduce((a, r) => a + r.units, 0) / u.length) : null,
    clv_n: clv.length,
    clv_avg: clv.length ? r2(clv.reduce((a, r) => a + r.clv_pts, 0) / clv.length) : null,
    moved_toward_pct: clv.length ? r2(100 * clv.filter(r => r.clv_pts > 0).length / clv.length) : null,
    moved_against_pct: clv.length ? r2(100 * clv.filter(r => r.clv_pts < 0).length / clv.length) : null
  };
}

function main() {
  const rows = [...propCalls(), ...gameCalls()].sort((a, b) => a.date.localeCompare(b.date) || a.matchup.localeCompare(b.matchup));
  const COLS = ["date", "kind", "market", "group", "player", "team", "matchup", "side", "first_at", "first_line", "first_price", "projection",
    "close_at", "close_line", "close_price", "clv_pts", "minutes_before_kick_first", "actual", "result", "units"];
  const esc = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  fs.writeFileSync(D("clv-log.csv"), [COLS.join(","), ...rows.map(r => COLS.map(c => esc(r[c])).join(","))].join("\n") + "\n");

  const after = r => r.date >= TEST_FROM, before = r => r.date < TEST_FROM;
  const P = rows.filter(r => r.kind === "prop");
  const seg = {};
  for (const g of ["QB", "RB", "WR"]) {
    seg[g] = summ(P.filter(r => r.group === g));
    for (const sd of ["over", "under"]) seg[`${g} ${sd}`] = summ(P.filter(r => r.group === g && r.side === sd));
  }
  const ml = rows.filter(r => r.kind === "moneyline");
  const doc = {
    generated_at: new Date().toISOString(),
    method: "first read with a line vs last capture before kickoff; units at the first-read price; clv_pts positive = market moved toward Leo (moneyline in percentage points of no-vig probability)",
    through: rows.length ? rows[rows.length - 1].date : null,
    all_time: {
      props: summ(P), by_segment: seg,
      leo_picks: summ(ml), spread: summ(rows.filter(r => r.kind === "spread"))
    },
    tests_from: TEST_FROM,
    tests: {
      leo_picks: summ(ml.filter(after)),
      wr_unders: summ(P.filter(r => after(r) && r.group === "WR" && r.side === "under")),
      rb_unders: summ(P.filter(r => after(r) && r.group === "RB" && r.side === "under"))
    },
    in_sample_before_tests: {
      leo_picks: summ(ml.filter(r => before(r) && !r.paused)),
      leo_picks_during_pause: summ(ml.filter(r => r.paused)),
      wr_unders: summ(P.filter(r => before(r) && r.group === "WR" && r.side === "under")),
      rb_unders: summ(P.filter(r => before(r) && r.group === "RB" && r.side === "under"))
    }
  };
  fs.writeFileSync(D("clv.json"), JSON.stringify(doc, null, 2) + "\n");

  console.log(`\nNFL CLOSING LINE VALUE (through ${doc.through})\n${"=".repeat(58)}`);
  const line = (k, s) => console.log(`  ${k.padEnd(18)} ${String(s.calls).padStart(4)} calls  ${s.record.padEnd(9)} units ${String(s.units).padStart(7)}  ROI ${String(s.roi_pct).padStart(6)}%  CLV avg ${String(s.clv_avg).padStart(6)}  toward ${s.moved_toward_pct}% against ${s.moved_against_pct}%`);
  line("ALL PROPS", doc.all_time.props);
  for (const [k, s] of Object.entries(seg)) line(k, s);
  line("LEO PICKS (ML)", doc.all_time.leo_picks);
  line("SPREAD SIDES", doc.all_time.spread);
  console.log(`  tests from ${TEST_FROM}:`);
  for (const [k, s] of Object.entries(doc.tests)) line(k, s);
  console.log(`  wrote clv-log.csv (${rows.length} rows) and clv.json\n${"=".repeat(58)}\n`);
}
main();
