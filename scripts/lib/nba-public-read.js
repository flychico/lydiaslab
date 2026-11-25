/**
 * The read Leo published (Lynold, 2026-11-24: "Grade on what we sent out to the public.
 * Cannot be switching picks after we send them.").
 *
 * The first game-day card for a date (not an early read) is the one the posts and
 * the card email are made from. Each game's Leo block from that card is saved in
 * data/nba/public-reads/<date>.json and never changes:
 *   - later reads that day keep the card showing that same winner, chance and pick
 *     (the new numbers are kept as game.latest, shown as information only);
 *   - the grader grades the winner, chance and margin from that read, and a Leo Pick
 *     in it is graded at its price whatever later reads say ("a sent pick stays").
 * A game first seen in a later read is saved at that read.
 * Every read still goes to prediction-history.csv for research.
 */
const fs = require("fs");
const path = require("path");
const DIR = path.join(__dirname, "..", "..", "data", "nba", "public-reads");
const FROM = "2026-11-24";   // dates before this keep "last read before tip"
const file = date => path.join(DIR, `${date}.json`);
const cache = {};
function load(date) {
  if (cache[date]) return cache[date];
  try { return (cache[date] = JSON.parse(fs.readFileSync(file(date), "utf8"))); } catch (e) { return (cache[date] = { date, games: {} }); }
}
const on = date => String(date) >= FROM;
/** { captured_at, leo } or null */
function get(date, gameId) { return on(date) ? load(date).games[String(gameId)] || null : null; }
/** Save a game's published read once. Returns true when added. */
function put(date, gameId, captured_at, leo) {
  if (!on(date)) return false;
  const d = load(date);
  if (d.games[String(gameId)]) return false;
  d.games[String(gameId)] = { captured_at, leo: JSON.parse(JSON.stringify(leo)) };
  return true;
}
function save(date) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file(date), JSON.stringify(load(date), null, 1) + "\n");
}
module.exports = { FROM, get, put, save, load, file };
