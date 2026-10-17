/**
 * Grading catch-up (DEC-20261017-04).
 *
 * nfl-grade-results.yml grades "yesterday and today". When nflverse posts a
 * Thursday or Monday game's stats after both of those runs, the date slides
 * out of the window and is never graded: TB @ DAL (Oct 8) and BUF @ LA
 * (Oct 12) sat ungraded until they were dispatched by hand.
 *
 * After grading its own date, each grader calls catchUp(): any game with a
 * frozen pre-kickoff prediction in the last DAYS days that is still missing
 * from the ledger gets its date graded again. The graders refuse to write a
 * graded date twice and write nothing when stats are not posted, so a
 * catch-up run is a no-op until there is something to grade.
 */
const fs = require("fs");
const { execFileSync } = require("child_process");

const DAYS = 14;

function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const head = lines.shift().split(",");
  const out = [];
  for (const line of lines) {
    // Fields used here (captured_at, date, game_id, kickoff_utc) never hold commas,
    // and every one sits before the first quoted field in both history files.
    const cells = line.split(",");
    out.push(Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ""])));
  }
  return out;
}

/** Dates before `today` with a frozen game that the ledger has never graded. */
function missingDates(historyFile, ledgerFile, today) {
  const graded = new Set(readCsv(ledgerFile).map(r => r.game_id));
  const floor = new Date(Date.parse(`${today}T12:00:00Z`) - DAYS * 864e5).toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const dates = new Set();
  for (const r of readCsv(historyFile)) {
    if (!r.game_id || !r.date || r.date >= today || r.date < floor) continue;
    // Frozen = captured strictly before kickoff, and the game is over by now.
    if (!r.kickoff_utc || !(r.captured_at < r.kickoff_utc) || r.kickoff_utc > now) continue;
    if (!graded.has(r.game_id)) dates.add(r.date);
  }
  return [...dates].sort();
}

/** Re-run `script` for each missing date. Never throws: grading must not fail on this. */
function catchUp({ script, historyFile, ledgerFile, today, label }) {
  // --force is a deliberate regrade of one date (and what the tests use).
  if (process.argv.includes("--no-catchup") || process.argv.includes("--force")) return;
  let dates = [];
  try { dates = missingDates(historyFile, ledgerFile, today); } catch (e) { return; }
  if (!dates.length) return;
  console.log(`\n  catch-up (${label}): frozen games still ungraded on ${dates.join(", ")}`);
  for (const d of dates) {
    try { execFileSync(process.execPath, [script, `--date=${d}`, "--no-catchup"], { stdio: "inherit" }); }
    catch (e) { console.warn(`  catch-up ${d} failed: ${e.message}`); }
  }
}

module.exports = { missingDates, catchUp, DAYS };
