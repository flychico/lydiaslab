#!/usr/bin/env node
"use strict";

/*
  LyDia Learning Summary Generator

  Reads:
  - data/results.json
  - data/clv/clv_log.csv when present

  Writes:
  - data/learning-summary.json
  - data/learning/<date>.json

  Purpose:
  Turn graded results into a readable process review.
  This does not change picks. It only summarizes what happened after grading.
*/

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const RESULTS_PATH = path.join(ROOT, "data", "results.json");
const CLV_PATH = path.join(ROOT, "data", "clv", "clv_log.csv");

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

  const summary = buildLearningSummary({ date, day, allDays, clvRows });

  writeJson(`data/learning/${date}.json`, summary);
  writeJson("data/learning-summary.json", summary);

  console.log(`Learning summary generated for ${date}.`);
}

function buildLearningSummary({ date, day, allDays, clvRows }) {
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

  const strongOfficial = allGradedMoneyline.filter(p =>
    p.status === "official_pick" &&
    num(p.model_probability) >= 0.72 &&
    num(p.lab_score) >= 80 &&
    num(p.raw_edge) >= 0.03
  );

  const protectedByGate = (allDays || []).flatMap(d =>
    (Array.isArray(d.picks) ? d.picks : [])
      .map(p => normalizePickForLearning(p, d.source))
      .filter(p =>
        p.market === "moneyline" &&
        p.pick &&
        (p.result === "W" || p.result === "L") &&
        num(p.model_probability) < 0.72 &&
        num(p.lab_score) >= 80
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
    clvCounts
  });

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
    headline: makeHeadline({ date, wins, losses, winRate, day }),
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
      official_model_probability: 0.72,
      official_lab_score: 80,
      official_market_edge: 0.03,
      note: "Official picks require high model probability and strong setup quality. A high Lab Rating alone is not enough."
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
    calibration: buildCalibration(),
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
  if (num(modelProbability) < 0.72 && num(labScore) >= 80) return "high_lab_low_probability_watch_only";
  if (num(modelProbability) >= 0.72 && num(labScore) >= 80 && result === "W") return "strict_gate_win";
  if (num(modelProbability) >= 0.72 && num(labScore) >= 80 && result === "L") return "strict_gate_loss_review";
  return result === "W" ? "win_needs_more_sample" : "loss_needs_review";
}

function legacyMarketRows(p) {
  const out = [];
  if (p.total && p.total.pick) out.push({ market: "total", result: p.totResult || "NG" });
  if (p.runLine && p.runLine.pick) out.push({ market: "run_line", result: p.rlResult || "NG" });
  return out;
}

function buildFindings(ctx) {
  const findings = [];

  if (!ctx.gradedMoneyline.length) {
    findings.push({
      title: "No official moneyline picks graded yet",
      read: "Learning will become useful after a finished slate is graded under the current model."
    });
    return findings;
  }

  findings.push({
    title: "Official-pick discipline",
    read: `${ctx.gradedMoneyline.length} moneyline pick${ctx.gradedMoneyline.length === 1 ? "" : "s"} ${ctx.gradedMoneyline.length === 1 ? "was" : "were"} graded. Record: ${ctx.wins}-${ctx.losses}${ctx.winRate !== null ? ` (${pct(ctx.winRate)})` : ""}.`
  });

  findings.push({
    title: "Probability gate",
    read: ctx.protectedByGate.length
      ? `Across all reviewed days, ${ctx.protectedByGate.length} graded setup${ctx.protectedByGate.length === 1 ? "" : "s"} had strong Lab Rating but model probability below 72%. Those should remain value watch, not official picks.`
      : "No high-Lab, low-probability moneyline setups appeared in the graded official set."
  });

  findings.push({
    title: "Bullpen learning",
    read: ctx.highBullpenRisk.length
      ? `Across all reviewed days, ${ctx.highBullpenRisk.length} graded moneyline pick${ctx.highBullpenRisk.length === 1 ? "" : "s"} carried a meaningful bullpen caution. Review these before adjusting thresholds.`
      : "No graded moneyline picks carried a major bullpen caution."
  });

  findings.push({
    title: "Pitcher learning",
    read: ctx.pitcherConflict.length
      ? `Across all reviewed days, ${ctx.pitcherConflict.length} graded pick${ctx.pitcherConflict.length === 1 ? "" : "s"} had a starting-pitcher conflict. These need manual review.`
      : "No major starting-pitcher conflicts showed up in the graded moneyline set."
  });

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
      if (row.status === "official_pick" && num(row.model_probability) >= 0.72 && num(row.lab_score) >= 80 && num(row.raw_edge) >= 0.03) strictGateCandidates++;
      if (num(row.model_probability) < 0.72 && num(row.lab_score) >= 80) lowProbHighLab++;
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

function makeHeadline({ date, wins, losses, winRate, day }) {
  if (wins + losses === 0) {
    return `Learning summary for ${date}: no graded official moneyline picks yet.`;
  }
  return `Learning summary for ${date}: moneyline record ${wins}-${losses}${winRate !== null ? ` (${pct(winRate)})` : ""}.`;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}

function writeJson(rel, obj) {
  const out = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(obj, null, 2) + "\n", "utf8");
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
    const aRows = fs.readFileSync(aPath, "utf8").trim().split("\n").slice(1).map(splitCsvLine).filter(r => r.length >= 13 && r[2] === latestModelVersion && (r[4] === "W" || r[4] === "L"));
    attribution.games = aRows.length;
    if (aRows.length >= 150) {
      const factor = (label, idx, fmt) => {
        const have = aRows.filter(r => r[idx] !== "" && isFinite(Number(r[idx]))).map(r => ({ v: Number(r[idx]), won: r[4] === "W" }));
        if (have.length < 100) return null;
        const sorted = [...have].sort((a, b) => a.v - b.v);
        const cut = n => sorted[Math.floor(sorted.length * n)].v;
        const lo = cut(1 / 3), hi = cut(2 / 3);
        const tert = [have.filter(x => x.v <= lo), have.filter(x => x.v > lo && x.v <= hi), have.filter(x => x.v > hi)];
        return { factor: label, tertiles: tert.map((t, i) => ({ band: i === 0 ? "low" : i === 1 ? "mid" : "high", games: t.length, win_rate: Number((t.filter(x => x.won).length / t.length).toFixed(3)) })), spread: Number((tert[2].filter(x => x.won).length / tert[2].length - tert[0].filter(x => x.won).length / tert[0].length).toFixed(3)) };
      };
      const factors = [
        factor("Pitcher score gap (pick − opp)", 7),
        factor("K-BB% gap (pick − opp)", 8),
        factor("Offense form gap (ΔOPS diff)", 11),
        factor("Bullpen fatigue gap (opp − pick)", 12),
        factor("Lab Rating", 6),
        factor("Model probability", 5)
      ].filter(Boolean).sort((a, b) => Math.abs(b.spread) - Math.abs(a.spread));
      attribution = { status: "ready", games: aRows.length, factors,
        note: "Win rate by input tertile, pick-side relative. |spread| = high-band win rate minus low-band — bigger magnitude = the metric separates winners from losers harder, and deserves weight. Read direction too: a NEGATIVE spread on a should-be-positive factor is a red flag." };
    }
  }

  // K-props learning: projection accuracy + lean record
  let kprops = { status: "no_data" };
  const kPath = path.join(ROOT, "data", "calibration", "kprops_log.csv");
  if (fs.existsSync(kPath)) {
    const kRows = fs.readFileSync(kPath, "utf8").trim().split("\n").slice(1).map(l => l.split(",")).filter(r => r.length >= 10 && r[6] !== "");
    const withProj = kRows.filter(r => r[5] !== "" && isFinite(Number(r[5])));
    if (withProj.length) {
      const errs = withProj.map(r => Number(r[6]) - Number(r[5]));
      const leans = kRows.filter(r => r[9] === "W" || r[9] === "L");
      const overLeans = leans.filter(r => Number(r[8]) > 0), underLeans = leans.filter(r => Number(r[8]) < 0);
      const rec = a => `${a.filter(r => r[9] === "W").length}-${a.filter(r => r[9] === "L").length}`;
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
        no_lean: kRows.filter(r => r[8] !== "" && Math.abs(Number(r[8])) < 0.7).length,
        note: "Bias = actual minus projection (positive means we under-project). Leans only counted at 0.7+ strikeout edges. Small samples early — a lean record means little before ~100 graded pitchers."
      };
    }
  }

  return {
    status: "ready",
    model_version: latestModelVersion,
    games_graded: rows.length,
    brier_score: brier,
    shadow_model: shadow,
    attribution,
    kprops,
    note: "Shadow ledger for learning only — never part of the public record. Official picks stay the only published record.",
    buckets,
    shadow_by_status: byStatus
  };
}
