#!/usr/bin/env node
/* LyDia — daily game previews + pick logging.
   Usage: node scripts/generate-previews.js [YYYY-MM-DD]   (default: today in US Eastern)
   Env:   ODDS_API_KEY  (optional — adds market odds + value edges for moneyline, total, and run line)
   Writes: previews/<date>.html, previews/index.html, data/picks/<date>.json, sitemap.xml

   Methodology note: moneyline uses Pythagorean win% + last-10 form (log5, home-field bump,
   starter ERA adjustment). Total runs and run line are a lighter-weight normal-approximation
   model (team scoring rate vs opponent run prevention, adjusted for park and starter quality,
   compared to market lines via a standard-normal CDF). All three are simplified estimates, not
   guarantees — see the disclaimer on every page. */

const fs = require("fs");
const path = require("path");

const SITE = "https://mlbedges.com";
const ROOT = path.join(__dirname, "..");
const HFA = 54 / 46, PYTH_EXP = 1.83, FORM_WEIGHT = 0.25, ERA_K = 0.20;
const LEAGUE_ERA = 4.20, MIN_IP = 20, ERA_CLAMP = [2.75, 6.00], VALUE_EDGE = 0.03;
const TOTAL_STD = 4.2;      // std dev of MLB game total runs (normal approximation)
const MARGIN_STD = 3.0;     // std dev of MLB game run margin (normal approximation)
const RUN_LINE = 1.5;       // standard MLB run line
const NO_PLAY_EDGE = 0.03;  // raw edge below this on moneyline -> explicit "pass" language
const NO_PLAY_EDGE_SECONDARY = 0.05; // totals/run-line use a lighter model, so require a bigger edge before calling a play

// Public competitor signal — a second opinion only. LyDia's own model + market
// edge always decides the pick; this can upgrade a value pick's confidence label
// or flag it as contested. It never overrides the pick itself.
const CONSENSUS_ALIGN_N = 2;       // this many public sources agreeing -> STRONG VALUE
const CONSENSUS_CONTEST_N = 2;     // this many public sources disagreeing -> CONTESTED VALUE
const CONSENSUS_CONTEST_EDGE = 0.05; // ...unless the model's edge is this big, which overrides the contest
const PICK_KEYWORDS = ["our pick", "we like", "best bet", "lean", "the play", "we're taking", "we are taking", "prediction", "pick:"];

function etToday() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}
const DATE = process.argv[2] || etToday();
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) { console.error("Bad date:", DATE); process.exit(1); }

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (p, dp = 1) => (p * 100).toFixed(dp) + "%";
const fmtAm = am => { am = Math.round(am); return am > 0 ? "+" + am : String(am); };
const amToProb = am => am > 0 ? 100 / (am + 100) : Math.abs(am) / (Math.abs(am) + 100);
const amToDec = am => am > 0 ? 1 + am / 100 : 1 + 100 / Math.abs(am);
const decToAm = d => d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
function niceDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}
const pythag = (rs, ra) => Math.pow(rs, PYTH_EXP) / (Math.pow(rs, PYTH_EXP) + Math.pow(ra, PYTH_EXP));
function log5Home(sH, sA) {
  const raw = (sH * (1 - sA)) / (sH * (1 - sA) + sA * (1 - sH));
  const o = (raw / (1 - raw)) * HFA;
  return o / (1 + o);
}
const clampEra = e => Math.min(ERA_CLAMP[1], Math.max(ERA_CLAMP[0], e));
const ipToNum = ip => { const [w, f] = String(ip).split("."); return Number(w) + (Number(f) || 0) / 3; };

// Standard-normal CDF (Zelen & Severo approximation) — used to turn a projected
// total/margin + std dev into a probability against a market line.
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}

const NAV = `<nav><div class="nav-inner">
  <a class="brand" href="/"><span class="brand-ly">Ly</span><span class="brand-dia">Dia</span></a>
  <a class="navlink" href="/">Home</a>
  <a class="navlink" href="/dashboard/">Dashboard</a>
  <a class="navlink" href="/picks/">Picks</a>
  <a class="navlink active" href="/previews/">Previews</a>
  <a class="navlink" href="/results/">Results</a>
  <a class="navlink" href="/odds/">Odds</a>
  <a class="navlink" href="/recaps/">Recaps</a>
  <a class="navlink" href="/articles/">Articles</a>
  <a class="navlink navlink-cta" href="/membership/">Join $30/mo</a>
</div></nav>`;
const FOOTER = `<footer>LyDia — analysis and education only, not betting advice. Please bet responsibly. If gambling stops being fun, call 1-800-GAMBLER.</footer>`;

// Membership upsell — LyDia never hides a pick (every pick on this page is
// public and free), members simply get all of it delivered before first
// pitch instead of having to check the site, plus a price re-check alert
// if the line moves past the playable range noted on each pick.
function membershipBox() {
  return `<div class="lead-box" style="border-color:var(--accent2)">
  <h3 style="margin:0 0 4px">Get this in your inbox before first pitch</h3>
  <p class="dim small" style="margin:0">$30/month. Every pick below, delivered — plus a re-check alert if a price moves past the playable range. Nothing on this page is ever hidden from members or non-members alike.</p>
  <p style="margin-top:10px"><a class="btn blue" href="/membership/">Join LyDia — $30/mo →</a> <a class="btn secondary" href="/results/">See the track record</a></p>
</div>`;
}

function leadCaptureBox(sourceTag) {
  const uid = "lead-" + sourceTag.replace(/[^a-z0-9]/gi, "");
  return `<div class="lead-box">
  <h3 style="margin:0 0 4px">Not ready to join? Get tomorrow's picks by email — free</h3>
  <p class="dim small" style="margin:0">One email a day, before first pitch. No card required.</p>
  <form name="newsletter" method="POST" data-netlify="true" netlify-honeypot="bot-field" id="${uid}">
    <p style="display:none"><input name="bot-field"></p>
    <input type="hidden" name="form-name" value="newsletter">
    <input type="hidden" name="source" value="${esc(sourceTag)}">
    <input type="email" name="email" required placeholder="you@example.com">
    <button type="submit">Send me picks free</button>
  </form>
  <p class="ok pos-text small" id="${uid}-ok" style="margin-top:8px">You're on the list — check your inbox tomorrow morning. 🎉</p>
  <script>
  (function(){
    var f = document.getElementById(${JSON.stringify(uid)});
    if (!f) return;
    f.addEventListener("submit", function(e){
      e.preventDefault();
      var data = new FormData(f);
      fetch("/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data).toString() })
        .then(function(){ f.style.display = "none"; document.getElementById(${JSON.stringify(uid + "-ok")}).style.display = "block"; })
        .catch(function(){ });
    });
  })();
  </script>
</div>`;
}

function pageShell(title, desc, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>&#9918;</text></svg>">
<link rel="stylesheet" href="/css/style.css">
<style>
.pv { border: 1px solid var(--border); border-radius: 10px; background: var(--bg-card); padding: 18px; margin: 16px 0; }
.pv.featured { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.pv h2 { margin: 0 0 4px; font-size: 1.15rem; }
.pv .meta { color: var(--text-dim); font-size: .85rem; margin-bottom: 8px; }
.pv .pick { font-weight: 700; color: var(--accent); }
.pv .subpick { font-size: .92rem; margin: 4px 0; }
.pv .pass { color: var(--text-dim); font-style: italic; }
.pv table { font-size: .88rem; margin: 8px 0; border-collapse: collapse; }
.pv td, .pv th { padding: 4px 10px; border-bottom: 1px solid var(--border); text-align: left; }
.pv .price-disc { font-size: .82rem; color: var(--text-dim); border-top: 1px dashed var(--border); margin-top: 8px; padding-top: 6px; }
.archive-list a { display: block; padding: 8px 0; border-bottom: 1px solid var(--border); }
.featured-flag { display: inline-block; background: var(--accent); color: #fff; font-size: .75rem; font-weight: 700; padding: 2px 9px; border-radius: 20px; margin-bottom: 8px; }
.approved-badge { display: inline-block; background: #2f9e44; color: #fff; font-size: .75rem; font-weight: 700; padding: 3px 10px; border-radius: 20px; margin: 4px 0 8px; }
.field-grid { display: grid; grid-template-columns: auto 1fr; gap: 3px 14px; font-size: .85rem; margin: 10px 0; padding: 10px 0; border-top: 1px dashed var(--border); border-bottom: 1px dashed var(--border); }
.field-grid dt { color: var(--text-dim); margin: 0; }
.field-grid dd { margin: 0; font-weight: 600; }
.why-block, .risk-block { font-size: .88rem; margin-top: 10px; line-height: 1.45; }
.why-block b, .risk-block b { display: block; margin-bottom: 3px; color: var(--text); }
</style>
</head>
<body>
${NAV}
<main>
${body}
</main>
${FOOTER}
</body>
</html>
`;
}


const PARKS = {
  "Arizona Diamondbacks": ["Chase Field", 33.445, -112.067, 1, "neutral", 1.02],
  "Atlanta Braves": ["Truist Park", 33.891, -84.468, 0, "hitter-friendly", 1.05],
  "Baltimore Orioles": ["Camden Yards", 39.284, -76.622, 0, "neutral", 1.00],
  "Boston Red Sox": ["Fenway Park", 42.346, -71.097, 0, "hitter-friendly", 1.06],
  "Chicago Cubs": ["Wrigley Field", 41.948, -87.655, 0, "wind-dependent", 1.02],
  "Chicago White Sox": ["Rate Field", 41.830, -87.634, 0, "hitter-friendly", 1.04],
  "Cincinnati Reds": ["Great American Ball Park", 39.097, -84.507, 0, "hitter-friendly", 1.07],
  "Cleveland Guardians": ["Progressive Field", 41.496, -81.685, 0, "neutral", 0.99],
  "Colorado Rockies": ["Coors Field", 39.756, -104.994, 0, "extreme hitter's park", 1.18],
  "Detroit Tigers": ["Comerica Park", 42.339, -83.049, 0, "pitcher-friendly", 0.95],
  "Houston Astros": ["Daikin Park", 29.757, -95.355, 1, "neutral", 0.99],
  "Kansas City Royals": ["Kauffman Stadium", 39.051, -94.480, 0, "pitcher-friendly", 0.96],
  "Los Angeles Angels": ["Angel Stadium", 33.800, -117.883, 0, "neutral", 1.00],
  "Los Angeles Dodgers": ["Dodger Stadium", 34.074, -118.240, 0, "pitcher-friendly", 0.94],
  "Miami Marlins": ["loanDepot park", 25.778, -80.220, 1, "pitcher-friendly", 0.93],
  "Milwaukee Brewers": ["American Family Field", 43.028, -87.971, 1, "neutral", 1.00],
  "Minnesota Twins": ["Target Field", 44.982, -93.278, 0, "neutral", 0.99],
  "New York Mets": ["Citi Field", 40.757, -73.846, 0, "pitcher-friendly", 0.96],
  "New York Yankees": ["Yankee Stadium", 40.829, -73.926, 0, "hitter-friendly", 1.05],
  "Athletics": ["Sutter Health Park", 38.580, -121.513, 0, "neutral", 1.01],
  "Philadelphia Phillies": ["Citizens Bank Park", 39.906, -75.166, 0, "hitter-friendly", 1.06],
  "Pittsburgh Pirates": ["PNC Park", 40.447, -80.006, 0, "pitcher-friendly", 0.97],
  "San Diego Padres": ["Petco Park", 32.707, -117.157, 0, "pitcher-friendly", 0.93],
  "San Francisco Giants": ["Oracle Park", 37.778, -122.389, 0, "strong pitcher's park", 0.91],
  "Seattle Mariners": ["T-Mobile Park", 47.591, -122.332, 1, "strong pitcher's park", 0.92],
  "St. Louis Cardinals": ["Busch Stadium", 38.622, -90.193, 0, "pitcher-friendly", 0.97],
  "Tampa Bay Rays": ["home park", 27.768, -82.653, 1, "neutral", 0.98],
  "Texas Rangers": ["Globe Life Field", 32.747, -97.084, 1, "neutral", 1.00],
  "Toronto Blue Jays": ["Rogers Centre", 43.641, -79.389, 1, "hitter-friendly", 1.03],
  "Washington Nationals": ["Nationals Park", 38.873, -77.007, 0, "neutral", 0.98]
};
const _wx = {};
async function weatherFor(homeTeam, gameIso) {
  const pk = PARKS[homeTeam];
  if (!pk || pk[3]) return null; // unknown or roofed
  try {
    if (!_wx[homeTeam]) {
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${pk[1]}&longitude=${pk[2]}&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation_probability&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=3&timezone=auto`);
      if (!res.ok) return null;
      _wx[homeTeam] = await res.json();
    }
    const h = _wx[homeTeam].hourly;
    if (!h || !h.time) return null;
    const target = new Date(gameIso).getTime();
    let best = 0, diff = Infinity;
    for (let i = 0; i < h.time.length; i++) {
      const d = Math.abs(new Date(h.time[i]).getTime() - target);
      if (d < diff) { diff = d; best = i; }
    }
    const dirs = ["N","NE","E","SE","S","SW","W","NW"];
    return { temp: Math.round(h.temperature_2m[best]), wind: Math.round(h.wind_speed_10m[best]),
             dir: dirs[Math.round(((h.wind_direction_10m[best] % 360) + 360) % 360 / 45) % 8],
             precip: h.precipitation_probability ? Math.round(h.precipitation_probability[best]) : null };
  } catch (e) { return null; }
}

// Confidence tier + a 0-100 "edge score" — a transparent read on edge size and
// model conviction, not a probability. Documented in methodology text; not a
// claim of precision, just a consistent way to rank plays against each other.
function tierAndScore(edge, prob) {
  const score = Math.max(5, Math.min(96, Math.round(50 + edge * 600 + (prob - 0.5) * 30)));
  const tier = edge >= 0.06 ? "Strong Play" : edge >= NO_PLAY_EDGE ? "Standard Play" : null;
  return { tier, score };
}

// Range of live prices across tracked books for whichever side was picked —
// "current price used" on the card. Falls back to a single price if only one
// book has a line.
function priceRangeStr(prices) {
  if (!prices || !prices.length) return null;
  const decs = prices.map(amToDec);
  const best = decToAm(Math.max(...decs));
  const worst = decToAm(Math.min(...decs));
  return best === worst ? fmtAm(best) : `${fmtAm(best)} to ${fmtAm(worst)}`;
}

// Range of no-vig (fair) implied probability across tracked books for the picked side.
function probRangeStr(probs) {
  if (!probs || !probs.length) return null;
  const lo = Math.min(...probs), hi = Math.max(...probs);
  return lo === hi ? pct(lo) : `${pct(lo)} to ${pct(hi)}`;
}

// "Why we like it" — built only from data the model actually has: the pitching
// matchup, recent form, and the price-sensitivity of the play. No claims about
// lineups, injuries, or bullpen availability the model doesn't check.
function whyWeLikeIt({ pick, pickHome, spA, spH, sA, sH, pd }) {
  const pickSp = pickHome ? spH : spA, oppSp = pickHome ? spA : spH;
  const eraDiff = spA.eff - spH.eff;
  const formPick = pickHome ? sH.form : sA.form, formOpp = pickHome ? sA.form : sH.form;
  if (Math.abs(eraDiff) >= 0.4) {
    return `${pick} projects ahead mainly on the mound — ${pickSp.name} has the stronger run-prevention number this season against ${oppSp.name}.`;
  } else if (formPick !== null && formOpp !== null && Math.abs(formPick - formOpp) >= 0.15) {
    return `${pick} has been the hotter team lately (last 10: ${pickHome ? sH.l10 : sA.l10} vs. ${pickHome ? sA.l10 : sH.l10}), enough to tip a close matchup.`;
  }
  return `${pick} grades out ahead on the model's blend of run differential and recent form${pickHome ? ", plus the home-field bump" : ""}.`;
}

// "What could go wrong" — one line, real weather data when it's genuinely a
// factor, otherwise an honest note about what the model can't see (injuries,
// bullpen availability, lineup changes) rather than a fabricated risk.
function whatCouldGoWrong({ wx, pkInfo, oppSp }) {
  if (pkInfo && !pkInfo[3] && wx) {
    if (wx.precip !== null && wx.precip >= 40) {
      return `Roughly a ${wx.precip}% chance of rain at ${pkInfo[0]} — a delay can scramble starter and bullpen usage.`;
    }
    if (wx.wind >= 12) {
      return `Wind is up (${wx.wind} mph ${wx.dir}) at ${pkInfo[0]}, adding variance to a pitching-driven number.`;
    }
  }
  return `${oppSp.name} can outpitch his season line on a given night, and the model doesn't see live injury or lineup news — worth a quick recheck before first pitch.`;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return fallback; }
}

// Minimal CSV line parser (handles quoted fields with embedded commas).
function parseCsvLine(line) {
  const out = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// The reliable competitor-signal source: a hand-logged row per source per game.
// Takes under a minute a day — glance at 2-3 free competitor pick pages, add a row.
function readManualSignals(dateStr) {
  const p = path.join(ROOT, "data", "config", "manual-competitor-signals.csv");
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(l => l.trim().length);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = (cells[i] || "").trim(); });
    if (row.date === dateStr && row.matchup) rows.push(row);
  }
  return rows;
}

// Best-effort competitor signal: most public pick sites are JavaScript-rendered,
// so a plain fetch usually returns only page shell, not real pick text. When a
// page does return usable text, look for a team name near a pick keyword.
async function fetchAutoSignals(teamNames) {
  const cfg = readJsonSafe(path.join(ROOT, "data", "config", "competitor-sources.json"), { sources: [] });
  const results = [];
  for (const src of cfg.sources || []) {
    if (!src.url) continue;
    const entry = { source: src.name || "Unknown", url: src.url, status: "unavailable", detected: [] };
    try {
      const res = await fetch(src.url, { headers: { "User-Agent": "Mozilla/5.0 LyDiaResearchBot/1.0" } });
      if (!res.ok) { entry.status = `unavailable HTTP ${res.status}`; results.push(entry); continue; }
      const text = (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      entry.status = "public page fetched";
      const lower = text.toLowerCase();
      for (const team of teamNames) {
        const shortName = team.split(" ").slice(-1)[0].toLowerCase();
        for (const kw of PICK_KEYWORDS) {
          let idx = lower.indexOf(kw);
          while (idx !== -1) {
            const window = lower.slice(Math.max(0, idx - 60), idx + 60);
            if (window.includes(team.toLowerCase()) || window.includes(shortName)) {
              entry.detected.push({ team, keyword: kw });
            }
            idx = lower.indexOf(kw, idx + 1);
          }
        }
      }
    } catch (e) {
      entry.status = `unavailable: ${e.message}`;
    }
    results.push(entry);
  }
  return results;
}

// How many tracked public sources (manual + auto) lean each side of this matchup.
function buildConsensus(away, home, manualSignals, autoSignals) {
  const agreeHome = [], agreeAway = [];
  const awayShort = away.split(" ").slice(-1)[0].toLowerCase();
  const homeShort = home.split(" ").slice(-1)[0].toLowerCase();
  for (const s of manualSignals) {
    const m = s.matchup.toLowerCase();
    if (m.includes(awayShort) && m.includes(homeShort)) {
      const side = (s.public_side || "").toLowerCase();
      if (side.includes(home.toLowerCase()) || side.includes(homeShort)) agreeHome.push(s.source);
      else if (side.includes(away.toLowerCase()) || side.includes(awayShort)) agreeAway.push(s.source);
    }
  }
  for (const sig of autoSignals) {
    for (const d of sig.detected) {
      if (d.team === home) agreeHome.push(sig.source);
      else if (d.team === away) agreeAway.push(sig.source);
    }
  }
  return { agreeHome: [...new Set(agreeHome)], agreeAway: [...new Set(agreeAway)] };
}

// Price-discipline block per the LyDia Agent v2 rules: every published pick
// carries a playable price range, not just a side.
function priceDiscipline(prob, bestAm) {
  if (bestAm === null || bestAm === undefined) return null;
  const cushion = prob >= 0.60 ? 20 : prob >= 0.55 ? 12 : 8; // more cushion on stronger favorites
  const playableTo = bestAm < 0 ? bestAm - cushion : bestAm + Math.round(cushion * 0.8);
  return { current: fmtAm(bestAm), playableTo: fmtAm(playableTo) };
}

async function main() {
  const season = Number(DATE.slice(0, 4));
  const [sched, standings] = await Promise.all([
    getJson(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}&hydrate=probablePitcher`),
    getJson(`https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`)
  ]);

  const strength = {};
  for (const rec of standings.records || [])
    for (const t of rec.teamRecords || []) {
      const l10 = (((t.records || {}).splitRecords) || []).find(r => r.type === "lastTen");
      const gp = Math.max(1, t.wins + t.losses);
      strength[t.team.id] = {
        pyth: pythag(t.runsScored, t.runsAllowed),
        form: l10 ? l10.wins / Math.max(1, l10.wins + l10.losses) : null,
        l10: l10 ? `${l10.wins}-${l10.losses}` : "—",
        rec: `${t.wins}-${t.losses}`,
        rsg: t.runsScored / gp, rag: t.runsAllowed / gp
      };
    }

  const games = (((sched.dates || [])[0]) || {}).games || [];
  const slate = games.filter(g => ["Preview", "Live"].includes(g.status.abstractGameState) || true).filter(g => g.gameType === "R" || g.gameType === undefined);
  if (!slate.length) { console.log("No games on", DATE); return; }

  // pitcher stats
  const pids = [];
  for (const g of slate) for (const side of ["away", "home"]) {
    const p = g.teams[side].probablePitcher; if (p) pids.push(p.id);
  }
  const pitchers = {};
  if (pids.length) {
    try {
      const data = await getJson(`https://statsapi.mlb.com/api/v1/people?personIds=${pids.join(",")}&hydrate=stats(group=[pitching],type=[season])`);
      for (const person of data.people || []) {
        const st = ((((person.stats || [])[0] || {}).splits || [])[0] || {}).stat;
        if (st) pitchers[person.id] = { era: Number(st.era), whip: st.whip, ip: ipToNum(st.inningsPitched) };
      }
    } catch (e) { console.warn("pitcher stats unavailable:", e.message); }
  }

  // optional market odds: moneyline, totals, run line (spreads)
  let oddsMap = null;
  if (process.env.ODDS_API_KEY) {
    try {
      const evs = await getJson(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${process.env.ODDS_API_KEY}&regions=us&markets=h2h,totals,spreads&oddsFormat=american`);
      oddsMap = {};
      for (const ev of evs) {
        const h2hRows = [], totalRows = [], spreadRows = [];
        for (const bk of ev.bookmakers || []) {
          const h2h = (bk.markets || []).find(m => m.key === "h2h");
          if (h2h) {
            const oA = h2h.outcomes.find(o => o.name === ev.away_team);
            const oH = h2h.outcomes.find(o => o.name === ev.home_team);
            if (oA && oH) h2hRows.push([oA.price, oH.price]);
          }
          const tot = (bk.markets || []).find(m => m.key === "totals");
          if (tot) {
            const oO = tot.outcomes.find(o => o.name === "Over");
            const oU = tot.outcomes.find(o => o.name === "Under");
            if (oO && oU && oO.point) totalRows.push({ line: oO.point, over: oO.price, under: oU.price });
          }
          const spr = (bk.markets || []).find(m => m.key === "spreads");
          if (spr) {
            const oA = spr.outcomes.find(o => o.name === ev.away_team);
            const oH = spr.outcomes.find(o => o.name === ev.home_team);
            if (oA && oH) spreadRows.push({ awayPoint: oA.point, awayPrice: oA.price, homePoint: oH.point, homePrice: oH.price });
          }
        }
        const entry = {};
        if (h2hRows.length) {
          const avgA = h2hRows.reduce((s, r) => s + amToProb(r[0]), 0) / h2hRows.length;
          const avgH = h2hRows.reduce((s, r) => s + amToProb(r[1]), 0) / h2hRows.length;
          const tot = avgA + avgH;
          // Per-book no-vig probability, so the card can show a real range (not just an average).
          const noVigA = h2hRows.map(r => { const qa = amToProb(r[0]), qh = amToProb(r[1]); return qa / (qa + qh); });
          const noVigH = h2hRows.map(r => { const qa = amToProb(r[0]), qh = amToProb(r[1]); return qh / (qa + qh); });
          entry.ml = { pAway: avgA / tot, pHome: avgH / tot,
            bestAway: decToAm(Math.max(...h2hRows.map(r => amToDec(r[0])))),
            bestHome: decToAm(Math.max(...h2hRows.map(r => amToDec(r[1])))),
            awayPrices: h2hRows.map(r => r[0]), homePrices: h2hRows.map(r => r[1]),
            awayNoVigRange: [Math.min(...noVigA), Math.max(...noVigA)],
            homeNoVigRange: [Math.min(...noVigH), Math.max(...noVigH)] };
        }
        if (totalRows.length) {
          // use the most common line, averaged prices at that line
          const lineCounts = {};
          for (const r of totalRows) lineCounts[r.line] = (lineCounts[r.line] || 0) + 1;
          const modeLine = Number(Object.entries(lineCounts).sort((a, b) => b[1] - a[1])[0][0]);
          const atLine = totalRows.filter(r => r.line === modeLine);
          const avgOver = atLine.reduce((s, r) => s + amToProb(r.over), 0) / atLine.length;
          const avgUnder = atLine.reduce((s, r) => s + amToProb(r.under), 0) / atLine.length;
          const t = avgOver + avgUnder;
          entry.total = { line: modeLine, pOver: avgOver / t, pUnder: avgUnder / t,
            bestOver: decToAm(Math.max(...atLine.map(r => amToDec(r.over)))),
            bestUnder: decToAm(Math.max(...atLine.map(r => amToDec(r.under)))) };
        }
        if (spreadRows.length) {
          const lineCounts = {};
          for (const r of spreadRows) lineCounts[r.homePoint] = (lineCounts[r.homePoint] || 0) + 1;
          const modeLine = Number(Object.entries(lineCounts).sort((a, b) => b[1] - a[1])[0][0]);
          const atLine = spreadRows.filter(r => r.homePoint === modeLine);
          const avgHome = atLine.reduce((s, r) => s + amToProb(r.homePrice), 0) / atLine.length;
          const avgAway = atLine.reduce((s, r) => s + amToProb(r.awayPrice), 0) / atLine.length;
          const t = avgHome + avgAway;
          entry.runLine = { homePoint: modeLine, awayPoint: -modeLine, pHomeCover: avgHome / t, pAwayCover: avgAway / t,
            bestHome: decToAm(Math.max(...atLine.map(r => amToDec(r.homePrice)))),
            bestAway: decToAm(Math.max(...atLine.map(r => amToDec(r.awayPrice)))) };
        }
        if (Object.keys(entry).length) oddsMap[ev.away_team + "@" + ev.home_team] = entry;
      }
    } catch (e) { console.warn("odds unavailable:", e.message); }
  }

  const nice = niceDate(DATE);
  const publishedEt = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  const picksOut = [];
  const rendered = [];

  const teamNames = [...new Set(slate.flatMap(g => [g.teams.away.team.name, g.teams.home.team.name]))];
  const manualSignals = readManualSignals(DATE);
  const autoSignals = await fetchAutoSignals(teamNames);

  for (const g of slate) {
    const a = g.teams.away, h = g.teams.home;
    const sA = strength[a.team.id], sH = strength[h.team.id];
    if (!sA || !sH) continue;
    const time = new Date(g.gameDate).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
    const spInfo = side => {
      const p = g.teams[side].probablePitcher;
      if (!p) return { name: "TBD", txt: "TBD", eff: LEAGUE_ERA };
      const st = pitchers[p.id];
      if (!st || !isFinite(st.era) || st.ip < MIN_IP)
        return { name: p.fullName, txt: `${p.fullName} (limited innings)`, eff: LEAGUE_ERA };
      return { name: p.fullName, txt: `${p.fullName} (${st.era.toFixed(2)} ERA, ${st.whip} WHIP, ${Math.round(st.ip)} IP)`, eff: clampEra(st.era) };
    };
    const spA = spInfo("away"), spH = spInfo("home");
    const blendA = sA.form === null ? sA.pyth : (1 - FORM_WEIGHT) * sA.pyth + FORM_WEIGHT * sA.form;
    const blendH = sH.form === null ? sH.pyth : (1 - FORM_WEIGHT) * sH.pyth + FORM_WEIGHT * sH.form;
    const pBase = log5Home(blendH, blendA);
    const o = (pBase / (1 - pBase)) * Math.exp(ERA_K * (spA.eff - spH.eff));
    const pHome = o / (1 + o);
    const pickHome = pHome >= 0.5;
    const pick = pickHome ? h.team.name : a.team.name;
    const prob = pickHome ? pHome : 1 - pHome;

    const mktEntry = oddsMap ? oddsMap[a.team.name + "@" + h.team.name] : null;
    const mkt = mktEntry && mktEntry.ml ? mktEntry.ml : null;
    const mktProb = mkt ? (pickHome ? mkt.pHome : mkt.pAway) : null;
    const bestAm = mkt ? (pickHome ? mkt.bestHome : mkt.bestAway) : null;
    const edge = mktProb !== null ? prob - mktProb : null;

    const pkInfo = PARKS[h.team.name];
    const wx = pkInfo ? await weatherFor(h.team.name, g.gameDate) : null;
    let venueTxt = "";
    if (pkInfo) {
      venueTxt = ` The setting: ${pkInfo[0]}, a ${pkInfo[4]} venue` +
        (pkInfo[3] ? " with a roof, so weather is a non-factor." :
         wx ? `; the forecast calls for ${wx.temp}°F with ${wx.wind} mph ${wx.dir} winds.` : ".");
    }
    const eraDiff = spA.eff - spH.eff;
    const duel = Math.abs(eraDiff) < 0.4
      ? `The pitching matchup is close to even.`
      : `${(eraDiff > 0 ? spH : spA).name} holds a clear edge on the mound.`;

    // --- Total runs projection (normal approximation) ---
    const parkFactor = pkInfo ? pkInfo[5] : 1.0;
    const parkAdj = Math.sqrt(parkFactor);
    let projAway = (sA.rsg + sH.rag) / 2 * parkAdj * (spH.eff / LEAGUE_ERA);
    let projHome = (sH.rsg + sA.rag) / 2 * parkAdj * (spA.eff / LEAGUE_ERA) * 1.02; // small HFA scoring nudge
    if (wx && !pkInfo[3]) {
      const tempAdj = 1 + (wx.temp - 70) * 0.001;
      projAway *= tempAdj; projHome *= tempAdj;
    }
    const projTotal = projAway + projHome;
    const projMargin = projHome - projAway;

    let totalOut = null;
    if (mktEntry && mktEntry.total) {
      const { line, pOver, pUnder, bestOver, bestUnder } = mktEntry.total;
      const modelPOver = 1 - normCdf((line - projTotal) / TOTAL_STD);
      const edgeOver = modelPOver - pOver, edgeUnder = (1 - modelPOver) - pUnder;
      let totPick = null, totEdge = 0, totProb = null, totMktProb = null, totBestAm = null;
      if (edgeOver >= edgeUnder && edgeOver >= NO_PLAY_EDGE_SECONDARY) { totPick = "Over"; totEdge = edgeOver; totProb = modelPOver; totMktProb = pOver; totBestAm = bestOver; }
      else if (edgeUnder > edgeOver && edgeUnder >= NO_PLAY_EDGE_SECONDARY) { totPick = "Under"; totEdge = edgeUnder; totProb = 1 - modelPOver; totMktProb = pUnder; totBestAm = bestUnder; }
      totalOut = { line, projTotal: Number(projTotal.toFixed(1)), pick: totPick, edge: Number(totEdge.toFixed(4)), prob: totProb !== null ? Number(totProb.toFixed(4)) : null, mktProb: totMktProb !== null ? Number(totMktProb.toFixed(4)) : null, bestAm: totBestAm };
    } else {
      totalOut = { line: null, projTotal: Number(projTotal.toFixed(1)), pick: null, edge: 0, prob: null, mktProb: null, bestAm: null };
    }

    let runLineOut = null;
    if (mktEntry && mktEntry.runLine) {
      const { homePoint, awayPoint, pHomeCover, pAwayCover, bestHome, bestAway } = mktEntry.runLine;
      const modelPHomeCover = normCdf((projMargin - Math.abs(homePoint)) / MARGIN_STD);
      const edgeHome = modelPHomeCover - pHomeCover, edgeAway = (1 - modelPHomeCover) - pAwayCover;
      let rlPick = null, rlEdge = 0, rlProb = null, rlMktProb = null, rlBestAm = null, rlPoint = null;
      if (edgeHome >= edgeAway && edgeHome >= NO_PLAY_EDGE_SECONDARY) { rlPick = h.team.name; rlEdge = edgeHome; rlProb = modelPHomeCover; rlMktProb = pHomeCover; rlBestAm = bestHome; rlPoint = homePoint; }
      else if (edgeAway > edgeHome && edgeAway >= NO_PLAY_EDGE_SECONDARY) { rlPick = a.team.name; rlEdge = edgeAway; rlProb = 1 - modelPHomeCover; rlMktProb = pAwayCover; rlBestAm = bestAway; rlPoint = awayPoint; }
      runLineOut = { point: rlPoint, projMargin: Number(projMargin.toFixed(1)), pick: rlPick, edge: Number(rlEdge.toFixed(4)), prob: rlProb !== null ? Number(rlProb.toFixed(4)) : null, mktProb: rlMktProb !== null ? Number(rlMktProb.toFixed(4)) : null, bestAm: rlBestAm };
    } else {
      runLineOut = { point: null, projMargin: Number(projMargin.toFixed(1)), pick: null, edge: 0, prob: null, mktProb: null, bestAm: null };
    }

    // Public competitor signal: a second opinion only. It can upgrade a value pick's
    // confidence label or flag it as contested — it never overrides the pick itself.
    const consensus = buildConsensus(a.team.name, h.team.name, manualSignals, autoSignals);
    const agreeCount = (pickHome ? consensus.agreeHome : consensus.agreeAway).length;
    const opposeCount = (pickHome ? consensus.agreeAway : consensus.agreeHome).length;
    // Every moneyline lean ends up either a real value play OR an explicit pass —
    // no third, unlabeled state. Previously, an edge at or below -NO_PLAY_EDGE (the
    // market strongly preferring the other side) or a missing market price fell
    // through both checks and rendered as an unqualified pick; that's fixed here.
    let valueTag = "";
    let isPass = false;
    if (edge !== null && edge >= VALUE_EDGE) {
      if (opposeCount >= CONSENSUS_CONTEST_N && edge < CONSENSUS_CONTEST_EDGE) valueTag = "CONTESTED VALUE";
      else if (agreeCount >= CONSENSUS_ALIGN_N) valueTag = "STRONG VALUE";
      else valueTag = "VALUE";
    } else {
      isPass = true;
    }
    const signalNote = agreeCount
      ? `${agreeCount} tracked public source${agreeCount > 1 ? "s" : ""} also lean${agreeCount > 1 ? "" : "s"} ${pick}.`
      : opposeCount
      ? `${opposeCount} tracked public source${opposeCount > 1 ? "s" : ""} lean the other side.`
      : `No public signal detected for this game today.`;

    const para = `${a.team.name} (${sA.rec}, last 10: ${sA.l10}) visit ${h.team.name} (${sH.rec}, last 10: ${sH.l10}) at ${time}. ` +
      `On the mound: ${spA.txt} against ${spH.txt}. ${duel} ` +
      `The model makes ${pick} a ${pct(prob)} favorite here` +
      (edge !== null ? (edge >= VALUE_EDGE ? ` — and with the market at ${pct(mktProb)} (best price ${fmtAm(bestAm)}), it sees value.` :
        edge <= -VALUE_EDGE ? `, though the market is higher on the other side (${pct(mktProb)}) — no value at the current price.` :
        `, roughly in line with the market (${pct(mktProb)}).`) : `.`) + venueTxt;

    const pd = valueTag ? priceDiscipline(prob, bestAm) : null;

    const totalLine = totalOut.pick
      ? `<p class="subpick">▸ Total: <b>${esc(totalOut.pick)} ${totalOut.line}</b> (model projects ${totalOut.projTotal} runs, edge ${pct(totalOut.edge)})</p>`
      : totalOut.line ? `<p class="subpick pass">Total: pass — projected ${totalOut.projTotal} vs line ${totalOut.line}, no clear edge.</p>` : "";
    const runLineLine = runLineOut.pick
      ? `<p class="subpick">▸ Run line: <b>${esc(runLineOut.pick)} ${runLineOut.point > 0 ? "+" : ""}${runLineOut.point}</b> (projected margin ${runLineOut.projMargin > 0 ? "+" : ""}${runLineOut.projMargin}, edge ${pct(runLineOut.edge)})</p>`
      : runLineOut.point !== null ? `<p class="subpick pass">Run line: pass — no clear edge at ${runLineOut.point > 0 ? "+" : ""}${runLineOut.point}.</p>` : "";

    // Full "Approved Play" card for anything that clears the value bar — the same
    // format members get by email. Passes keep the older compact line; nothing is
    // ever hidden either way, this just decides how much detail a game gets.
    let cardBlock = "";
    let tier = null, edgeScore = null, priceRangeTxt = null, mktProbRangeTxt = null, whyTxt = null, riskTxt = null;
    if (valueTag && pd) {
      const t = tierAndScore(edge, prob);
      tier = t.tier; edgeScore = t.score;
      const pickedPrices = mkt ? (pickHome ? mkt.homePrices : mkt.awayPrices) : null;
      priceRangeTxt = priceRangeStr(pickedPrices) || pd.current;
      const pickedNoVigRange = mkt ? (pickHome ? mkt.homeNoVigRange : mkt.awayNoVigRange) : null;
      mktProbRangeTxt = pickedNoVigRange ? probRangeStr(pickedNoVigRange) : pct(mktProb);
      const oppSp = pickHome ? spA : spH;
      whyTxt = whyWeLikeIt({ pick, pickHome, spA, spH, sA, sH, pd });
      riskTxt = whatCouldGoWrong({ wx, pkInfo, oppSp });

      cardBlock = `
  <span class="approved-badge">Approved Play: ${esc(pick)} ML</span>
  <dl class="field-grid">
    <dt>Game</dt><dd>${esc(a.team.name)} @ ${esc(h.team.name)}</dd>
    <dt>Market</dt><dd>Moneyline</dd>
    <dt>Pick</dt><dd>${esc(pick)} ML</dd>
    <dt>Current price used</dt><dd>${esc(priceRangeTxt)}</dd>
    <dt>Playable to</dt><dd>${esc(pd.current)}</dd>
    <dt>Pass at</dt><dd>${esc(pd.playableTo)} or worse</dd>
    <dt>Confidence tier</dt><dd>${esc(tier)}</dd>
    <dt>Dia edge score</dt><dd>${edgeScore} / 100</dd>
    <dt>Market no-vig probability</dt><dd>${esc(mktProbRangeTxt)}</dd>
    <dt>Dia projected probability</dt><dd>${pct(prob)}</dd>
    <dt>Raw edge</dt><dd>+${pct(edge)}</dd>
  </dl>
  <div class="why-block"><b>Why we like it</b>${esc(whyTxt)}</div>
  <div class="risk-block"><b>What could go wrong</b>${esc(riskTxt)}</div>`;
    }

    rendered.push({
      html: `<div class="pv" data-edge="${edge !== null ? edge : -1}">
  <h2>${esc(a.team.name)} @ ${esc(h.team.name)}</h2>
  <div class="meta">${time} · ${esc(spA.name)} vs ${esc(spH.name)}</div>
  <p>${esc(para)}</p>
  ${cardBlock || `<p class="pick">▸ Moneyline: ${esc(pick)} (${pct(prob)})${isPass ? " — PASS, no edge" : ""}</p>`}
  ${totalLine}${runLineLine}
  <p class="dim small">${esc(signalNote)}</p>
</div>\n`,
      edge: edge !== null ? edge : -1
    });

    picksOut.push({
      gamePk: g.gamePk, away: a.team.name, home: h.team.name, time: g.gameDate,
      moneyline: {
        pick, side: pickHome ? "home" : "away", prob: Number(prob.toFixed(4)),
        mktProb: mktProb !== null ? Number(mktProb.toFixed(4)) : null,
        bestAm, valueTag: valueTag || null, isPass,
        consensusAgree: agreeCount, consensusOppose: opposeCount,
        tier, edgeScore, priceRange: priceRangeTxt, mktProbRange: mktProbRangeTxt,
        why: whyTxt, risk: riskTxt
      },
      total: totalOut,
      runLine: runLineOut
    });
  }

  // Feature the single highest-edge game of the day at the top — visible to everyone,
  // never hidden, just highlighted (the "hero pick" competitors lead with).
  rendered.sort((x, y) => y.edge - x.edge);
  if (rendered.length && rendered[0].edge >= VALUE_EDGE) {
    rendered[0].html = rendered[0].html.replace('<div class="pv"', '<div class="pv featured"')
      .replace('<h2>', '<span class="featured-flag">PLAY OF THE DAY</span>\n  <h2>');
  }

  let body = `<h1>MLB Game Previews — ${esc(nice)}</h1>
<p class="subtitle">Every matchup, the pitching duel, and the model's lean across moneyline, total, and run line. Methodology: Pythagorean strength (75%) + last-10 form (25%), log5, home-field bump, starter-ERA adjustment, and a public-signal check against tracked competitor sources.</p>
<p class="dim small">Published automatically at ${esc(publishedEt)} ET · ${rendered.length} game${rendered.length > 1 ? "s" : ""} on today's slate. No edge, no play — every pick that doesn't clear the bar says so.</p>\n`;
  body += membershipBox();
  body += rendered.map(r => r.html).join("");
  body += leadCaptureBox(`preview-${DATE}`);

  body += `<p class="dim small">Model outputs, not guarantees — the model doesn't know injuries, bullpens, or weather beyond the forecast shown. Total and run line use a simplified normal-approximation model layered on the same team/pitcher inputs as the moneyline. Every pick is graded on the <a href="/results/">Results page</a>.</p>`;

  const sigRows = autoSignals.map(s => `<tr><td>${esc(s.source)}</td><td>${esc(s.status)}</td><td><a href="${esc(s.url)}">source</a></td></tr>`).join("")
    || `<tr><td colspan="3" class="dim">No competitor sources configured.</td></tr>`;
  body += `<h2>Public signals checked today</h2>
<div class="card"><table><thead><tr><th>Source</th><th>Status</th><th>Link</th></tr></thead><tbody>${sigRows}</tbody></table>
<p class="dim small">Public sources are checked as a second opinion only — LyDia's own model and market edge always decide the pick. Add a verified daily signal in <code>data/config/manual-competitor-signals.csv</code>; it's more reliable than the automated fetch above, since most pick sites are JavaScript-rendered.</p></div>`;

  fs.mkdirSync(path.join(ROOT, "previews"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, "data", "picks"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "previews", `${DATE}.html`), pageShell(
    `MLB Game Previews & Picks ${nice} | LyDia`,
    `Preview and model pick for every MLB game on ${nice}: pitching matchups, form, and value vs the betting market across moneyline, total, and run line.`,
    body));
  fs.writeFileSync(path.join(ROOT, "data", "picks", `${DATE}.json`), JSON.stringify({ date: DATE, generated: new Date().toISOString(), picks: picksOut }, null, 2));
  console.log(`wrote previews/${DATE}.html and data/picks/${DATE}.json (${picksOut.length} picks)`);

  // archive index
  const posts = fs.readdirSync(path.join(ROOT, "previews")).filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).sort().reverse();
  fs.writeFileSync(path.join(ROOT, "previews", "index.html"), pageShell(
    "MLB Game Previews — archive | LyDia",
    "Daily MLB game previews with model picks for every matchup.",
    `<h1>Game Previews</h1>\n<div class="card archive-list">\n` +
    posts.map(f => `<a href="/previews/${f}">Game Previews — ${esc(niceDate(f.replace(".html", "")))}</a>`).join("\n") +
    `\n</div>`));

  // sitemap: static pages + recaps + previews
  const staticPages = ["", "dashboard/", "picks/", "odds/", "tools/", "stats/", "recaps/", "articles/", "membership/", "results/", "previews/"];
  const recapPosts = fs.existsSync(path.join(ROOT, "recaps")) ?
    fs.readdirSync(path.join(ROOT, "recaps")).filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).map(f => `recaps/${f}`) : [];
  const urls = staticPages.map(p => `${SITE}/${p}`)
    .concat(recapPosts.map(p => `${SITE}/${p}`))
    .concat(posts.map(f => `${SITE}/previews/${f}`));
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `  <url><loc>${u}</loc></url>`).join("\n") + `\n</urlset>\n`);
  console.log("sitemap updated:", urls.length, "urls");
}

main().catch(e => { console.error(e); process.exit(1); });
                    