/*
  Leo — NFL head-to-head tracker feed.

  Rolls the two graded ledgers into one feed for /nfl/results/, which is not a
  list of final scores but a running scoreboard of LEO vs THE SPORTSBOOK.

  The unit is a single decision, in the form the question is actually asked:

      Bryce Young   line 221.5   Leo 273   -> OVER   actual 287   RIGHT

  ACCUMULATES. This reads the WHOLE ledger, every graded date, not just the
  latest slate. A tracker that resets weekly cannot answer the only question
  that matters, which is whether the edge holds up over a season.

  ONLY DECISIONS APPEAR. A projection with no posted line is not a call against
  the book and is excluded, as is any row where the market posted one side only
  (anytime TD, where a vig-inclusive price would fake a lean). Excluded rows are
  counted and reported, never silently dropped.

  USAGE
    node scripts/generate-nfl-tracker.js
*/
const fs = require("fs");
const path = require("path");
const { splitCsv } = require("./lib/odds-history");

const DIR = path.join(__dirname, "..", "data", "nfl");
const PROPS  = path.join(DIR, "nfl-props-graded.csv");
const GAMES  = path.join(DIR, "nfl-results-log.csv");
const OUT    = path.join(DIR, "tracker.json");

// Which market belongs to which position group on the page.
const GROUP = { QB_PASS_YARDS: "QB", RB_RUSH_YARDS: "RB", WR_REC_YARDS: "WR" };
const UNIT  = { QB_PASS_YARDS: "pass yds", RB_RUSH_YARDS: "rush yds", WR_REC_YARDS: "rec yds" };

const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const r2 = x => x == null ? null : Math.round(x * 100) / 100;

function readCsv(f) {
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const head = splitCsv(lines[0]);
  return lines.slice(1).map(l => {
    const c = splitCsv(l); const o = {};
    head.forEach((h, i) => o[h] = c[i]);
    return o;
  });
}

// American price from a probability, for display only where the book's own
// posted price was not recorded.
const toAmerican = p => {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  return p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
};

function blank() { return { w: 0, l: 0, p: 0, beat: 0, cmp: 0, err: 0, lerr: 0, n: 0 }; }
function tally(s, row) {
  if (row.result === "W") s.w++; else if (row.result === "L") s.l++; else if (row.result === "P") s.p++;
  if (row.beat) { s.cmp++; if (row.beat === "Y") s.beat++; }
  if (row.err != null)  { s.err += row.err; s.n++; }
  if (row.lerr != null) { s.lerr += row.lerr; }
  return s;
}
function finish(s) {
  const dec = s.w + s.l;
  return {
    w: s.w, l: s.l, p: s.p, decided: dec,
    win_pct: dec ? r2(100 * s.w / dec) : null,
    beat: s.beat, compared: s.cmp,
    beat_pct: s.cmp ? r2(100 * s.beat / s.cmp) : null,
    mae: s.n ? r2(s.err / s.n) : null,
    line_mae: s.n ? r2(s.lerr / s.n) : null
  };
}

/*
  Final scores are not in either ledger -- they live in the per-slate
  results-<date>.json the grader writes. The tracker groups by game, so a row
  without its score reads as an unfinished thought.
*/
function scoreIndex() {
  const idx = {};
  for (const f of fs.readdirSync(DIR)) {
    const m = /^results-(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
    if (!m) continue;
    let rows; try { rows = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch (e) { continue; }
    for (const g of Array.isArray(rows) ? rows : []) {
      if (g.away_score == null || g.home_score == null) continue;
      // Keyed by week, not date: a game whose only calls are props (no graded
      // moneyline) still needs its score, and Monday games are graded a day late.
      if (g.week != null) idx[`${g.week}|${g.matchup}`] = { away: g.away_score, home: g.home_score };
    }
  }
  return idx;
}

function main() {
  const scores = scoreIndex();
  const propRows = readCsv(PROPS);
  const gameRows = readCsv(GAMES);
  if (!propRows.length && !gameRows.length) {
    console.log("No graded ledgers yet — nothing to build.");
    return;
  }

  // ---- player props ------------------------------------------------------
  const props = [];
  let noLine = 0, noLean = 0, excluded = 0;

  for (const r of propRows) {
    if (r.excluded === "Y") { excluded++; continue; }
    const group = GROUP[r.market];
    if (!group) { noLean++; continue; }                 // anytime TD etc.
    const line = n(r.line), actual = n(r.actual), proj = n(r.projection);
    if (line == null || actual == null || proj == null) { noLine++; continue; }
    if (!r.lean || !r.result) { noLean++; continue; }   // no call was made

    props.push({
      date: r.date, week: r.week, matchup: r.matchup,
      team: r.team, opponent: r.opponent,
      player: r.player, group, depth: r.depth || "",
      unit: UNIT[r.market] || "",
      line, leo: proj, lean: r.lean, actual,
      result: r.result,
      err: n(r.abs_error), lerr: n(r.line_abs_error),
      beat: r.beat_line || "",
      margin: r2(actual - line)      // how far past the line it landed
    });
  }
  /*
    DEDUPE. A game graded twice (the Monday nighter is graded on the Monday
    and again on the Tuesday sweep) appends a second row per player, and the
    page then showed every call twice. Last grade for a player+market+week
    wins; the ledger stays append-only.
  */
  {
    const seen=new Map();
    for(const p of props) {
      const k=`${p.week}|${p.matchup}|${p.player}|${p.group}`;
      const prev=seen.get(k);
      // Latest grade wins, but keep the EARLIEST date: a re-grade the next
      // day must not make the game look like it was played then.
      if(prev && prev.date < p.date) p.date=prev.date;
      seen.set(k, p);
    }
    props.length=0; props.push(...seen.values());
  }

  // Newest first, then biggest call first within a day.
  props.sort((a, b) => b.date.localeCompare(a.date) ||
                       a.group.localeCompare(b.group) ||
                       Math.abs(b.leo - b.line) - Math.abs(a.leo - a.line));

  // ---- moneyline ---------------------------------------------------------
  const games = [];
  for (const r of gameRows) {
    if (r.market !== "moneyline") continue;
    const prob = n(r.leo_value), mprob = n(r.market_value);
    if (prob == null || !r.result) continue;
    const posted = n(r.market_price);
    games.push({
      date: r.date, week: r.week, matchup: r.matchup,
      away: r.away, home: r.home,
      pick: r.leo_side,
      leo_prob: prob, market_prob: mprob,
      price: posted != null ? posted : toAmerican(mprob),
      price_is_implied: posted == null,
      edge: n(r.edge),
      winner: r.actual_value, result: r.result,
      beat: r.beat_market || "", brier: n(r.brier),
      score: scores[`${r.week}|${r.matchup}`] || null
    });
  }
  {
    const seen=new Map();
    for(const g of games) {
      const k=`${g.week}|${g.matchup}`, prev=seen.get(k);
      if(prev && prev.date < g.date) g.date=prev.date;
      seen.set(k, g);
    }
    games.length=0; games.push(...seen.values());
  }
  games.sort((a, b) => b.date.localeCompare(a.date) || a.matchup.localeCompare(b.matchup));

  // ---- running records ---------------------------------------------------
  const byGroup = {};
  for (const g of ["QB", "RB", "WR"]) byGroup[g] = blank();
  const all = blank();
  for (const p of props) { tally(byGroup[p.group], p); tally(all, p); }

  const ml = blank();
  for (const g of games) tally(ml, { result: g.result, beat: g.beat, err: null, lerr: null });

  const dates = [...new Set([...props.map(p => p.date), ...games.map(g => g.date)])].sort();
  const weeks = [...new Set([...props.map(p => p.week), ...games.map(g => g.week)])]
                  .filter(Boolean).sort((a, b) => Number(a) - Number(b));

  const payload = {
    generated_at: new Date().toISOString(),
    first_graded: dates[0] || null,
    through: dates[dates.length - 1] || null,
    slates: dates.length,
    weeks,
    summary: {
      props: { all: finish(all), QB: finish(byGroup.QB), RB: finish(byGroup.RB), WR: finish(byGroup.WR) },
      moneyline: finish(ml)
    },
    counts: { prop_calls: props.length, games: games.length, excluded, no_line: noLine, no_call: noLean },
    // Final scores by "<week>|<matchup>", so a game whose only calls are props
    // still shows how it finished.
    scores,
    props, games
  };

  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));

  console.log(`\nNFL TRACKER FEED\n${"=".repeat(58)}`);
  console.log(`  through ${payload.through}  ·  ${dates.length} slate(s)  ·  week(s) ${weeks.join(", ")}`);
  console.log(`  ${"-".repeat(52)}`);
  const line = (label, s) => console.log(
    `  ${label.padEnd(12)} ${String(s.w + "-" + s.l).padEnd(8)}` +
    (s.win_pct != null ? `${String(s.win_pct + "%").padEnd(7)}` : "".padEnd(7)) +
    (s.beat_pct != null ? `beat line ${s.beat}/${s.compared} (${s.beat_pct}%)` : ""));
  line("QB", payload.summary.props.QB);
  line("RB", payload.summary.props.RB);
  line("WR", payload.summary.props.WR);
  line("ALL PROPS", payload.summary.props.all);
  line("MONEYLINE", payload.summary.moneyline);
  console.log(`  ${"-".repeat(52)}`);
  console.log(`  ${props.length} prop calls, ${games.length} games`);
  console.log(`  not a call: ${noLean} (no lean or no line comparison) · ${excluded} excluded · ${noLine} missing a number`);
  console.log(`  wrote ${path.basename(OUT)}`);
  console.log("=".repeat(58) + "\n");
}

main();
