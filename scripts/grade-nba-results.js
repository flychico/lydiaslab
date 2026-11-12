#!/usr/bin/env node
/**
 * Grade Leo NBA reads against final scores.
 *
 *   node scripts/grade-nba-results.js [--date=YYYY-MM-DD]   default: yesterday, New York
 *        --summary-only   rebuild data/nba/results.json from the ledger and stop
 *
 * The read of record for a game is the LAST row in prediction-history.csv
 * captured before tip. Each final is written once to results-ledger.csv;
 * a game that is not final yet is left for the next run. After its own date
 * it re-grades any frozen game from the last 14 days that is still missing
 * (scripts/lib/nfl-catchup.js), so a late final cannot fall out of the window.
 *
 * What gets graded
 *   winner      did the side Leo gave 50%+ win (and the DraftKings favourite)
 *   brier       squared error of the win chance, Leo and the no-vig market
 *   miss        |predicted margin - final margin|, Leo and the spread
 *   lean        when Leo was 4+ points off the spread: Leo's side at the
 *               DraftKings spread, win / loss / push. A test, not a bet.
 *   line move   (NBA-H15) the DraftKings spread at Leo's first read of the
 *               day (open_home_spread) and at the close (close_home_spread,
 *               from the pickcenter in ESPN's game summary; the scoreboard
 *               drops the line once a game is final). close_source says
 *               which: "espn" or, when ESPN has no line, "last_capture" (the
 *               last DraftKings line Leo saved before tip).
 *               lean_clv_pts = points the line moved toward Leo's lean side
 *               from the open to the close (+ = toward Leo).
 *               A benchmark only: the line is never a model input.
 *   box scores  every player's line from ESPN's game summary, saved to
 *               data/nba/boxscores/<date>.json (who played, minutes, stats,
 *               did-not-play reasons) so the audit can check the injury
 *               input the morning after, without waiting a day for the
 *               sportsdataverse release.
 */
const fs = require("fs");
const path = require("path");
const M = require("./lib/nba-model");
const { catchUp } = require("./lib/nfl-catchup");
const S = require("./lib/nba-espn-summary");

const DIR = path.join(__dirname, "..", "data", "nba");
const HISTORY = path.join(DIR, "prediction-history.csv");
const LEDGER = path.join(DIR, "results-ledger.csv");
const COLS = ["date", "game_id", "away", "home", "away_score", "home_score", "margin", "leo_home_margin", "leo_p_home", "mkt_home_spread",
  "mkt_p_home", "leo_pick", "winner", "leo_winner_correct", "mkt_winner_correct", "brier_leo", "brier_mkt", "leo_miss", "line_miss",
  "lean_side", "lean_line", "lean_result", "edge_pts", "home_lost", "away_lost", "captured_at", "kickoff_utc", "model_version",
  "open_home_spread", "close_home_spread", "lean_clv_pts", "close_source",
  "home_ml", "away_ml", "pick_side", "pick_team", "pick_p", "pick_price", "pick_result", "pick_units",
  "lean_price", "lean_units", "price_source", "pick_close_price", "pick_close_source"];
const PK = require("./lib/nba-picks");
/* Leo Pick and lean units from the read of record (DEC-20261102-30). p is that
   prediction-history row (or null when it cannot be found). Prices are the
   DraftKings numbers stored before tip; nothing is looked up after the game. */
function moneyFields(p, margin, leanSide, leanResult) {
  const o = { home_ml: p ? p.home_ml ?? "" : "", away_ml: p ? p.away_ml ?? "" : "", pick_side: "", pick_team: "", pick_p: "", pick_price: "", pick_result: "", pick_units: "",
    lean_price: "", lean_units: "", price_source: "" };
  if (p) {
    const pk = PK.pick({ p_home: p.leo_p_home, home_ml: p.home_ml, away_ml: p.away_ml, home: p.home, away: p.away });
    if (pk && pk.ok) {
      const res = pk.side === "home" ? (margin > 0 ? "win" : "loss") : (margin < 0 ? "win" : "loss");
      Object.assign(o, { pick_side: pk.side, pick_team: pk.team, pick_p: pk.p.toFixed(3), pick_price: pk.price, pick_result: res, pick_units: PK.units(res, pk.price).toFixed(3) });
    }
  }
  if (leanSide && leanResult) {
    const raw = p ? (leanSide === "home" ? p.home_spread_odds : p.away_spread_odds) : "";
    const known = raw !== "" && raw != null && Number.isFinite(+raw) && +raw !== 0, price = known ? +raw : -110;
    Object.assign(o, { lean_price: price, lean_units: PK.units(leanResult, price).toFixed(3), price_source: known ? "dk_at_read" : "assumed" });
  }
  return o;
}
const BOX_DIR = path.join(DIR, "boxscores");
const clvPts = (side, open, close) => side && open !== "" && open != null && close !== "" && close != null
  ? (side === "home" ? +open - +close : +close - +open).toFixed(1) : "";
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const nyDate = d => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const arg = process.argv.find(a => a.startsWith("--date="));
const DATE = arg ? arg.slice(7) : nyDate(new Date(Date.now() - 864e5));

function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const [head, ...lines] = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const h = head.split(",");
  return lines.map(l => { const c = l.split(","); return Object.fromEntries(h.map((k, i) => [k, c[i] ?? ""])); });
}
async function finals(date) {
  if (process.env.NBA_FIXTURES) {
    const f = path.join(process.env.NBA_FIXTURES, `scoreboard_${date.replace(/-/g, "")}.json`);
    return parse(JSON.parse(fs.readFileSync(f, "utf8")));
  }
  const r = await fetch(`${ESPN}/scoreboard?dates=${date.replace(/-/g, "")}`);
  if (!r.ok) throw new Error("ESPN scoreboard HTTP " + r.status);
  return parse(await r.json());
  function parse(j) {
    return (j.events || []).filter(e => e.status && e.status.type && e.status.type.completed).map(e => {
      const c = e.competitions[0], H = c.competitors.find(x => x.homeAway === "home"), A = c.competitors.find(x => x.homeAway === "away");
      const o = (c.odds || []).find(x => /draftkings/i.test(x.provider && x.provider.name || "")) || (c.odds || [])[0];
      const ps = o && o.pointSpread || {}, cl = parseFloat(String(ps.home && ps.home.close && ps.home.close.line != null ? ps.home.close.line : (o && o.spread != null ? o.spread : "")).replace(/^\+/, ""));
      return { game_id: String(e.id), home: H.team.abbreviation, away: A.team.abbreviation, hs: +H.score, as: +A.score, close_home_spread: Number.isFinite(cl) ? cl : null };
    });
  }
}

function summarize() {
  const rows = readCsv(LEDGER);
  const num = v => v === "" || v == null ? null : +v;
  const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  const block = list => {
    const withMkt = list.filter(r => r.mkt_p_home !== "");
    const leans = list.filter(r => r.lean_result);
    const rec = rs => ({ won: rs.filter(r => r.lean_result === "win").length, lost: rs.filter(r => r.lean_result === "loss").length, push: rs.filter(r => r.lean_result === "push").length });
    const L = rec(leans);
    const u = rs => +rs.reduce((t, r) => t + (r.lean_units !== "" && r.lean_units != null ? +r.lean_units : (PK.units(r.lean_result, -110) ?? 0)), 0).toFixed(2);
    const pk = list.filter(r => r.pick_result && r.date >= PK.TRACK_FROM), pw = pk.filter(r => r.pick_result === "win").length;
    const mv = pk.filter(r => r.pick_close_price !== "" && r.pick_close_price != null).map(r => PK.imp(+r.pick_close_price) - PK.imp(+r.pick_price));
    const pu = +pk.reduce((t, r) => t + +r.pick_units, 0).toFixed(2);
    return {
      games: list.length,
      winner_leo: list.length ? +avg(list.map(r => +r.leo_winner_correct)).toFixed(3) : null,
      winner_market: withMkt.length ? +avg(withMkt.map(r => +r.mkt_winner_correct)).toFixed(3) : null,
      brier_leo: withMkt.length ? +avg(withMkt.map(r => num(r.brier_leo))).toFixed(4) : null,
      brier_market: withMkt.length ? +avg(withMkt.map(r => num(r.brier_mkt))).toFixed(4) : null,
      miss_leo: withMkt.length ? +avg(withMkt.map(r => num(r.leo_miss))).toFixed(2) : null,
      miss_line: withMkt.length ? +avg(withMkt.map(r => num(r.line_miss))).toFixed(2) : null,
      leans: { ...L, pct: L.won + L.lost ? +(L.won / (L.won + L.lost)).toFixed(3) : null, units_at_110: +((L.won * 100 / 110) - L.lost).toFixed(2),
        units: u(leans), priced: leans.filter(r => r.price_source === "dk_at_read").length },
      // Leo Picks: 60%+ and priced better than -230, 1 unit at the moneyline stored before tip. Counted from TRACK_FROM.
      picks: { from: PK.TRACK_FROM, n: pk.length, won: pw, lost: pk.length - pw, pct: pk.length ? +(pw / pk.length).toFixed(3) : null, units: pu,
        roi: pk.length ? +(pu / pk.length).toFixed(3) : null,
        avg_price: pk.length ? Math.round(pk.reduce((t, r) => t + +r.pick_price, 0) / pk.length) : null,
        stated: pk.length ? +(pk.reduce((t, r) => t + +r.pick_p, 0) / pk.length).toFixed(3) : null,
        price_moves: { n: mv.length, toward_leo: mv.filter(v => v > 0.004).length, against: mv.filter(v => v < -0.004).length } },
      lean_line_moves: (() => {
        const m = leans.filter(r => r.lean_clv_pts !== "" && r.lean_clv_pts != null).map(r => +r.lean_clv_pts);
        return { n: m.length, toward_leo: m.filter(v => v > 0).length, against: m.filter(v => v < 0).length, unchanged: m.filter(v => v === 0).length,
          avg_pts: m.length ? +avg(m).toFixed(2) : null };
      })(),
      leans_by_edge: [[4, 6], [6, 8], [8, 99]].map(([a, b]) => ({ edge: b === 99 ? `${a}+` : `${a}-${b}`, ...rec(leans.filter(r => Math.abs(+r.edge_pts) >= a && Math.abs(+r.edge_pts) < b)) }))
    };
  };
  const dates = [...new Set(rows.map(r => r.date))].sort();
  const last7 = dates.slice(-7);
  const doc = {
    updated_at: new Date().toISOString(), model_version: M.MODEL_VERSION,
    note: "Leo Picks (60%+ and priced better than -230) are a tracked test, not bets. Leans (4+ pts off the spread) ended after " + PK.LEANS_UNTIL + " and stay on the record. Units: 1 unit each at the DraftKings price stored before tip (leans at -110 where no spread price was stored). Picks are counted from " + PK.TRACK_FROM + "; earlier games are shown as a replay. Under 50 graded items is an early read.",
    season: block(rows), last_7_days: block(rows.filter(r => last7.includes(r.date))),
    by_date: dates.map(d => ({ date: d, ...block(rows.filter(r => r.date === d)) })).reverse(),
    games: rows.slice().reverse().map(r => ({
      date: r.date, game_id: r.game_id, away: r.away, home: r.home, away_score: +r.away_score, home_score: +r.home_score,
      leo_home_margin: num(r.leo_home_margin), leo_p_home: num(r.leo_p_home), mkt_home_spread: num(r.mkt_home_spread), mkt_p_home: num(r.mkt_p_home),
      leo_winner_correct: +r.leo_winner_correct, lean_side: r.lean_side, lean_line: num(r.lean_line), lean_result: r.lean_result, edge_pts: num(r.edge_pts),
      pick_team: r.pick_team || "", pick_p: num(r.pick_p), pick_price: num(r.pick_price), pick_result: r.pick_result || "", pick_units: num(r.pick_units),
      pick_replay: !!r.pick_result && r.date < PK.TRACK_FROM, pick_close_price: num(r.pick_close_price), lean_price: num(r.lean_price), lean_units: num(r.lean_units), price_source: r.price_source || ""
    }))
  };
  fs.writeFileSync(path.join(DIR, "results.json"), JSON.stringify(doc, null, 1) + "\n");
  const s = doc.season;
  console.log(`Season: ${s.games} graded. Winner Leo ${s.winner_leo} / market ${s.winner_market}. Brier ${s.brier_leo} / ${s.brier_market}. Leans ${s.leans.won}-${s.leans.lost}-${s.leans.push} (${s.leans.units}u). Picks ${s.picks.won}-${s.picks.lost} (${s.picks.units}u) since ${s.picks.from}.`);
}

function writeBox(date, games) {
  fs.mkdirSync(BOX_DIR, { recursive: true });
  const f = path.join(BOX_DIR, `${date}.json`);
  const prev = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).games : [];
  const byId = new Map(prev.map(x => [x.game_id, x])); for (const x of games) byId.set(x.game_id, x);
  fs.writeFileSync(f, JSON.stringify({ date, source: "ESPN game summary", saved_at: new Date().toISOString(), games: [...byId.values()] }) + "\n");
  console.log(`  box scores: ${byId.size} games saved to data/nba/boxscores/${date}.json`);
}

/* Ledger rows graded before the summary source existed (or when ESPN had no
   line yet) get their close, close_source, lean_clv_pts and box score filled
   in later. Only blank fields are written; nothing graded is changed. */
async function backfill() {
  if (!fs.existsSync(LEDGER)) return;
  const text = fs.readFileSync(LEDGER, "utf8").split(/\r?\n/).filter(Boolean);
  const head = text[0].split(","), rows = readCsv(LEDGER);
  if (!head.includes("close_source")) return;      // header rewritten below on first run
  const lastLine = new Map();
  for (const r of readCsv(HISTORY)) if (r.mkt_home_spread !== "" && r.captured_at < r.kickoff_utc) {
    const l = lastLine.get(r.game_id); if (!l || r.captured_at > l.captured_at) lastLine.set(r.game_id, r); }
  const cutoff = nyDate(new Date(Date.now() - 14 * 864e5)), byDate = {};
  let changed = 0;
  for (const r of rows) {
    if (r.date < cutoff) continue;
    const needClose = r.close_home_spread === "" || r.close_source === "last_capture";
    const needBox = !fs.existsSync(path.join(BOX_DIR, `${r.date}.json`)) ||
      !JSON.parse(fs.readFileSync(path.join(BOX_DIR, `${r.date}.json`), "utf8")).games.some(x => x.game_id === r.game_id);
    if (!needClose && !needBox) continue;
    let sm = null;
    try { sm = await S.fetchSummary(r.game_id); } catch (e) { console.log(`  backfill ${r.game_id}: ${e.message}`); }
    const c = sm ? S.closeSpread(sm) : null;
    if (needClose) {
      const before = [r.close_home_spread, r.close_source, r.lean_clv_pts].join("|");
      if (c && c.home_spread != null) { r.close_home_spread = String(c.home_spread); r.close_source = "espn"; }
      else if (r.close_home_spread === "" && lastLine.has(r.game_id)) { r.close_home_spread = lastLine.get(r.game_id).mkt_home_spread; r.close_source = "last_capture"; }
      r.lean_clv_pts = clvPts(r.lean_side, r.open_home_spread, r.close_home_spread);
      if ([r.close_home_spread, r.close_source, r.lean_clv_pts].join("|") !== before) changed++;
    }
    const players = sm ? S.boxScore(sm) : [];
    if (needBox && players.length) (byDate[r.date] = byDate[r.date] || []).push({ game_id: r.game_id, away: r.away, home: r.home, away_score: +r.away_score, home_score: +r.home_score, players });
  }
  for (const [d, g] of Object.entries(byDate)) writeBox(d, g);
  if (changed) {
    fs.writeFileSync(LEDGER, COLS.join(",") + "\n" + rows.map(o => COLS.map(c => String(o[c] ?? "")).join(",")).join("\n") + "\n");
    console.log(`  backfill: closing line filled on ${changed} graded games`);
  }
}

/* New ledger columns are added once; old rows keep every value and get the new fields filled. */
function upgradeLedger() {
  if (!fs.existsSync(LEDGER)) return;
  const lines = fs.readFileSync(LEDGER, "utf8").split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(",");
  if (COLS.every(c => head.includes(c))) return;
  // Rows graded before a column existed: fill picks and units from the same read of record (captured_at).
  const hist = new Map(readCsv(HISTORY).map(h => [h.game_id + "|" + h.captured_at, h]));
  const rows = readCsv(LEDGER).map(o => o.pick_result !== undefined && o.pick_result !== "" ? o
    : { ...o, ...moneyFields(hist.get(o.game_id + "|" + o.captured_at) || null, +o.margin, o.lean_side, o.lean_result) });
  fs.writeFileSync(LEDGER, COLS.join(",") + "\n" + rows.map(o => COLS.map(c => String(o[c] ?? "")).join(",")).join("\n") + "\n");
  console.log("  ledger: new columns added (" + COLS.filter(c => !head.includes(c)).join(", ") + ")");
}

(async () => {
  upgradeLedger();
  if (process.argv.includes("--summary-only")) return summarize();
  const ledger = readCsv(LEDGER), graded = new Set(ledger.map(r => r.game_id));
  // Read of record: last capture before tip, per game.
  const frozen = new Map(), opening = new Map(), lastLine = new Map();
  for (const r of readCsv(HISTORY)) {
    if (r.date !== DATE || !(r.captured_at < r.kickoff_utc)) continue;
    if (r.mkt_home_spread !== "") {
      const o = opening.get(r.game_id); if (!o || r.captured_at < o.captured_at) opening.set(r.game_id, r);
      const l = lastLine.get(r.game_id); if (!l || r.captured_at > l.captured_at) lastLine.set(r.game_id, r);
    }
    const prev = frozen.get(r.game_id); if (!prev || r.captured_at > prev.captured_at) frozen.set(r.game_id, r);
  }
  if (!frozen.size) { console.log(`NBA grade ${DATE}: no frozen reads.`); }
  else {
    const fin = await finals(DATE), out = [], box = [];
    for (const g of fin) {
      const p = frozen.get(g.game_id); if (!p || graded.has(g.game_id)) continue;
      const margin = g.hs - g.as, m = +p.leo_home_margin, ph = +p.leo_p_home, y = margin > 0 ? 1 : 0;
      const sp = p.mkt_home_spread === "" ? null : +p.mkt_home_spread;
      const mp = p.home_ml !== "" && p.away_ml !== "" ? M.noVig(+p.home_ml, +p.away_ml) : null;
      // Closing line and box score from ESPN's game summary (never an input).
      let close = null, players = [];
      try { const sm = await S.fetchSummary(g.game_id); close = S.closeSpread(sm); players = S.boxScore(sm); }
      catch (e) { console.log(`  ${g.away}@${g.home}: no ESPN summary (${e.message})`); }
      if (players.length) box.push({ game_id: g.game_id, away: g.away, home: g.home, away_score: g.as, home_score: g.hs, players });
      const closeSp = close && close.home_spread != null ? close.home_spread
        : lastLine.has(g.game_id) ? +lastLine.get(g.game_id).mkt_home_spread : null;
      const closeSrc = close && close.home_spread != null ? "espn" : closeSp != null ? "last_capture" : "";
      const openSp = opening.has(g.game_id) ? opening.get(g.game_id).mkt_home_spread : "";
      let lean = "";
      if (p.lean_side && sp != null) {
        const cover = margin + sp;   // >0 home covered
        const res = p.lean_side === "home" ? cover : -cover;
        lean = res > 0 ? "win" : res < 0 ? "loss" : "push";
      }
      out.push({
        date: DATE, game_id: g.game_id, away: g.away, home: g.home, away_score: g.as, home_score: g.hs, margin,
        leo_home_margin: m.toFixed(2), leo_p_home: ph.toFixed(4), mkt_home_spread: sp ?? "", mkt_p_home: mp == null ? "" : mp.toFixed(4),
        leo_pick: ph >= 0.5 ? g.home : g.away, winner: y ? g.home : g.away,
        leo_winner_correct: +((ph >= 0.5) === !!y), mkt_winner_correct: mp == null ? "" : +((mp >= 0.5) === !!y),
        brier_leo: ((ph - y) ** 2).toFixed(4), brier_mkt: mp == null ? "" : ((mp - y) ** 2).toFixed(4),
        leo_miss: Math.abs(m - margin).toFixed(2), line_miss: sp == null ? "" : Math.abs(-sp - margin).toFixed(2),
        lean_side: p.lean_side, lean_line: p.lean_line, lean_result: lean, edge_pts: p.edge_pts,
        home_lost: p.home_lost, away_lost: p.away_lost, captured_at: p.captured_at, kickoff_utc: p.kickoff_utc, model_version: p.model_version,
        open_home_spread: openSp, close_home_spread: closeSp ?? "", close_source: closeSrc,
        lean_clv_pts: clvPts(p.lean_side, openSp, closeSp),
        ...moneyFields(p, margin, p.lean_side, lean)
      });
      // Price on the pick at the close (ESPN summary; else Leo's last capture): a benchmark, never an input.
      { const o = out[out.length - 1];
        if (o.pick_side) {
          const espnMl = close ? (o.pick_side === "home" ? close.home_ml : close.away_ml) : null;
          const lc = lastLine.get(g.game_id), capMl = lc ? (o.pick_side === "home" ? lc.home_ml : lc.away_ml) : "";
          o.pick_close_price = espnMl != null ? espnMl : capMl !== "" && capMl != null ? +capMl : "";
          o.pick_close_source = espnMl != null ? "espn" : o.pick_close_price !== "" ? "last_capture" : "";
        } }
    }
    if (box.length) writeBox(DATE, box);
    if (out.length) {
      const exists = fs.existsSync(LEDGER);
      fs.appendFileSync(LEDGER, (exists ? "" : COLS.join(",") + "\n") + out.map(o => COLS.map(c => String(o[c] ?? "")).join(",")).join("\n") + "\n");
    }
    const waiting = [...frozen.keys()].filter(id => !graded.has(id) && !out.some(o => o.game_id === id)).length;
    console.log(`NBA grade ${DATE}: ${out.length} graded, ${waiting} not final yet.`);
    for (const o of out) console.log(`  ${o.away} ${o.away_score} @ ${o.home} ${o.home_score}  Leo ${o.leo_pick} ${o.leo_winner_correct ? "right" : "wrong"}${o.lean_result ? "  lean " + o.lean_result : ""}`);
  }
  await backfill();
  summarize();
  catchUp({ script: __filename, historyFile: HISTORY, ledgerFile: LEDGER, today: nyDate(new Date()), label: "NBA" });
})().catch(e => { console.error(e); process.exit(1); });
