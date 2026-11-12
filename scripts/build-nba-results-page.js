#!/usr/bin/env node
/**
 * Leo NBA results page, built at grading time (HO-0031, DEC-20261110-30,
 * design: business/RESULTS_DESIGN.md).
 *
 *   node scripts/build-nba-results-page.js [--all] [YYYY-MM-DD ...]
 *
 * 1. Miss reasons and upsets (scripts/lib/nba-misses.js) for the dates given,
 *    else every graded date from the last 3 days plus any date with no file
 *    yet; --all rebuilds every graded date. Written to
 *    data/nba/misses/<date>.json (the audit email reads the same labels).
 * 2. data/nba/results-days.json: every graded day, newest first, with the
 *    calls record, upsets, misses and the "What Leo is learning" tally
 *    (open tests from data/nba/learning.json, written by the NBA admin chat).
 * 3. nba/results/index.html: the page with the latest days as static HTML,
 *    so search engines read it. The page script re-renders the same view
 *    with innerHTML = (prerender rule) for the filters.
 *
 * Reads only frozen and graded files; nothing here feeds Leo's numbers.
 * Never blocks grading: the workflow runs it with a warning on failure.
 */
const fs = require("fs");
const path = require("path");
const M = require("./lib/nba-model");
const PK = require("./lib/nba-picks");
const URLS = require("./lib/nba-urls");
const MISS = require("./lib/nba-misses");
const VIEW = require("./lib/nba-results-view");

const ROOT = path.join(__dirname, ".."), DIR = path.join(ROOT, "data", "nba"), MDIR = path.join(DIR, "misses");
const PAGE = path.join(ROOT, "nba", "results", "index.html");
const VERSION = "20261111a";
const nyDate = d => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const num = v => v === "" || v == null || !Number.isFinite(+v) ? null : +v;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const [head, ...lines] = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const h = head.split(",");
  return lines.map(l => { const c = l.split(","); return Object.fromEntries(h.map((k, i) => [k, c[i] ?? ""])); });
}
const nick = c => URLS.nick(c);
const monday = d => { const t = new Date(d + "T12:00:00Z"), k = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - k); return t.toISOString().slice(0, 10); };
const shift = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

async function buildMisses(rows, dates) {
  if (!dates.length) return;
  const model = readJson(path.join(DIR, "model.json"), {}), lostCoef = (model.coef || {}).lost_d || 0;
  let players = null;
  try { players = (await M.loadSeason(model.season)).players; }
  catch (e) { console.log(`  season player file not loaded (${e.message}): regulars who sat unlisted are not checked this run`); }
  fs.mkdirSync(MDIR, { recursive: true });
  for (const date of dates) {
    const card = readJson(path.join(DIR, `picks-${date}.json`), { games: [] }), box = readJson(path.join(DIR, "boxscores", `${date}.json`), { games: [] });
    const cardBy = new Map(card.games.map(g => [String(g.game_id), g])), boxBy = new Map(box.games.map(g => [String(g.game_id), g]));
    const regs = players ? M.regulars(players, date) : null;
    // Players with 1 or 2 games this season (not regulars yet, NBA-H17): value by the model's own formula on the games they played.
    const uncounted = [];
    if (players) {
      const by = new Map();
      for (const p of players) { if (p.date >= date) break; if (p.played) { const k = p.id + "|" + p.team; if (!by.has(k)) by.set(k, []); by.get(k).push(p); } }
      for (const g of by.values()) if (g.length < 3) {
        const mins = g.reduce((t, r) => t + r.minutes, 0), mpg = mins / g.length, gpm = g.reduce((t, r) => t + r.gmsc, 0) / Math.max(1, mins);
        if (mpg >= 10) uncounted.push({ name: g[0].name, team: g[0].team, value: Math.max(0, mpg * (gpm - 0.20)) });
      }
    }
    const games = rows.filter(r => r.date === date).map(r => {
      const c = MISS.classify(r, { card: cardBy.get(r.game_id), box: boxBy.get(r.game_id), regs, uncounted, lostCoef, nick, trackFrom: PK.TRACK_FROM });
      return { game_id: r.game_id, away: r.away, home: r.home, overtime: c.overtime, upset: c.upset,
        miss: c.reason ? { kinds: c.kinds, reason: c.reason, label: c.label, evidence: c.evidence, cost_pts: c.cost_pts } : null };
    });
    const f = path.join(MDIR, `${date}.json`), prev = readJson(f, null);
    if (prev && JSON.stringify(prev.games) === JSON.stringify(games)) continue;
    fs.writeFileSync(f, JSON.stringify({ date, built_at: new Date().toISOString(), regulars_checked: !!regs, games }, null, 1) + "\n");
    console.log(`  misses ${date}: ${games.filter(g => g.miss).length} of ${games.length} games missed, ${games.filter(g => g.upset).length} upsets`);
  }
}

function buildDoc(rows) {
  const dates = [...new Set(rows.map(r => r.date))].sort().reverse();
  const run = { w: 0, l: 0, p: 0, units: 0, n: 0 };
  const add = (acc, res, units) => { acc.n++; acc[res === "win" ? "w" : res === "loss" ? "l" : "p"]++; acc.units += units; };
  const byDate = {};
  for (const date of dates.slice().reverse()) {     // oldest first for the running total
    const mf = readJson(path.join(MDIR, `${date}.json`), { games: [] }), mBy = new Map(mf.games.map(g => [g.game_id, g]));
    const calls = { w: 0, l: 0, p: 0, units: 0, n: 0 };
    const games = rows.filter(r => r.date === date).map(r => {
      const m = +r.leo_home_margin, sp = -m, dk = num(r.mkt_home_spread), x = mBy.get(r.game_id) || {};
      const leoSpread = dk == null ? Math.round(sp * 2) / 2 : sp > dk ? Math.floor(sp * 2) / 2 : Math.ceil(sp * 2) / 2;   // .5 grid toward DraftKings (DEC-20261102-03)
      const g = { id: r.game_id, away: r.away, home: r.home, as: +r.away_score, hs: +r.home_score, ot: !!x.overtime,
        url: URLS.gamePath({ away: r.away, home: r.home, date }), p_home: +r.leo_p_home, leo_spread: leoSpread, mkt_spread: dk,
        leo_right: +r.leo_winner_correct === 1, leo_miss: +r.leo_miss, line_miss: num(r.line_miss), pick: null, lean: null, miss: x.miss || null, upset: x.upset || null };
      if (r.pick_result && date >= PK.TRACK_FROM) {
        g.pick = { team: r.pick_team, price: +r.pick_price, p: +r.pick_p, result: r.pick_result, units: +r.pick_units };
        add(calls, g.pick.result, g.pick.units); add(run, g.pick.result, g.pick.units);
      }
      if (r.lean_result) {
        const units = r.lean_units !== "" ? +r.lean_units : PK.units(r.lean_result, -110);
        g.lean = { team: r.lean_side === "home" ? r.home : r.away, line: +r.lean_line, price: r.lean_price !== "" ? +r.lean_price : -110, assumed: r.price_source !== "dk_at_read",
          gap: Math.abs(+r.edge_pts), result: r.lean_result, units };
        add(calls, g.lean.result, units); add(run, g.lean.result, units);
      }
      return g;
    });
    const fix = c => ({ ...c, units: +c.units.toFixed(2) });
    byDate[date] = { date, games, calls: fix(calls), running: fix(run) };
  }
  const days = dates.map(d => byDate[d]), all = days.flatMap(d => d.games.map(g => ({ ...g, date: d.date })));
  const recOf = list => { const c = { w: 0, l: 0, p: 0, units: 0, n: 0 }; for (const [res, units] of list) add(c, res, units); c.units = +c.units.toFixed(2); return c; };
  const picks = recOf(all.filter(g => g.pick).map(g => [g.pick.result, g.pick.units])), leans = recOf(all.filter(g => g.lean).map(g => [g.lean.result, g.lean.units]));
  const lined = rows.filter(r => r.mkt_p_home !== ""), sp = rows.filter(r => r.line_miss !== "");
  const avg = a => a.length ? +(a.reduce((t, v) => t + v, 0) / a.length).toFixed(2) : null;

  // What Leo is learning: reason tally by week (Monday to Sunday, by game date).
  const latest = dates[0] || nyDate(new Date()), thisW = monday(latest), lastW = shift(thisW, -7);
  const tally = { this_week: {}, last_week: {}, season: {} };
  for (const g of all) if (g.miss) {
    const w = monday(g.date), r = g.miss.reason;
    tally.season[r] = (tally.season[r] || 0) + 1;
    if (w === thisW) tally.this_week[r] = (tally.this_week[r] || 0) + 1;
    if (w === lastW) tally.last_week[r] = (tally.last_week[r] || 0) + 1;
  }
  const L = readJson(path.join(DIR, "learning.json"), { tests: [] });
  const tot = o => Object.values(o).reduce((t, v) => t + v, 0), low = r => MISS.LABEL[r].toLowerCase();
  const top = Object.entries(tally.season).sort((a, b) => b[1] - a[1])[0];
  const me = r => `${MISS.LABEL[r]} misses: ${tally.this_week[r] || 0} this week, ${tally.last_week[r] || 0} last week.`;
  const trend = !tot(tally.season) ? "No misses graded yet."
    : `${tot(tally.season)} misses so far this season, most often ${low(top[0])} (${top[1]}). ${me("model_error")} ${me("injury_input")}`;

  return {
    updated_at: new Date().toISOString(), through: latest, model_version: M.MODEL_VERSION,
    note: "Leo Picks are a tracked test, not bets. One unit each at the DraftKings price saved before tip. Picks count from " + PK.TRACK_FROM + ". Leans ended after " + PK.LEANS_UNTIL + " and stay on the record. Under 50 graded calls is an early read.",
    season: { games: rows.length, right: rows.filter(r => +r.leo_winner_correct === 1).length, mkt_games: lined.length, mkt_right: lined.filter(r => +r.mkt_winner_correct === 1).length,
      miss_leo: avg(sp.map(r => +r.leo_miss)), miss_line: avg(sp.map(r => +r.line_miss)),
      calls: days.length ? days[0].running : { w: 0, l: 0, p: 0, units: 0, n: 0 },
      picks: { ...picks, from: PK.TRACK_FROM }, leans },
    learning: { week_of: thisW, order: MISS.ORDER, labels: MISS.LABEL, tally, trend, rule: L.rule || "", tests: L.tests || [], tests_updated: L.updated || "" },
    teams: [...new Set(rows.flatMap(r => [r.away, r.home]))].sort((a, b) => nick(a).localeCompare(nick(b))),
    days
  };
}

const CSS = `
.rec-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:14px;}
.rec{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:13px 15px;display:flex;flex-direction:column;gap:3px;}
.rec .lab{font-size:.64rem;font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:var(--text-dim);}
.rec .big{font-size:1.5rem;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.1;}
.rec .beat{font-size:.76rem;color:var(--text-dim);line-height:1.4;}
.updated{font-size:.84rem;color:var(--text-dim);margin:10px 0 0;}
.sec-h{font-family:var(--font-display,inherit);font-size:1.35rem;margin:26px 0 4px;}
.sub-h{font-size:.72rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--text-dim);margin:16px 0 6px;}
.sec-p{font-size:.88rem;color:var(--text-dim);margin:0 0 12px;max-width:780px;line-height:1.55;}
.sec-p b{color:var(--text);}
.tbl-card{padding:0;overflow-x:auto;}
table.calls{width:100%;border-collapse:collapse;font-size:.88rem;}
table.calls th,table.calls td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--border);}
table.calls th{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim);}
table.tally{table-layout:fixed;}
table.tally td:not(:first-child),table.tally th:not(:first-child){text-align:right;font-variant-numeric:tabular-nums;font-weight:700;width:72px;}
table.tally .help{display:block;font-size:.78rem;color:var(--text-dim);margin-top:3px;line-height:1.4;}
.ok{color:var(--good);font-weight:800;} .no{color:var(--danger);font-weight:800;}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin:6px 0 12px;}
.filters .field{margin:0;min-width:150px;flex:1 1 150px;}
.filters .field label{display:block;font-size:.68rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim);margin-bottom:4px;}
.filters select{width:100%;box-sizing:border-box;}
.chip-reset{border:1px solid var(--border);background:var(--bg-card);color:var(--text);border-radius:999px;padding:8px 14px;font-weight:700;cursor:pointer;font:inherit;font-size:.85rem;}
.call-tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.7rem;font-weight:800;background:rgba(47,110,74,.12);border:1px solid rgba(47,110,74,.4);color:var(--good);white-space:nowrap;}
.call-tag.lean{background:rgba(26,37,53,.07);border-color:rgba(26,37,53,.25);color:var(--text);}
details.day{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;margin:0 0 12px;overflow:hidden;}
details.day>summary{cursor:pointer;list-style:none;padding:14px 16px;display:flex;flex-wrap:wrap;gap:4px 14px;align-items:baseline;}
details.day>summary::-webkit-details-marker{display:none;}
details.day>summary::after{content:"+";margin-left:auto;font-weight:800;color:var(--text-dim);}
details.day[open]>summary::after{content:"\\2212";}
details.day[open]>summary{border-bottom:1px solid var(--border);}
.day-date{font-family:var(--font-display,inherit);font-size:1.12rem;font-weight:700;}
.day-sum{font-size:.82rem;color:var(--text-dim);}
.day-body{padding:6px 16px 14px;}
.day-line{font-size:.88rem;color:var(--text-dim);margin:8px 0 0;}
.day-sec h3{font-size:.7rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--text-dim);margin:16px 0 6px;}
ul.lines{list-style:none;margin:0;padding:0;}
ul.lines li{font-size:.9rem;line-height:1.55;padding:7px 0;border-bottom:1px solid var(--border);}
ul.lines li:last-child{border-bottom:0;}
ul.lines a,.miss h4 a{color:var(--text);font-weight:700;text-decoration:underline;text-decoration-color:var(--border);text-underline-offset:3px;}
.none{font-size:.88rem;color:var(--text-dim);margin:0;}
.miss{border:1px solid var(--border);border-left:4px solid var(--text-dim);border-radius:12px;padding:11px 14px;margin:0 0 10px;background:var(--bg-elev);}
.miss[data-reason="model_error"]{border-left-color:var(--danger);}
.miss[data-reason="injury_input"]{border-left-color:var(--accent);}
.miss-head{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin-bottom:4px;}
.miss h4{margin:0;font-size:1rem;}
.kinds{display:flex;flex-wrap:wrap;gap:5px;}
.kind{font-size:.68rem;font-weight:800;padding:2px 8px;border-radius:999px;border:1px solid var(--border);color:var(--text-dim);white-space:nowrap;}
.miss p{font-size:.9rem;line-height:1.55;margin:4px 0;}
.miss p.why{margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);}
.reason{display:inline-block;font-size:.7rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;padding:2px 8px;border-radius:6px;border:1px solid var(--border);color:var(--text);white-space:nowrap;margin-right:4px;}
.reason.r-model_error{border-color:var(--danger);color:var(--danger);}
.reason.r-injury_input{border-color:var(--accent);}
.cost{color:var(--text-dim);}
ul.tests{list-style:none;margin:0 0 12px;padding:0;max-width:820px;}
ul.tests li{font-size:.88rem;line-height:1.5;padding:7px 0;border-bottom:1px solid var(--border);}
.t-status{display:inline-block;min-width:74px;font-size:.66rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim);}
.t-status.t-adopted{color:var(--good);} .t-status.t-rejected{color:var(--danger);}
.rule{margin-top:10px;}
.more{text-align:center;margin:14px 0;}
@media(max-width:760px){
  table.tally th,table.tally td{padding:9px 8px;}
  table.tally td:not(:first-child),table.tally th:not(:first-child){width:54px;}
  table.tally th{font-size:.62rem;letter-spacing:.02em;}
  details.day>summary{padding:12px 13px;} .day-body{padding:4px 13px 12px;}
}`;

function writePage(doc) {
  const view = VIEW.make(nick), app = view.render(doc, {});
  const prev = fs.existsSync(PAGE) ? fs.readFileSync(PAGE, "utf8") : "", navM = prev.match(/<nav id="nav">[\s\S]*?<\/nav>/);
  const upd = "Last updated " + new Date(doc.updated_at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) +
    " ET &middot; games through " + new Date(doc.through + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XVWTMDNBJK"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XVWTMDNBJK');
</script>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Leo NBA Results: Every Game Graded, Day by Day | Leo</title>
<meta name="description" content="Leo's NBA record day by day: every call graded, the upsets, what Leo got right, and what Leo missed and why.">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Leo">
<meta property="og:title" content="Leo NBA Results: Every Game Graded, Day by Day | Leo">
<meta property="og:url" content="https://ndhorizon.com/nba/results/">
<meta property="og:image" content="https://ndhorizon.com/img/og-card.png">
<link rel="canonical" href="https://ndhorizon.com/nba/results/">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>&#127936;</text></svg>">
<link rel="stylesheet" href="/css/style.css">
<link rel="stylesheet" href="/css/scoreboard.css">
<style>${CSS}
</style>
</head>
<body>
${navM ? navM[0] : '<nav id="nav"></nav>'}
<main class="scoreboard-shell" id="main">
<!-- Built by scripts/build-nba-results-page.js at grading time (HO-0031). The page script replaces #app with the same view (innerHTML =). -->
<section class="score-hero">
    <p class="eyebrow">Every read, graded against what actually happened.</p>
    <h1>Leo&rsquo;s NBA results</h1>
    <p class="subtitle">Day by day: the upsets, what Leo got right, and what Leo missed and why. Each game is graded on the last read Leo made before tip. Nothing is changed after the fact, and losses stay on the record.</p>
    <p class="updated" id="updated">${upd}</p>
    <p style="margin:10px 0 0"><a class="chip-reset" href="/nba/teams/" style="text-decoration:none;display:inline-block">Browse by team</a></p>
  </section>
  <div id="status"></div>
  <div id="app">${app}</div>
</main>
<footer id="footer"></footer><script src="/js/app.js"></script>
<script src="/scripts/lib/nba-urls.js?v=20261107"></script>
<script src="/scripts/lib/nba-results-view.js?v=${VERSION}"></script>
<script>
renderNav("/nba/results/"); renderFooter();
/* NBA results, day by day (HO-0031, DEC-20261110-30). The page is built at grading time;
   this script draws the same view from data/nba/results-days.json so the filters work.
   Every section is written with innerHTML = (prerender rule). */
let DOC = null, ALL = false, F = { date: "", team: "" };
try { const q = new URLSearchParams(location.search); F.date = q.get("date") || ""; F.team = (q.get("team") || "").toUpperCase(); } catch (e) {}
const VIEWER = NBA_RESULTS_VIEW.make(c => NBA_URLS.nick(c));
function draw() { document.getElementById("app").innerHTML = VIEWER.render(DOC, { team: F.team, date: F.date, all: ALL, teamUrl: c => "/nba/teams/" + NBA_URLS.slugify(NBA_URLS.nick(c)) + "/" }); }
function setFilter(k, v) {
  F[k] = v;
  try { const q = new URLSearchParams(); if (F.date) q.set("date", F.date); if (F.team) q.set("team", F.team); history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : "")); } catch (e) {}
  draw();
}
function clearFilters() { F.date = ""; setFilter("team", ""); }
function showAll() { ALL = true; draw(); }
(async () => {
  try {
    const r = await fetch("/data/nba/results-days.json?v=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return;
    DOC = await r.json();
    const d = s => new Date(s + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
    document.getElementById("updated").innerHTML = "Last updated " + new Date(DOC.updated_at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET &middot; games through " + d(DOC.through);
    draw();
  } catch (e) {}
})();
</script>
</body>
</html>
`;
  fs.writeFileSync(PAGE, html);
}

(async () => {
  const rows = readCsv(path.join(DIR, "results-ledger.csv"));
  if (!rows.length) { console.log("NBA results page: no graded games yet."); return; }
  const graded = [...new Set(rows.map(r => r.date))].sort(), args = process.argv.slice(2).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const recent = nyDate(new Date(Date.now() - 3 * 864e5));
  const dates = process.argv.includes("--all") ? graded : args.length ? args.filter(d => graded.includes(d))
    : graded.filter(d => d >= recent || !fs.existsSync(path.join(MDIR, `${d}.json`)));
  await buildMisses(rows, dates);
  const doc = buildDoc(rows);
  fs.writeFileSync(path.join(DIR, "results-days.json"), JSON.stringify(doc) + "\n");
  writePage(doc);
  const s = doc.season, t = doc.learning.tally.season;
  console.log(`NBA results page: ${doc.days.length} days, ${s.games} games. Calls ${s.calls.w}-${s.calls.l}-${s.calls.p} (${s.calls.units}u). Misses by reason: ${MISS.ORDER.map(r => r + " " + (t[r] || 0)).join(", ")}.`);
})().catch(e => { console.error(e); process.exit(1); });
