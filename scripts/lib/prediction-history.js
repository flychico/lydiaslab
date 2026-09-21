/*
  Leo — append-only NFL prediction history.

  THE BUG THIS EXISTS TO PREVENT
  ------------------------------
  generate-nfl-model.js rebuilds team ratings from every COMPLETED game, then
  projects the slate. prepare-slate runs several times a day, and each run
  rewrites picks-{date}.json in place. On 2026-09-20 that file was rewritten
  four times AFTER the 1:02pm kickoffs -- so by Monday it held "predictions"
  computed from ratings that already contained Sunday's results.

  Every one of the 14 games was affected. Pre-kickoff Leo had ATL at 69.1%;
  the file graded on Monday said 34.8%, because ATL had lost in between. The
  first graded day came out 10-3 / 8-5 / 10-3. Against the genuine pre-kickoff
  file it was 6-7 / 6-7 / 6-7.

  A model that grades itself on numbers it revised after the whistle is not
  being measured at all. So predictions are frozen here, append-only, with the
  time they were made and the kickoff they precede.

      the prediction of record = the last row captured BEFORE kickoff

  Identical in shape and reasoning to lib/odds-history.js, which solved the
  same problem for market lines. Two different files, one lesson: anything
  rewritten in place cannot be graded honestly.
*/
const fs = require("fs");
const path = require("path");
const { appendObservations, splitCsv } = require("./odds-history");

const COLS = [
  "captured_at","date","game_id","matchup","away","home","week","kickoff_utc",
  "model_version","pick","model_prob","raw_model_prob","market_prob","price","edge",
  "value_side","proj_total","total_line","total_side","proj_spread","spread_line",
  "spread_side","exp_margin"
];

// The values whose change constitutes a new prediction. Anything derived from
// these (edge, value_side) is along for the ride.
const VALUES = ["pick","model_prob","raw_model_prob","proj_total","proj_spread","market_prob","price"];

/*
  gameday + a "HH:MM" Eastern gametime -> a real UTC instant.

  Built by asking what the candidate UTC instant looks like in New York and
  correcting the difference, so it lands right on both sides of the November
  DST change without hardcoding an offset (NFL_WATCH_LIST #5 is the same
  hazard in the cron schedules).
*/
function kickoffUtc(dateStr, hhmm) {
  if (!dateStr || !hhmm) return "";
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return "";
  const [h, mi] = [Number(m[1]), Number(m[2])];
  let guess = Date.parse(`${dateStr}T${String(h).padStart(2,"0")}:${m[2]}:00Z`);
  if (!Number.isFinite(guess)) return "";
  for (let i = 0; i < 3; i++) {
    const asET = new Date(guess).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
    const p = asET.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*(\d{1,2}):(\d{2})/);
    if (!p) break;
    const etH = Number(p[4]) % 24, etM = Number(p[5]);
    const driftMin = (h * 60 + mi) - (etH * 60 + etM);
    if (driftMin === 0) break;
    guess += driftMin * 60000;
  }
  return new Date(guess).toISOString();
}

function record(dir, picks) {
  if (!Array.isArray(picks) || !picks.length) return { appended: 0, unchanged: 0 };
  const capturedAt = new Date().toISOString();
  const rows = picks.map(g => ({
    captured_at: capturedAt, date: g.date, game_id: g.game_id, matchup: g.matchup,
    away: g.away, home: g.home, week: g.week,
    kickoff_utc: kickoffUtc(g.date, g.kickoff),
    model_version: g.model_version, pick: g.pick,
    model_prob: g.model_prob ?? "", raw_model_prob: g.raw_model_prob ?? "",
    market_prob: g.market_prob ?? "", price: g.price ?? "", edge: g.edge ?? "",
    value_side: g.value_side ?? "",
    proj_total: g.proj_total ?? "", total_line: g.total_line ?? "", total_side: g.total_side ?? "",
    proj_spread: g.proj_spread ?? "", spread_line: g.spread_line ?? "", spread_side: g.spread_side ?? "",
    exp_margin: g.exp_margin ?? ""
  }));
  return appendObservations(path.join(dir, "prediction-history.csv"), COLS, rows,
                            ["date","game_id"], VALUES);
}

/*
  The prediction of record for each game on `date`: the last one captured
  strictly before that game's kickoff. Returns [] when nothing qualifies,
  which is the correct answer for a slate that has not been predicted yet.
*/
function frozenPredictions(file, date) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = splitCsv(lines[0]);
  const idx = {}; header.forEach((h, i) => idx[h] = i);

  const best = new Map();
  let afterKick = 0;
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsv(lines[i]);
    const row = {}; header.forEach((h, j) => row[h] = c[j]);
    if (date && row.date !== date) continue;
    const cap = Date.parse(row.captured_at), kick = Date.parse(row.kickoff_utc);
    if (!Number.isFinite(kick) || !Number.isFinite(cap)) continue;
    if (!(cap < kick)) { afterKick++; continue; }   // revised after the whistle
    const prev = best.get(row.game_id);
    if (!prev || cap > prev._cap) { row._cap = cap; best.set(row.game_id, row); }
  }

  const num = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
  const out = [...best.values()].map(r => ({
    date: r.date, game_id: r.game_id, matchup: r.matchup, away: r.away, home: r.home,
    week: r.week, model_version: r.model_version,
    captured_at: r.captured_at, kickoff_utc: r.kickoff_utc,
    minutes_before_kickoff: Math.round((Date.parse(r.kickoff_utc) - r._cap) / 60000),
    pick: r.pick, model_prob: num(r.model_prob), raw_model_prob: num(r.raw_model_prob),
    market_prob: num(r.market_prob), price: num(r.price), edge: num(r.edge),
    value_side: r.value_side || null,
    proj_total: num(r.proj_total), total_line: num(r.total_line), total_side: r.total_side || null,
    proj_spread: num(r.proj_spread), spread_line: num(r.spread_line), spread_side: r.spread_side || null,
    exp_margin: num(r.exp_margin),
    status: "frozen", total_status: "frozen", spread_status: "frozen"
  }));
  out._skippedAfterKickoff = afterKick;
  return out;
}

/*
  PROP PREDICTIONS — same freeze, same reason.

  generate-nfl-props.js rebuilds every projection from weekly player stats,
  and a rerun after kickoff has that week's stats in hand. On 2026-09-20, 198
  of 290 projections were rewritten post-kickoff; Tyler Shough's passing
  projection moved from 297 to 269 once the model could see he threw for 252,
  turning a 45-yard miss into an apparent 17-yard one.

  The FACTORS are frozen alongside the projection -- rate_used,
  expected_volume, opp_adjustment, games_played. Those are the inputs the
  learning system attributes error to, so a revised factor is exactly as
  corrupting as a revised projection, and harder to notice.
*/
const PROP_COLS = [
  "captured_at","date","game_id","matchup","kickoff_utc","team","opponent",
  "player","position","depth","market","model_version","projection",
  "rate_used","expected_volume","opp_adjustment","games_played"
];
const PROP_VALUES = ["projection","rate_used","expected_volume","opp_adjustment","games_played"];

function recordProps(dir, props, kickoffByMatchup) {
  if (!Array.isArray(props) || !props.length) return { appended: 0, unchanged: 0 };
  const capturedAt = new Date().toISOString();
  const rows = props.map(p => ({
    captured_at: capturedAt, date: p.date, game_id: p.game_id, matchup: p.matchup,
    kickoff_utc: (kickoffByMatchup && kickoffByMatchup[p.matchup]) || "",
    team: p.team, opponent: p.opponent, player: p.player,
    position: p.position, depth: p.depth || "", market: p.market,
    model_version: p.model_version, projection: p.projection,
    rate_used: p.rate_used ?? "", expected_volume: p.expected_volume ?? "",
    opp_adjustment: p.opp_adjustment ?? "", games_played: p.games_played ?? ""
  }));
  return appendObservations(path.join(dir, "prop-prediction-history.csv"), PROP_COLS, rows,
                            ["date","matchup","market","player"], PROP_VALUES);
}

function frozenProps(file, date) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = splitCsv(lines[0]);
  const best = new Map();
  let afterKick = 0, noKick = 0;
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsv(lines[i]);
    const row = {}; header.forEach((h, j) => row[h] = c[j]);
    if (date && row.date !== date) continue;
    const cap = Date.parse(row.captured_at), kick = Date.parse(row.kickoff_utc);
    if (!Number.isFinite(kick)) { noKick++; continue; }
    if (!(cap < kick)) { afterKick++; continue; }
    const k = `${row.matchup}\u0001${row.market}\u0001${row.player}`;
    const prev = best.get(k);
    if (!prev || cap > prev._cap) { row._cap = cap; best.set(k, row); }
  }
  const num = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
  const out = [...best.values()].map(r => ({
    date: r.date, game_id: r.game_id, matchup: r.matchup,
    team: r.team, opponent: r.opponent, player: r.player,
    position: r.position, depth: r.depth || null, market: r.market,
    model_version: r.model_version, projection: num(r.projection),
    rate_used: num(r.rate_used), expected_volume: num(r.expected_volume),
    opp_adjustment: num(r.opp_adjustment), games_played: num(r.games_played),
    captured_at: r.captured_at, kickoff_utc: r.kickoff_utc,
    minutes_before_kickoff: Math.round((Date.parse(r.kickoff_utc) - r._cap) / 60000)
  }));
  out._skippedAfterKickoff = afterKick;
  out._skippedNoKickoff = noKick;
  return out;
}

module.exports = { record, frozenPredictions, recordProps, frozenProps, kickoffUtc, COLS, PROP_COLS };
