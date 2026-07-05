#!/usr/bin/env node
/* LyDia Picks — grade yesterday's picks against final scores and rebuild results.html.
   Usage: node scripts/grade-results.js [YYYY-MM-DD]  (default: yesterday in US Eastern)
   Reads:  data/picks/<date>.json
   Writes: data/results.json, results.html */

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

function etYesterday() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  et.setDate(et.getDate() - 1);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}
const DATE = process.argv[2] || etYesterday();
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const amToDec = am => am > 0 ? 1 + am / 100 : 1 + 100 / Math.abs(am);
const fmtAm = am => am > 0 ? "+" + am : String(am);
function niceDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const RESULTS_PATH = path.join(ROOT, "data", "results.json");

async function gradeDay() {
  const picksFile = path.join(ROOT, "data", "picks", `${DATE}.json`);
  if (!fs.existsSync(picksFile)) { console.log(`No picks file for ${DATE} — nothing to grade.`); return null; }
  const { picks } = JSON.parse(fs.readFileSync(picksFile, "utf8"));
  const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}`);
  if (!res.ok) throw new Error("Schedule HTTP " + res.status);
  const sched = await res.json();
  const finals = {};
  for (const g of (((sched.dates || [])[0]) || {}).games || []) {
    if (g.status.abstractGameState === "Final" && g.teams.away.score !== undefined)
      finals[g.gamePk] = { awayScore: g.teams.away.score, homeScore: g.teams.home.score };
  }

  const graded = [];
  let wins = 0, losses = 0, ungraded = 0, units = 0, unitsCounted = 0;
  for (const p of picks) {
    const f = finals[p.gamePk];
    if (!f || f.awayScore === f.homeScore) { graded.push({ ...p, result: "NG" }); ungraded++; continue; }
    const homeWon = f.homeScore > f.awayScore;
    const won = (p.side === "home") === homeWon;
    if (won) wins++; else losses++;
    if (p.bestAm) { units += won ? amToDec(p.bestAm) - 1 : -1; unitsCounted++; }
    graded.push({ ...p, result: won ? "W" : "L", finalAway: f.awayScore, finalHome: f.homeScore });
  }
  return { date: DATE, wins, losses, ungraded, units: unitsCounted ? Number(units.toFixed(2)) : null, picks: graded };
}

function rebuildResultsPage(results) {
  const days = Object.values(results.days).sort((a, b) => b.date.localeCompare(a.date));
  let W = 0, L = 0, U = 0, hasUnits = false;
  for (const d of days) { W += d.wins; L += d.losses; if (d.units !== null) { U += d.units; hasUnits = true; } }
  const winPct = W + L ? (W / (W + L) * 100).toFixed(1) : "—";

  const dayRows = days.slice(0, 60).map(d => `<tr>
    <td>${esc(niceDate(d.date))}</td>
    <td class="num">${d.wins}-${d.losses}</td>
    <td class="num">${d.wins + d.losses ? (d.wins / (d.wins + d.losses) * 100).toFixed(0) + "%" : "—"}</td>
    <td class="num ${d.units > 0 ? "pos-text" : d.units < 0 ? "neg-text" : ""}">${d.units !== null ? (d.units > 0 ? "+" : "") + d.units.toFixed(2) : "—"}</td>
    <td><details><summary>${d.picks.length} picks</summary>${d.picks.map(p =>
      `<div class="small">${p.result === "W" ? "✅" : p.result === "L" ? "❌" : "⏸"} ${esc(p.pick)} (${(p.prob * 100).toFixed(0)}%${p.bestAm ? `, ${fmtAm(p.bestAm)}` : ""}) — ${esc(p.away)} @ ${esc(p.home)}${p.finalAway !== undefined ? ` · ${p.finalAway}-${p.finalHome}` : ""}</div>`).join("")}
    </details></td>
  </tr>`).join("\n");

  const body = `<h1>Results</h1>
<p class="subtitle">Every model pick, graded automatically against final scores. Wins and losses alike — nothing is deleted.</p>
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
  Picks are published every morning on the <a href="/previews/">Previews page</a> before first pitch and graded the next day —
  timestamps are in the <a href="https://github.com/">repository history</a>, so the record can't be rewritten.
  A reminder that even good models have losing stretches: judge the process over hundreds of picks, not a hot or cold week.
</div>`;

  const NAV = `<nav><div class="nav-inner">
  <a class="brand" href="/index.html"><span class="brand-ly">Ly</span><span class="brand-dia">Dia</span> Picks</a>
  <a class="navlink" href="/index.html">Home</a>
  <a class="navlink" href="/dashboard.html">Dashboard</a>
  <a class="navlink" href="/picks.html">Picks</a>
  <a class="navlink" href="/previews/">Previews</a>
  <a class="navlink active" href="/results.html">Results</a>
  <a class="navlink" href="/odds.html">Odds</a>
  <a class="navlink" href="/recaps/">Recaps</a>
  <a class="navlink" href="/membership.html">Membership</a>
</div></nav>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Results — verified pick record | LyDia Picks</title>
<meta name="description" content="LyDia Picks verified results: ${W}-${L} (${winPct}%) — every model pick graded publicly against final scores.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>&#9918;</text></svg>">
<link rel="stylesheet" href="/css/style.css">
</head>
<body>
${NAV}
<main>
${body}
</main>
<footer>LyDia Picks — analysis and education only, not betting advice. Please bet responsibly. If gambling stops being fun, call 1-800-GAMBLER.</footer>
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
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
    console.log(`graded ${DATE}: ${day.wins}-${day.losses}${day.units !== null ? `, ${day.units > 0 ? "+" : ""}${day.units}u` : ""}`);
  }
  fs.writeFileSync(path.join(ROOT, "results.html"), rebuildResultsPage(results));
  console.log("results.html rebuilt");
}

main().catch(e => { console.error(e); process.exit(1); });
