/*
  LyDia — shared K-props -> Excel row schema.

  Both scripts/export-kprops-xlsx.js (pre-game capture) and
  scripts/grade-calibration.js (post-game grading refresh) build rows through
  this one file, so the two things that write data/k-props/<date>.xlsx can
  never drift into different column sets or orders.

  2026-08-14: full column reorder + rename to Lynold's exact spec, 5 columns
  dropped from the prior 43-column schema (recent_form_capped, whiff_leverage,
  whiff_leverage_applied, whiff_lineup_source, opp_lineup_source). Column
  order matches kprops_log.csv's KLOG_COLUMNS in grade-calibration.js exactly
  — same 38 columns, same positions, same names. Kept identical on purpose: a
  CSV row and an xlsx row for the same pitcher/date should be recognizable as
  the same record at a glance.
*/

const HEADERS = [
  "date", "pitcher", "line", "over_price", "under_price",
  "game", "game_pk", "role", "expected_innings", "bullpen_game", "pitching_plan_reported", "books",
  "k_rate_season", "recent_form_starts", "recent_form_bf", "bf_per_ip", "recent_form_k_rate", "recent_form_weight",
  "opp_k_source", "opp_lineup_k", "opp_lineup_k_weighted", "opp_lineup_k_resolved", "opp_team_season_k", "league_lineup_k",
  "whiff_leverage",
  "actual_k", "ou_result", "lean", "lean_result",
  "projection_raw", "calibration_band", "k_rate_used", "opp_k_adjustment", "calibration_bias",
  "error_raw", "abs_error_raw", "error_corrected", "abs_error_corrected", "projection"
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
  const absErrRaw = errRaw !== null ? Math.abs(errRaw) : null;
  const errCorr = (actual !== null && proj !== null) ? Number((actual - proj).toFixed(2)) : null;
  const absErrCorr = errCorr !== null ? Math.abs(errCorr) : null;

  return [
    date, rec.name || "", num(rec.line), num(rec.over), num(rec.under),
    rec.game || "", rec.game_pk ?? "", rec.pitcher_role_label || "",
    num(rec.expected_innings), bool(rec.bullpen_game), bool(rec.pitching_plan_reported), num(rec.books),
    num(rec.k_rate_season), num(rf.starts), num(rf.batters_faced), num(rec.bf_per_ip), num(rf.recent_k_rate), num(rf.weight),
    rec.opp_k_source || "", num(rec.opp_lineup_k), num(rec.opp_lineup_k_weighted), rec.opp_lineup_k_resolved ?? "",
    num(rec.opp_team_season_k), num(rec.league_lineup_k),
    num(rec.whiff_leverage),
    actual, graded ? (graded.ou_result || "") : "", graded ? num(graded.lean) : null, graded ? (graded.lean_result || "") : "",
    projRaw, rec.calibration_band || "", num(rec.k_rate_used), num(rec.opp_k_adjustment), num(rec.calibration_bias),
    errRaw, absErrRaw, errCorr, absErrCorr, proj
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
