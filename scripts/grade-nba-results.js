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
 */
const fs = require("fs");
const path = require("path");
const M = require("./lib/nba-model");
const { catchUp } = require("./lib/nfl-catchup");

const DIR = path.join(__dirname, "..", "data", "nba");
const HISTORY = path.join(DIR, "prediction-history.csv");
const LEDGER = path.join(DIR, "results-ledger.csv");
const COLS = ["date", "game_id", "away", "home", "away_score", "home_score", "margin", "leo_home_margin", "leo_p_home", "mkt_home_spread",
  "mkt_p_home", "leo_pick", "winner", "leo_winner_correct", "mkt_winner_correct", "brier_leo", "brier_mkt", "leo_miss", "line_miss",
  "lean_side", "lean_line", "lean_result", "edge_pts", "home_lost", "away_lost", "captured_at", "kickoff_utc", "model_version"];
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
      return { game_id: String(e.id), home: H.team.abbreviation, away: A.team.abbreviation, hs: +H.score, as: +A.score };
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
    return {
      games: list.length,
      winner_leo: list.length ? +avg(list.map(r => +r.leo_winner_correct)).toFixed(3) : null,
      winner_market: withMkt.length ? +avg(withMkt.map(r => +r.mkt_winner_correct)).toFixed(3) : null,
      brier_leo: withMkt.length ? +avg(withMkt.map(r => num(r.brier_leo))).toFixed(4) : null,
      brier_market: withMkt.length ? +avg(withMkt.map(r => num(r.brier_mkt))).toFixed(4) : null,
      miss_leo: withMkt.length ? +avg(withMkt.map(r => num(r.leo_miss))).toFixed(2) : null,
      miss_line: withMkt.length ? +avg(withMkt.map(r => num(r.line_miss))).toFixed(2) : null,
      leans: { ...L, pct: L.won + L.lost ? +(L.won / (L.won + L.lost)).toFixed(3) : null, units_at_110: +((L.won * 100 / 110) - L.lost).toFixed(2) },
      leans_by_edge: [[4, 6], [6, 8], [8, 99]].map(([a, b]) => ({ edge: b === 99 ? `${a}+` : `${a}-${b}`, ...rec(leans.filter(r => Math.abs(+r.edge_pts) >= a && Math.abs(+r.edge_pts) < b)) }))
    };
  };
  const dates = [...new Set(rows.map(r => r.date))].sort();
  const last7 = dates.slice(-7);
  const doc = {
    updated_at: new Date().toISOString(), model_version: M.MODEL_VERSION,
    note: "Leans are a tracked test, not bets. Spread units assume -110. Under 50 graded items is an early read.",
    season: block(rows), last_7_days: block(rows.filter(r => last7.includes(r.date))),
    by_date: dates.map(d => ({ date: d, ...block(rows.filter(r => r.date === d)) })).reverse(),
    games: rows.slice().reverse().map(r => ({
      date: r.date, game_id: r.game_id, away: r.away, home: r.home, away_score: +r.away_score, home_score: +r.home_score,
      leo_home_margin: num(r.leo_home_margin), leo_p_home: num(r.leo_p_home), mkt_home_spread: num(r.mkt_home_spread),
      leo_winner_correct: +r.leo_winner_correct, lean_side: r.lean_side, lean_line: num(r.lean_line), lean_result: r.lean_result, edge_pts: num(r.edge_pts)
    }))
  };
  fs.writeFileSync(path.join(DIR, "results.json"), JSON.stringify(doc, null, 1) + "\n");
  const s = doc.season;
  console.log(`Season: ${s.games} graded. Winner Leo ${s.winner_leo} / market ${s.winner_market}. Brier ${s.brier_leo} / ${s.brier_market}. Leans ${s.leans.won}-${s.leans.lost}-${s.leans.push}.`);
}

(async () => {
  if (process.argv.includes("--summary-only")) return summarize();
  const ledger = readCsv(LEDGER), graded = new Set(ledger.map(r => r.game_id));
  // Read of record: last capture before tip, per game.
  const frozen = new Map();
  for (const r of readCsv(HISTORY)) {
    if (r.date !== DATE || !(r.captured_at < r.kickoff_utc)) continue;
    const prev = frozen.get(r.game_id); if (!prev || r.captured_at > prev.captured_at) frozen.set(r.game_id, r);
  }
  if (!frozen.size) { console.log(`NBA grade ${DATE}: no frozen reads.`); }
  else {
    const fin = await finals(DATE), out = [];
    for (const g of fin) {
      const p = frozen.get(g.game_id); if (!p || graded.has(g.game_id)) continue;
      const margin = g.hs - g.as, m = +p.leo_home_margin, ph = +p.leo_p_home, y = margin > 0 ? 1 : 0;
      const sp = p.mkt_home_spread === "" ? null : +p.mkt_home_spread;
      const mp = p.home_ml !== "" && p.away_ml !== "" ? M.noVig(+p.home_ml, +p.away_ml) : null;
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
        home_lost: p.home_lost, away_lost: p.away_lost, captured_at: p.captured_at, kickoff_utc: p.kickoff_utc, model_version: p.model_version
      });
    }
    if (out.length) {
      const exists = fs.existsSync(LEDGER);
      fs.appendFileSync(LEDGER, (exists ? "" : COLS.join(",") + "\n") + out.map(o => COLS.map(c => String(o[c] ?? "")).join(",")).join("\n") + "\n");
    }
    const waiting = [...frozen.keys()].filter(id => !graded.has(id) && !out.some(o => o.game_id === id)).length;
    console.log(`NBA grade ${DATE}: ${out.length} graded, ${waiting} not final yet.`);
    for (const o of out) console.log(`  ${o.away} ${o.away_score} @ ${o.home} ${o.home_score}  Leo ${o.leo_pick} ${o.leo_winner_correct ? "right" : "wrong"}${o.lean_result ? "  lean " + o.lean_result : ""}`);
  }
  summarize();
  catchUp({ script: __filename, historyFile: HISTORY, ledgerFile: LEDGER, today: nyDate(new Date()), label: "NBA" });
})().catch(e => { console.error(e); process.exit(1); });
