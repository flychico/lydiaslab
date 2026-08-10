/*
  LyDia — shared results.json / results/index.html reconstruction.

  Used by both scripts/grade-results.js (grades today's picks, then rebuilds
  using what it just wrote) and scripts/rebuild-results.js (rebuilds
  everything from data/results_log.csv alone, no grading, no network calls
  — this is what runs after a hand-edit to the CSV).

  Design: data/results_log.csv is authoritative for WHAT HAPPENED (result,
  actual stat, final score). data/published-picks/<date>.json (or the legacy
  data/picks/<date>.json) is authoritative for WHAT WAS PICKED (price,
  model probability, lab score, pitcher/bullpen context) — that half never
  needs hand-editing, so it's still read fresh from its original file rather
  than duplicated into the CSV. rebuildDay() below merges the two.
*/

const fs = require("fs");
const path = require("path");
const { readRowsForDate, computeUnits } = require("./results-log");

const ROOT = path.join(__dirname, "..", "..");

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const amToDec = am => am > 0 ? 1 + am / 100 : 1 + 100 / Math.abs(am);
const fmtAm = am => am > 0 ? "+" + am : String(am);
function niceDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function normPick(p) {
  if (p.moneyline || p.total || Array.isArray(p.strikeouts)) {
    return { ...p, strikeouts: Array.isArray(p.strikeouts) ? p.strikeouts : [] };
  }
  return {
    gamePk: p.gamePk, away: p.away, home: p.home, time: p.time,
    labScore: p.edgeScore || null,
    moneyline: { pick: p.pick, side: p.side, prob: p.prob, mktProb: p.mktProb, bestAm: p.bestAm, valueTag: p.valueTag, isPass: false, consensusAgree: p.consensusAgree, consensusOppose: p.consensusOppose },
    total: null, runLine: null, strikeouts: []
  };
}

function readJsonSafe(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")); } catch (e) { return null; }
}

function loadPicksForDate(date) {
  const publishedFile = path.join(ROOT, "data", "published-picks", `${date}.json`);
  const legacyFile = path.join(ROOT, "data", "picks", `${date}.json`);
  if (fs.existsSync(publishedFile)) {
    const data = JSON.parse(fs.readFileSync(publishedFile, "utf8"));
    return { file: publishedFile, data, source: "published-picks" };
  }
  if (fs.existsSync(legacyFile)) {
    const data = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
    return { file: legacyFile, data, source: "legacy-picks" };
  }
  return null;
}

function loadMarketMap(date) {
  const market = readJsonSafe(`data/market/${date}.json`);
  const map = new Map();
  if (!market || !Array.isArray(market.items)) return map;
  for (const item of market.items) {
    map.set(item.pick_id, item);
    map.set(`${item.game}|${item.pick_team}`, item);
  }
  return map;
}

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }
function pickId(p, date) { return `${slug(p.away)}-${slug(p.home)}-${date}-ml`; }

function clvResult(posted, closing) {
  if (typeof posted !== "number" || typeof closing !== "number") return "not_tracked";
  const postedDec = amToDec(posted);
  const closingDec = amToDec(closing);
  if (Math.abs(postedDec - closingDec) < 0.015) return "stable";
  return closingDec < postedDec ? "beat_close" : "lost_to_close";
}

function lessonTag({ result, clv, modelProb, labScore }) {
  if (result === "NG") return "not_graded";
  if (clv === "beat_close" && result === "W") return "good_process_win";
  if (clv === "beat_close" && result === "L") return "good_price_bad_result";
  if (clv === "lost_to_close" && result === "W") return "result_win_price_warning";
  if (clv === "lost_to_close" && result === "L") return "bad_process_loss";
  if (modelProb < 0.6 && labScore >= 80) return "high_lab_low_probability_watch_only";
  return result === "W" ? "win_needs_more_sample" : "loss_needs_review";
}

function buildLearning(p, result, marketItem, source) {
  const ml = p.moneyline || {};
  const posted = marketItem && typeof marketItem.posted_price === "number" ? marketItem.posted_price : ml.bestAm;
  const closing = marketItem && typeof marketItem.closing_price === "number" ? marketItem.closing_price : null;
  const labScore = p.labScore || p.lab_score || ml.edgeScore || null;
  const modelProb = ml.prob ?? null;
  const clv = clvResult(posted, closing);
  return {
    model_version: ml.modelVersion || p.modelVersion || p.model_version || (source === "published-picks" ? "moneyline-v2-strict-probability-gate" : "legacy"),
    official_model: source === "published-picks" ? "moneyline_only" : "legacy_mixed_markets",
    result_source: source,
    lab_score: labScore,
    model_probability: modelProb,
    market_probability: ml.mktProb ?? null,
    raw_edge: ml.rawEdge ?? (typeof modelProb === "number" && typeof ml.mktProb === "number" ? Number((modelProb - ml.mktProb).toFixed(4)) : null),
    pitcher_edge_team: p.pitcherEdge && p.pitcherEdge.team ? p.pitcherEdge.team : null,
    pitcher_gap: p.pitcherEdge && typeof p.pitcherEdge.gap === "number" ? p.pitcherEdge.gap : null,
    bullpen_label: p.bullpen && p.bullpen.label ? p.bullpen.label : null,
    pick_side_bullpen_score: p.bullpen && p.bullpen.pick_team ? p.bullpen.pick_team.score : null,
    opponent_bullpen_score: p.bullpen && p.bullpen.opponent ? p.bullpen.opponent.score : null,
    posted_price: posted ?? null,
    current_price: marketItem && typeof marketItem.current_price === "number" ? marketItem.current_price : null,
    closing_price: closing,
    clv_result: clv,
    result,
    lesson_tag: lessonTag({ result, clv, modelProb: modelProb || 0, labScore: labScore || 0 })
  };
}

/*
  Rebuilds one day's results.json entry purely from data/results_log.csv +
  that date's original published-picks file. No network access.
*/
function rebuildDay(date) {
  const loaded = loadPicksForDate(date);
  if (!loaded) return null;
  const picks = Array.isArray(loaded.data.picks) ? loaded.data.picks : [];
  const csvRows = readRowsForDate(date);
  const rowsByGame = new Map();
  for (const r of csvRows) {
    const key = String(r.game_pk);
    if (!rowsByGame.has(key)) rowsByGame.set(key, []);
    rowsByGame.get(key).push(r);
  }
  const marketMap = loadMarketMap(date);

  const graded = [];
  let wins = 0, losses = 0, ungraded = 0, voided = 0, units = 0, unitsCounted = 0;
  const marketRecords = {
    moneyline: { wins: 0, losses: 0, pushes: 0, voids: 0, units: 0 },
    game_total: { wins: 0, losses: 0, pushes: 0, voids: 0, units: 0 },
    pitcher_strikeouts: { wins: 0, losses: 0, pushes: 0, voids: 0, units: 0 }
  };

  const tally = (bucket, result, price) => {
    const u = computeUnits(result, price);
    if (result === "W") { wins++; if (bucket) marketRecords[bucket].wins++; }
    else if (result === "L") { losses++; if (bucket) marketRecords[bucket].losses++; }
    else if (result === "PUSH" && bucket) marketRecords[bucket].pushes++;
    else if (result === "VOID") { if (bucket) marketRecords[bucket].voids++; voided++; }
    if (u !== null) { units += u; unitsCounted++; if (bucket) marketRecords[bucket].units += u; }
    return u;
  };

  for (const raw of picks) {
    const p = normPick(raw);
    const rows = rowsByGame.get(String(p.gamePk)) || [];
    const marketItem = marketMap.get(pickId(p, date)) || marketMap.get(`${p.away} @ ${p.home}|${p.moneyline && p.moneyline.pick}`);

    if (!rows.length || (rows.length === 1 && rows[0].market === "NG")) {
      const learning = buildLearning(p, "NG", marketItem, loaded.source);
      graded.push({ ...p, result: "NG", learning });
      ungraded++;
      continue;
    }

    const mlRow = rows.find(r => r.market === "moneyline");
    const totRow = rows.find(r => r.market === "game_total");
    const kRows = rows.filter(r => r.market === "pitcher_strikeouts");
    const rlRow = rows.find(r => r.market === "run_line");
    const anyRow = mlRow || totRow || kRows[0] || rlRow;
    const finalAway = anyRow ? Number(anyRow.final_away) : undefined;
    const finalHome = anyRow ? Number(anyRow.final_home) : undefined;

    let mlResult = "NG";
    if (mlRow) {
      mlResult = mlRow.result;
      tally("moneyline", mlResult, mlRow.price);
    }

    let totResult = "NG";
    if (totRow) {
      totResult = totRow.result;
      tally("game_total", totResult, totRow.price);
    }

    const kResults = kRows.map(r => ({
      pitcher: r.pitcher, pick: r.pick, line: Number(r.line), bestAm: Number(r.price),
      actual: r.actual === "" ? null : Number(r.actual), result: r.result
    }));
    for (const r of kRows) tally("pitcher_strikeouts", r.result, r.price);

    let rlResult = "NG";
    if (rlRow) {
      rlResult = rlRow.result;
      tally(null, rlResult, rlRow.price); // run_line was never its own market_records bucket, matches original
    }

    const learning = buildLearning(p, mlResult, marketItem, loaded.source);
    graded.push({ ...p, mlResult, totResult, kResults, rlResult, finalAway, finalHome, learning });
  }

  const modelVersion = loaded.data.model_version ||
    (graded.find(p => p.modelVersion || p.model_version) || {}).modelVersion ||
    (graded.find(p => p.modelVersion || p.model_version) || {}).model_version ||
    (loaded.source === "published-picks" ? "unknown" : "legacy");

  return {
    date,
    wins, losses, ungraded, voided,
    units: unitsCounted ? Number(units.toFixed(2)) : null,
    source: loaded.source,
    current_official_model: loaded.data.current_official_model || (loaded.source === "published-picks" ? "moneyline_only" : "legacy_mixed_markets"),
    model_version: modelVersion,
    market_records: Object.fromEntries(Object.entries(marketRecords).map(([k, v]) => [k, { ...v, units: Number(v.units.toFixed(2)) }])),
    picks: graded
  };
}

// Every date that has at least one row in results_log.csv is rebuildable.
function allLoggedDates() {
  const { readAllRows } = require("./results-log");
  return [...new Set(readAllRows().map(r => r.date))].sort();
}

function rebuildResultsPage(results) {
  const days = Object.values(results.days).sort((a, b) => b.date.localeCompare(a.date));
  const officialDays = days.filter(d => ["moneyline_only", "multi_market_v1"].includes(d.current_official_model));

  let OW = 0, OL = 0, OU = 0, hasOfficialUnits = false;
  const lifetimeMarkets = {
    moneyline: { wins: 0, losses: 0, pushes: 0, voids: 0, units: 0 },
    game_total: { wins: 0, losses: 0, pushes: 0, voids: 0, units: 0 },
    pitcher_strikeouts: { wins: 0, losses: 0, pushes: 0, voids: 0, units: 0 }
  };
  for (const d of officialDays) {
    if (d.market_records) {
      for (const key of Object.keys(lifetimeMarkets)) {
        const rec = d.market_records[key] || {};
        for (const field of ["wins", "losses", "pushes", "voids", "units"]) lifetimeMarkets[key][field] += Number(rec[field]) || 0;
      }
    } else {
      for (const p of d.picks || []) {
        if (p.mlResult === "W") lifetimeMarkets.moneyline.wins++;
        else if (p.mlResult === "L") lifetimeMarkets.moneyline.losses++;
      }
    }
    if (d.units !== null && Number.isFinite(d.units)) { OU += d.units; hasOfficialUnits = true; }
  }
  for (const rec of Object.values(lifetimeMarkets)) { OW += rec.wins; OL += rec.losses; }
  const gradedOfficial = OW + OL;
  const oPct = gradedOfficial ? (OW / gradedOfficial * 100).toFixed(1) : "—";

  const pickLine = p => {
    const lines = [];
    const icon = r => r === "W" ? "✅" : r === "L" ? "❌" : r === "VOID" ? "∅" : r === "PUSH" ? "↔" : "⏸";
    if (p.moneyline && p.moneyline.pick && !p.moneyline.isPass) {
      const probability = typeof p.moneyline.prob === "number" ? ` (${(p.moneyline.prob * 100).toFixed(0)}%${p.moneyline.bestAm ? `, ${fmtAm(p.moneyline.bestAm)}` : ""})` : "";
      lines.push(`<div class="small">${icon(p.mlResult)} ML ${esc(p.moneyline.pick)}${probability}</div>`);
    }
    if (p.total && p.total.pick) lines.push(`<div class="small">${icon(p.totResult)} TOTAL ${esc(p.total.pick)} ${esc(p.total.line)} (${fmtAm(p.total.bestAm)})</div>`);
    for (const k of p.kResults || p.strikeouts || []) lines.push(`<div class="small">${icon(k.result)} K PROP ${esc(k.pitcher)} ${esc(k.pick)} ${esc(k.line)} (${fmtAm(k.bestAm)})${k.actual !== null && k.actual !== undefined ? ` · ${esc(k.actual)} K` : ""}</div>`);
    if (!lines.length) lines.push(`<div class="small dim">No official play</div>`);
    return `<div style="margin-bottom:8px"><div class="small"><strong>${esc(p.away)} @ ${esc(p.home)}</strong>${p.finalAway !== undefined ? ` · ${p.finalAway}-${p.finalHome}` : ""}</div>${lines.join("")}</div>`;
  };

  const dayRows = officialDays.slice(0, 60).map(d => {
    const picks = d.picks || [];
    const records = d.market_records || {};
    const dW = Object.values(records).reduce((n, r) => n + (Number(r.wins) || 0), 0) || picks.filter(p => p.mlResult === "W").length;
    const dL = Object.values(records).reduce((n, r) => n + (Number(r.losses) || 0), 0) || picks.filter(p => p.mlResult === "L").length;
    const dPct = dW + dL ? (dW / (dW + dL) * 100).toFixed(0) + "%" : "—";
    return `<tr>
    <td>${esc(niceDate(d.date))}</td>
    <td class="num">${dW}-${dL}</td>
    <td class="num">${dPct}</td>
    <td class="num ${d.units > 0 ? "pos-text" : d.units < 0 ? "neg-text" : ""}">${d.units !== null ? (d.units > 0 ? "+" : "") + d.units.toFixed(2) : "—"}</td>
    <td><details><summary>${picks.length} published pick group${picks.length === 1 ? "" : "s"}</summary>${picks.map(pickLine).join("")}</details></td>
  </tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Results — verified official pick record | LyDia</title>
<meta name="description" content="LyDia verified official results by market: moneyline, game totals, and pitcher strikeout props. Every official pick stays public, including losses, pushes, and voids.">
<link rel="canonical" href="https://lydiaslab.com/results/">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>&#9918;</text></svg>">
<link rel="stylesheet" href="/css/style.css">
</head>
<body>
<nav id="nav"></nav>
<main>
<h1>Results</h1>
<p class="subtitle">LyDia tracks official moneylines, full-game totals, and pitcher strikeout props. Each market has its own qualification rules and its own public record. Team totals remain research-only while their graded sample develops.</p>
<section id="live-pick-results" class="card" style="margin:16px 0 24px">
  <h2 style="margin-top:0">Today's Pick Status</h2>
  <div class="loading">Loading live pick results...</div>
</section>
<div class="kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px">
  <div class="card"><div class="dim small">OFFICIAL RECORD</div><div style="font-size:1.6rem;font-weight:700">${OW}-${OL}</div><div class="dim small">${oPct === "—" ? "no graded official picks yet" : oPct + "% win rate"}</div></div>
  <div class="card"><div class="dim small">GRADED OFFICIAL PICKS</div><div style="font-size:1.6rem;font-weight:700">${gradedOfficial}</div><div class="dim small">all official markets</div></div>
  <div class="card"><div class="dim small">OFFICIAL UNITS (flat 1u)</div><div style="font-size:1.6rem;font-weight:700" class="${OU > 0 ? "pos-text" : OU < 0 ? "neg-text" : ""}">${hasOfficialUnits ? (OU > 0 ? "+" : "") + OU.toFixed(2) : "—"}</div><div class="dim small">at published best price</div></div>
  <div class="card"><div class="dim small">DAYS TRACKED</div><div style="font-size:1.6rem;font-weight:700">${days.length}</div><div class="dim small">since public tracking began</div></div>
</div>
<div class="notice" style="margin-bottom:20px">
  <strong>Public record scope:</strong> The combined record includes only dated, locked official picks. Market records remain separate so a strong K-prop run cannot hide weak totals, or vice versa.
</div>
<div class="kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:24px">
  ${Object.entries(lifetimeMarkets).map(([key, r]) => `<div class="card"><div class="dim small">${esc(key.replace(/_/g, " ").toUpperCase())}</div><div style="font-size:1.35rem;font-weight:700">${r.wins}-${r.losses}</div><div class="dim small">${r.pushes} push · ${r.voids} void · ${(r.units > 0 ? "+" : "") + r.units.toFixed(2)}u</div></div>`).join("")}
</div>
<div class="card">
<table>
<thead><tr><th>Date</th><th class="num">Record</th><th class="num">Win%</th><th class="num">Units</th><th>Picks</th></tr></thead>
<tbody>
${dayRows}
</tbody>
</table>
</div>
<div class="notice" style="margin-top:20px">
  Picks are published to dated locked files before grading. The official record is rebuilt from those dated files after games finish, so the history has a public timestamp trail.
  A reminder that even good models have losing stretches: judge the process over hundreds of picks, not a hot or cold week.
</div>
<div class="lead-box" style="border-color:var(--accent2);margin-top:16px">
  <h3 style="margin:0 0 4px">Want this delivered before first pitch?</h3>
  <p class="dim small" style="margin:0">$30/month. Same transparency, cleaner delivery.</p>
  <p style="margin-top:10px"><a class="btn blue" href="/membership/">Join LyDia — $30/mo →</a></p>
</div>
</main>
<footer id="footer"></footer>
<script src="/js/app.js"></script>
<script src="/js/live-results.js"></script>
<script>renderNav("/results/"); renderFooter();</script>
</body>
</html>
`;
}

function rebuildAll() {
  const dates = allLoggedDates();
  const results = { days: {} };
  for (const date of dates) {
    const day = rebuildDay(date);
    if (day) results.days[date] = day;
  }
  return results;
}

module.exports = {
  normPick, loadPicksForDate, loadMarketMap, pickId, buildLearning, clvResult, lessonTag,
  rebuildDay, rebuildAll, rebuildResultsPage, esc, fmtAm, amToDec, niceDate
};
