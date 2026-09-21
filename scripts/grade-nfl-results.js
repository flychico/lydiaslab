/*
  Leo — NFL game-level grading.

  WHAT THIS IS FOR
  ----------------
  Until now the NFL side produced predictions and never looked back at them.
  MLB has six grading scripts; NFL had zero. That meant the pick gate could
  only ever open on a historical backtest, never on live evidence -- and
  every slate we published was thrown away the moment it was superseded.

  This writes the ledger that fixes that. One immutable row per game per
  market, joining what Leo said to what actually happened.

  WHAT IT GRADES (three independent markets, kept decoupled on purpose --
  see MODEL_IMPROVEMENT_FRAMEWORK.md "Never change all three models at once")

    moneyline  model_prob vs the winner        -> Brier, hit/miss
    total      proj_total vs actual total      -> MAE, over/under correct
    spread     proj_spread vs actual margin    -> MAE, side covered

  Every market is graded against the MARKET's number as well as the outcome,
  because "we were right" is worth little if the closing line was righter.
  beat_market is the column that actually matters.

  IMMUTABILITY
  ------------
  Rows are appended once and never rewritten. Re-running for a date that is
  already graded is a no-op, so a retried workflow cannot double-count or
  silently revise history.

  USAGE
  -----
    node scripts/grade-nfl-results.js [--date=YYYY-MM-DD] [--force]
*/
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { splitCsv } = require("./lib/odds-history");
const { frozenPredictions } = require("./lib/prediction-history");

const FEED = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";
const DIR  = path.join(__dirname, "..", "data", "nfl");
const LEDGER = path.join(DIR, "nfl-results-log.csv");

const argDate = (process.argv.find(a => a.startsWith("--date=")) || "").split("=")[1];
const FORCE = process.argv.includes("--force");
const DATE = argDate || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const r3 = x => x == null ? null : Math.round(x * 1000) / 1000;

const COLS = [
  "date","graded_at","game_id","matchup","away","home","week","model_version",
  "market","status","leo_side","leo_value","market_value","market_price","edge",
  "actual_value","result","market_result","beat_market","abs_error","brier","variance_class"
];

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = splitCsv(lines[0]);
  return lines.slice(1).map(l => {
    const c = splitCsv(l); const o = {};
    head.forEach((h, i) => o[h] = c[i]);
    return o;
  });
}

/*
  Variance analysis, per MODEL_IMPROVEMENT_FRAMEWORK.md. The point is to
  separate SKILL from LUCK: a loss with a small error is a selection problem,
  a loss with a large error is variance. Thresholds are expressed in the
  market's own units so they mean the same thing across markets.
*/
function varianceClass(result, absError, tight, loose) {
  if (result == null || absError == null) return "";
  if (result === "W") return absError <= tight ? "good_pick_won"  : "lucky_win";
  if (result === "L") return absError >= loose ? "good_pick_lost" : "bad_pick_lost";
  return "push";
}

function main() {
  /*
    GRADE THE FROZEN PREDICTION, NOT THE LIVE FILE.

    picks-{date}.json is rewritten by every prepare-slate run. The runs that
    fire after kickoff recompute team ratings from completed games and then
    re-project games those results came from. Grading that file on 2026-09-20
    produced 10-3 / 8-5 / 10-3; the genuine pre-kickoff numbers were
    6-7 / 6-7 / 6-7 on all three markets.

    prediction-history.csv is append-only and carries the time each prediction
    was made, so the prediction of record is the last one before kickoff.
    The live file is only a fallback for a slate predicted before this history
    existed -- and that fallback is announced loudly, because it is not
    trustworthy for a date whose games have already been played.
  */
  let picks = frozenPredictions(path.join(DIR, "prediction-history.csv"), DATE);
  let source = "";
  if (picks.length) {
    const lead = picks.map(p => p.minutes_before_kickoff);
    source = `frozen pre-kickoff predictions (${picks.length} games, ` +
             `${Math.min(...lead)}-${Math.max(...lead)} min before kickoff)`;
  } else {
    const picksFile = path.join(DIR, `picks-${DATE}.json`);
    if (!fs.existsSync(picksFile)) {
      console.log(`No frozen predictions and no picks-${DATE}.json — nothing to grade for ${DATE}.`);
      return;
    }
    picks = JSON.parse(fs.readFileSync(picksFile, "utf8"));
    if (!Array.isArray(picks) || !picks.length) { console.log("Picks file empty."); return; }
    source = `picks-${DATE}.json — WARNING: this file is rewritten by every ` +
             `prepare-slate run and may contain post-kickoff revisions`;
  }

  /*
    INCREMENTAL BY GAME, NOT BY DATE.

    This used to refuse any date already in the ledger. But a Sunday slate is
    graded the next morning while the 8:20pm game is often still missing from
    nflverse -- and once the date was marked done, that game could never be
    added. Every Sunday-night and Monday-night game would have been
    permanently absent, and the ledger would have looked complete.

    So: skip the (game, market) rows already present, grade whatever is new.
    Still no double-counting, and late finishers land on the next run.
  */
  const alreadyGraded = new Set();
  if (fs.existsSync(LEDGER) && !FORCE) {
    for (const l of fs.readFileSync(LEDGER, "utf8").split(/\r?\n/).slice(1)) {
      if (!l) continue;
      const c = splitCsv(l);
      if (c[0] === DATE) alreadyGraded.add(`${c[2]}|${c[8]}`);   // game_id | market
    }
  }

  const games = parseCSV(execFileSync("curl",
    ["-sSL","--fail","--max-time","120", FEED],
    { maxBuffer: 1024*1024*512, encoding: "utf8" }));

  /*
    NEVER GRADE A LIVE GAME.

    Scores alone are not proof a game is over -- a feed that publishes
    in-progress scores would hand us a partial total and we would grade it as
    final, permanently, in an append-only ledger. nflverse fills `result` (the
    final margin) only once a game is complete, so both must be present.

    This is not hypothetical: IND @ KC was still being played while this
    slate's other 13 games were graded.
  */
  const byId = new Map();
  let live = 0;
  for (const g of games) {
    const as = n(g.away_score), hs = n(g.home_score);
    if (as == null || hs == null) continue;              // no score posted
    if (String(g.result ?? "").trim() === "") { live++; continue; }  // in progress
    byId.set(g.game_id, { ...g, as, hs });
  }
  if (live) console.log(`  ${live} game(s) have scores but no final result — in progress, not graded.`);

  const rows = [];
  const gradedAt = new Date().toISOString();
  let finished = 0, pending = 0, skipped = 0;

  for (const p of picks) {
    const g = byId.get(p.game_id);
    if (!g) { pending++; continue; }
    finished++;
    const done = m => alreadyGraded.has(`${p.game_id}|${m}`);
    if (done("moneyline") && done("total") && done("spread")) { skipped++; continue; }

    const margin = g.hs - g.as;                  // positive = home won by
    const total  = g.hs + g.as;
    const winner = margin > 0 ? p.home : margin < 0 ? p.away : "TIE";

    const base = {
      date: DATE, graded_at: gradedAt, game_id: p.game_id, matchup: p.matchup,
      away: p.away, home: p.home, week: p.week, model_version: p.model_version
    };

    // ---- moneyline ------------------------------------------------------
    // Brier is computed on Leo's probability for the HOME side so it is
    // directly comparable to the market's home probability. Lower is better.
    if (p.model_prob != null && !done("moneyline")) {
      const homeOutcome = margin > 0 ? 1 : 0;
      const leoHome = p.pick === p.home ? p.model_prob : 1 - p.model_prob;
      const mktHome = p.market_prob == null ? null
                    : (p.pick === p.home ? p.market_prob : 1 - p.market_prob);
      const leoBrier = Math.pow(leoHome - homeOutcome, 2);
      const mktBrier = mktHome == null ? null : Math.pow(mktHome - homeOutcome, 2);
      const res = winner === "TIE" ? "P" : (p.pick === winner ? "W" : "L");
      rows.push({ ...base, market: "moneyline", status: p.status,
        leo_side: p.pick, leo_value: r3(p.model_prob), market_value: r3(p.market_prob),
        market_price: p.price ?? "",
        edge: r3(p.edge), actual_value: winner, result: res,
        market_result: mktHome == null ? "" : (mktHome >= 0.5) === (homeOutcome === 1) ? "W" : "L",
        beat_market: mktBrier == null ? "" : (leoBrier < mktBrier ? "Y" : "N"),
        abs_error: "", brier: r3(leoBrier),
        variance_class: varianceClass(res, Math.abs(leoHome - homeOutcome), 0.35, 0.65) });
    }

    // ---- total ----------------------------------------------------------
    if (p.proj_total != null && !done("total")) {
      const line = n(p.total_line);
      const side = p.total_side;                       // "Over" / "Under"
      const res = line == null || total === line ? "P"
                : ((total > line) === (side === "Over") ? "W" : "L");
      const leoErr = Math.abs(p.proj_total - total);
      const mktErr = line == null ? null : Math.abs(line - total);
      rows.push({ ...base, market: "total", status: p.total_status,
        leo_side: side, leo_value: p.proj_total, market_value: line,
        edge: r3(p.total_edge), actual_value: total, result: res,
        market_result: "", beat_market: mktErr == null ? "" : (leoErr < mktErr ? "Y" : "N"),
        abs_error: r3(leoErr), brier: "",
        variance_class: varianceClass(res, leoErr, 7, 14) });
    }

    // ---- spread ---------------------------------------------------------
    // spread_line is stated from the HOME side (NFL_WATCH_LIST #3): positive
    // means the home team is favoured by that many.
    if (p.proj_spread != null && !done("spread")) {
      const line = n(p.spread_line);
      const side = p.spread_side;
      let res = "P";
      if (line != null) {
        const homeCovered = margin > line;
        if (margin !== line) res = ((side === p.home) === homeCovered) ? "W" : "L";
      }
      const leoErr = Math.abs(p.proj_spread - margin);
      const mktErr = line == null ? null : Math.abs(line - margin);
      rows.push({ ...base, market: "spread", status: p.spread_status,
        leo_side: side, leo_value: p.proj_spread, market_value: line,
        edge: r3(p.spread_edge), actual_value: margin, result: res,
        market_result: "", beat_market: mktErr == null ? "" : (leoErr < mktErr ? "Y" : "N"),
        abs_error: r3(leoErr), brier: "",
        variance_class: varianceClass(res, leoErr, 7, 14) });
    }
  }

  console.log(`\nNFL GAME GRADING — ${DATE}\n${"=".repeat(58)}`);
  console.log(`  source: ${source}`);
  console.log(`  games on slate     ${picks.length}`);
  console.log(`  final              ${finished}`);
  console.log(`  not yet final      ${pending}`);
  if (skipped) console.log(`  already graded     ${skipped} (skipped, not re-counted)`);

  if (!rows.length) {
    console.log(`  nothing to write — no game is final yet.`);
    console.log("=".repeat(58) + "\n");
    return;
  }

  const q = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  if (!fs.existsSync(LEDGER)) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(LEDGER, COLS.join(",") + "\n");
    console.log(`  created ${path.basename(LEDGER)}`);
  } else if (FORCE) {
    // --force means REPAIR this date, not append a second copy of it. Without
    // this, re-running to fix a grade silently doubles the sample and every
    // rate computed from the ledger is quietly wrong. (Same bug was caught and
    // fixed in grade-nfl-props.js; this file had it too.)
    const kept = fs.readFileSync(LEDGER, "utf8").split(/\r?\n/)
      .filter((l, i) => i === 0 || (l && !l.startsWith(DATE + ",")));
    fs.writeFileSync(LEDGER, kept.join("\n").replace(/\n*$/, "\n"));
    console.log(`  --force: cleared existing ${DATE} rows before rewriting`);
  }
  fs.appendFileSync(LEDGER, rows.map(r => COLS.map(c => q(r[c])).join(",")).join("\n") + "\n");

  // Summary by market so a run is readable without opening the CSV.
  const byMkt = {};
  for (const r of rows) {
    const m = byMkt[r.market] = byMkt[r.market] || { W:0, L:0, P:0, beat:0, cmp:0 };
    m[r.result] = (m[r.result] || 0) + 1;
    if (r.beat_market === "Y") m.beat++;
    if (r.beat_market) m.cmp++;
  }
  for (const [m, s] of Object.entries(byMkt)) {
    const dec = s.W + s.L;
    console.log(`  ${m.padEnd(10)} ${s.W}-${s.L}${s.P ? "-" + s.P : ""}` +
      (dec ? ` (${(100*s.W/dec).toFixed(0)}%)` : "") +
      (s.cmp ? `   beat market ${s.beat}/${s.cmp}` : ""));
  }
  console.log(`  +${rows.length} rows appended`);
  console.log("=".repeat(58) + "\n");
  console.log("  NOTE: sample is tiny. MODEL_IMPROVEMENT_FRAMEWORK requires 50+");
  console.log("  graded picks before any of this means anything.\n");
}

main();
