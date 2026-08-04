#!/usr/bin/env node
"use strict";

/*
  backfill-recaps.js [YYYY-MM-DD] [--force]

  For every FINAL game on DATE, grade the pregame reasoning against the actual
  boxscore ("how the analysis held up") and do two things:

    1. Persist the review into data/recap-reviews/DATE.json (merging), so
       generate-matchup-pages.js renders it on the page. This is why long-final
       games no longer show an empty Final-result section.

    2. Append one structured row per game to data/calibration/recap_components.csv
       -- the pregame-read-vs-actual ledger. This is the learning signal: over
       time it says which reads (direction, pitcher edge, bullpen flag, offense
       projection) actually match reality, and by how much. It never gates or
       changes a pick; it measures.

  Pregame source is member-brief/DATE.json (the full record). Games that fell
  out of a collapsed brief have no recoverable pregame projections, so they are
  logged and skipped rather than graded on invented data.

  Idempotent: a game already carrying a recap, and a ledger row already present
  for (date, game_pk), are skipped unless --force.

  Boxscore/schedule come from statsapi. Run it AFTER games are final (next
  morning), then run generate-matchup-pages.js for the same date to render.
*/

const fs = require("fs");
const path = require("path");
const RecapBuild = require("./lib/recap-build-core.js");

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
const DATE = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a))
  || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const FORCE = args.includes("--force");

const RECAP_PATH = path.join(ROOT, "data", "recap-reviews", `${DATE}.json`);
const LEDGER_PATH = path.join(ROOT, "data", "calibration", "recap_components.csv");

const LEDGER_HEADER = [
  "date", "game_pk", "game", "pick_team",
  "direction_winner", "direction_correct",
  "submodel_strength_right", "submodel_run_right",
  "starter_favored_team", "starter_gap", "starter_held_up", "starter_favored_era", "starter_other_era",
  "away_team", "away_proj_runs", "away_actual_runs", "away_offense_diff",
  "home_team", "home_proj_runs", "home_actual_runs", "home_offense_diff",
  "away_bullpen_flagged", "away_bullpen_actual_er", "away_bullpen_actual_era",
  "home_bullpen_flagged", "home_bullpen_actual_er", "home_bullpen_actual_era"
];

function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; } }
function num(v) { return typeof v === "number" && isFinite(v) ? v : ""; }
function boolCell(v) { return typeof v === "boolean" ? (v ? "1" : "0") : ""; }
function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function fetchSchedule(date) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${encodeURIComponent(date)}&hydrate=probablePitcher,linescore`;
  const r = await fetch(url, { headers: { "user-agent": "LyDia recap backfill" } });
  if (!r.ok) throw new Error(`schedule HTTP ${r.status}`);
  return r.json();
}

function ledgerRow(game, review) {
  const d = review.data || {};
  const dir = d.direction || {};
  const sub = d.submodel || {};
  const st = d.starter || {};
  const off = (d.offense || []).filter(Boolean);
  const awayOff = off.find(o => o.team === game.away_team) || {};
  const homeOff = off.find(o => o.team === game.home_team) || {};
  const ab = d.away_bullpen || {};
  const hb = d.home_bullpen || {};
  const abA = ab.actual || {};
  const hbA = hb.actual || {};
  return [
    DATE, game.game_pk, game.game, game.pick_team || "",
    dir.winner || "", boolCell(dir.correct),
    boolCell(sub.strengthRight), boolCell(sub.runRight),
    st.favoredTeam || "", num(st.pitcherGap), boolCell(st.heldUp),
    st.favored ? num(st.favored.era) : "", st.other ? num(st.other.era) : "",
    game.away_team, num(awayOff.projectedRuns), num(awayOff.actualRuns), num(awayOff.diff),
    game.home_team, num(homeOff.projectedRuns), num(homeOff.actualRuns), num(homeOff.diff),
    boolCell(ab.wasFlagged), num(abA.er), num(abA.era),
    boolCell(hb.wasFlagged), num(hbA.er), num(hbA.era)
  ].map(csvCell).join(",");
}

async function main() {
  const brief = readJsonSafe(path.join(ROOT, "data", "member-brief", `${DATE}.json`));
  if (!brief || !Array.isArray(brief.games) || !brief.games.length) {
    console.log(`Recap backfill: no member brief for ${DATE}; nothing to grade.`);
    return;
  }
  const pitchers = readJsonSafe(path.join(ROOT, "data", "pitcher-matchups", `${DATE}.json`)) || { games: {} };

  let schedule;
  try { schedule = await fetchSchedule(DATE); }
  catch (e) { console.warn(`Recap backfill: schedule unavailable (${e.message}); aborting without changes.`); return; }
  const scheduleByPk = new Map(((((schedule.dates || [])[0]) || {}).games || []).map(g => [String(g.gamePk), g]));

  const existing = readJsonSafe(RECAP_PATH) || { date: DATE, games: {} };
  const recapGames = { ...(existing.games || {}) };

  // Existing ledger keys, to avoid duplicate rows on re-run.
  const seenKeys = new Set();
  let ledgerExists = fs.existsSync(LEDGER_PATH);
  if (ledgerExists) {
    for (const line of fs.readFileSync(LEDGER_PATH, "utf8").split("\n")) {
      const [date, pk] = line.split(",");
      if (date && pk) seenKeys.add(`${date}|${pk}`);
    }
  }

  const newRows = [];
  let graded = 0, skippedFinal = 0, skippedHave = 0, notFinal = 0;

  for (const game of brief.games) {
    const pk = String(game.game_pk);
    const sg = scheduleByPk.get(pk);
    if (!sg || !sg.status || sg.status.abstractGameState !== "Final") { notFinal++; continue; }

    const alreadyHasRecap = recapGames[pk] && Array.isArray(recapGames[pk].paragraphs) && recapGames[pk].paragraphs.length;
    const alreadyInLedger = seenKeys.has(`${DATE}|${pk}`);
    if (alreadyHasRecap && alreadyInLedger && !FORCE) { skippedHave++; continue; }

    const boxscore = await RecapBuild.fetchBoxscore(game.game_pk);
    const review = RecapBuild.buildReviewFromBoxscore(game, sg, pitchers.games[pk], boxscore);
    if (!review) { skippedFinal++; console.warn(`  no review built for ${game.game} (${pk}) — boxscore or pregame data incomplete.`); continue; }

    recapGames[pk] = { game_pk: game.game_pk, game: game.game, ...review.data, paragraphs: review.paragraphs };
    if (!alreadyInLedger || FORCE) { newRows.push(ledgerRow(game, review)); seenKeys.add(`${DATE}|${pk}`); }
    graded++;
  }

  // Write recap-reviews (merge, never regress a day from having reviews).
  fs.mkdirSync(path.dirname(RECAP_PATH), { recursive: true });
  fs.writeFileSync(RECAP_PATH, JSON.stringify({ date: DATE, generated_at: new Date().toISOString(), games: recapGames }, null, 2) + "\n", "utf8");

  // Append ledger rows.
  if (newRows.length) {
    fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
    const prefix = ledgerExists ? "" : LEDGER_HEADER.join(",") + "\n";
    fs.appendFileSync(LEDGER_PATH, prefix + newRows.join("\n") + "\n", "utf8");
  }

  console.log(`Recap backfill ${DATE}: graded ${graded}, ledger rows added ${newRows.length}, `
    + `already had ${skippedHave}, no review ${skippedFinal}, not final ${notFinal}.`);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
