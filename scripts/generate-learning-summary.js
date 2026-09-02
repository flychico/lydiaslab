#!/usr/bin/env node
"use strict";

/*
  LyDia Learning Summary Generator

  Reads:
  - data/results.json
  - data/clv/clv_log.csv when present

  Writes:
  - data/learning-summary.json           (legacy — still written for
    generate-coach.js and the current /learning/ page; being phased out)
  - data/learning/<date>.json            (per-date archive, unchanged)
  - data/learning_summary.csv            (one row: every scalar/summary field)
  - data/learning_findings.csv
  - data/learning_calibration_buckets.csv
  - data/learning_shadow_by_status.csv
  - data/learning_games.csv              (one row per unique game, boolean
    flag columns for which review bucket(s) it fell into)
  - data/learning_next_review.csv
  - data/learning_clv_counts.csv
  - data/learning_lesson_counts.csv

  2026-08-11: added the CSV set above per Lynold's request to move off
  learning-summary.json. This is step 1 of 2 — the JSON is still written
  because generate-coach.js currently does a read-modify-write on it
  (reads the file, adds its own "coach" block, writes it back), and the
  /learning/ page still fetches it directly. Both get converted in the next
  pass; until then this script intentionally writes both formats so nothing
  downstream breaks. See NOTES.md in the delivery folder for the full plan.

  Purpose:
  Turn graded results into a readable process review.
  This does not change picks. It only summarizes what happened after grading.
*/

const fs = require("fs");
const path = require("path");
// 2026-08-22, Lynold's explicit instruction: "everything needs to be traced
// to the live gate" -- every 0.72/80 literal below used to be this script's
// own hardcoded copy of the official-pick gate, stale since the 2026-08-05
// calibration remap and again since the 2026-08-22 lab-score gate change.
// Now reads the same two constants generate-member-lab.js actually enforces.
const { OFFICIAL_MODEL_PROB, OFFICIAL_LAB_SCORE } = require("./lib/gate-constants");

const ROOT = path.join(__dirname, "..");
const RESULTS_PATH = path.join(ROOT, "data", "results.json");
const CLV_PATH = path.join(ROOT, "data", "clv", "clv_log.csv");
// 2026-08-30, Lynold's direct instruction: the Findings section only ever
// counted how often a flag tripped (bullpen caution, pitcher conflict) --
// never whether that flag actually predicted anything. grade-confidence.js
// already computes the real answer nightly (component lift/correlation,
// rating-band calibration) into confidence_report.json; it just never fed
// into this file. Read-only here -- this script never recomputes those
// numbers, only reports them.
const CONFIDENCE_REPORT_PATH = path.join(ROOT, "data", "calibration", "confidence_report.json");

const args = parseArgs(process.argv.slice(2));

main();

function main() {
  const results = readJsonSafe(RESULTS_PATH);
  if (!results || !results.days || !Object.keys(results.days).length) {
    const empty = {
      generated_at: new Date().toISOString(),
      status: "empty",
      summary: "No graded results are available yet. Learning starts after at least one slate is graded.",
      latest_date: null,
      days_reviewed: 0
    };
    writeJson("data/learning-summary.json", empty);
    writeCsv("data/learning_summary.csv", ["generated_at", "status", "summary", "latest_date", "days_reviewed"], [empty]);
    console.log("No results found. Wrote empty learning summary.");
    return;
  }

  const dates = Object.keys(results.days).sort();
  const date = args.date || dates[dates.length - 1];
  const day = results.days[date];

  if (!day) {
    throw new Error(`No results found for ${date}. Available dates: ${dates.join(", ")}`);
  }

  const allDays = dates.map(d => results.days[d]);
  const clvRows = readCsvSafe(CLV_PATH);
  const confidenceReport = readJsonSafe(CONFIDENCE_REPORT_PATH);

  const summary = buildLearningSummary({ date, day, allDays, clvRows, confidenceReport });

  writeJson(`data/learning/${date}.json`, summary);
  writeJson("data/learning-summary.json", summary);
  writeLearningSummaryCsvs(summary);

  console.log(`Learning summary generated for ${date}.`);
}

function buildLearningSummary({ date, day, allDays, clvRows, confidenceReport }) {
  const picks = Array.isArray(day.picks) ? day.picks : [];
  const gradedMoneyline = picks
    .map(p => normalizePickForLearning(p, day.source))
    .filter(p => p.market === "moneyline" && p.result !== "NG" && p.pick);

  // Review buckets span ALL graded days (a one-day window left them empty most mornings)
  const allGradedMoneyline = (allDays || []).flatMap(d =>
    (Array.isArray(d.picks) ? d.picks : [])
      .map(p => normalizePickForLearning(p, d.source))
      .filter(p => p.market === "moneyline" && p.result !== "NG" && p.pick)
      .map(p => ({ ...p, date: d.date }))
  );

  const legacyMarkets = picks.flatMap(p => legacyMarketRows(p)).filter(Boolean);
  const lessonCounts = countBy(gradedMoneyline, p => p.lesson_tag || "unlabeled");
  const clvCounts = countBy(gradedMoneyline, p => p.clv_result || "not_tracked");

  const wins = gradedMoneyline.filter(p => p.result === "W").length;
  const losses = gradedMoneyline.filter(p => p.result === "L").length;
  const winRate = wins + losses ? round(wins / (wins + losses), 4) : null;

  const avgModelProbability = avg(gradedMoneyline.map(p => p.model_probability));
  const avgLabScore = avg(gradedMoneyline.map(p => p.lab_score));
  const avgRawEdge = avg(gradedMoneyline.map(p => p.raw_edge));

  // 2026-08-08 (Lynold): the edge-magnitude requirement was removed from the
  // real official-pick gate in generate-member-lab.js (officialEligible no
  // longer checks raw_edge, just that market data exists at all). This
  // report used to carry its own separate copy of the old >= 0.03 edge
  // requirement here, in the gates display block below, and in
  // buildMultiDayView()'s strict_gate_candidates count -- all three were
  // stale and out of sync with the actual gate. Removed from all three so
  // this report never miscounts an official pick (e.g. a 65% model read vs.
  // a 67% market read, edge = -0.02) as something other than what it is.
  const strongOfficial = allGradedMoneyline.filter(p =>
    p.status === "official_pick" &&
    num(p.model_probability) >= OFFICIAL_MODEL_PROB &&
    num(p.lab_score) >= OFFICIAL_LAB_SCORE
  );

  const protectedByGate = (allDays || []).flatMap(d =>
    (Array.isArray(d.picks) ? d.picks : [])
      .map(p => normalizePickForLearning(p, d.source))
      .filter(p =>
        p.market === "moneyline" &&
        p.pick &&
        (p.result === "W" || p.result === "L") &&
        num(p.model_probability) < OFFICIAL_MODEL_PROB &&
        num(p.lab_score) >= OFFICIAL_LAB_SCORE
      ).map(p => ({ ...p, date: d.date }))
  );

  const highBullpenRisk = allGradedMoneyline.filter(p =>
    p.bullpen_label === "Adds caution" ||
    p.bullpen_label === "Both bullpens stressed" ||
    num(p.pick_side_bullpen_score) >= 78
  );

  const pitcherConflict = allGradedMoneyline.filter(p =>
    p.pitcher_edge_team &&
    p.pitcher_edge_team !== "No clear SP edge" &&
    p.pitcher_edge_team !== p.pick_team &&
    num(p.pitcher_gap) >= 8
  );

  const multiDay = buildMultiDayView(allDays);
  const findings = buildFindings({
    gradedMoneyline,
    wins,
    losses,
    winRate,
    avgModelProbability,
    avgLabScore,
    avgRawEdge,
    strongOfficial,
    protectedByGate,
    highBullpenRisk,
    pitcherConflict,
    clvCounts,
    confidenceReport
  });

  // Computed before the headline so a zero-picks-today date can still
  // report Leo's actual current record instead of a misleading "no picks
  // yet" (Lynold 2026-08-08 — you've had official picks since Leo started;
  // that phrasing only ever meant "none finished grading for this one
  // date," never "none ever," but it read like the latter).
  const calibration = buildCalibration();

  return {
    generated_at: new Date().toISOString(),
    status: "ready",
    latest_date: date,
    days_reviewed: allDays.length,
    source_files: {
      results: "data/results.json",
      clv: fs.existsSync(CLV_PATH) ? "data/clv/clv_log.csv" : null
    },
    current_official_model: currentModelVersion(gradedMoneyline, allGradedMoneyline, day),
    headline: makeHeadline({ date, wins, losses, winRate, day, calibration }),
    day: {
      date,
      source: day.source || "unknown",
      record_all_markets: `${day.wins || 0}-${day.losses || 0}`,
      units_all_markets: day.units ?? null,
      ungraded: day.ungraded || 0,
      moneyline_record: `${wins}-${losses}`,
      moneyline_win_rate: winRate,
      official_moneyline_picks: gradedMoneyline.length,
      legacy_market_entries: legacyMarkets.length
    },
    gates: {
      official_model_probability: OFFICIAL_MODEL_PROB,
      official_lab_score: OFFICIAL_LAB_SCORE,
      note: "Official picks require high model probability and strong setup quality. A high Lab Rating alone is not enough. (Market edge is no longer a gate -- a picked side with a lower market-implied probability than the model's read can still qualify, as long as market data exists for the game at all.)"
    },
    process_metrics: {
      average_model_probability: avgModelProbability,
      average_lab_score: avgLabScore,
      average_raw_edge: avgRawEdge,
      clv_counts: clvCounts,
      lesson_counts: lessonCounts,
      strong_official_count: strongOfficial.length,
      protected_by_probability_gate_count: protectedByGate.length,
      high_bullpen_risk_count: highBullpenRisk.length,
      pitcher_conflict_count: pitcherConflict.length
    },
    findings,
    calibration,
    buckets: {
      strong_official: strongOfficial.map(publicPickRow),
      protected_by_probability_gate: protectedByGate.map(publicPickRow),
      high_bullpen_risk: highBullpenRisk.map(publicPickRow),
      pitcher_conflicts: pitcherConflict.map(publicPickRow),
      all_moneyline: gradedMoneyline.map(publicPickRow)
    },
    multi_day: multiDay,
    next_review: [
      "Do not change thresholds from one slate.",
      "Watch whether official picks with model probability >= 72% beat low-probability value watches over a larger sample.",
      "Track closing price movement once market snapshots have enough data.",
      "Keep value watch separate from official picks."
    ]
  };
}

function normalizePickForLearning(p, source) {
  const ml = p.moneyline || {};
  const learning = p.learning || {};
  const result = p.mlResult || p.result || learning.result || "NG";
  const labScore = firstNum(learning.lab_score, p.labScore, p.lab_score, ml.edgeScore);
  const modelProbability = firstNum(learning.model_probability, ml.prob);
  const marketProbability = firstNum(learning.market_probability, ml.mktProb);
  const rawEdge = firstNum(
    learning.raw_edge,
    ml.rawEdge,
    typeof modelProbability === "number" && typeof marketProbability === "number"
      ? round(modelProbability - marketProbability, 4)
      : null
  );

  return {
    game_pk: p.gamePk || p.game_pk || null,
    market: "moneyline",
    game: `${p.away || p.away_team || ""} @ ${p.home || p.home_team || ""}`.trim(),
    away: p.away || p.away_team || null,
    home: p.home || p.home_team || null,
    pick: ml.pick || null,
    pick_team: ml.pick || null,
    side: ml.side || null,
    result,
    source: source || learning.result_source || "unknown",
    date: p.date || null,
    status: p.status || learning.status || null,
    model_version: learning.model_version || p.modelVersion || p.model_version || (source === "published-picks" ? "moneyline-v2-strict-probability-gate" : "legacy"),
    lab_score: labScore,
    model_probability: modelProbability,
    market_probability: marketProbability,
    raw_edge: rawEdge,
    posted_price: firstNum(learning.posted_price, ml.bestAm),
    current_price: firstNum(learning.current_price),
    closing_price: firstNum(learning.closing_price),
    clv_result: learning.clv_result || "not_tracked",
    lesson_tag: learning.lesson_tag || fallbackLessonTag({ result, modelProbability, labScore }),
    pitcher_edge_team: learning.pitcher_edge_team || (p.pitcherEdge && p.pitcherEdge.team) || null,
    pitcher_gap: firstNum(learning.pitcher_gap, p.pitcherEdge && p.pitcherEdge.gap),
    bullpen_label: learning.bullpen_label || (p.bullpen && p.bullpen.label) || null,
    pick_side_bullpen_score: firstNum(learning.pick_side_bullpen_score, p.bullpen && p.bullpen.pick_team && p.bullpen.pick_team.score),
    opponent_bullpen_score: firstNum(learning.opponent_bullpen_score, p.bullpen && p.bullpen.opponent && p.bullpen.opponent.score)
  };
}

function fallbackLessonTag({ result, modelProbability, labScore }) {
  if (result === "NG") return "not_graded";
  if (num(modelProbability) < OFFICIAL_MODEL_PROB && num(labScore) >= OFFICIAL_LAB_SCORE) return "high_lab_low_probability_watch_only";
  if (num(modelProbability) >= OFFICIAL_MODEL_PROB && num(labScore) >= OFFICIAL_LAB_SCORE && result === "W") return "strict_gate_win";
  if (num(modelProbability) >= OFFICIAL_MODEL_PROB && num(labScore) >= OFFICIAL_LAB_SCORE && result === "L") return "strict_gate_loss_review";
  return result === "W" ? "win_needs_more_sample" : "loss_needs_review";
}

function legacyMarketRows(p) {
  const out = [];
  if (p.total && p.total.pick) out.push({ market: "total", result: p.totResult || "NG" });
  if (p.runLine && p.runLine.pick) out.push({ market: "run_line", result: p.rlResult || "NG" });
  return out;
}

// 2026-08-08 (Lynold): removed the early return that used to bail out with a
// single generic finding the moment TODAY's graded-moneyline count was zero.
// Three of these four findings (probability gate, bullpen learning, pitcher
// learning) are built from ALL historical days already and never depended on
// today's count -- the early return was throwing that data away on any date
// with zero moneyline picks graded, which is common (most days aren't
// moneyline-heavy). The "Official-pick discipline" finding below still
// reports honestly when today's count is zero; it just no longer skips the
// other three.
// 2026-08-30, Lynold's direct instruction: "this should be telling us what
// is working vs what is not working." Before this, every finding here was a
// static count of how often a flag tripped (bullpen caution, pitcher
// conflict) -- never whether that flag actually predicted a win or a loss.
// The real answer to that already gets computed every night by
// grade-confidence.js into confidence_report.json (component win-rate
// lift/correlation, rating-band calibration) -- it just never fed into this
// file. This function now reads those numbers rather than duplicating the
// statistics. See scripts/grade-confidence.js for the method; this is
// display-only.
//
// Separately, "which raw inputs (pitcher score, wOBA, team strength, ...)
// actually predict winning" is answered by scripts/lib/coach-correlation-core.js
// and rendered as its own "Full-history correlation findings" card
// (data/learning-summary.json's coach.history, written by
// scripts/generate-coach.js). Findings below deliberately do NOT repeat
// that -- it asks a different question (do the raw inputs work) from this
// section (does Lab Rating's own scoring reward the right things, and is
// the rating honestly calibrated).
function signed(v, digits = 3) {
  return (typeof v === "number" && Number.isFinite(v)) ? `${v >= 0 ? "+" : ""}${v.toFixed(digits)}` : "n/a";
}
function pctSigned(v) {
  return (typeof v === "number" && Number.isFinite(v)) ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%` : "n/a";
}
// Shared verdict logic so a component gets the same read wherever it's
// mentioned in this file -- lift (median-split win-rate difference) and
// corr_with_win (full-range correlation) can disagree in sign, which is a
// real property of a non-straight-line relationship, not a bug. Picking
// whichever number sounds more confident and hiding the other would
// misrepresent the data.
function componentVerdict(comp) {
  if (!comp) return "";
  const weak = comp.corr_with_win < 0.02;
  const disagree = weak && comp.lift > 0.02;
  if (disagree) return " Correlation and the median-split lift disagree in sign here -- a sign the relationship isn't a straight line, not clear evidence either way.";
  if (weak) return " Currently not earning its points -- moves the score without moving the record.";
  return "";
}

function buildFindings(ctx) {
  const findings = [];
  const cr = ctx.confidenceReport;
  const components = (cr && Array.isArray(cr.components))
    ? cr.components.filter(c => !c.constant && typeof c.corr_with_win === "number")
    : [];

  if (ctx.gradedMoneyline.length) {
    findings.push({
      title: "Official-pick discipline",
      read: `${ctx.gradedMoneyline.length} moneyline pick${ctx.gradedMoneyline.length === 1 ? "" : "s"} ${ctx.gradedMoneyline.length === 1 ? "was" : "were"} graded today. Record: ${ctx.wins}-${ctx.losses}${ctx.winRate !== null ? ` (${pct(ctx.winRate)})` : ""}.`
    });
  } else {
    findings.push({
      title: "No new moneyline picks graded today",
      read: "No moneyline picks finished grading for this date. The findings below draw on the full graded history instead."
    });
  }

  findings.push({
    title: "Probability gate",
    read: ctx.protectedByGate.length
      ? `Across all reviewed days, ${ctx.protectedByGate.length} graded setup${ctx.protectedByGate.length === 1 ? "" : "s"} had strong Lab Rating but model probability below 72%. Those should remain value watch, not official picks.`
      : "No high-Lab, low-probability moneyline setups appeared in the graded official set."
  });

  // ---- What's working vs. not, in Lab Rating's own scoring ----
  if (components.length) {
    const ranked = [...components].sort((a, b) => b.corr_with_win - a.corr_with_win);
    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    findings.push({
      title: "What's working: Lab Rating components",
      read: `Over ${best.n} graded picks with a reconciling breakdown, ${best.component} is the strongest working piece of Lab Rating right now -- picks scoring above its median win ${pct(best.win_rate_above)} of the time vs. ${pct(best.win_rate_below)} below (lift ${pctSigned(best.lift)}, correlation to winning ${signed(best.corr_with_win)}).`
    });
    if (worst.key !== best.key) {
      const notWorking = worst.corr_with_win < 0.02;
      const disagree = notWorking && worst.lift > 0.02;
      findings.push({
        title: disagree ? "Mixed signal: Lab Rating component" : (notWorking ? "What's not working: Lab Rating components" : "Weakest-working Lab Rating component"),
        read: `${worst.component} -- correlation to winning ${signed(worst.corr_with_win)}, lift ${pctSigned(worst.lift)} over ${worst.n} picks.${componentVerdict(worst)}`
      });
    }
  } else {
    findings.push({
      title: "Lab Rating component check",
      read: cr
        ? (cr.components_note || "Not enough reconciling Lab Rating breakdowns yet to check which components actually earn their points.")
        : "data/calibration/confidence_report.json not found yet -- run grade-confidence.js to unlock a real working/not-working check here."
    });
  }

  // ---- Bullpen and pitcher: keep the original real-world flag counts
  // (a different, still-useful question -- "how often did this specific
  // caution actually show up today's/history's picks") but now attach the
  // statistical read on whether that flag predicts anything, when available.
  const bullpenComp = components.find(c => c.key === "bullpen_points");
  findings.push({
    title: "Bullpen learning",
    read: (ctx.highBullpenRisk.length
      ? `Across all reviewed days, ${ctx.highBullpenRisk.length} graded moneyline pick${ctx.highBullpenRisk.length === 1 ? "" : "s"} carried a meaningful bullpen caution.`
      : "No graded moneyline picks carried a major bullpen caution.")
      + (bullpenComp
        ? ` Statistically, Lab Rating's bullpen component correlates ${signed(bullpenComp.corr_with_win)} with winning over ${bullpenComp.n} picks (lift ${pctSigned(bullpenComp.lift)}).${componentVerdict(bullpenComp)}`
        : "")
  });

  const pitchComp = components.find(c => c.key === "pitching_plan_points");
  findings.push({
    title: "Pitcher learning",
    read: (ctx.pitcherConflict.length
      ? `Across all reviewed days, ${ctx.pitcherConflict.length} graded pick${ctx.pitcherConflict.length === 1 ? "" : "s"} had a starting-pitcher conflict. These need manual review.`
      : "No major starting-pitcher conflicts showed up in the graded moneyline set.")
      + (pitchComp
        ? ` Statistically, the pitching-plan component correlates ${signed(pitchComp.corr_with_win)} with winning over ${pitchComp.n} picks (lift ${pctSigned(pitchComp.lift)}).${componentVerdict(pitchComp)}`
        : "")
  });

  // ---- Is a high rating actually more reliable than a middling one? ----
  if (cr && Array.isArray(cr.rating_bands) && cr.rating_bands.length >= 2) {
    const bands = cr.rating_bands;
    const worstGap = [...bands].sort((a, b) => a.gap - b.gap)[0];
    const top = bands[bands.length - 1];
    findings.push({
      title: "Rating calibration",
      read: `Actual win rate by Lab Rating band: ${bands.map(b => `${b.band} → ${pct(b.actual_win_rate)} (n=${b.n})`).join(", ")}. Widest predicted-vs-actual gap is the ${worstGap.band} band (${pctSigned(worstGap.gap)}).`
        + (top.n < 10 ? ` The top band has only ${top.n} graded picks so far -- too few to trust its win rate yet, watch as the sample grows.` : "")
    });
  }

  return findings;
}

function buildMultiDayView(days) {
  let wins = 0;
  let losses = 0;
  let officialMoneyline = 0;
  let strictGateCandidates = 0;
  let lowProbHighLab = 0;

  for (const d of days) {
    for (const p of d.picks || []) {
      const row = normalizePickForLearning(p, d.source);
      if (!row.pick || row.result === "NG") continue;
      officialMoneyline++;
      if (row.result === "W") wins++;
      if (row.result === "L") losses++;
      // 2026-08-08 (Lynold): dropped the stale raw_edge >= 0.03 condition
      // here too -- see the matching note above strongOfficial. This count
      // now matches the real gate (probability + Lab only).
      if (row.status === "official_pick" && num(row.model_probability) >= OFFICIAL_MODEL_PROB && num(row.lab_score) >= OFFICIAL_LAB_SCORE) strictGateCandidates++;
      if (num(row.model_probability) < OFFICIAL_MODEL_PROB && num(row.lab_score) >= OFFICIAL_LAB_SCORE) lowProbHighLab++;
    }
  }

  return {
    moneyline_record: `${wins}-${losses}`,
    moneyline_win_rate: wins + losses ? round(wins / (wins + losses), 4) : null,
    official_moneyline_entries: officialMoneyline,
    strict_gate_candidates: strictGateCandidates,
    high_lab_low_probability_entries: lowProbHighLab,
    note: "Multi-day view includes whatever historical data exists. Older days may include legacy model behavior."
  };
}

function publicPickRow(p) {
  return {
    // game_pk added 2026-08-11: it was already computed on every normalized
    // pick (see normalizePickForLearning) but never surfaced here, so the
    // JSON buckets had no clean join key across a game that appears in more
    // than one bucket. Needed now so learning_games.csv can be one row per
    // real game instead of one row per (game-string, bucket) pair.
    game_pk: p.game_pk || null,
    date: p.date || null,
    status: p.status || null,
    model_version: p.model_version || null,
    game: p.game,
    pick: p.pick,
    result: p.result,
    model_probability: p.model_probability,
    lab_score: p.lab_score,
    raw_edge: p.raw_edge,
    clv_result: p.clv_result,
    lesson_tag: p.lesson_tag,
    pitcher_edge_team: p.pitcher_edge_team,
    pitcher_gap: p.pitcher_gap,
    bullpen_label: p.bullpen_label,
    pick_side_bullpen_score: p.pick_side_bullpen_score,
    opponent_bullpen_score: p.opponent_bullpen_score
  };
}

function currentModelVersion(dayRows, allRows, day) {
  const versions = dayRows.map(p => p.model_version).filter(Boolean);
  if (versions.length) return versions[versions.length - 1];
  const historical = allRows.map(p => p.model_version).filter(Boolean);
  return day.model_version || historical[historical.length - 1] || day.current_official_model || "unknown";
}

// 2026-08-08 (Lynold): when today has zero graded moneyline picks, this used
// to always print "no graded official moneyline picks yet" -- true only in
// the narrow sense of "not today," but it read like "we've never had one,"
// which isn't true (see multi_day.official_moneyline_entries). Now falls
// back to Leo's actual current record, sourced from the calibration ledger
// (calibration_model_log.csv, filtered to the latest model_version -- "leo"
// -- same source the calibration section below already uses), which covers
// every graded game under the current model regardless of official status.
// Only falls back to the old cold-start wording if there's truly no
// calibration data at all yet.
function makeHeadline({ date, wins, losses, winRate, day, calibration }) {
  if (wins + losses > 0) {
    return `Learning summary for ${date}: moneyline record ${wins}-${losses}${winRate !== null ? ` (${pct(winRate)})` : ""}.`;
  }
  if (calibration && calibration.status === "ready" && calibration.games_graded) {
    const cw = calibration.wins || 0;
    const cl = calibration.losses || 0;
    const cwr = cw + cl ? pct(cw / (cw + cl)) : "-";
    return `Learning summary for ${date}: no new moneyline picks graded today. Leo's current record: ${cw}-${cl}${cw + cl ? ` (${cwr})` : ""} across ${calibration.games_graded} graded game${calibration.games_graded === 1 ? "" : "s"} (all statuses, model ${calibration.model_version}).`;
  }
  return `Learning summary for ${date}: no graded official moneyline picks yet.`;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}

function writeJson(rel, obj) {
  const out = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(rel, header, rows) {
  const out = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const body = [header.join(","), ...rows.map(r => header.map(h => csvCell(r[h])).join(","))].join("\n") + "\n";
  fs.writeFileSync(out, body, "utf8");
}

/*
  Splits the single nested learning-summary object into flat tables. Reads
  ONLY from the `summary` object buildLearningSummary() already returns —
  no new analysis, just a different serialization of the same numbers.

  learning_games.csv de-duplicates the five overlapping JSON buckets
  (strong_official / protected_by_probability_gate / high_bullpen_risk /
  pitcher_conflicts / all_moneyline) into one row per game with a boolean
  flag column per bucket, keyed on game_pk where present. NOTE: the
  all_moneyline bucket's rows never carried a `date` in the old JSON either
  (a pre-existing quirk in how that bucket is built vs. the other four,
  which get `date` stitched on from the day being iterated) — not something
  this migration introduces or fixes; flagged here so a blank date in that
  bucket's rows isn't mistaken for a new bug.
*/
function writeLearningSummaryCsvs(summary) {
  const c = summary.calibration || {};
  const shadow = c.shadow_model || {};
  const attribution = c.attribution || {};
  const kprops = c.kprops || {};
  const md = summary.multi_day || {};
  const coach = summary.coach || {}; // not populated by this script — see header note
  const day = summary.day || {};
  const gates = summary.gates || {};
  const pm = summary.process_metrics || {};

  writeCsv("data/learning_summary.csv", [
    "generated_at", "status", "latest_date", "days_reviewed", "source_results", "source_clv",
    "current_official_model", "headline",
    "day_date", "day_source", "day_record_all_markets", "day_units_all_markets", "day_ungraded",
    "day_moneyline_record", "day_moneyline_win_rate", "day_official_moneyline_picks", "day_legacy_market_entries",
    "gate_official_model_probability", "gate_official_lab_score", "gate_note",
    "avg_model_probability", "avg_lab_score", "avg_raw_edge",
    "strong_official_count", "protected_by_probability_gate_count", "high_bullpen_risk_count", "pitcher_conflict_count",
    "calibration_status", "calibration_model_version", "calibration_games_graded", "calibration_wins",
    "calibration_losses", "calibration_brier_score", "calibration_note",
    "shadow_status", "shadow_games", "shadow_official_model_version", "shadow_model_version",
    "shadow_brier_official", "shadow_brier_shadow", "shadow_leader", "shadow_disagreements",
    "shadow_wins_disagreements", "shadow_note",
    "attribution_status", "attribution_games", "attribution_needed",
    "kprops_status", "kprops_self_calibration", "kprops_graded", "kprops_with_projection", "kprops_bias",
    "kprops_mae", "kprops_lean_record", "kprops_over_lean_record", "kprops_under_lean_record",
    "kprops_no_lean", "kprops_note",
    "multi_day_moneyline_record", "multi_day_moneyline_win_rate", "multi_day_official_moneyline_entries",
    "multi_day_strict_gate_candidates", "multi_day_high_lab_low_probability_entries", "multi_day_note",
    "coach_status", "coach_title", "coach_summary", "coach_current_model_days", "coach_current_model_picks",
    "coach_minimum_days", "coach_minimum_picks", "coach_bullpen_model_owner", "coach_hard_stop"
  ], [{
    generated_at: summary.generated_at, status: summary.status, latest_date: summary.latest_date,
    days_reviewed: summary.days_reviewed,
    source_results: summary.source_files && summary.source_files.results,
    source_clv: summary.source_files && summary.source_files.clv,
    current_official_model: summary.current_official_model, headline: summary.headline,
    day_date: day.date, day_source: day.source, day_record_all_markets: day.record_all_markets,
    day_units_all_markets: day.units_all_markets, day_ungraded: day.ungraded,
    day_moneyline_record: day.moneyline_record, day_moneyline_win_rate: day.moneyline_win_rate,
    day_official_moneyline_picks: day.official_moneyline_picks, day_legacy_market_entries: day.legacy_market_entries,
    gate_official_model_probability: gates.official_model_probability, gate_official_lab_score: gates.official_lab_score,
    gate_note: gates.note,
    avg_model_probability: pm.average_model_probability, avg_lab_score: pm.average_lab_score,
    avg_raw_edge: pm.average_raw_edge,
    strong_official_count: pm.strong_official_count, protected_by_probability_gate_count: pm.protected_by_probability_gate_count,
    high_bullpen_risk_count: pm.high_bullpen_risk_count, pitcher_conflict_count: pm.pitcher_conflict_count,
    calibration_status: c.status, calibration_model_version: c.model_version, calibration_games_graded: c.games_graded,
    calibration_wins: c.wins, calibration_losses: c.losses, calibration_brier_score: c.brier_score, calibration_note: c.note,
    shadow_status: shadow.status, shadow_games: shadow.games, shadow_official_model_version: shadow.official_model_version,
    shadow_model_version: shadow.shadow_model_version, shadow_brier_official: shadow.brier_official,
    shadow_brier_shadow: shadow.brier_shadow, shadow_leader: shadow.leader, shadow_disagreements: shadow.disagreements,
    shadow_wins_disagreements: shadow.shadow_wins_disagreements, shadow_note: shadow.note,
    attribution_status: attribution.status, attribution_games: attribution.games, attribution_needed: attribution.needed,
    kprops_status: kprops.status, kprops_self_calibration: kprops.self_calibration, kprops_graded: kprops.graded,
    kprops_with_projection: kprops.with_projection, kprops_bias: kprops.bias, kprops_mae: kprops.mae,
    kprops_lean_record: kprops.lean_record, kprops_over_lean_record: kprops.over_lean_record,
    kprops_under_lean_record: kprops.under_lean_record, kprops_no_lean: kprops.no_lean, kprops_note: kprops.note,
    multi_day_moneyline_record: md.moneyline_record, multi_day_moneyline_win_rate: md.moneyline_win_rate,
    multi_day_official_moneyline_entries: md.official_moneyline_entries,
    multi_day_strict_gate_candidates: md.strict_gate_candidates,
    multi_day_high_lab_low_probability_entries: md.high_lab_low_probability_entries, multi_day_note: md.note,
    coach_status: coach.status, coach_title: coach.title, coach_summary: coach.summary,
    coach_current_model_days: coach.current_model_days, coach_current_model_picks: coach.current_model_picks,
    coach_minimum_days: coach.minimum_days, coach_minimum_picks: coach.minimum_picks,
    coach_bullpen_model_owner: coach.bullpen_model_owner, coach_hard_stop: coach.hard_stop
  }]);

  writeCsv("data/learning_findings.csv", ["title", "read"], summary.findings || []);

  writeCsv("data/learning_calibration_buckets.csv",
    ["range", "games", "wins", "expected_win_rate", "actual_win_rate"], c.buckets || []);

  writeCsv("data/learning_shadow_by_status.csv", ["status", "games", "wins", "units"],
    Object.entries(c.shadow_by_status || {}).map(([status, v]) => ({ status, ...v })));

  writeCsv("data/learning_next_review.csv", ["item"],
    (summary.next_review || []).map(item => ({ item })));

  writeCsv("data/learning_clv_counts.csv", ["label", "count"],
    Object.entries(pm.clv_counts || {}).map(([label, count]) => ({ label, count })));

  writeCsv("data/learning_lesson_counts.csv", ["label", "count"],
    Object.entries(pm.lesson_counts || {}).map(([label, count]) => ({ label, count })));

  const GAME_COLS = ["game_pk", "date", "status", "model_version", "game", "pick", "result", "model_probability",
    "lab_score", "raw_edge", "clv_result", "lesson_tag", "pitcher_edge_team", "pitcher_gap",
    "bullpen_label", "pick_side_bullpen_score", "opponent_bullpen_score"];
  const FLAG_BUCKETS = [
    ["strong_official", "in_strong_official"],
    ["protected_by_probability_gate", "in_protected_by_probability_gate"],
    ["high_bullpen_risk", "in_high_bullpen_risk"],
    ["pitcher_conflicts", "in_pitcher_conflicts"],
    ["all_moneyline", "in_all_moneyline"]
  ];
  const buckets = summary.buckets || {};
  const gameMap = new Map();
  const keyOf = p => p.game_pk != null ? `pk:${p.game_pk}` : `k:${p.date}|${p.game}|${p.pick}|${p.model_version}`;
  for (const [bucketKey, flagCol] of FLAG_BUCKETS) {
    for (const p of buckets[bucketKey] || []) {
      const k = keyOf(p);
      if (!gameMap.has(k)) {
        const row = {};
        GAME_COLS.forEach(col => row[col] = p[col]);
        FLAG_BUCKETS.forEach(([, fc]) => row[fc] = 0);
        gameMap.set(k, row);
      }
      gameMap.get(k)[flagCol] = 1;
    }
  }
  writeCsv("data/learning_games.csv", [...GAME_COLS, ...FLAG_BUCKETS.map(([, fc]) => fc)], [...gameMap.values()]);
}

function readCsvSafe(p) {
  try {
    const raw = fs.readFileSync(p, "utf8").trim();
    if (!raw) return [];
    const lines = raw.split(/\r?\n/);
    const header = splitCsvLine(lines.shift());
    return lines.map(line => {
      const cols = splitCsvLine(line);
      const obj = {};
      header.forEach((h, i) => obj[h] = cols[i] || "");
      return obj;
    });
  } catch (e) {
    return [];
  }
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (!v.startsWith("--")) continue;
    const key = v.slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith("--") ? next : "true";
    if (next && !next.startsWith("--")) i++;
  }
  return out;
}

function countBy(arr, fn) {
  const out = {};
  for (const item of arr) {
    const key = fn(item);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function firstNum(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (typeof v !== "undefined" && v !== null && v !== "" && Number.isFinite(n)) return n;
  }
  return null;
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
}

function avg(vals) {
  const clean = vals.filter(v => typeof v === "number" && Number.isFinite(v));
  if (!clean.length) return null;
  return round(clean.reduce((s, v) => s + v, 0) / clean.length, 4);
}

function round(n, dp = 4) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const m = Math.pow(10, dp);
  return Math.round(n * m) / m;
}

function pct(v) {
  return typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "-";
}

// ---- Full-slate calibration (versioned model ledger) ----
// Every analyzed game — official, value watch, watchlist, pass — graded nightly.
// Measures whether model probabilities are honest (does 65% mean 65%?) and
// what the games below the official gates would have returned.
function buildCalibration() {
  const logPath = path.join(ROOT, "data", "calibration", "calibration_model_log.csv");
  if (!fs.existsSync(logPath)) return { status: "no_data", games_graded: 0 };
  const lines = fs.readFileSync(logPath, "utf8").split("\n").slice(1).filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    const cols = splitCsvLine(line);
    if (cols.length < 12) continue;
    const prob = parseFloat(cols[6]);
    const result = cols[10];
    if (!isFinite(prob) || (result !== "W" && result !== "L")) continue;
    parsed.push({ date: cols[0], game_pk: cols[1], model_version: cols[2], matchup: cols[3], side: cols[4], status: cols[5], prob, mkt: parseFloat(cols[7]), lab: parseFloat(cols[8]), price: parseFloat(cols[9]), won: result === "W", result, final_score: cols[11] });
  }
  const latestModelVersion = parsed.length ? parsed[parsed.length - 1].model_version : null;
  const rows = parsed.filter(r => r.model_version === latestModelVersion);
  if (!rows.length) return { status: "no_data", games_graded: 0 };

  // Probability buckets
  const edges = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 1.01];
  const buckets = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const inB = rows.filter(r => r.prob >= edges[i] && r.prob < edges[i + 1]);
    if (!inB.length) continue;
    buckets.push({
      range: `${Math.round(edges[i] * 100)}-${edges[i + 1] > 1 ? 100 : Math.round(edges[i + 1] * 100)}%`,
      games: inB.length,
      wins: inB.filter(r => r.won).length,
      expected_win_rate: Number((inB.reduce((a, r) => a + r.prob, 0) / inB.length).toFixed(3)),
      actual_win_rate: Number((inB.filter(r => r.won).length / inB.length).toFixed(3))
    });
  }

  // Brier score (lower is better; 0.25 = coin-flip guessing)
  const brier = Number((rows.reduce((a, r) => a + Math.pow(r.prob - (r.won ? 1 : 0), 2), 0) / rows.length).toFixed(4));

  // Shadow record by status: what the non-official tiers would have returned (flat 1u at best price)
  const byStatus = {};
  for (const r of rows) {
    const b = byStatus[r.status] || (byStatus[r.status] = { games: 0, wins: 0, units: 0 });
    b.games++;
    if (r.won) { b.wins++; b.units += isFinite(r.price) ? (r.price > 0 ? r.price / 100 : 100 / Math.abs(r.price)) : 0; }
    else b.units -= 1;
  }
  for (const k of Object.keys(byStatus)) byStatus[k].units = Number(byStatus[k].units.toFixed(2));

  // Versioned A/B: current official model vs shadow model on identical games.
  // The retired shadow_v3_log.csv mixed model eras and is intentionally not
  // used for current comparisons.
  let shadow = { status: "no_data" };
  const sPath = path.join(ROOT, "data", "calibration", "shadow_model_log.csv");
  if (fs.existsSync(sPath)) {
    const parsed = fs.readFileSync(sPath, "utf8").split("\n").slice(1).filter(Boolean).map(l => {
      const [d, pk, officialVersion, shadowVersion, pOfficial, pShadow, hw] = l.split(",");
      return { date: d, game_pk: pk, official_version: officialVersion, shadow_version: shadowVersion, p_official: parseFloat(pOfficial), p_shadow: parseFloat(pShadow), hw: Number(hw) };
    }).filter(r => isFinite(r.p_official) && isFinite(r.p_shadow) && (r.hw === 0 || r.hw === 1));
    if (parsed.length) {
      const latest = parsed[parsed.length - 1];
      const sRows = parsed.filter(r => r.official_version === latest.official_version && r.shadow_version === latest.shadow_version);
      const b = (rowsArr, key) => Number((rowsArr.reduce((a, r) => a + Math.pow(r[key] - r.hw, 2), 0) / rowsArr.length).toFixed(4));
      const diff = sRows.filter(r => (r.p_official >= 0.5) !== (r.p_shadow >= 0.5));
      shadow = {
        status: "ready",
        games: sRows.length,
        official_model_version: latest.official_version,
        shadow_model_version: latest.shadow_version,
        brier_official: b(sRows, "p_official"),
        brier_shadow: b(sRows, "p_shadow"),
        leader: b(sRows, "p_shadow") < b(sRows, "p_official") ? "shadow" : b(sRows, "p_shadow") > b(sRows, "p_official") ? "official" : "tied",
        disagreements: diff.length,
        shadow_wins_disagreements: diff.filter(r => (r.p_shadow >= 0.5) === (r.hw === 1)).length,
        note: "Only rows from the latest matching official/shadow model-version pair are compared. Promote nothing from a mixed-version sample."
      };
    }
  }

  // Attribution: input-metric relevance — dormant until n >= 150
  let attribution = { status: "collecting", games: 0, needed: 150 };
  const aPath = path.join(ROOT, "data", "calibration", "attribution_model_log.csv");
  if (fs.existsSync(aPath)) {
    // 2026-08-25, Lynold's explicit instruction: attribution_model_log.csv
    // was rewritten from a 34-column pick/opp-relative schema to a 31-column
    // home/away-relative schema (see grade-calibration.js's ALOG_COLUMNS).
    // This reader used to address columns POSITIONALLY (r[7], r[9], r[10]...)
    // -- switched to header-name lookups, same fix already applied to the
    // kprops_log.csv reader below on 2026-08-14, so a future reorder can't
    // silently break this section again.
    //
    // Also fixed while here (pre-existing, not caused by today's rewrite):
    // the old idx-10 "Pitcher score gap" factor actually pointed at
    // pick_pitcher (a NAME string, not a number) -- isFinite() silently
    // filtered every row, so that factor had been permanently empty.
    // idx-9 "Lab Rating" pointed at pitcher_gap -- this file has never
    // logged a lab_rating column at all, so that factor was mislabeled data
    // duplication, not a real Lab Rating read. "K-BB% gap" (idx 17) and
    // "Offense form gap (ΔOPS diff)" (idx 26) referenced columns from an
    // even older pre-2026-08-13 schema (K-BB%/OPS-delta) that no longer
    // exist in any version of this file since that reorder -- both were
    // already permanently empty. Dropped both rather than re-map them to
    // unrelated data. Offense form is now covered by home_woba_gap (the
    // real, currently-logged offense-form gap column, wOBA-based).
    const aHead = fs.readFileSync(aPath, "utf8").split("\n")[0].split(",");
    const aIdx = name => aHead.indexOf(name);
    const iModelVer = aIdx("model_version"), iPickTeam = aIdx("pick_team"), iWinner = aIdx("winner");
    const iHomeProb = aIdx("home_model_prob"), iHomePitcherGap = aIdx("home_pitcher_gap");
    const iHomeWobaGap = aIdx("home_woba_gap"), iHomeBullpenGap = aIdx("home_bullpen_gap");
    const aRows = iModelVer === -1 ? [] : fs.readFileSync(aPath, "utf8").trim().split("\n").slice(1).map(splitCsvLine)
      .filter(r => r.length === aHead.length && r[iModelVer] === latestModelVersion && (r[iWinner] === "home" || r[iWinner] === "away"))
      .map(r => ({ r, pickIsHome: r[iPickTeam] === "home team", won: (r[iPickTeam] === "home team") === (r[iWinner] === "home") }));
    attribution.games = aRows.length;
    if (aRows.length >= 150) {
      // Every source column below is home-relative; flipped back to
      // pick-relative here (negated for away picks) so "high tertile" means
      // the same thing — favorable to whoever was picked — on every row,
      // regardless of which side LyDia picked.
      // toPickRelative: gap-type columns (additive, symmetric around 0) just
      // negate for an away pick; home_model_prob is a bounded 0-1
      // probability, so an away pick needs the complement (1-v), not -v.
      const negateForAway = (v, pickIsHome) => pickIsHome ? v : -v;
      const complementForAway = (v, pickIsHome) => pickIsHome ? v : (1 - v);
      const factor = (label, idx, toPickRelative) => {
        if (idx === -1) return null;
        const have = aRows.filter(x => x.r[idx] !== "" && isFinite(Number(x.r[idx]))).map(x => ({
          v: toPickRelative(Number(x.r[idx]), x.pickIsHome),
          won: x.won
        }));
        if (have.length < 100) return null;
        const sorted = [...have].sort((a, b) => a.v - b.v);
        const cut = n => sorted[Math.floor(sorted.length * n)].v;
        const lo = cut(1 / 3), hi = cut(2 / 3);
        const tert = [have.filter(x => x.v <= lo), have.filter(x => x.v > lo && x.v <= hi), have.filter(x => x.v > hi)];
        return { factor: label, tertiles: tert.map((t, i) => ({ band: i === 0 ? "low" : i === 1 ? "mid" : "high", games: t.length, win_rate: Number((t.filter(x => x.won).length / t.length).toFixed(3)) })), spread: Number((tert[2].filter(x => x.won).length / tert[2].length - tert[0].filter(x => x.won).length / tert[0].length).toFixed(3)) };
      };
      const factors = [
        factor("Pitcher score gap (pick − opp)", iHomePitcherGap, negateForAway),
        factor("Offense form gap (pick − opp, wOBA)", iHomeWobaGap, negateForAway),
        factor("Bullpen fatigue gap (opp − pick)", iHomeBullpenGap, negateForAway),
        factor("Model probability", iHomeProb, complementForAway)
      ].filter(Boolean).sort((a, b) => Math.abs(b.spread) - Math.abs(a.spread));
      attribution = { status: "ready", games: aRows.length, factors,
        note: "Win rate by input tertile, pick-side relative. |spread| = high-band win rate minus low-band — bigger magnitude = the metric separates winners from losers harder, and deserves weight. Read direction too: a NEGATIVE spread on a should-be-positive factor is a red flag." };
    }
  }

  // K-props learning: projection accuracy + lean record
  let kprops = { status: "no_data" };
  const kPath = path.join(ROOT, "data", "calibration", "kprops_log.csv");
  if (fs.existsSync(kPath)) {
    const kLines = fs.readFileSync(kPath, "utf8").trim().split("\n");
    // 2026-08-14: kprops_log.csv's columns were reordered/renamed/trimmed to
    // Lynold's exact spec. This reader used to address the file POSITIONALLY
    // (r[5]=projection, r[6]=actual_k, r[8]=lean, r[9]=lean_result) — the same
    // bug fixed the same day in update-k-props.js's self-calibration reader.
    // Switched to header-name lookups so a future reorder can't silently break
    // this report's numbers.
    const kHead = (kLines[0] || "").split(",");
    const kIdx = name => kHead.indexOf(name);
    const iProj = kIdx("projection"), iActual = kIdx("actual_k"), iLean = kIdx("lean"), iLeanRes = kIdx("lean_result");
    if (iProj === -1 || iActual === -1 || iLean === -1 || iLeanRes === -1) {
      kprops = { status: "no_data", note: `kprops_log.csv header missing an expected column (found: ${kHead.join("|") || "no header"}).` };
    } else {
      const kRows = kLines.slice(1).map(l => l.split(",")).filter(r => r.length > Math.max(iProj, iActual, iLean, iLeanRes) && r[iActual] !== "");
      const withProj = kRows.filter(r => r[iProj] !== "" && isFinite(Number(r[iProj])));
      if (withProj.length) {
        const errs = withProj.map(r => Number(r[iActual]) - Number(r[iProj]));
        const leans = kRows.filter(r => r[iLeanRes] === "W" || r[iLeanRes] === "L");
        const overLeans = leans.filter(r => Number(r[iLean]) > 0), underLeans = leans.filter(r => Number(r[iLean]) < 0);
        const rec = a => `${a.filter(r => r[iLeanRes] === "W").length}-${a.filter(r => r[iLeanRes] === "L").length}`;
        let kliveBias = 0, kliveN = 0;
        try { const kf = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "k-props", "today.json"), "utf8")); kliveBias = kf.learned_bias || 0; kliveN = kf.learned_n || 0; } catch (e) {}
        kprops = {
          status: "ready",
          self_calibration: kliveBias ? `${kliveBias > 0 ? "+" : ""}${kliveBias} K correction active (n=${kliveN})` : "no correction needed yet",
          graded: kRows.length,
          with_projection: withProj.length,
          bias: Number((errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(2)),
          mae: Number((errs.reduce((a, b) => a + Math.abs(b), 0) / errs.length).toFixed(2)),
          lean_record: rec(leans),
          over_lean_record: rec(overLeans),
          under_lean_record: rec(underLeans),
          no_lean: kRows.filter(r => r[iLean] !== "" && Math.abs(Number(r[iLean])) < 0.7).length,
          note: "Bias = actual minus projection (positive means we under-project). Leans only counted at 0.7+ strikeout edges. Small samples early — a lean record means little before ~100 graded pitchers."
        };
      }
    }
  }

  return {
    status: "ready",
    model_version: latestModelVersion,
    games_graded: rows.length,
    wins: rows.filter(r => r.won).length,
    losses: rows.filter(r => !r.won).length,
    brier_score: brier,
    shadow_model: shadow,
    attribution,
    kprops,
    note: "Shadow ledger for learning only — never part of the public record. Official picks stay the only published record.",
    buckets,
    shadow_by_status: byStatus
  };
}
