#!/usr/bin/env node
/*
  LyDia — pregame attribution snapshot.

  Writes data/calibration/pregame_attribution_log.csv: the same 30 model
  inputs/derived-calc columns as attribution_model_log.csv (Lynold's
  31-column, home/away-relative spec, minus a filled-in `winner` -- that
  column stays blank here, since these games haven't been played), captured
  from data/member-brief/<date>.json BEFORE the game is final, not after.

  2026-08-25, Lynold's explicit instruction: full schema rewrite from
  pick/opp-relative to home/away-relative, to make the log trackable in
  Excel without a pick-side lookup on every column. Specifically:
    - added away_team, home_team (were previously only inferrable from the
      `matchup` "AWAY @ HOME" string)
    - pick_team now holds the literal string "home team" or "away team"
      (which side LyDia picked), not the team name -- the team name is
      already in away_team/home_team
    - dropped opp_team (redundant with away_team/home_team + pick_team),
      pick_whip/opp_whip, pick_hr9/opp_hr9 (both pairs logged but never
      read by anything downstream -- confirmed via the 2026-08-25 unused-
      column audit)
    - every remaining pick/opp-relative column converted to a direct
      home_X/away_X pair (pitcher, pitcher_score, era, woba, bullpen_risk)
    - model_prob -> home_model_prob, result -> winner (both were pick-
      relative facts; home_model_prob/winner are the same raw facts stated
      relative to home instead, away is the complement)
    - the 6 "show your work" gap/calc columns (pitcher_gap, woba_diff,
      bullpen_gap, pitcher_boost, pre_bullpen_odds/prob, bullpen_adj,
      money_line_odds, moneyline_prop) converted from pick-relative to
      home-relative and KEPT, per Lynold's explicit answer that these stay
      rather than get dropped.

  WHY THIS IS SEPARATE FROM attribution_model_log.csv
  attribution_model_log.csv (grade-calibration.js) only gets a row once a
  game is Final -- it reads the boxscore to fill `winner`. That means the
  pregame reasoning for today's games isn't visible anywhere until
  daily-recap.yml runs the next morning. This script captures the exact
  same reasoning same-day, before the recap, so it's on hand right after
  publish. grade-calibration.js's grading pass the next morning is
  unaffected by this file -- they're independent outputs of the same
  formula chain, read from the same source fields.

  UPSERT, NOT APPEND
  publish-picks.yml runs up to 4x/day as more games get posted lineups and
  pitchers move off TBD. Each run here replaces any existing row for
  (date, gamePk) with the freshest read, so the file always holds each
  game's most current pregame snapshot as of the last publish wave, right
  up until the game goes final and grade-calibration.js takes over.

  FORMULA CHAIN -- kept in sync manually with grade-calibration.js's
  attribution block (odds(), r4() below).

  Usage: node scripts/export-pregame-attribution.js [YYYY-MM-DD]  (defaults to today ET)
*/
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const DATE = (process.argv[2] || "").match(/^\d{4}-\d{2}-\d{2}$/)
  ? process.argv[2]
  : new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

function mmddyyyy(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
}
const DATE_OUT = mmddyyyy(DATE);

// Same as grade-calibration.js's normDate() -- accepts either stored form
// so the upsert below matches existing rows regardless of which format
// they were written in.
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

const COLUMNS = [
  "date", "gamePk", "model_version", "matchup", "away_team", "home_team",
  "pick_team", "status", "winner",
  "home_model_prob", "home_pitcher_gap", "home_pitcher", "home_pitcher_score",
  "away_pitcher", "away_pitcher_score", "home_era", "away_era",
  "home_woba", "away_woba", "home_bullpen_risk", "away_bullpen_risk",
  "home_strength_blend", "away_strength_blend", "home_woba_gap", "home_bullpen_gap",
  "home_pitcher_boost", "home_pre_bullpen_odds", "home_pre_bullpen_prob", "home_bullpen_adj",
  "home_money_line_odds", "home_moneyline_prop"
];
const HEADER = COLUMNS.join(",") + "\n";

const r4 = v => (typeof v === "number" && isFinite(v)) ? Number(v.toFixed(4)) : null;
const n2 = v => v === null || v === undefined ? "" : v;
const odds = p => (p !== null && p > 0 && p < 1) ? r4(p / (1 - p)) : null;
const bpRiskNum = t => { const v = t ? (t.risk_index ?? t.score) : null; return r4(typeof v === "number" ? v : NaN); };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
// 2026-08-25, Lynold's explicit instruction: ERA_K now imported from
// scripts/lib/pitcher-boost-constants.js instead of a local hardcoded copy.
// That local copy (0.20) had drifted stale -- generate-member-lab.js's live
// value had been retuned to 0.15 and this file was never updated to match,
// so home_pitcher_boost/home_pre_bullpen_odds in this pregame snapshot
// silently stopped matching what the live model actually priced. (A
// same-day 2026-08-24 attempt to centralize this via a shared
// PITCHER_SCORE_K=0.03 constant in that same module was reverted back to a
// local copy per Lynold's call that day -- this is that centralization done
// for real, at the current correct value.)
const { ERA_K, PITCHER_SCORE_GAP_CLAMP } = require("./lib/pitcher-boost-constants");
// homeScore/awayScore below are pitcher_edge.home_score/away_score -- the
// SAME starter-only pitcher_score field the live model's scoreH/scoreA read,
// so this reproduces exactly what the live moneyline used.

function main() {
  const briefPath = path.join(ROOT, "data", "member-brief", `${DATE}.json`);
  if (!fs.existsSync(briefPath)) {
    console.log(`Pregame attribution: no member brief for ${DATE} at ${briefPath} -- nothing to export.`);
    return;
  }
  let brief;
  try {
    brief = JSON.parse(fs.readFileSync(briefPath, "utf8"));
  } catch (e) {
    console.warn(`Pregame attribution: could not parse ${briefPath} -- ${e.message}`);
    return;
  }
  const games = Array.isArray(brief.games) ? brief.games : Array.isArray(brief) ? brief : [];
  if (!games.length) {
    console.log(`Pregame attribution: member brief for ${DATE} has no games -- nothing to export.`);
    return;
  }

  const rows = [];
  for (const g of games) {
    if (!g.side) continue; // no pick side resolved yet -- nothing to orient home/away model-relative fields by
    const pickHome = g.side === "home";
    const pe = g.pitcher_edge || {};
    const homePitcher = pe.home_pitcher;
    const awayPitcher = pe.away_pitcher;
    const homeScore = r4(pe.home_score);
    const awayScore = r4(pe.away_score);
    const homeEra = r4(g.model_effective_era_home);
    const awayEra = r4(g.model_effective_era_away);
    const of_ = g.offense_form || {};
    const homeWoba = r4(of_.home ? of_.home.woba_15d : NaN);
    const awayWoba = r4(of_.away ? of_.away.woba_15d : NaN);
    const bp = g.bullpen || {};
    // bp only stores pick_team/opponent (no home/away split at the source),
    // so this is the one pair that still needs the pickHome flip to land on
    // the correct physical side.
    const homeRisk = bpRiskNum(pickHome ? bp.pick_team : bp.opponent);
    const awayRisk = bpRiskNum(pickHome ? bp.opponent : bp.pick_team);

    // 2026-08-19, Lynold's explicit instruction (carried forward): pBase in
    // generate-member-lab.js is ALWAYS the home team's blend
    // (team_strength_blend_home), regardless of which side is picked --
    // home_strength_blend IS the number that anchors the odds calc on every
    // row; away_strength_blend never feeds the formula (kept for reference
    // only). Already home/away-direct, unchanged by this rewrite.
    const homeBlend = r4(g.team_strength_blend_home);
    const awayBlend = r4(g.team_strength_blend_away);

    // 2026-08-25: model_probability, model_probability_pre_bullpen, and
    // bullpen_log_odds_adjustment are all stored PICK-relative on the member
    // brief game object (pickHome ? X : 1-X, or pickHome ? X : -X --
    // confirmed by reading generate-member-lab.js directly, lines
    // 1125/1272/1317/1344). To make these home-relative: when the pick IS
    // home the stored value already reads home-relative; when the pick is
    // away, undo the flip.
    const pickProb = r4(g.model_probability);
    const homeModelProb = pickHome ? pickProb : (pickProb !== null ? r4(1 - pickProb) : null);
    const pickPreBullpenProb = r4(g.model_probability_pre_bullpen);
    const homePreBullpenProb = pickHome ? pickPreBullpenProb : (pickPreBullpenProb !== null ? r4(1 - pickPreBullpenProb) : null);
    const pickBullpenAdj = r4(g.bullpen_log_odds_adjustment);
    const homeBullpenAdj = pickHome ? pickBullpenAdj : (pickBullpenAdj !== null ? r4(-pickBullpenAdj) : null);

    const homePitcherGap = (homeScore !== null && awayScore !== null) ? r4(homeScore - awayScore) : null;
    const homeWobaGap = (homeWoba !== null && awayWoba !== null) ? r4(homeWoba - awayWoba) : null;
    // Mirrors the old bullpen_gap convention (opponent risk minus the
    // favored side's risk, so positive = the favored side is safer) just
    // restated home-relative: away risk minus home risk.
    const homeBullpenGap = (homeRisk !== null && awayRisk !== null) ? r4(awayRisk - homeRisk) : null;

    const homePreBullpenOdds = odds(homePreBullpenProb);
    const homeScoreGap = (homeScore !== null && awayScore !== null) ? clamp(homeScore - awayScore, -PITCHER_SCORE_GAP_CLAMP, PITCHER_SCORE_GAP_CLAMP) : null;
    const homePitcherBoost = homeScoreGap !== null ? r4(Math.exp(ERA_K * homeScoreGap)) : null;
    const homeMoneyLineOdds = odds(homeModelProb);
    const homeMoneylineProp = homeModelProb;

    const pickTeamSide = g.side === "home" ? "home team" : "away team";

    rows.push([
      DATE_OUT, g.game_pk, csvField(g.model_source || brief.model_version || "unknown"),
      csvField(g.game), csvField(g.away_team), csvField(g.home_team),
      csvField(pickTeamSide), g.status || "", "",
      n2(homeModelProb), n2(homePitcherGap), csvField(homePitcher || ""), n2(homeScore),
      csvField(awayPitcher || ""), n2(awayScore),
      n2(homeEra), n2(awayEra),
      n2(homeWoba), n2(awayWoba), n2(homeRisk), n2(awayRisk),
      n2(homeBlend), n2(awayBlend), n2(homeWobaGap), n2(homeBullpenGap),
      n2(homePitcherBoost), n2(homePreBullpenOdds), n2(homePreBullpenProb), n2(homeBullpenAdj),
      n2(homeMoneyLineOdds), n2(homeMoneylineProp)
    ].join(","));
  }

  if (!rows.length) {
    console.log(`Pregame attribution: ${DATE} has games but none with a resolved pick side yet -- nothing to export this run.`);
    return;
  }

  const OUT = path.join(ROOT, "data", "calibration", "pregame_attribution_log.csv");
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  let existingLines = [];
  if (fs.existsSync(OUT)) {
    existingLines = fs.readFileSync(OUT, "utf8").split("\n").filter(Boolean);
    if (existingLines.length && existingLines[0].startsWith("date,")) existingLines.shift(); // drop old header
  }
  // Upsert: drop any existing row for (date, gamePk) we're about to rewrite,
  // keep every other date/game untouched, then append this run's rows.
  const todaysPks = new Set(games.map(g => String(g.game_pk)));
  const kept = existingLines.filter(l => {
    const p = l.split(",");
    if (p.length < 2) return false;
    const sameDate = normDate(p[0]) === DATE;
    return !(sameDate && todaysPks.has(String(p[1])));
  });

  fs.writeFileSync(OUT, HEADER + [...kept, ...rows].join("\n") + "\n");
  console.log(`Pregame attribution: wrote ${rows.length} row(s) for ${DATE} to data/calibration/pregame_attribution_log.csv (${kept.length} prior rows retained).`);
}

main();
