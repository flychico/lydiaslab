#!/usr/bin/env node
/**
 * Leo NBA daily card: win chance and Leo's spread for every game, with the
 * injury report as an input.
 *
 *   node scripts/generate-nba-slate.js [YYYY-MM-DD]     default: today, New York
 *
 * Reads
 *   sportsdataverse release CSVs   this season's results and player lines
 *   ESPN scoreboard                today's games, tip times, DraftKings lines,
 *                                  and the last few days' finals (the release
 *                                  files can trail by a day)
 *   ESPN injury report             who is out or day-to-day right now
 *   data/nba/model.json            coefficients and last season's ratings
 * Writes
 *   data/nba/picks-<date>.json, data/nba/picks-today.json
 *   data/nba/prediction-history.csv   append-only; one row per game per run,
 *                                     only while the game has not started.
 *                                     The last row before tip is the read
 *                                     of record that grading uses.
 *
 * The DraftKings line is shown beside Leo and used to grade Leo. It is never
 * an input. A "lean" is recorded when Leo and the spread are 4+ points apart;
 * it is a tracked test, not a bet (DEC-20261031-01).
 */
const fs = require("fs");
const path = require("path");
const M = require("./lib/nba-model");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "data", "nba");
const HISTORY = path.join(DIR, "prediction-history.csv");
const HIST_COLS = ["captured_at", "date", "game_id", "kickoff_utc", "away", "home", "leo_home_margin", "leo_p_home",
  "mkt_home_spread", "home_ml", "away_ml", "lean_side", "lean_line", "edge_pts", "home_lost", "away_lost", "home_out", "away_out", "model_version"];
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const DATE = (process.argv.slice(2).find(a => /^\d{4}-\d{2}-\d{2}$/.test(a))) || today();
const shift = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const num = v => { const x = parseFloat(String(v).replace(/^\+/, "")); return Number.isFinite(x) ? x : null; };
const r1 = v => v == null ? null : Math.round(v * 10) / 10;
const half = v => Math.round(v * 2) / 2;

async function getJson(url, tries = 3) {
  // Tests only: NBA_FIXTURES=<dir> serves scoreboard_<yyyymmdd>.json and injuries.json from disk.
  if (process.env.NBA_FIXTURES) {
    const m = url.match(/dates=(\d{8})/), f = path.join(process.env.NBA_FIXTURES, m ? `scoreboard_${m[1]}.json` : "injuries.json");
    if (!fs.existsSync(f)) throw new Error("no fixture " + f);
    return JSON.parse(fs.readFileSync(f, "utf8"));
  }
  for (let i = 1; ; i++) {
    try { const r = await fetch(url, { headers: { "user-agent": "leo-nba/1.0" } }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
    catch (e) { if (i >= tries) throw new Error(url + ": " + e.message); await new Promise(s => setTimeout(s, 1500 * i)); }
  }
}

/** One scoreboard day -> plain game objects with the DraftKings line. */
async function scoreboard(date) {
  const j = await getJson(`${ESPN}/scoreboard?dates=${date.replace(/-/g, "")}`);
  return (j.events || []).filter(e => !e.season || e.season.type === 2 || e.season.slug === "regular-season").map(e => {
    const c = e.competitions[0], side = h => c.competitors.find(x => x.homeAway === h);
    const H = side("home"), A = side("away"), o = (c.odds || []).find(x => /draftkings/i.test(x.provider && x.provider.name || "")) || (c.odds || [])[0];
    let market = null;
    if (o) {
      const ps = o.pointSpread || {}, ml = o.moneyline || {};
      const homeSpread = num(ps.home && ps.home.close && ps.home.close.line) ?? (o.spread != null ? num(o.spread) : null);
      market = {
        provider: (o.provider && o.provider.name) || "DraftKings",
        home_spread: homeSpread,
        home_ml: num(ml.home && ml.home.close && ml.home.close.odds) ?? num(o.homeTeamOdds && o.homeTeamOdds.moneyLine),
        away_ml: num(ml.away && ml.away.close && ml.away.close.odds) ?? num(o.awayTeamOdds && o.awayTeamOdds.moneyLine),
        total: num(o.overUnder)
      };
      market.p_home = M.noVig(market.home_ml, market.away_ml);
    }
    const st = e.status && e.status.type || {};
    return {
      game_id: String(e.id), date, tip_utc: new Date(e.date).toISOString(), state: st.state, completed: !!st.completed, status: st.shortDetail || st.description || "",
      home: H.team.abbreviation, away: A.team.abbreviation, home_name: H.team.displayName, away_name: A.team.displayName,
      hs: num(H.score), as: num(A.score), neutral: !!c.neutralSite, venue: c.venue && c.venue.fullName || "", market
    };
  });
}

async function injuries() {
  const j = await getJson(`${ESPN}/injuries`);
  const byId = new Map(), byName = new Map(), list = [];
  for (const t of j.injuries || []) for (const i of t.injuries || []) {
    const a = i.athlete || {}, href = ((a.links || [])[0] || {}).href || "", m = href.match(/\/id\/(\d+)/);
    const status = String(i.status || (i.type && i.type.description) || "").toLowerCase();
    const row = { id: m ? m[1] : "", name: a.displayName || "", team: a.team && a.team.abbreviation || "", status, detail: [i.details && i.details.type, i.details && i.details.detail].filter(Boolean).join(" "), updated: i.date || "" };
    list.push(row); if (row.id) byId.set(row.id, row); byName.set(row.name.toLowerCase() + "|" + row.team, row);
  }
  return { byId, byName, list, timestamp: j.timestamp || new Date().toISOString() };
}

function readHistory() {
  if (!fs.existsSync(HISTORY)) return [];
  const [head, ...lines] = fs.readFileSync(HISTORY, "utf8").split(/\r?\n/).filter(Boolean);
  const h = head.split(",");
  return lines.map(l => { const c = l.split(","); return Object.fromEntries(h.map((k, i) => [k, c[i] ?? ""])); });
}

(async () => {
  const model = JSON.parse(fs.readFileSync(path.join(DIR, "model.json"), "utf8"));
  const season = model.season;
  const slate = await scoreboard(DATE);
  console.log(`NBA ${DATE}: ${slate.length} games on the scoreboard`);
  fs.mkdirSync(DIR, { recursive: true });
  if (!slate.length) { console.log("No games. Nothing written."); return; }

  // Results so far: the release file, topped up with ESPN finals it lacks.
  const { games, players } = await M.loadSeason(season);
  const known = new Set(games.map(g => g.game_id));
  for (let k = 1; k <= 4; k++) {
    for (const g of await scoreboard(shift(DATE, -k)).catch(() => [])) {
      if (g.completed && !known.has(g.game_id) && g.hs != null) { games.push({ game_id: g.game_id, date: g.date, home: g.home, away: g.away, hs: g.hs, as: g.as, margin: g.hs - g.as }); known.add(g.game_id); }
    }
  }
  const prev = games.filter(g => g.date < DATE);
  const teams = [...new Set([...Object.keys(model.prior_ratings), ...prev.flatMap(g => [g.home, g.away]), ...slate.flatMap(g => [g.home, g.away])])].sort();
  const { r, hca } = M.ratings(prev, teams, model.prior_ratings);
  const lastDate = {};
  for (const g of prev) { lastDate[g.home] = g.date; lastDate[g.away] = g.date; }
  const regs = M.regulars(players, DATE);
  const inj = await injuries();
  const weight = s => model.status_weight[s] ?? (s.includes("out") ? 1 : 0.4);
  const statusOf = p => inj.byId.get(p.id) || inj.byName.get(p.name.toLowerCase() + "|" + p.team);

  const prevFile = path.join(DIR, `picks-${DATE}.json`);
  const previous = fs.existsSync(prevFile) ? Object.fromEntries(JSON.parse(fs.readFileSync(prevFile, "utf8")).games.map(g => [g.game_id, g])) : {};
  const now = new Date().toISOString();
  const out = [], hist = [];
  for (const g of slate) {
    const started = g.state !== "pre" || g.tip_utc <= now;
    // Once a game tips, the card keeps the last read made before tip.
    if (started && previous[g.game_id] && previous[g.game_id].leo) {
      out.push({ ...previous[g.game_id], state: g.state, completed: g.completed, status: g.status, hs: g.hs, as: g.as });
      continue;
    }
    const f = { rating_diff: r[g.home] - r[g.away] };
    const rest = { home: M.restDays(lastDate[g.home], DATE), away: M.restDays(lastDate[g.away], DATE) };
    f.b2b_d = rest.home.b2b - rest.away.b2b; f.rest_d = rest.home.rest - rest.away.rest;
    const miss = {};
    for (const side of ["home", "away"]) miss[side] = M.lostValue(regs, g[side], p => { const s = statusOf(p); return s ? weight(s.status) : 0; });
    f.lost_d = miss.home.lost - miss.away.lost;
    const { margin, p_home } = M.predict(model, f);
    const mk = g.market && g.market.home_spread != null ? g.market : null;
    const edge = mk ? margin - (-mk.home_spread) : null;
    let lean = null;
    if (edge != null && Math.abs(edge) >= model.lean_edge_pts) {
      const side = edge > 0 ? "home" : "away";
      lean = { side, team: g[side], line: side === "home" ? mk.home_spread : -mk.home_spread, edge_pts: r1(Math.abs(edge)) };
    }
    const named = side => miss[side].missing.map(p => ({ ...p, status: (statusOf(p) || {}).status || "", detail: (statusOf(p) || {}).detail || "" }));
    const game = {
      ...g, model_version: model.model_version,
      leo: {
        home_margin: r1(margin), home_spread: half(-margin), p_home: +p_home.toFixed(3), p_away: +(1 - p_home).toFixed(3),
        rating: { home: r1(r[g.home]), away: r1(r[g.away]), home_court: r1(hca) },
        rest: { home: rest.home.rest, away: rest.away.rest }, back_to_back: { home: rest.home.b2b, away: rest.away.b2b },
        missing: { home: named("home"), away: named("away") }, lost: { home: r1(miss.home.lost), away: r1(miss.away.lost) },
        edge_pts: r1(edge), lean
      }
    };
    out.push(game);
    if (!started) hist.push({
      captured_at: now, date: DATE, game_id: g.game_id, kickoff_utc: g.tip_utc, away: g.away, home: g.home,
      leo_home_margin: margin.toFixed(2), leo_p_home: p_home.toFixed(4),
      mkt_home_spread: mk ? mk.home_spread : "", home_ml: mk ? mk.home_ml ?? "" : "", away_ml: mk ? mk.away_ml ?? "" : "",
      lean_side: lean ? lean.side : "", lean_line: lean ? lean.line : "", edge_pts: edge == null ? "" : edge.toFixed(2),
      home_lost: miss.home.lost.toFixed(2), away_lost: miss.away.lost.toFixed(2),
      home_out: miss.home.missing.filter(p => p.weight >= 1).length, away_out: miss.away.missing.filter(p => p.weight >= 1).length,
      model_version: model.model_version
    });
  }

  const doc = {
    date: DATE, generated_at: now, model_version: model.model_version, injuries_as_of: inj.timestamp,
    data_through: prev.length ? prev[prev.length - 1].date : null, games_rated: prev.length, lean_edge_pts: model.lean_edge_pts,
    games: out.sort((a, b) => a.tip_utc.localeCompare(b.tip_utc))
  };
  fs.writeFileSync(prevFile, JSON.stringify(doc, null, 1) + "\n");
  if (DATE === today()) fs.writeFileSync(path.join(DIR, "picks-today.json"), JSON.stringify(doc, null, 1) + "\n");
  fs.writeFileSync(path.join(DIR, "injuries-today.json"), JSON.stringify({ as_of: inj.timestamp, players: inj.list }, null, 1) + "\n");
  if (hist.length) {
    const exists = fs.existsSync(HISTORY);
    fs.appendFileSync(HISTORY, (exists ? "" : HIST_COLS.join(",") + "\n") + hist.map(h => HIST_COLS.map(c => String(h[c] ?? "").replace(/,/g, " ")).join(",")).join("\n") + "\n");
  }
  // Slate index for the page's date picker.
  const idxFile = path.join(DIR, "slates.json");
  const idx = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, "utf8")) : [];
  const rest_ = idx.filter(d => d.date !== DATE);
  rest_.push({ date: DATE, games: out.length, leans: out.filter(g => g.leo && g.leo.lean).length });
  fs.writeFileSync(idxFile, JSON.stringify(rest_.sort((a, b) => a.date.localeCompare(b.date)), null, 1) + "\n");

  for (const g of doc.games) {
    const L = g.leo, mk = g.market;
    console.log(`  ${g.away}@${g.home}  Leo ${g.home} ${L.home_spread > 0 ? "+" : ""}${L.home_spread} (${(L.p_home * 100).toFixed(0)}%)  DK ${mk && mk.home_spread != null ? mk.home_spread : "-"}  missing ${L.lost.away}/${L.lost.home}${L.lean ? "  LEAN " + L.lean.team + " " + L.lean.line : ""}`);
  }
  console.log(`Data through ${doc.data_through} (${prev.length} games). ${hist.length} pre-tip reads frozen.`);
})().catch(e => { console.error(e); process.exit(1); });
