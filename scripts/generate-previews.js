#!/usr/bin/env node
/* LyDia Picks — daily game previews + pick logging.
   Usage: node scripts/generate-previews.js [YYYY-MM-DD]   (default: today in US Eastern)
   Env:   ODDS_API_KEY  (optional — adds market odds + value edges)
   Writes: previews/<date>.html, previews/index.html, data/picks/<date>.json, sitemap.xml */

const fs = require("fs");
const path = require("path");

const SITE = "https://mlbedges.com";
const ROOT = path.join(__dirname, "..");
const HFA = 54 / 46, PYTH_EXP = 1.83, FORM_WEIGHT = 0.25, ERA_K = 0.20;
const LEAGUE_ERA = 4.20, MIN_IP = 20, ERA_CLAMP = [2.75, 6.00], VALUE_EDGE = 0.03;

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

const NAV = `<nav><div class="nav-inner">
  <a class="brand" href="/index.html"><span class="brand-ly">Ly</span><span class="brand-dia">Dia</span> Picks</a>
  <a class="navlink" href="/index.html">Home</a>
  <a class="navlink" href="/dashboard.html">Dashboard</a>
  <a class="navlink" href="/picks.html">Picks</a>
  <a class="navlink active" href="/previews/">Previews</a>
  <a class="navlink" href="/results.html">Results</a>
  <a class="navlink" href="/odds.html">Odds</a>
  <a class="navlink" href="/recaps/">Recaps</a>
  <a class="navlink" href="/membership.html">Membership</a>
</div></nav>`;
const FOOTER = `<footer>LyDia Picks — analysis and education only, not betting advice. Please bet responsibly. If gambling stops being fun, call 1-800-GAMBLER.</footer>`;

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
.pv h2 { margin: 0 0 4px; font-size: 1.15rem; }
.pv .meta { color: var(--text-dim); font-size: .85rem; margin-bottom: 8px; }
.pv .pick { font-weight: 700; color: var(--accent); }
.pv table { font-size: .88rem; margin: 8px 0; border-collapse: collapse; }
.pv td, .pv th { padding: 4px 10px; border-bottom: 1px solid var(--border); text-align: left; }
.archive-list a { display: block; padding: 8px 0; border-bottom: 1px solid var(--border); }
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
  "Arizona Diamondbacks": ["Chase Field", 33.445, -112.067, 1, "neutral"],
  "Atlanta Braves": ["Truist Park", 33.891, -84.468, 0, "hitter-friendly"],
  "Baltimore Orioles": ["Camden Yards", 39.284, -76.622, 0, "neutral"],
  "Boston Red Sox": ["Fenway Park", 42.346, -71.097, 0, "hitter-friendly"],
  "Chicago Cubs": ["Wrigley Field", 41.948, -87.655, 0, "wind-dependent"],
  "Chicago White Sox": ["Rate Field", 41.830, -87.634, 0, "hitter-friendly"],
  "Cincinnati Reds": ["Great American Ball Park", 39.097, -84.507, 0, "hitter-friendly"],
  "Cleveland Guardians": ["Progressive Field", 41.496, -81.685, 0, "neutral"],
  "Colorado Rockies": ["Coors Field", 39.756, -104.994, 0, "extreme hitter's park"],
  "Detroit Tigers": ["Comerica Park", 42.339, -83.049, 0, "pitcher-friendly"],
  "Houston Astros": ["Daikin Park", 29.757, -95.355, 1, "neutral"],
  "Kansas City Royals": ["Kauffman Stadium", 39.051, -94.480, 0, "pitcher-friendly"],
  "Los Angeles Angels": ["Angel Stadium", 33.800, -117.883, 0, "neutral"],
  "Los Angeles Dodgers": ["Dodger Stadium", 34.074, -118.240, 0, "pitcher-friendly"],
  "Miami Marlins": ["loanDepot park", 25.778, -80.220, 1, "pitcher-friendly"],
  "Milwaukee Brewers": ["American Family Field", 43.028, -87.971, 1, "neutral"],
  "Minnesota Twins": ["Target Field", 44.982, -93.278, 0, "neutral"],
  "New York Mets": ["Citi Field", 40.757, -73.846, 0, "pitcher-friendly"],
  "New York Yankees": ["Yankee Stadium", 40.829, -73.926, 0, "hitter-friendly"],
  "Athletics": ["Sutter Health Park", 38.580, -121.513, 0, "neutral"],
  "Philadelphia Phillies": ["Citizens Bank Park", 39.906, -75.166, 0, "hitter-friendly"],
  "Pittsburgh Pirates": ["PNC Park", 40.447, -80.006, 0, "pitcher-friendly"],
  "San Diego Padres": ["Petco Park", 32.707, -117.157, 0, "pitcher-friendly"],
  "San Francisco Giants": ["Oracle Park", 37.778, -122.389, 0, "strong pitcher's park"],
  "Seattle Mariners": ["T-Mobile Park", 47.591, -122.332, 1, "strong pitcher's park"],
  "St. Louis Cardinals": ["Busch Stadium", 38.622, -90.193, 0, "pitcher-friendly"],
  "Tampa Bay Rays": ["home park", 27.768, -82.653, 1, "neutral"],
  "Texas Rangers": ["Globe Life Field", 32.747, -97.084, 1, "neutral"],
  "Toronto Blue Jays": ["Rogers Centre", 43.641, -79.389, 1, "hitter-friendly"],
  "Washington Nationals": ["Nationals Park", 38.873, -77.007, 0, "neutral"]
};
const _wx = {};
async function weatherFor(homeTeam, gameIso) {
  const pk = PARKS[homeTeam];
  if (!pk || pk[3]) return null; // unknown or roofed
  try {
    if (!_wx[homeTeam]) {
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${pk[1]}&longitude=${pk[2]}&hourly=temperature_2m,wind_speed_10m,wind_direction_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=3&timezone=auto`);
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
             dir: dirs[Math.round(((h.wind_direction_10m[best] % 360) + 360) % 360 / 45) % 8] };
  } catch (e) { return null; }
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
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
      strength[t.team.id] = {
        pyth: pythag(t.runsScored, t.runsAllowed),
        form: l10 ? l10.wins / Math.max(1, l10.wins + l10.losses) : null,
        l10: l10 ? `${l10.wins}-${l10.losses}` : "—",
        rec: `${t.wins}-${t.losses}`
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

  // optional market odds
  let oddsMap = null;
  if (process.env.ODDS_API_KEY) {
    try {
      const evs = await getJson(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${process.env.ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=american`);
      oddsMap = {};
      for (const ev of evs) {
        const rows = [];
        for (const bk of ev.bookmakers || []) {
          const m = (bk.markets || []).find(m => m.key === "h2h");
          if (!m) continue;
          const oA = m.outcomes.find(o => o.name === ev.away_team);
          const oH = m.outcomes.find(o => o.name === ev.home_team);
          if (oA && oH) rows.push([oA.price, oH.price]);
        }
        if (!rows.length) continue;
        const avgA = rows.reduce((s, r) => s + amToProb(r[0]), 0) / rows.length;
        const avgH = rows.reduce((s, r) => s + amToProb(r[1]), 0) / rows.length;
        const tot = avgA + avgH;
        oddsMap[ev.away_team + "@" + ev.home_team] = {
          pAway: avgA / tot, pHome: avgH / tot,
          bestAway: decToAm(Math.max(...rows.map(r => amToDec(r[0])))),
          bestHome: decToAm(Math.max(...rows.map(r => amToDec(r[1]))))
        };
      }
    } catch (e) { console.warn("odds unavailable:", e.message); }
  }

  const nice = niceDate(DATE);
  let body = `<h1>MLB Game Previews — ${esc(nice)}</h1>
<p class="subtitle">Every matchup, the pitching duel, and the model's lean. Methodology: Pythagorean strength (75%) + last-10 form (25%), log5, home-field bump, starter-ERA adjustment.</p>\n`;
  const picksOut = [];

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

    const mkt = oddsMap ? oddsMap[a.team.name + "@" + h.team.name] : null;
    const mktProb = mkt ? (pickHome ? mkt.pHome : mkt.pAway) : null;
    const bestAm = mkt ? (pickHome ? mkt.bestHome : mkt.bestAway) : null;
    const edge = mktProb !== null ? prob - mktProb : null;

    const pkInfo = PARKS[h.team.name];
    const wx = pkInfo ? await weatherFor(h.team.name, g.gameDate) : null;
    let venueTxt = "";
    if (pkInfo) {
      venueTxt = ` The setting: ${pkInfo[0]}, a ${pkInfo[4]} venue` +
        (pkInfo[3] ? " with a roof, so weather is a non-factor." :
         wx ? `; the forecast calls for ${wx.temp}\u00B0F with ${wx.wind} mph ${wx.dir} winds.` : ".");
    }
    const eraDiff = spA.eff - spH.eff;
    const duel = Math.abs(eraDiff) < 0.4
      ? `The pitching matchup is close to even.`
      : `${(eraDiff > 0 ? spH : spA).name} holds a clear edge on the mound.`;
    const para = `${a.team.name} (${sA.rec}, last 10: ${sA.l10}) visit ${h.team.name} (${sH.rec}, last 10: ${sH.l10}) at ${time}. ` +
      `On the mound: ${spA.txt} against ${spH.txt}. ${duel} ` +
      `The model makes ${pick} a ${pct(prob)} favorite here` +
      (edge !== null ? (edge >= VALUE_EDGE ? ` — and with the market at ${pct(mktProb)} (best price ${fmtAm(bestAm)}), it sees value.` :
        edge <= -VALUE_EDGE ? `, though the market is higher on the other side (${pct(mktProb)}) — no value at the current price.` :
        `, roughly in line with the market (${pct(mktProb)}).`) : `.`) + venueTxt;

    body += `<div class="pv">
  <h2>${esc(a.team.name)} @ ${esc(h.team.name)}</h2>
  <div class="meta">${time} · ${esc(spA.name)} vs ${esc(spH.name)}</div>
  <p>${esc(para)}</p>
  <p class="pick">▸ Model pick: ${esc(pick)} (${pct(prob)})${edge !== null && edge >= VALUE_EDGE ? " — VALUE" : ""}</p>
</div>\n`;

    picksOut.push({
      gamePk: g.gamePk, away: a.team.name, home: h.team.name,
      pick, side: pickHome ? "home" : "away", prob: Number(prob.toFixed(4)),
      mktProb: mktProb !== null ? Number(mktProb.toFixed(4)) : null,
      bestAm, time: g.gameDate
    });
  }

  body += `<p class="dim small">Model outputs, not guarantees — the model doesn't know injuries, bullpens, or weather. Every pick is graded on the <a href="/results.html">Results page</a>. <a href="/membership.html">Get picks by email</a>.</p>`;

  fs.mkdirSync(path.join(ROOT, "previews"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, "data", "picks"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "previews", `${DATE}.html`), pageShell(
    `MLB Game Previews & Picks ${nice} | LyDia Picks`,
    `Preview and model pick for every MLB game on ${nice}: pitching matchups, form, and value vs the betting market.`,
    body));
  fs.writeFileSync(path.join(ROOT, "data", "picks", `${DATE}.json`), JSON.stringify({ date: DATE, generated: new Date().toISOString(), picks: picksOut }, null, 2));
  console.log(`wrote previews/${DATE}.html and data/picks/${DATE}.json (${picksOut.length} picks)`);

  // archive index
  const posts = fs.readdirSync(path.join(ROOT, "previews")).filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).sort().reverse();
  fs.writeFileSync(path.join(ROOT, "previews", "index.html"), pageShell(
    "MLB Game Previews — archive | LyDia Picks",
    "Daily MLB game previews with model picks for every matchup.",
    `<h1>Game Previews</h1>\n<div class="card archive-list">\n` +
    posts.map(f => `<a href="/previews/${f}">Game Previews — ${esc(niceDate(f.replace(".html", "")))}</a>`).join("\n") +
    `\n</div>`));

  // sitemap: static pages + recaps + previews
  const staticPages = ["", "dashboard.html", "picks.html", "odds.html", "tools.html", "stats.html", "recaps.html", "articles.html", "membership.html", "results.html", "recaps/", "previews/"];
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
