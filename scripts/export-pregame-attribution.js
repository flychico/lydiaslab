#!/usr/bin/env node
/*
  LyDia — pregame attribution snapshot.

  Writes data/calibration/pregame_attribution_log.csv: the same 33 model
  inputs/derived-calc columns as attribution_model_log.csv (Lynold's
  34-column spec, minus a filled-in `result` -- that column stays blank
  here, since these games haven't been played), captured from
  data/member-brief/<date>.json BEFORE the game is final, not after.

  WHY THIS IS SEPARATE FROM attribution_model_log.csv
  attribution_model_log.csv (grade-calibration.js) only gets a row once a
  game is Final -- it reads the boxscore to fill `result`. That means the
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
  attribution block (odds(), r4() below). The pitcher-boost coefficient
  itself (2026-08-24 on) is no longer a manual-sync risk -- both files
  import it from scripts/lib/pitcher-boost-constants.js.

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
  "date", "gamePk", "model_version", "matchup", "pick_team", "opp_team", "status", "result",
  "model_prob", "pitcher_gap", "pick_pitcher", "pick_pitcher_score", "opp_pitcher", "opp_pitcher_score",
  "pick_era", "opp_era", "pick_whip", "opp_whip", "pick_hr9", "opp_hr9",
  "pick_woba", "opp_woba", "pick_bullpen_risk", "opp_bullpen_risk",
  "home_strength_blend", "away_strength_blend", "woba_diff", "bullpen_gap",
  "pitcher_boost", "pre_bullpen_odds", "pre_bullpen_prob", "bullpen_adj",
  "money_line_odds", "moneyline_prop"
];
const HEADER = COLUMNS.join(",") + "\n";

const r4 = v => (typeof v === "number" && isFinite(v)) ? Number(v.toFixed(4)) : null;
const n2 = v => v === null || v === undefined ? "" : v;
const odds = p => (p !== null && p > 0 && p < 1) ? r4(p / (1 - p)) : null;
const bpRiskNum = t => { const v = t ? (t.risk_index ?? t.score) : null; return r4(typeof v === "number" ? v : NaN); };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
// 2026-08-24, Lynold's explicit instruction: PITCHER_SCORE_K/CLAMP moved to
// a shared module -- this file used to carry its own hardcoded ERA_K=0.20
// copy for pitcher_boost, "kept in sync manually" per this file's own header
// comment above. Manual sync is exactly how grade-calibration.js's copy went
// stale for three days after generate-member-lab.js's own formula changed
// (see scripts/lib/pitcher-boost-constants.js for that history and the
// 2026-08-24 recalibration itself -- 0.20 down to 0.03, a 6-point pitcher
// gap was swinging model_prob ~27 points).
const { PITCHER_SCORE_K, PITCHER_SCORE_GAP_CLAMP } = require("./lib/pitcher-boost-constants");
// pScore/oScore below are pitcher_edge.home_score/away_score -- the SAME
// starter-only pitcher_score field the live model's scoreH/scoreA read, so
// this reproduces exactly what the live moneyline used.

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
    if (!g.side) continue; // no pick side resolved yet -- nothing to orient pick/opp by
    const pickHome = g.side === "home";
    const pe = g.pitcher_edge || {};
    const pAdv = pickHome ? pe.home_advanced : pe.away_advanced;
    const oAdv = pickHome ? pe.away_advanced : pe.home_advanced;
    const pPitcher = pickHome ? pe.home_pitcher : pe.away_pitcher;
    const oPitcher = pickHome ? pe.away_pitcher : pe.home_pitcher;
    const pScore = r4(pickHome ? pe.home_score : pe.away_score);
    const oScore = r4(pickHome ? pe.away_score : pe.home_score);
    const pWhip = r4(pickHome ? pe.home_whip : pe.away_whip);
    const oWhip = r4(pickHome ? pe.away_whip : pe.home_whip);
    const pHr9 = r4(pAdv ? pAdv.hr9 : NaN);
    const oHr9 = r4(oAdv ? oAdv.hr9 : NaN);
    const pEra = r4(pickHome ? g.model_effective_era_home : g.model_effective_era_away);
    const oEra = r4(pickHome ? g.model_effective_era_away : g.model_effective_era_home);
    const of_ = g.offense_form || {};
    const pOff = pickHome ? of_.home : of_.away;
    const oOff = pickHome ? of_.away : of_.home;
    const pWoba = r4(pOff ? pOff.woba_15d : NaN);
    const oWoba = r4(oOff ? oOff.woba_15d : NaN);
    const bp = g.bullpen || {};
    const pRisk = bpRiskNum(bp.pick_team), oRisk = bpRiskNum(bp.opponent);
    const oppTeam = pickHome ? g.away_team : g.home_team;
    // 2026-08-19, Lynold's explicit instruction: renamed from pick/opp-relative
    // to home/away-direct, no conditional needed. pBase in generate-member-lab.js
    // is ALWAYS the home team's blend (team_strength_blend_home), regardless of
    // which side is picked -- home_strength_blend IS the number that anchors
    // the odds calc on every row; away_strength_blend never feeds the formula
    // (it's each team's own independent rating, kept for reference only). The
    // old pick_team_strength_blend column silently swapped which physical
    // number it showed depending on home/away, which made an away pick's row
    // look like its OWN blend anchored the price when it never did.
    const homeBlend = r4(g.team_strength_blend_home);
    const awayBlend = r4(g.team_strength_blend_away);

    const preBullpenProb = r4(g.model_probability_pre_bullpen);
    const legacyStrengthProb = r4(g.legacy_strength_probability);
    const bullpenAdj = r4(g.bullpen_log_odds_adjustment);
    const modelProb = r4(g.model_probability);

    const pitcherGap = (pScore !== null && oScore !== null) ? r4(pScore - oScore) : null;
    const wobaDiff = (pWoba !== null && oWoba !== null) ? r4(pWoba - oWoba) : null;
    const bullpenGap = (pRisk !== null && oRisk !== null) ? r4(oRisk - pRisk) : null;

    const preBullpenOdds = odds(preBullpenProb);
    const scoreGap = (pScore !== null && oScore !== null) ? clamp(pScore - oScore, -PITCHER_SCORE_GAP_CLAMP, PITCHER_SCORE_GAP_CLAMP) : null;
    const pitcherBoost = scoreGap !== null ? r4(Math.exp(PITCHER_SCORE_K * scoreGap)) : null;
    const moneyLineOdds = odds(modelProb);
    const moneylineProp = modelProb;

    rows.push([
      DATE_OUT, g.game_pk, csvField(g.model_source || brief.model_version || "unknown"),
      csvField(g.game), csvField(g.pick_team), csvField(oppTeam), g.status || "", "",
      n2(modelProb), n2(pitcherGap), csvField(pPitcher || ""), n2(pScore), csvField(oPitcher || ""), n2(oScore),
      n2(pEra), n2(oEra), n2(pWhip), n2(oWhip), n2(pHr9), n2(oHr9),
      n2(pWoba), n2(oWoba), n2(pRisk), n2(oRisk),
      n2(homeBlend), n2(awayBlend), n2(wobaDiff), n2(bullpenGap),
      n2(pitcherBoost), n2(preBullpenOdds), n2(preBullpenProb), n2(bullpenAdj),
      n2(moneyLineOdds), n2(moneylineProp)
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
