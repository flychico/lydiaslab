/*
  Leo — NFL prop grading.

  This fills the `result` and `actual_value` columns that have sat empty in
  nfl-props-log.csv since the day it was created. Every projection we have
  ever published was written down and then never compared to anything.

  WHY IT MATTERS MORE THAN THE GAME LEDGER
  ----------------------------------------
  Game picks accumulate slowly -- 14 a week, and the sample needed to say
  anything is 50+. Props accumulate at ~300 a slate. Prop grading reaches a
  meaningful sample in WEEKS where moneyline takes a season. It is the fastest
  honest read we can get on whether any of this works.

  WHAT IT GRADES
    yardage markets  projection vs actual   -> MAE, and vs the line where posted
    anytime TD       probability vs scored  -> Brier, and hit/miss vs the line

  BEATING THE LINE IS THE REAL TEST
  ---------------------------------
  "Our projection was close" is weak. "Our projection was closer than the
  closing line" is the only thing that implies edge, so beat_line is computed
  wherever a line exists and is the column to trend.

  EXCLUSIONS
  ----------
  A projection for a player listed Out/Doubtful is not a prediction -- it is a
  stale roster assumption. Those rows are marked `excluded` and kept out of
  every summary, rather than deleted, so the exclusion itself is auditable.

  USAGE
    node scripts/grade-nfl-props.js [--date=YYYY-MM-DD] [--week=N] [--force]
*/
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { splitCsv } = require("./lib/odds-history");
const { keyFull, keyInitialLast } = require("./lib/nfl-names");
const { frozenProps } = require("./lib/prediction-history");

const SEASON = 2026;
const REL = "https://github.com/nflverse/nflverse-data/releases/download";
const DIR = path.join(__dirname, "..", "data", "nfl");
const LEDGER = path.join(DIR, "nfl-props-graded.csv");

const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || "").split("=")[1];
const FORCE = process.argv.includes("--force");
const DATE = arg("date") || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const r3 = x => x == null ? null : Math.round(x * 1000) / 1000;

const COLS = ["date","graded_at","week","game_id","matchup","team","opponent","player","position","depth",
              "market","model_version","projection","line","lean","actual","result","abs_error",
              "line_abs_error","beat_line","brier","variance_class","excluded","exclude_reason",
              // FACTORS — the inputs the projection was built from, frozen at
              // prediction time, plus what actually happened to each of them.
              // This is what makes error attributable instead of just measured.
              "rate_used","expected_volume","opp_adjustment","games_played",
              "actual_rate","actual_volume","rate_effect","volume_effect",
              "frozen_minutes_before_kickoff"];

// The volume stat each market's rate is per-unit-of.
const VOLUME = {
  QB_PASS_YARDS: r => n(r.attempts),
  RB_RUSH_YARDS: r => n(r.carries),
  WR_REC_YARDS:  r => n(r.targets)
};

// Our market -> the nflverse weekly column that realises it.
const ACTUAL = {
  QB_PASS_YARDS: r => n(r.passing_yards),
  RB_RUSH_YARDS: r => n(r.rushing_yards),
  WR_REC_YARDS:  r => n(r.receiving_yards),
  ANYTIME_TD:    r => ((n(r.rushing_tds) || 0) + (n(r.receiving_tds) || 0)) > 0 ? 1 : 0
};

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = splitCsv(lines[0]);
  return lines.slice(1).map(l => {
    const c = splitCsv(l); const o = {};
    head.forEach((h, i) => o[h] = c[i]);
    return o;
  });
}

function main() {
  /*
    GRADE THE FROZEN PROJECTION. props-{date}.json is rebuilt by every
    prepare-slate run from that week's player stats -- so a rerun after
    kickoff projects players whose numbers it has already seen. On 2026-09-20
    that rewrote 198 of 290 projections, moving Tyler Shough from 297 to 269
    after he threw for 252 and turning a 45-yard miss into an apparent 17.
  */
  let props = frozenProps(path.join(DIR, "prop-prediction-history.csv"), DATE);
  let source = "";
  if (props.length) {
    const lead = props.map(p => p.minutes_before_kickoff);
    source = `frozen pre-kickoff projections (${props.length}, ${Math.min(...lead)}-${Math.max(...lead)} min before kickoff)`;
    // Line / lean / injury flags live on the merged file, not the frozen one.
    const live = fs.existsSync(path.join(DIR, `props-${DATE}.json`))
      ? JSON.parse(fs.readFileSync(path.join(DIR, `props-${DATE}.json`), "utf8")) : [];
    const byKey = new Map(live.map(r => [`${r.matchup}|${r.market}|${r.player}`, r]));
    props = props.map(p => {
      const m = byKey.get(`${p.matchup}|${p.market}|${p.player}`) || {};
      return { ...p, line: m.line, lean: m.lean, market_prob: m.market_prob,
               lean_blocked: m.lean_blocked, sidelined: m.sidelined,
               injury_status: m.injury_status };
    });
  } else {
    const propsFile = path.join(DIR, `props-${DATE}.json`);
    if (!fs.existsSync(propsFile)) { console.log(`No frozen projections and no props-${DATE}.json — nothing to grade.`); return; }
    props = JSON.parse(fs.readFileSync(propsFile, "utf8"));
    if (!Array.isArray(props) || !props.length) { console.log("Props file empty."); return; }
    source = `props-${DATE}.json — WARNING: rewritten by every prepare-slate run, may contain post-kickoff revisions`;
  }

  if (fs.existsSync(LEDGER) && !FORCE) {
    if (fs.readFileSync(LEDGER, "utf8").split(/\r?\n/).some(l => l.startsWith(DATE + ","))) {
      console.log(`${DATE} already graded — refusing to double-count. Use --force only to repair.`);
      return;
    }
  }

  // Week comes from game_id (2026_02_CAR_ATL) unless overridden.
  const week = arg("week") || (String(props[0].game_id || "").split("_")[1] || "").replace(/^0/, "");
  if (!week) { console.log("Could not determine week."); return; }

  // On game day this file often does not exist yet, or exists without the
  // current week. Neither is an error -- it just means results are not in.
  // Crashing here would fail the whole grading workflow on every early run.
  let stats;
  try {
    stats = parseCSV(execFileSync("curl",
      ["-sSL","--fail","--max-time","180", `${REL}/stats_player/stats_player_week_${SEASON}.csv`],
      { maxBuffer: 1024*1024*512, encoding: "utf8" }));
  } catch (e) {
    console.log(`Weekly player stats not available yet (${String(e.message || e).slice(0, 80)}).`);
    console.log("Nothing graded — this is normal before results post.");
    return;
  }

  const wk = stats.filter(r => String(r.week) === String(week) && String(r.season) === String(SEASON));
  if (!wk.length) { console.log(`No week ${week} player stats posted yet — games are not final. Nothing graded.`); return; }

  // Index actuals by both name keys, scoped to team so a shared key cannot
  // cross-match between clubs.
  const byKey = new Map();
  for (const r of wk) {
    const nm = r.player_display_name || r.player_name || "";
    if (!nm) continue;
    for (const k of [keyFull(nm), keyInitialLast(nm)]) {
      if (k) byKey.set(`${r.team}|${k}`, r);
    }
  }

  const rows = [];
  const gradedAt = new Date().toISOString();
  let graded = 0, excluded = 0, noActual = 0;

  for (const p of props) {
    const stat = byKey.get(`${p.team}|${keyFull(p.player)}`)
              || byKey.get(`${p.team}|${keyInitialLast(p.player)}`);

    const base = {
      date: DATE, graded_at: gradedAt, week, game_id: p.game_id, matchup: p.matchup,
      team: p.team, opponent: p.opponent, player: p.player, position: p.position,
      depth: p.depth || "", market: p.market, model_version: p.model_version,
      projection: p.projection, line: p.line ?? (p.market_prob ?? ""), lean: p.lean || "",
      rate_used: p.rate_used ?? "", expected_volume: p.expected_volume ?? "",
      opp_adjustment: p.opp_adjustment ?? "", games_played: p.games_played ?? "",
      frozen_minutes_before_kickoff: p.minutes_before_kickoff ?? "",
      actual_rate: "", actual_volume: "", rate_effect: "", volume_effect: ""
    };

    if (p.sidelined) {
      rows.push({ ...base, actual: "", result: "", abs_error: "", line_abs_error: "",
                  beat_line: "", brier: "", variance_class: "",
                  excluded: "Y", exclude_reason: `listed ${p.injury_status || "Out"}` });
      excluded++; continue;
    }
    if (!stat) {
      // No stat line at all: did not play (healthy scratch, inactive). Not a
      // model failure, so it is recorded and excluded rather than counted.
      rows.push({ ...base, actual: "", result: "", abs_error: "", line_abs_error: "",
                  beat_line: "", brier: "", variance_class: "",
                  excluded: "Y", exclude_reason: "no stat line (did not play)" });
      noActual++; continue;
    }

    const actual = ACTUAL[p.market](stat);
    if (actual == null) { noActual++; continue; }
    graded++;

    if (p.market === "ANYTIME_TD") {
      const brier = Math.pow(p.projection - actual, 2);
      const mkt = p.market_prob;
      const res = p.lean ? ((actual === 1) === (p.lean === "over") ? "W" : "L") : "";
      rows.push({ ...base, actual, result: res,
        abs_error: r3(Math.abs(p.projection - actual)),
        line_abs_error: mkt == null ? "" : r3(Math.abs(mkt - actual)),
        beat_line: mkt == null ? "" : (brier < Math.pow(mkt - actual, 2) ? "Y" : "N"),
        brier: r3(brier),
        variance_class: res === "W" ? (Math.abs(p.projection - actual) <= 0.4 ? "good_pick_won" : "lucky_win")
                      : res === "L" ? (Math.abs(p.projection - actual) >= 0.6 ? "good_pick_lost" : "bad_pick_lost") : "",
        excluded: "", exclude_reason: "" });
    } else {
      /*
        ERROR ATTRIBUTION. A projection is rate x volume. Knowing it missed by
        45 yards says nothing useful; knowing the RATE was right and the
        VOLUME was wrong says which half of the model to fix.

        Exact decomposition, since both terms sum to the total miss:
          volume_effect = (actual_vol  - proj_vol)  * proj_rate
          rate_effect   = (actual_rate - proj_rate) * actual_vol
      */
      const volFn = VOLUME[p.market];
      const aVol = volFn ? volFn(stat) : null;
      const aRate = (aVol != null && aVol > 0) ? actual / aVol : null;
      if (aVol != null) base.actual_volume = r3(aVol);
      if (aRate != null) base.actual_rate = r3(aRate);
      if (aVol != null && aRate != null && p.rate_used != null && p.expected_volume != null) {
        base.volume_effect = r3((aVol - p.expected_volume) * p.rate_used);
        base.rate_effect   = r3((aRate - p.rate_used) * aVol);
      }
      const err = Math.abs(p.projection - actual);
      const line = p.line;
      const lineErr = line == null ? null : Math.abs(line - actual);
      // Push when the actual lands exactly on the line.
      const res = !p.lean || line == null ? ""
                : actual === line ? "P"
                : ((actual > line) === (p.lean === "over") ? "W" : "L");
      // 20% of the line is the "was this close" band for variance classing.
      const tight = line == null ? 15 : line * 0.20;
      rows.push({ ...base, actual, result: res,
        abs_error: r3(err), line_abs_error: lineErr == null ? "" : r3(lineErr),
        beat_line: lineErr == null ? "" : (err < lineErr ? "Y" : "N"),
        brier: "",
        variance_class: res === "W" ? (err <= tight ? "good_pick_won" : "lucky_win")
                      : res === "L" ? (err >= tight * 2 ? "good_pick_lost" : "bad_pick_lost") : "",
        excluded: "", exclude_reason: "" });
    }
  }

  console.log(`\nNFL PROP GRADING — ${DATE} (week ${week})\n${"=".repeat(58)}`);
  console.log(`  source: ${source}`);
  console.log(`  projections        ${props.length}`);
  console.log(`  graded             ${graded}`);
  console.log(`  excluded (injury)  ${excluded}`);
  console.log(`  no stat line       ${noActual}`);

  /*
    DO NOT RECORD A SLATE THAT HAS NOT BEEN PLAYED.

    Run before kickoff, every player legitimately has no stat line -- and
    writing that produces 300 rows permanently asserting "did not play" about
    players who are about to play. In an append-only ledger that is a lie we
    can never take back, and the scheduled workflow will attempt exactly this
    run on every early trigger.

    So: if nothing actually graded, write nothing at all.
  */
  if (!graded) {
    console.log(`  nothing graded — results are not in yet. Ledger untouched.`);
    console.log("=".repeat(58) + "\n");
    return;
  }
  if (!rows.length) { console.log("  nothing to write.\n"); return; }

  const q = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  if (!fs.existsSync(LEDGER)) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(LEDGER, COLS.join(",") + "\n");
    console.log(`  created ${path.basename(LEDGER)}`);
  } else if (FORCE) {
    // --force means REPAIR this date, not append a second copy of it. Without
    // this, re-running to fix a bad grade silently doubles the sample and
    // every rate computed from the ledger is quietly wrong.
    const kept = fs.readFileSync(LEDGER, "utf8").split(/\r?\n/)
      .filter((l, i) => i === 0 || (l && !l.startsWith(DATE + ",")));
    fs.writeFileSync(LEDGER, kept.join("\n").replace(/\n*$/, "\n"));
    console.log(`  --force: cleared existing ${DATE} rows before rewriting`);
  }
  fs.appendFileSync(LEDGER, rows.map(r => COLS.map(c => q(r[c])).join(",")).join("\n") + "\n");

  // Per-market summary. MAE is reported beside the LINE's MAE, because ours
  // alone says nothing.
  const live = rows.filter(r => !r.excluded && r.actual !== "");
  const byM = {};
  for (const r of live) {
    const m = byM[r.market] = byM[r.market] || { n:0, err:0, lerr:0, cmp:0, beat:0, W:0, L:0, P:0 };
    m.n++;
    if (r.abs_error !== "") m.err += Number(r.abs_error);
    if (r.line_abs_error !== "") { m.lerr += Number(r.line_abs_error); m.cmp++; if (r.beat_line === "Y") m.beat++; }
    if (r.result) m[r.result] = (m[r.result] || 0) + 1;
  }
  console.log(`  ${"-".repeat(52)}`);
  for (const [m, s] of Object.entries(byM)) {
    const dec = s.W + s.L;
    console.log(`  ${m.padEnd(15)} n=${String(s.n).padEnd(4)} MAE ${(s.err/s.n).toFixed(2)}` +
      (s.cmp ? `  line MAE ${(s.lerr/s.cmp).toFixed(2)}  beat line ${s.beat}/${s.cmp} (${(100*s.beat/s.cmp).toFixed(0)}%)` : "") +
      (dec ? `  lean ${s.W}-${s.L}` : ""));
  }
  console.log("=".repeat(58));
  console.log(`  +${rows.length} rows appended\n`);
  console.log("  beat-line % is the column that matters. Anything under 50%");
  console.log("  means the closing line is a better projection than ours.\n");
}

main();
