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
    moneyline: { pick: p.pick, side: p.side, prob: p.prob, mktProb: p.mktProb, bestAm: p.bestAm, valueTag: p.valueTag, isPass: false, consensusAgree: p.consensusAgree, consensusOppose: p.consensusOppose },
    total: null, runLine: null
  };
}

const RESULTS_PATH = path.join(ROOT, "data", "results.json");
const CLV_PATH = path.join(ROOT, "data", "clv", "clv_log.csv");

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

  const graded = [];
  let wins = 0, losses = 0, ungraded = 0, units = 0, unitsCounted = 0;
  const clvRows = [];

  for (const raw of picks) {
    const p = normPick(raw);
    const f = finals[p.gamePk];
    if (!f || f.awayScore === f.homeScore) { graded.push({ ...p, result: "NG" }); ungraded++; continue; }
    const homeWon = f.homeScore > f.awayScore;
    const totalRuns = f.awayScore + f.homeScore;
    const margin = f.homeScore - f.awayScore;

    let mlResult = "NG";
    if (p.moneyline && p.moneyline.pick && !p.moneyline.isPass) {
      const won = (p.moneyline.side === "home") === homeWon;
      mlResult = won ? "W" : "L";
      if (won) wins++; else losses++;
      if (p.moneyline.bestAm) { units += won ? amToDec(p.moneyline.bestAm) - 1 : -1; unitsCounted++; }
      clvRows.push({ date: DATE, market: "moneyline", matchup: `${p.away}@${p.home}`, pick: p.moneyline.pick, priceTaken: p.moneyline.bestAm, result: mlResult });
    }

    let totResult = "NG";
    if (p.total && p.total.pick) {
      const won = p.total.pick === "Over" ? totalRuns > p.total.line : totalRuns < p.total.line;
      totResult = totalRuns === p.total.line ? "PUSH" : (won ? "W" : "L");
      if (totResult === "W") wins++; else if (totResult === "L") losses++;
      if (p.total.bestAm && totResult !== "PUSH") { units += (totResult === "W") ? amToDec(p.total.bestAm) - 1 : -1; unitsCounted++; }
      clvRows.push({ date: DATE, market: "total", matchup: `${p.away}@${p.home}`, pick: `${p.total.pick} ${p.total.line}`, priceTaken: p.total.bestAm, result: totResult });
    }

    let rlResult = "NG";
    if (p.runLine && p.runLine.pick) {
      const pickedHome = p.runLine.pick === p.home;
      const adjMargin = pickedHome ? margin + p.runLine.point : -margin + p.runLine.point;
      rlResult = adjMargin === 0 ? "PUSH" : (adjMargin > 0 ? "W" : "L");
      if (rlResult === "W") wins++; else if (rlResult === "L") losses++;
      if (p.runLine.bestAm && rlResult !== "PUSH") { units += (rlResult === "W") ? amToDec(p.runLine.bestAm) - 1 : -1; unitsCounted++; }
      clvRows.push({ date: DATE, market: "run_line", matchup: `${p.away}@${p.home}`, pick: `${p.runLine.pick} ${p.runLine.point > 0 ? "+" : ""}${p.runLine.point}`, priceTaken: p.runLine.bestAm, result: rlResult });
    }

    graded.push({ ...p, mlResult, totResult, rlResult, finalAway: f.awayScore, finalHome: f.homeScore });
  }

  if (clvRows.length) {
    fs.mkdirSync(path.dirname(CLV_PATH), { recursive: true });
    const header = "date,market,matchup,pick,price_taken,result\n";
    if (!fs.existsSync(CLV_PATH)) fs.writeFileSync(CLV_PATH, header);
    const lines = clvRows.map(r => `${r.date},${r.market},"${r.matchup}","${r.pick}",${r.priceTaken ?? ""},${r.result}`).join("\n") + "\n";
    fs.appendFileSync(CLV_PATH, lines);
  }

  return { date: DATE, wins, losses, ungraded, units: unitsCounted ? Number(units.toFixed(2)) : null, source: loaded.source, picks: graded };
}

function rebuildResultsPage(results) {
  const days = Object.values(results.days).sort((a, b) => b.date.localeCompare(a.date));
  let W = 0, L = 0, U = 0, hasUnits = false;
  for (const d of days) { W += d.wins; L += d.losses; if (d.units !== null) { U += d.units; hasUnits = true; } }
  const winPct = W + L ? (W / (W + L) * 100).toFixed(1) : "—";

  const pickLine = p => {
    const parts = [];
    if (p.moneyline && p.moneyline.pick && !p.moneyline.isPass) parts.push(`${p.mlResult === "W" ? "✅" : p.mlResult === "L" ? "❌" : "⏸"} ML ${esc(p.moneyline.pick)} (${(p.moneyline.prob * 100).toFixed(0)}%${p.moneyline.bestAm ? `, ${fmtAm(p.moneyline.bestAm)}` : ""})`);
    if (p.total && p.total.pick) parts.push(`${p.totResult === "W" ? "✅" : p.totResult === "L" ? "❌" : p.totResult === "PUSH" ? "➖" : "⏸"} Total ${esc(p.total.pick)} ${p.total.line}`);
    if (p.runLine && p.runLine.pick) parts.push(`${p.rlResult === "W" ? "✅" : p.rlResult === "L" ? "❌" : p.rlResult === "PUSH" ? "➖" : "⏸"} RL ${esc(p.runLine.pick)} ${p.runLine.point > 0 ? "+" : ""}${p.runLine.point}`);
    if (!parts.length) return `<div class="small dim">No official play — ${esc(p.away)} @ ${esc(p.home)}</div>`;
    return `<div class="small">${parts.join(" · ")} — ${esc(p.away)} @ ${esc(p.home)}${p.finalAway !== undefined ? ` · ${p.finalAway}-${p.finalHome}` : ""}</div>`;
  };

  const dayRows = days.slice(0, 60).map(d => `<tr>
    <td>${esc(niceDate(d.date))}</td>
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
<meta name="description" content="LyDia verified results: ${W}-${L} (${winPct}%) — every published model pick graded publicly against final scores.">
<link rel="canonical" href="https://mlbedges.com/results/">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>&#9918;</text></svg>">
<link rel="stylesheet" href="/css/style.css">
</head>
<body>
<nav id="nav"></nav>
<main>
<h1>Results</h1>
<p class="subtitle">Every published model pick is graded automatically against final scores. Wins and losses alike stay visible.</p>
<section id="live-pick-results" class="card" style="margin:16px 0 24px">
  <h2 style="margin-top:0">Today's Pick Status</h2>
  <div class="loading">Loading live pick results...</div>
</section>
<div class="kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px">
  <div class="card"><div class="dim small">RECORD</div><div style="font-size:1.6rem;font-weight:700">${W}-${L}</div></div>
  <div class="card"><div class="dim small">WIN RATE</div><div style="font-size:1.6rem;font-weight:700">${winPct}%</div></div>
  <div class="card"><div class="dim small">UNITS (flat 1u @ best price)</div><div style="font-size:1.6rem;font-weight:700" class="${U > 0 ? "pos-text" : U < 0 ? "neg-text" : ""}">${hasUnits ? (U > 0 ? "+" : "") + U.toFixed(2) : "—"}</div></div>
  <div class="card"><div class="dim small">DAYS TRACKED</div><div style="font-size:1.6rem;font-weight:700">${days.length}</div></div>
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
  Picks are published to dated files in <code>data/published-picks/</code>. The official record is rebuilt from those dated files after games finish, so the history has a public timestamp trail.
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
