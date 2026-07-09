#!/usr/bin/env node
/* LyDia — grade published picks against final scores and rebuild results/index.html.
   Usage: node scripts/grade-results.js [YYYY-MM-DD]  (default: yesterday in US Eastern)
   Reads first: data/published-picks/<date>.json
   Fallback:    data/picks/<date>.json for pre-lock historical days
   Writes:      data/results.json, results/index.html, data/clv/clv_log.csv */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

function etYesterday() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  et.setDate(et.getDate() - 1);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}
const DATE = process.argv[2] || etYesterday();
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const amToDec = am => am > 0 ? 1 + am / 100 : 1 + 100 / Math.abs(am);
const fmtAm = am => am > 0 ? "+" + am : String(am);
function niceDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function normPick(p) {
  if (p.moneyline) return p;
  return {
    gamePk: p.gamePk, away: p.away, home: p.home, time: p.time,
    labScore: p.edgeScore || null,
    moneyline: { pick: p.pick, side: p.side, prob: p.prob, mktProb: p.mktProb, bestAm: p.bestAm, valueTag: p.valueTag, isPass: false, consensusAgree: p.consensusAgree, consensusOppose: p.consensusOppose },
    total: null, runLine: null
  };
}

const RESULTS_PATH = path.join(ROOT, "data", "results.json");
const CLV_PATH = path.join(ROOT, "data", "clv", "clv_log.csv");

function readJsonSafe(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")); } catch (e) { return null; }
}
function loadPicksForDate() {
  const publishedFile = path.join(ROOT, "data", "published-picks", `${DATE}.json`);
  const legacyFile = path.join(ROOT, "data", "picks", `${DATE}.json`);
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
function loadMarketMap() {
  const market = readJsonSafe(`data/market/${DATE}.json`);
  const map = new Map();
  if (!market || !Array.isArray(market.items)) return map;
  for (const item of market.items) {
    map.set(item.pick_id, item);
    map.set(`${item.game}|${item.pick_team}`, item);
  }
  return map;
}
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
function pickId(p) {
  return `${slug(p.away)}-${slug(p.home)}-${DATE}-ml`;
}
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
    model_version: p.modelVersion || p.model_version || (source === "published-picks" ? "moneyline-v2-strict-probability-gate" : "legacy"),
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

async function gradeDay() {
  const loaded = loadPicksForDate();
  if (!loaded) { console.log(`No published picks file for ${DATE} — nothing to grade.`); return null; }
  const { picks } = loaded.data;
  if (!Array.isArray(picks)) throw new Error(`${loaded.file} does not contain a picks array.`);
  console.log(`Grading ${DATE} from ${loaded.source}: ${path.relative(ROOT, loaded.file)}`);

  const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}`);
  if (!res.ok) throw new Error("Schedule HTTP " + res.status);
  const sched = await res.json();
  const finals = {};
  for (const g of (((sched.dates || [])[0]) || {}).games || []) {
    if (g.status.abstractGameState === "Final" && g.teams.away.score !== undefined) {
      finals[g.gamePk] = { awayScore: g.teams.away.score, homeScore: g.teams.home.score };
    }
  }

  const marketMap = loadMarketMap();
  const graded = [];
  let wins = 0, losses = 0, ungraded = 0, units = 0, unitsCounted = 0;
  const clvRows = [];

  for (const raw of picks) {
    const p = normPick(raw);
    const f = finals[p.gamePk];
    const marketItem = marketMap.get(pickId(p)) || marketMap.get(`${p.away} @ ${p.home}|${p.moneyline && p.moneyline.pick}`);
    if (!f || f.awayScore === f.homeScore) {
      const learning = buildLearning(p, "NG", marketItem, loaded.source);
      graded.push({ ...p, result: "NG", learning });
      ungraded++;
      continue;
    }

    const homeWon = f.homeScore > f.awayScore;
    const totalRuns = f.awayScore + f.homeScore;
    const margin = f.homeScore - f.awayScore;

    let mlResult = "NG";
    if (p.moneyline && p.moneyline.pick && !p.moneyline.isPass) {
      const won = (p.moneyline.side === "home") === homeWon;
      mlResult = won ? "W" : "L";
      if (won) wins++; else losses++;
      if (p.moneyline.bestAm) { units += won ? amToDec(p.moneyline.bestAm) - 1 : -1; unitsCounted++; }
      const learning = buildLearning(p, mlResult, marketItem, loaded.source);
      clvRows.push({
        date: DATE,
        market: "moneyline",
        matchup: `${p.away}@${p.home}`,
        pick: p.moneyline.pick,
        priceTaken: learning.posted_price,
        closingPrice: learning.closing_price,
        clv: learning.clv_result,
        labScore: learning.lab_score,
        modelProb: learning.model_probability,
        rawEdge: learning.raw_edge,
        result: mlResult,
        lesson: learning.lesson_tag
      });
    }

    let totResult = "NG";
    if (p.total && p.total.pick) {
      const won = p.total.pick === "Over" ? totalRuns > p.total.line : totalRuns < p.total.line;
      totResult = totalRuns === p.total.line ? "PUSH" : (won ? "W" : "L");
      if (totResult === "W") wins++; else if (totResult === "L") losses++;
      if (p.total.bestAm && totResult !== "PUSH") { units += (totResult === "W") ? amToDec(p.total.bestAm) - 1 : -1; unitsCounted++; }
      clvRows.push({ date: DATE, market: "total", matchup: `${p.away}@${p.home}`, pick: `${p.total.pick} ${p.total.line}`, priceTaken: p.total.bestAm, closingPrice: "", clv: "legacy_not_tracked", labScore: p.labScore || "", modelProb: "", rawEdge: p.total.edge ?? "", result: totResult, lesson: "legacy_market" });
    }

    let rlResult = "NG";
    if (p.runLine && p.runLine.pick) {
      const pickedHome = p.runLine.pick === p.home;
      const adjMargin = pickedHome ? margin + p.runLine.point : -margin + p.runLine.point;
      rlResult = adjMargin === 0 ? "PUSH" : (adjMargin > 0 ? "W" : "L");
      if (rlResult === "W") wins++; else if (rlResult === "L") losses++;
      if (p.runLine.bestAm && rlResult !== "PUSH") { units += (rlResult === "W") ? amToDec(p.runLine.bestAm) - 1 : -1; unitsCounted++; }
      clvRows.push({ date: DATE, market: "run_line", matchup: `${p.away}@${p.home}`, pick: `${p.runLine.pick} ${p.runLine.point > 0 ? "+" : ""}${p.runLine.point}`, priceTaken: p.runLine.bestAm, closingPrice: "", clv: "legacy_not_tracked", labScore: p.labScore || "", modelProb: "", rawEdge: p.runLine.edge ?? "", result: rlResult, lesson: "legacy_market" });
    }

    const learning = buildLearning(p, mlResult, marketItem, loaded.source);
    graded.push({ ...p, mlResult, totResult, rlResult, finalAway: f.awayScore, finalHome: f.homeScore, learning });
  }

  if (clvRows.length) {
    fs.mkdirSync(path.dirname(CLV_PATH), { recursive: true });
    const header = "date,market,matchup,pick,price_taken,closing_price,clv_result,lab_score,model_probability,raw_edge,result,lesson_tag\n";
    if (!fs.existsSync(CLV_PATH)) fs.writeFileSync(CLV_PATH, header);
    const lines = clvRows.map(r => `${r.date},${r.market},"${r.matchup}","${r.pick}",${r.priceTaken ?? ""},${r.closingPrice ?? ""},${r.clv ?? ""},${r.labScore ?? ""},${r.modelProb ?? ""},${r.rawEdge ?? ""},${r.result ?? ""},${r.lesson ?? ""}`).join("\n") + "\n";
    fs.appendFileSync(CLV_PATH, lines);
  }

  return { date: DATE, wins, losses, ungraded, units: unitsCounted ? Number(units.toFixed(2)) : null, source: loaded.source, current_official_model: loaded.source === "published-picks" ? "moneyline_only" : "legacy_mixed_markets", picks: graded };
}

function rebuildResultsPage(results) {
  const days = Object.values(results.days).sort((a, b) => b.date.localeCompare(a.date));
  let W = 0, L = 0, U = 0, hasUnits = false;
  for (const d of days) { W += d.wins; L += d.losses; if (d.units !== null) { U += d.units; hasUnits = true; } }
  const winPct = W + L ? (W / (W + L) * 100).toFixed(1) : "—";
  // Official record: moneyline results only, on days graded under the current official model.
  let OW = 0, OL = 0;
  for (const d of days) {
    if (d.current_official_model !== "moneyline_only") continue;
    for (const p of d.picks) { if (p.mlResult === "W") OW++; else if (p.mlResult === "L") OL++; }
  }
  const oPct = OW + OL ? (OW / (OW + OL) * 100).toFixed(1) : "—";

  const pickLine = p => {
    const parts = [];
    if (p.moneyline && p.moneyline.pick && !p.moneyline.isPass) parts.push(`${p.mlResult === "W" ? "✅" : p.mlResult === "L" ? "❌" : "⏸"} ML ${esc(p.moneyline.pick)} (${(p.moneyline.prob * 100).toFixed(0)}%${p.moneyline.bestAm ? `, ${fmtAm(p.moneyline.bestAm)}` : ""})`);
    if (p.total && p.total.pick) parts.push(`${p.totResult === "W" ? "✅" : p.totResult === "L" ? "❌" : p.totResult === "PUSH" ? "➖" : "⏸"} Total ${esc(p.total.pick)} ${p.total.line}`);
    if (p.runLine && p.runLine.pick) parts.push(`${p.rlResult === "W" ? "✅" : p.rlResult === "L" ? "❌" : p.rlResult === "PUSH" ? "➖" : "⏸"} RL ${esc(p.runLine.pick)} ${p.runLine.point > 0 ? "+" : ""}${p.runLine.point}`);
    if (!parts.length) return `<div class="small dim">No official play — ${esc(p.away)} @ ${esc(p.home)}</div>`;
    const lesson = p.learning && p.learning.lesson_tag ? ` <span class="dim">· ${esc(p.learning.lesson_tag.replace(/_/g, " "))}</span>` : "";
    return `<div class="small">${parts.join(" · ")} — ${esc(p.away)} @ ${esc(p.home)}${p.finalAway !== undefined ? ` · ${p.finalAway}-${p.finalHome}` : ""}${lesson}</div>`;
  };

  const dayRows = days.slice(0, 60).map(d => `<tr>
    <td>${esc(niceDate(d.date))}${d.current_official_model !== "moneyline_only" ? ' <span class="dim small">(legacy markets)</span>' : ""}</td>
    <td class="num">${d.wins}-${d.losses}</td>
    <td class="num">${d.wins + d.losses ? (d.wins / (d.wins + d.losses) * 100).toFixed(0) + "%" : "—"}</td>
    <td class="num ${d.units > 0 ? "pos-text" : d.units < 0 ? "neg-text" : ""}">${d.units !== null ? (d.units > 0 ? "+" : "") + d.units.toFixed(2) : "—"}</td>
    <td><details><summary>${d.picks.length} published pick group${d.picks.length === 1 ? "" : "s"}</summary>${d.picks.map(pickLine).join("")}</details></td>
  </tr>`).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Results — verified pick record | LyDia</title>
<meta name="description" content="LyDia verified results: official moneyline model ${OW}-${OL}, all graded markets including legacy ${W}-${L} — every pick graded in public, wins and losses alike.">
<link rel="canonical" href="https://mlbedges.com/results/">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>&#9918;</text></svg>">
<link rel="stylesheet" href="/css/style.css">
</head>
<body>
<nav id="nav"></nav>
<main>
<h1>Results</h1>
<p class="subtitle">Current official LyDia picks are moneyline-only and require both a high model probability and a strong Lab Score. Older results may include legacy totals and run-line outputs from earlier model versions. Wins and losses alike stay visible.</p>
<section id="live-pick-results" class="card" style="margin:16px 0 24px">
  <h2 style="margin-top:0">Today's Pick Status</h2>
  <div class="loading">Loading live pick results...</div>
</section>
<div class="kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px">
  <div class="card"><div class="dim small">OFFICIAL RECORD (moneyline model)</div><div style="font-size:1.6rem;font-weight:700">${OW}-${OL}</div><div class="dim small">${oPct === "—" ? "no graded official picks yet" : oPct + "% win rate"}</div></div>
  <div class="card"><div class="dim small">ALL GRADED MARKETS (incl. legacy)</div><div style="font-size:1.6rem;font-weight:700">${W}-${L}</div><div class="dim small">${winPct === "—" ? "—" : winPct + "% win rate"}</div></div>
  <div class="card"><div class="dim small">UNITS (flat 1u @ best price)</div><div style="font-size:1.6rem;font-weight:700" class="${U > 0 ? "pos-text" : U < 0 ? "neg-text" : ""}">${hasUnits ? (U > 0 ? "+" : "") + U.toFixed(2) : "—"}</div></div>
  <div class="card"><div class="dim small">DAYS TRACKED</div><div style="font-size:1.6rem;font-weight:700">${days.length}</div></div>
</div>
<div class="notice" style="margin-bottom:20px">
  <strong>Current official model:</strong> moneyline only. <strong>Legacy history:</strong> earlier records may show totals or run lines. Learning fields are stored in <code>data/results.json</code> and <code>data/clv/clv_log.csv</code> for process review.
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

async function main() {
  let results = { days: {} };
  if (fs.existsSync(RESULTS_PATH)) results = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));

  const day = await gradeDay();
  if (day) {
    results.days[DATE] = day;
    fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2) + "\n");
    console.log(`graded ${DATE}: ${day.wins}-${day.losses}${day.units !== null ? `, ${day.units > 0 ? "+" : ""}${day.units}u` : ""}`);
  }
  fs.mkdirSync(path.join(ROOT, "results"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "results", "index.html"), rebuildResultsPage(results));
  console.log("results/index.html rebuilt");
}

main().catch(e => { console.error(e); process.exit(1); });
