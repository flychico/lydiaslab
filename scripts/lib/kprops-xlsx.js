/*
  LyDia — shared K-props -> Excel row schema.

  Both scripts/export-kprops-xlsx.js (pre-game capture) and
  scripts/grade-calibration.js (post-game grading refresh) build rows through
  this one file, so the two files that write data/k-props/<date>.xlsx can
  never drift into different column sets or orders.

  Column order matches kprops_log.csv's KHEAD exactly (grade-calibration.js) —
  same 43 columns, same positions, same names as the review workbook built
  2026-08-09. Kept identical on purpose: a CSV row and an xlsx row for the
  same pitcher/date should be recognizable as the same record at a glance.
*/

const HEADERS = [
  "date", "pitcher", "line", "over_price", "under_price", "projection", "actual_k",
  "ou_result", "lean", "lean_result", "projection_raw", "calibration_band",
  "game", "game_pk", "role", "expected_innings", "bullpen_game", "pitching_plan_reported", "books",
  "k_rate_season", "k_rate_used", "recent_form_starts", "recent_form_bf", "recent_form_k_rate",
  "recent_form_weight", "recent_form_capped",
  "bf_per_ip", "opp_k_adjustment", "opp_k_source", "opp_lineup_k", "opp_lineup_k_weighted",
  "opp_lineup_k_resolved", "opp_team_season_k", "league_lineup_k",
  "whiff_leverage", "whiff_leverage_applied", "whiff_lineup_source", "opp_lineup_source",
  "calibration_bias", "error_raw", "abs_error_raw", "error_corrected", "abs_error_corrected"
];

function num(v) { return Number.isFinite(v) ? v : null; }
function bool(v) { return v === true ? true : v === false ? false : null; }

/*
  rec    = one entry from data/k-props/<date>.json's `pitchers` object
           (the projection-time record — always present).
  graded = { actual_k, ou_result, lean, lean_result } once grade-calibration.js
           has run for that date, or null before then. Pre-game rows are
           written with graded=null; grade-calibration.js re-writes the file
           afterward with the real values filled in.

  Returns a plain array in HEADERS order — the row-building logic is
  deliberately dependency-free (no exceljs calls here) so it can be unit
  tested with a plain `node` invocation, independent of whether exceljs is
  actually installed.
*/
function buildRow(date, rec, graded) {
  const rf = rec.recent_form || {};
  const actual = graded ? num(graded.actual_k) : null;
  const projRaw = num(rec.projection_raw);
  const proj = num(rec.projection);
  const errRaw = (actual !== null && projRaw !== null) ? Number((actual - projRaw).toFixed(2)) : null;
  const errCorr = (actual !== null && proj !== null) ? Number((actual - proj).toFixed(2)) : null;

  return [
    date, rec.name || "", num(rec.line), num(rec.over), num(rec.under), proj,
    actual, graded ? (graded.ou_result || "") : "", graded ? num(graded.lean) : null,
    graded ? (graded.lean_result || "") : "",
    projRaw, rec.calibration_band || "",
    rec.game || "", rec.game_pk ?? "", rec.pitcher_role_label || "",
    num(rec.expected_innings), bool(rec.bullpen_game), bool(rec.pitching_plan_reported), num(rec.books),
    num(rec.k_rate_season), num(rec.k_rate_used),
    num(rf.starts), num(rf.batters_faced), num(rf.recent_k_rate), num(rf.weight), bool(rf.capped),
    num(rec.bf_per_ip), num(rec.opp_k_adjustment), rec.opp_k_source || "",
    num(rec.opp_lineup_k), num(rec.opp_lineup_k_weighted), rec.opp_lineup_k_resolved ?? "",
    num(rec.opp_team_season_k), num(rec.league_lineup_k),
    num(rec.whiff_leverage), bool(rec.whiff_leverage_applied), rec.whiff_lineup_source || "", rec.opp_lineup_source || "",
    num(rec.calibration_bias), errRaw,
    errRaw !== null ? Math.abs(errRaw) : null,
    errCorr, errCorr !== null ? Math.abs(errCorr) : null
  ];
}

/*
  Writes one sheet named "K-Props" with a bold header row and the given
  rows. Requires exceljs (added to package.json 2026-08-09) — this is the
  only function in this file that touches it, kept separate from buildRow()
  above so the row-construction logic stays testable without the library
  actually being installed.
*/
async function writeWorkbook(filePath, rows) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("K-Props");
  ws.addRow(HEADERS);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  for (const row of rows) ws.addRow(row);
  ws.columns.forEach(col => { col.width = 16; });
  await wb.xlsx.writeFile(filePath);
}

module.exports = { HEADERS, buildRow, writeWorkbook };
