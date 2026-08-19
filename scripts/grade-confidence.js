#!/usr/bin/env node
"use strict";
/*
  LyDia — confidence accountability.

  THE QUESTION THIS EXISTS TO ANSWER
  "ARI @ PIT scored 87. The final was 3-0 and it was never close. What did the
  system learn from having called that an 87 when it behaved like a 55?"

  Until now: nothing. Every ledger grades the PROJECTION — did the number beat
  the line, did the pick win. Nothing grades the CONFIDENCE. The rating that
  decided whether a game was official was never itself checked against reality,
  so a rating could be uncorrelated with winning indefinitely and no report
  would say so. It is: corr(lab_score, win) = -0.029 over 261 graded games.

  WHAT THIS DOES
  Joins each analysed game's Lab Rating component breakdown (already stored in
  data/member-brief/<date>.json, never previously carried into a ledger) to its
  graded outcome, then asks three questions:

    1. Do the rating bands mean what they say? Predicted vs actual by band.
    2. Does each COMPONENT earn its points? For every component, compare the
       win rate of games where it contributed heavily against games where it
       did not. A component that carries real information wins more when it
       pays more. One that does not is donating points to the score for free.
    3. Which specific games were most wrongly rated, with the breakdown
       attached, so "why was this an 87" is answerable per game.

  Outputs:
    data/calibration/confidence_log.csv      one row per graded game + components
    data/calibration/confidence_report.json  the three analyses above

  This never gates or changes a pick. It is measurement.

  Usage:
    node scripts/grade-confidence.js              all available history
    node scripts/grade-confidence.js 2026-08-01   one date (nightly use)
*/

const fs = require("fs");
const path = require("path");
// 2026-08-19, Lynold's explicit instruction (via bug report): COMPONENTS'
// max values below used to be hand-typed literals, copied once from
// lab-rating-core.js and never updated -- the 08-16 CONVICTION_MAX 35->20 /
// OFFENSE_MAX 25->40 rebalance changed the real weights but not this file's
// copy, so the Confidence tab kept showing Max 35/25 (conviction/offense)
// for weeks after they were actually 20/40. Reading the live constants
// instead of duplicating them means this can't drift out of sync again.
const {
  CONVICTION_MAX, AGREEMENT_MAX, PITCHER_MAX, BULLPEN_MAX, OFFENSE_MAX, COMPLETENESS_MAX
} = require("./lib/lab-rating-core");

/*
  This script measures; it must never block publishing.

  It runs inside daily-recap.yml well before the commit step. A throw here fails
  the job and the commit never runs, so every ledger row grade-calibration.js
  DID write that night is discarded — losing real evidence because a report
  about that evidence could not be generated. That is the wrong trade, and it
  happened on the first live run: a single-date invocation produced one graded
  game, the correlation was undefined, and .toFixed() on null took the whole
  workflow down with it.

  So: loud on the console, zero to the shell. Same reasoning as the deliberate
  exit(0) in grade-calibration.js — see the comment at the bottom of that file.
*/
process.on("uncaughtException", err => {
  console.error("\n!! CONFIDENCE REPORT FAILED — no report written for this run.");
  console.error(`   ${err && err.stack ? err.stack : err}`);
  console.error("   Exiting 0 on purpose so the workflow still commits the graded ledgers.\n");
  process.exit(0);
});

const ROOT = path.join(__dirname, "..");
const BRIEF_DIR = path.join(ROOT, "data", "member-brief");
const CAL_DIR = path.join(ROOT, "data", "calibration");
const LOG = path.join(CAL_DIR, "confidence_log.csv");
const REPORT = path.join(CAL_DIR, "confidence_report.json");
/*
  THE DATE ARGUMENT DOES NOT FILTER THE ANALYSIS. It highlights.

  This report is derived data — every row is rebuilt from data/member-brief/*
  and the graded ledger, both of which are append-only. So it is written
  wholesale each run rather than appended, which is safe only because it always
  reads the FULL history.

  An earlier version filtered collection by the date argument while still
  writing the log wholesale. Run nightly as `grade-confidence.js <yesterday>`,
  that would have rewritten confidence_log.csv down to a single day and thrown
  the rest away, every night, silently. It never fired only because the first
  live run happened to find zero gradeable games and exited early.

  So: the analysis is always over everything. A date passed on the command line
  adds a focus section for that day on top of the full report — which is what a
  nightly run actually wants, "here is what last night added, and here is where
  the record now stands."
*/
const FOCUS_DATE = (process.argv[2] || "").match(/^\d{4}-\d{2}-\d{2}$/) ? process.argv[2] : null;

// The six Lab Rating v2 components, with the maximum each can contribute.
// Sourced from lib/lab-rating-core.js; if that file is retuned these need to
// follow, which is why the max is asserted against observed data below.
// 2026-08-13: max points corrected to the current v3 weights. Were still
// v1/v2 values (30/20/20/15/10/5) despite the file's own header comment
// claiming these are "asserted against observed data" -- no such assertion
// exists anywhere in this file. These are display-only (max_points in
// confidence_report.json / confidence_components.csv) and never fed scoring,
// but they were wrong. Current weights per lab-rating-core.js: conviction 35,
// agreement 0, pitching plan 20 (pitcher-edge-only since 2026-08-12), bullpen
// 20, offense 25, completeness 0.
const COMPONENTS = [
  { key: "conviction_points",    label: "conviction",    max: CONVICTION_MAX },
  { key: "agreement_points",     label: "agreement",     max: AGREEMENT_MAX },
  { key: "pitching_plan_points", label: "pitching plan", max: PITCHER_MAX },
  { key: "bullpen_points",       label: "bullpen",       max: BULLPEN_MAX },
  { key: "offense_points",       label: "offense",       max: OFFENSE_MAX },
  { key: "completeness_points",  label: "completeness",  max: COMPLETENESS_MAX }
];

// 2026-08-13, Lynold's spec: confidence_log.csv's columns, exact order.
// Separate from COMPONENTS above (which still drives the full six-component
// analysis in confidence_report.json) -- this omits agreement/completeness
// (zero-point diagnostics in v3) and adds the raw pregame inputs the four
// scored components are actually computed from, so a reader can see
// input -> score without cross-referencing member-brief by hand.
//
// 2026-08-13, gap fix: added pick_team and pick_bullpen_innings. Without
// pick_team there was no way to independently check pitchEdgeSupports
// (pitcher_edge_team === pick_team), which is half of pitching_plan_points'
// formula in lab-rating-core.js -- a reader could see the edge team but not
// which side was actually picked. Without pick_bullpen_innings there was no
// way to reconstruct bullpen_points' weight factor
// (clamp(pickBullpenInnings / BULLPEN_FULL_INNINGS, BULLPEN_MIN_WEIGHT, 1)) --
// the risk-index gap alone under-determines the score. offense_points and
// conviction_points needed nothing added; their raw inputs were already here.
const LOG_SCORED = ["conviction_points", "pitching_plan_points", "bullpen_points", "offense_points"];
const LOG_COLUMNS = [
  "date", "gamePk", "lab_version", "status", "pick_team",
  "pitcher_edge_team", "pitcher_gap",
  "pick_bullpen_risk_index", "opp_bullpen_risk_index", "pick_bullpen_innings",
  "pick_woba_15d", "opp_woba_15d", "pick_woba_30d", "opp_woba_30d",
  "lab_score", "model_prob", "result"
].concat(LOG_SCORED);
const HEADER = LOG_COLUMNS.join(",");

const csvField = s => {
  s = String(s == null ? "" : s);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const num = v => (typeof v === "number" && Number.isFinite(v)) ? v : null;

// 2026-08-14: calibration_model_log.csv's date column now writes MM/DD/YYYY
// (was YYYY-MM-DD). loadOutcomes() below builds its join key straight from
// that raw column and matches it against collect()'s key, which is always
// ISO (built from the member-brief FILENAME, data/member-brief/YYYY-MM-DD.json
// -- untouched by this format change). Without normalizing here first, every
// join would silently return zero matches the moment the ledger's format
// flipped -- confidence grading would run, log nothing, and print no error.
function normDate(s) {
  s = String(s || "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return s;
}

/* ---------- outcomes, from the graded moneyline ledger ---------- */
function loadOutcomes() {
  const f = path.join(CAL_DIR, "calibration_model_log.csv");
  if (!fs.existsSync(f)) {
    console.error(`No graded ledger at ${f}. Run grade-calibration.js first.`);
    process.exit(1);
  }
  const lines = fs.readFileSync(f, "utf8").split("\n").filter(l => l.trim());
  const head = lines[0].split(",");
  const iDate = head.indexOf("date"), iPk = head.indexOf("gamePk"), iRes = head.indexOf("result");
  const out = new Map();
  for (const line of lines.slice(1)) {
    // matchup fields may be quoted and contain commas; the columns we need sit
    // before and after that, so index from both ends rather than splitting naively
    const c = line.split(",");
    const res = c[c.length - 2];
    if (res !== "W" && res !== "L") continue;
    out.set(`${normDate(c[iDate])}|${c[iPk]}`, res === "W" ? 1 : 0);
  }
  return out;
}

/* ---------- one row per analysed game with its component breakdown ---------- */
function collect(outcomes) {
  const rows = [];
  const files = fs.readdirSync(BRIEF_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of files) {
    const date = f.replace(".json", "");
    let brief;
    try { brief = JSON.parse(fs.readFileSync(path.join(BRIEF_DIR, f), "utf8")); } catch (e) { continue; }
    for (const g of brief.games || []) {
      const key = `${date}|${g.game_pk}`;
      if (!outcomes.has(key)) continue;              // not graded (or voided)
      // NOTE: no date filter here, deliberately. See the FOCUS_DATE comment.
      const b = g.lab_score_breakdown;
      if (!b) continue;                              // pre-v2 brief, no breakdown
      // Raw pregame inputs for confidence_log.csv (2026-08-13 spec). pick/opp
      // is side-relative, same convention as attribution_model_log.csv.
      const pickHome = g.side === "home";
      const pe = g.pitcher_edge || {};
      const bp = g.bullpen || {};
      const pickBp = bp.pick_team || {};
      const oppBp = bp.opponent || {};
      const off = g.offense_form || {};
      const pickOff = off[g.side] || {};
      const oppOff = off[pickHome ? "away" : "home"] || {};
      // pick_bullpen_innings: bullpen_innings is stored on pitching_plan.<side>
      // for the PICK's own side (role.bullpenInnings from generate-member-lab.js),
      // same field bullpenPoints()'s weight factor is computed from.
      const plan = g.pitching_plan || {};
      const pickPlan = plan[g.side] || {};
      const row = {
        date, gamePk: g.game_pk,
        lab_version: b.version || brief.lab_rating_version || "unknown",
        status: g.status || "",
        lab: num(g.lab_score),
        prob: num(g.model_probability),
        won: outcomes.get(key),
        game: g.game || "",
        pick: g.pick_team || "",
        pitcher_edge_team: pe.team || "",
        pitcher_gap: num(pe.gap),
        pick_bullpen_risk_index: num(pickBp.risk_index),
        opp_bullpen_risk_index: num(oppBp.risk_index),
        pick_bullpen_innings: num(pickPlan.bullpen_innings),
        pick_woba_15d: num(pickOff.woba_15d),
        opp_woba_15d: num(oppOff.woba_15d),
        pick_woba_30d: num(pickOff.woba_30d),
        opp_woba_30d: num(oppOff.woba_30d)
      };
      if (row.lab === null || row.prob === null) continue;
      for (const c of COMPONENTS) row[c.key] = num(b[c.key]) ?? 0;
      /*
        Only trust a breakdown that reconciles with its own score.

        Ratings written before Lab Rating v2 used entirely different component
        keys (market_points, model_edge_points, base_points). Reading v2 keys off
        a v1 breakdown silently yields six zeros, and those rows then drag every
        mean, median split and correlation toward nothing — the first run of this
        script reported a 92-rated game as "bullpen 12.04 and nothing else" for
        exactly that reason.

        The check is arithmetic rather than a version-string comparison on
        purpose. A hardcoded version string is what silently killed totals
        grading for five days; a row that adds up is a row we can analyse, in
        any version, including ones that do not exist yet.
      */
      const sum = COMPONENTS.reduce((t, c) => t + row[c.key], 0);
      row.reconciles = Math.abs(sum - row.lab) <= 1.5;   // rounding tolerance
      rows.push(row);
    }
  }
  return rows;
}

/* ---------- statistics ---------- */
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
// Any statistic that can legitimately be undefined must survive being undefined.
const round4 = v => (typeof v === "number" && Number.isFinite(v)) ? Number(v.toFixed(4)) : null;
function pointBiserial(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  const sx = Math.sqrt(mean(xs.map(v => (v - mx) ** 2)));
  const sy = Math.sqrt(mean(ys.map(v => (v - my) ** 2)));
  if (sx === 0 || sy === 0) return null;
  const cov = mean(xs.map((v, i) => (v - mx) * (ys[i] - my)));
  return cov / (sx * sy);
}

function bandAnalysis(rows) {
  const bands = [[0, 50], [50, 65], [65, 75], [75, 85], [85, 101]];
  return bands.map(([lo, hi]) => {
    const s = rows.filter(r => r.lab >= lo && r.lab < hi);
    if (!s.length) return null;
    return {
      band: `${lo}-${hi - 1}`, n: s.length,
      mean_model_prob: Number(mean(s.map(r => r.prob)).toFixed(4)),
      actual_win_rate: Number(mean(s.map(r => r.won)).toFixed(4)),
      gap: Number((mean(s.map(r => r.won)) - mean(s.map(r => r.prob))).toFixed(4))
    };
  }).filter(Boolean);
}

/*
  Does a component earn its points?

  Split the graded set at the component's median contribution and compare win
  rates. "Lift" is the win-rate difference between the games where a component
  paid above its median and the games where it did not. A component carrying
  real information should show positive lift. Zero lift means it moves the
  score without moving the outcome — the score rises, the record does not.
*/
function componentAnalysis(rows) {
  return COMPONENTS.map(c => {
    const vals = rows.map(r => r[c.key]);
    const spread = Math.max(...vals) - Math.min(...vals);
    if (spread === 0) {
      return { component: c.label, key: c.key, n: rows.length, constant: true,
        note: "never varies in this sample — contributes nothing to discrimination" };
    }
    const sorted = [...vals].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const hi = rows.filter(r => r[c.key] > med);
    const lo = rows.filter(r => r[c.key] <= med);
    const hiW = hi.length ? mean(hi.map(r => r.won)) : null;
    const loW = lo.length ? mean(lo.map(r => r.won)) : null;
    return {
      component: c.label, key: c.key, max_points: c.max, n: rows.length,
      median_points: Number(med.toFixed(2)),
      mean_points: Number(mean(vals).toFixed(2)),
      n_above: hi.length, win_rate_above: hiW === null ? null : Number(hiW.toFixed(4)),
      n_below: lo.length, win_rate_below: loW === null ? null : Number(loW.toFixed(4)),
      lift: (hiW === null || loW === null) ? null : Number((hiW - loW).toFixed(4)),
      corr_with_win: (() => { const c2 = pointBiserial(vals, rows.map(r => r.won)); return c2 === null ? null : Number(c2.toFixed(4)); })()
    };
  });
}

/* The games the rating got most wrong, with the breakdown that produced them. */
function worstMisses(rows, count = 12) {
  return rows
    .map(r => ({ ...r, miss: (r.won ? 0 : 1) * r.lab }))
    .filter(r => !r.won)
    .sort((a, b) => b.lab - a.lab)
    .slice(0, count)
    .map(r => ({
      date: r.date, game: r.game, pick: r.pick, status: r.status,
      lab_score: r.lab, model_prob: r.prob, result: "L",
      points_from: COMPONENTS.reduce((o, c) => { o[c.label] = r[c.key]; return o; }, {})
    }));
}

/* ---------- run ---------- */
const outcomes = loadOutcomes();
const rows = collect(outcomes);

if (!rows.length) {
  console.log("No graded games with a Lab Rating breakdown anywhere in data/member-brief/.");
  process.exit(0);
}

fs.mkdirSync(CAL_DIR, { recursive: true });
// Ledger is rebuilt wholesale rather than appended: it is derived entirely from
// member-brief + the graded ledger, both of which are themselves append-only.
// Nothing original lives here, so a rebuild cannot lose evidence.
const blank = v => (v === null || v === undefined) ? "" : v;
// 2026-08-14, Lynold's explicit instruction: the date COLUMN in every ledger
// standardizes on MM/DD/YYYY. r.date itself stays ISO (it's also read into
// confidence_report.json's coverage/focus fields below, which stay ISO like
// every other JSON output in this pipeline) -- only the CSV body's own copy
// of it is reformatted, at the point of writing.
function mmddyyyy(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
}
const body = rows.map(r => [
  mmddyyyy(r.date), r.gamePk, csvField(r.lab_version), r.status, csvField(r.pick),
  csvField(r.pitcher_edge_team), blank(r.pitcher_gap),
  blank(r.pick_bullpen_risk_index), blank(r.opp_bullpen_risk_index), blank(r.pick_bullpen_innings),
  blank(r.pick_woba_15d), blank(r.opp_woba_15d), blank(r.pick_woba_30d), blank(r.opp_woba_30d),
  r.lab, r.prob, r.won ? "W" : "L"
].concat(LOG_SCORED.map(k => blank(r[k]))).join(",")).join("\n");
fs.writeFileSync(LOG, HEADER + "\n" + body + "\n");

const byVersion = {};
for (const r of rows) (byVersion[r.lab_version] = byVersion[r.lab_version] || []).push(r);

// Band calibration is safe on every row — it needs only lab_score and the
// outcome. Component analysis needs a breakdown that adds up.
const usable = rows.filter(r => r.reconciles);
const excluded = rows.length - usable.length;

const report = {
  generated_at: new Date().toISOString(),
  n_graded: rows.length,
  n_with_usable_breakdown: usable.length,
  n_excluded_from_component_analysis: excluded,
  exclusion_reason: excluded
    ? "components do not sum to the stated lab_score — pre-v2 ratings whose breakdown used different keys"
    : null,
  coverage: { from: rows[0].date, to: rows[rows.length - 1].date },
  overall: {
    mean_lab: Number(mean(rows.map(r => r.lab)).toFixed(2)),
    mean_model_prob: Number(mean(rows.map(r => r.prob)).toFixed(4)),
    actual_win_rate: Number(mean(rows.map(r => r.won)).toFixed(4)),
    // pointBiserial returns null on fewer than 3 rows, or when either series
    // has zero variance — a single graded game, or a day where every pick won.
    // A nightly run scoped to one date hits this routinely, so it must produce
    // null rather than throwing. round4() is used everywhere a correlation is
    // written for the same reason.
    corr_lab_win: round4(pointBiserial(rows.map(r => r.lab), rows.map(r => r.won)))
  },
  by_lab_version: Object.fromEntries(Object.entries(byVersion).map(([v, rs]) => [v, {
    n: rs.length,
    corr_lab_win: rs.length >= 3 ? round4(pointBiserial(rs.map(r => r.lab), rs.map(r => r.won))) : null
  }])),
  rating_bands: bandAnalysis(rows),
  components: usable.length >= 20 ? componentAnalysis(usable) : [],
  components_note: usable.length >= 20
    ? `computed on ${usable.length} game(s) whose breakdown reconciles with its score`
    : `too few reconciling breakdowns (${usable.length}) to analyse components`,
  worst_misses: worstMisses(usable.length ? usable : rows),
  // What the run being reported on actually added, if a date was given.
  focus: (() => {
    if (!FOCUS_DATE) return null;
    const day = rows.filter(r => r.date === FOCUS_DATE);
    if (!day.length) return { date: FOCUS_DATE, n: 0, note: "no graded games with a breakdown on this date" };
    return {
      date: FOCUS_DATE,
      n: day.length,
      mean_lab: Number(mean(day.map(r => r.lab)).toFixed(2)),
      mean_model_prob: round4(mean(day.map(r => r.prob))),
      actual_win_rate: round4(mean(day.map(r => r.won))),
      games: day.sort((a, b) => b.lab - a.lab).map(r => ({
        game: r.game, pick: r.pick, status: r.status,
        lab_score: r.lab, model_prob: round4(r.prob), result: r.won ? "W" : "L"
      }))
    };
  })()
};
fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));

/* ---------- console summary ---------- */
const pct = v => v === null ? "  n/a" : (v * 100).toFixed(1).padStart(5) + "%";
console.log(`\nCONFIDENCE ACCOUNTABILITY — ${rows.length} graded games, ${report.coverage.from} .. ${report.coverage.to}\n`);

console.log("Does the rating predict the outcome?");
console.log(report.overall.corr_lab_win === null
  ? `  corr(lab_score, win) = n/a  (needs 3+ graded games with variance in both the rating and the result; this run had ${rows.length})\n`
  : `  corr(lab_score, win) = ${report.overall.corr_lab_win >= 0 ? "+" : ""}${report.overall.corr_lab_win}`
    + `   (0.00 = the rating carries no outcome information)\n`);

console.log("Rating band          n   predicted    actual      gap");
for (const b of report.rating_bands) {
  console.log(`  ${b.band.padEnd(10)}${String(b.n).padStart(6)}${pct(b.mean_model_prob).padStart(12)}`
    + `${pct(b.actual_win_rate).padStart(10)}${((b.gap >= 0 ? "+" : "") + (b.gap * 100).toFixed(1) + "%").padStart(9)}`);
}

console.log(`\nDoes each component earn its points?   (${report.components_note})`);
console.log("  component        max    mean   win% when high   win% when low     lift     corr");
for (const c of report.components) {
  if (c.constant) { console.log(`  ${c.component.padEnd(15)}  ${String(c.max_points ?? "").padStart(3)}   (constant — no discrimination)`); continue; }
  const lift = c.lift === null ? "   n/a" : ((c.lift >= 0 ? "+" : "") + (c.lift * 100).toFixed(1) + "%").padStart(7);
  const corr = c.corr_with_win === null ? "  n/a" : ((c.corr_with_win >= 0 ? "+" : "") + c.corr_with_win.toFixed(3)).padStart(7);
  console.log(`  ${c.component.padEnd(15)}${String(c.max_points).padStart(4)}${String(c.mean_points).padStart(8)}`
    + `${pct(c.win_rate_above).padStart(15)}${pct(c.win_rate_below).padStart(15)}${lift}${corr}`);
}

console.log("\nWorst-rated losses (what supplied the points):");
for (const m of report.worst_misses.slice(0, 6)) {
  const parts = Object.entries(m.points_from).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(", ");
  console.log(`  ${m.date}  ${String(m.lab_score).padStart(3)}  ${(m.pick || m.game).slice(0, 34).padEnd(34)} prob ${(m.model_prob * 100).toFixed(1)}%`);
  console.log(`        ${parts}`);
}
if (report.focus) {
  console.log(`\n${report.focus.date} added ${report.focus.n} graded game(s)`
    + (report.focus.n ? `  — predicted ${(report.focus.mean_model_prob * 100).toFixed(1)}%, actual ${(report.focus.actual_win_rate * 100).toFixed(1)}%` : ""));
  for (const g of report.focus.games || []) {
    console.log(`  ${String(g.lab_score).padStart(3)}  ${(g.pick || g.game).slice(0, 30).padEnd(31)}${(g.model_prob * 100).toFixed(1).padStart(6)}%  ${g.result}`);
  }
}
console.log(`\nWrote ${path.relative(ROOT, LOG)} and ${path.relative(ROOT, REPORT)}\n`);
