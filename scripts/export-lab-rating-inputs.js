#!/usr/bin/env node
/*
  LyDia — daily Lab Rating raw-inputs export.

  Writes data/calibration/lab_rating_inputs_log.csv: every RAW input
  scripts/lib/lab-rating-core.js's calcLabRating() reads (NOT the pre-computed
  point values -- those are already in lab_score_breakdown inside the brief;
  this captures the inputs one level upstream of that, same "raw material"
  spirit as export-pitcher-data.js), for every game with a resolved pick in
  today's member brief, captured same-day, before the recap.

  Columns map 1:1 onto calcLabRating()'s parameter list:
    model_prob                 -> modelProb (conviction)
    strength_prob_pick         -> strengthProbPick (agreement diagnostic, 0pt)
    run_prob_pick               -> runProbPick (agreement diagnostic, 0pt)
    pick_pitcher_score          -> pickPitcherScore (pitching-plan support,
                                   individualized -- see 2026-08-26 in
                                   lab-rating-core.js)
    pick_bullpen_risk/opp_...  -> bullpen.pick_team/opponent .risk_index??.score
    assigned_bullpen_innings   -> pick side's pitching_plan bullpen_innings
    pick_woba_15d/30d, opp_... -> offense_form pick-relative wOBA windows

  2026-08-26: pitch_gap/pitch_edge_supports no longer feed calcLabRating (the
  pitching-plan component reads pick_pitcher_score directly now) -- kept as
  trailing diagnostic-only columns since they're still real, useful context
  (and still drive the pitcher-conflict gate elsewhere), just not a Lab
  Rating input anymore. Historical rows logged before this date have no
  pick_pitcher_score value (blank) -- not backfilled, same "no guess on
  missing history" convention used throughout this pipeline.

  Upsert by (date, gamePk), same pattern as export-pregame-attribution.js and
  export-pitcher-data.js -- later publish waves overwrite this run's rows.

  Usage: node scripts/export-lab-rating-inputs.js [YYYY-MM-DD]
*/
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATE = (process.argv[2] || "").match(/^\d{4}-\d{2}-\d{2}$/)
  ? process.argv[2]
  : new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

function normDate(s) {
  s = String(s || "");
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return s;
}
function csvField(s) {
  s = String(s == null ? "" : s);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function n2(v) { return v === null || v === undefined ? "" : v; }
function r4(v) { return (typeof v === "number" && isFinite(v)) ? Number(v.toFixed(4)) : null; }

const COLUMNS = [
  "date", "gamePk", "matchup", "pick_team", "opp_team", "status", "result",
  "lab_score_published", "model_prob", "strength_prob_pick", "run_prob_pick",
  "pick_pitcher_score",
  "pick_bullpen_risk", "opp_bullpen_risk", "assigned_bullpen_innings",
  "pick_woba_15d", "opp_woba_15d", "pick_woba_30d", "opp_woba_30d",
  "pitch_gap", "pitch_edge_supports"
];
const HEADER = COLUMNS.join(",") + "\n";

function main() {
  const briefPath = path.join(ROOT, "data", "member-brief", `${DATE}.json`);
  if (!fs.existsSync(briefPath)) {
    console.log(`Lab Rating inputs export: no member brief for ${DATE} at ${briefPath} -- nothing to export.`);
    return;
  }
  let brief;
  try {
    brief = JSON.parse(fs.readFileSync(briefPath, "utf8"));
  } catch (e) {
    console.warn(`Lab Rating inputs export: could not parse ${briefPath} -- ${e.message}`);
    return;
  }
  const games = Array.isArray(brief.games) ? brief.games : Array.isArray(brief) ? brief : [];
  if (!games.length) {
    console.log(`Lab Rating inputs export: member brief for ${DATE} has no games -- nothing to export.`);
    return;
  }

  const rows = [];
  for (const g of games) {
    if (!g.side) continue; // no pick side resolved yet
    const pickHome = g.side === "home";
    const oppTeam = pickHome ? g.away_team : g.home_team;

    // Pitching-plan support inputs. pick_pitcher_score is the real Lab
    // Rating input as of 2026-08-26 (individualized, no opponent reference).
    // pitch_gap/pitch_edge_supports are recomputed below too, but only as
    // trailing diagnostic columns now -- see the 2026-08-26 header note.
    const scoreAway = g.model_pitcher_score_away;
    const scoreHome = g.model_pitcher_score_home;
    const pickPitcherScore = pickHome
      ? (typeof scoreHome === "number" ? scoreHome : null)
      : (typeof scoreAway === "number" ? scoreAway : null);
    const pitchGap = (typeof scoreAway === "number" && typeof scoreHome === "number")
      ? Math.abs(scoreHome - scoreAway) : null;
    const pitchEdgeTeam = pitchGap !== null && pitchGap < 4
      ? "No clear SP edge"
      : (typeof scoreAway === "number" && typeof scoreHome === "number" && scoreHome > scoreAway ? g.home_team : g.away_team);
    const pitchEdgeSupports = pitchEdgeTeam === g.pick_team;

    // Bullpen support inputs -- already pick-relative in the brief.
    const bp = g.bullpen || {};
    const pickRiskRaw = bp.pick_team ? (bp.pick_team.risk_index ?? bp.pick_team.score) : null;
    const oppRiskRaw = bp.opponent ? (bp.opponent.risk_index ?? bp.opponent.score) : null;
    const pickPlan = g.pitching_plan ? (pickHome ? g.pitching_plan.home : g.pitching_plan.away) : null;
    const assignedBullpenInnings = pickPlan && typeof pickPlan.bullpen_innings === "number" ? pickPlan.bullpen_innings : null;

    // Offense support inputs -- home/away in the brief, converted pick-relative.
    const of_ = g.offense_form || {};
    const pOff = pickHome ? of_.home : of_.away;
    const oOff = pickHome ? of_.away : of_.home;

    // Conviction / agreement diagnostic inputs.
    const modelProb = typeof g.model_probability === "number" ? g.model_probability : null;
    const strengthProbPick = typeof g.legacy_strength_probability === "number" ? g.legacy_strength_probability : null;
    const runProbPickRaw = typeof g.run_model_probability === "number" ? g.run_model_probability : null;
    const runProbPick = runProbPickRaw === null ? null : (pickHome ? runProbPickRaw : 1 - runProbPickRaw);

    rows.push([
      DATE, g.game_pk, csvField(g.game), csvField(g.pick_team), csvField(oppTeam), g.status || "", "",
      n2(g.lab_score), n2(r4(modelProb)), n2(r4(strengthProbPick)), n2(r4(runProbPick)),
      n2(pickPitcherScore),
      n2(pickRiskRaw), n2(oppRiskRaw), n2(assignedBullpenInnings),
      n2(pOff ? r4(pOff.woba_15d) : null), n2(oOff ? r4(oOff.woba_15d) : null),
      n2(pOff ? r4(pOff.woba_30d) : null), n2(oOff ? r4(oOff.woba_30d) : null),
      n2(pitchGap), pitchEdgeSupports ? "TRUE" : "FALSE"
    ].join(","));
  }

  if (!rows.length) {
    console.log(`Lab Rating inputs export: ${DATE} has games but none with a resolved pick side yet -- nothing to export this run.`);
    return;
  }

  const OUT = path.join(ROOT, "data", "calibration", "lab_rating_inputs_log.csv");
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  let existingLines = [];
  if (fs.existsSync(OUT)) {
    existingLines = fs.readFileSync(OUT, "utf8").split("\n").filter(Boolean);
    if (existingLines.length && existingLines[0].startsWith("date,")) existingLines.shift();
  }
  const todaysPks = new Set(games.map(g => String(g.game_pk)));
  const kept = existingLines.filter(l => {
    const p = l.split(",");
    if (p.length < 2) return false;
    const sameDate = normDate(p[0]) === DATE;
    return !(sameDate && todaysPks.has(String(p[1])));
  });

  fs.writeFileSync(OUT, HEADER + [...kept, ...rows].join("\n") + "\n");
  console.log(`Lab Rating inputs export: wrote ${rows.length} row(s) for ${DATE} to data/calibration/lab_rating_inputs_log.csv (${kept.length} prior rows retained).`);
}

main();
