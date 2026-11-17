/**
 * One price per Leo Pick (Lynold, 2026-11-16: "pick 1 price for both tracking
 * and for picks and results ... consistent and logical"). DEC-20261116-30.
 *
 * From LOCK_FROM, a Leo Pick's price locks at the first read that makes it a
 * Leo Pick (60%+ and priced better than -230). The card, the game pages, the
 * emails, the X posts, the grader, the ledger and the bet tracker all use that
 * one price. The pick stays while Leo still has that team at 60%+ at the read
 * of record, even if the price later moves past -230 (the same idea as the NFL
 * rule DEC-20261115-53: a call once made is not taken back because the line
 * moved). If Leo drops under 60% or flips sides, there is no pick; a flip to a
 * new Leo Pick locks a new price.
 *
 * Stored in data/nba/pick-locks/<date>.json:
 *   { date, games: { <game_id>: { side, team, price, p, locked_at } } }
 * Written only by scripts/generate-nba-slate.js, only for games not yet tipped.
 * Never used as a model input: it only decides the price a pick is graded at.
 */
const fs = require("fs");
const path = require("path");
const PK = require("./nba-picks");

const LOCK_FROM = "2026-11-16";
const DIR = path.join(__dirname, "..", "..", "data", "nba", "pick-locks");
const file = date => path.join(DIR, `${date}.json`);
const cache = {};

function load(date) {
  if (!(date in cache)) { try { cache[date] = JSON.parse(fs.readFileSync(file(date), "utf8")); } catch (e) { cache[date] = { date, games: {} }; } }
  return cache[date];
}
/** The pick as Leo reads it now, with the locked price applied. pk is PK.pick()/pickForGame() output. */
function apply(date, gameId, pk, opt = {}) {
  if (!pk || date < LOCK_FROM) return pk;
  const L = load(date).games[String(gameId)];
  // Hold (HO-0097, option B): no lock yet and the last read before tip rested on an open day-to-day status.
  const H = (load(date).holds || {})[String(gameId)];
  if (!opt.ignoreHold && !L && pk.ok && H && H.held) return { ...pk, ok: false, held: true, why: `too close to call: rested on ${H.players.join(" and ")} (day-to-day)` };
  if (!L || L.side !== pk.side || pk.p < 0.6) return pk;
  return { ...pk, price: L.price, ok: true, why: "", locked: true };
}
/** Lock the price the first time a game is a Leo Pick (or when Leo flips to a new Leo Pick). Returns true if a lock was written. */
function lock(date, gameId, pk, at) {
  if (!pk || !pk.ok || date < LOCK_FROM) return false;
  const doc = load(date), L = doc.games[String(gameId)];
  if (L && L.side === pk.side) return false;
  doc.games[String(gameId)] = { side: pk.side, team: pk.team, price: pk.price, p: +(+pk.p).toFixed(4), locked_at: at };
  return true;
}
/** Record whether this read holds the game (HO-0097, option B). The last read before tip is the one the grader sees. */
function hold(date, gameId, h) {
  if (date < LOCK_FROM) return false;
  const doc = load(date); doc.holds = doc.holds || {};
  const prev = JSON.stringify(doc.holds[String(gameId)] || null), next = h ? { held: true, side: h.side, players: h.players, at: h.at } : null;
  if (prev === JSON.stringify(next)) return false;
  if (next) doc.holds[String(gameId)] = next; else delete doc.holds[String(gameId)];
  return true;
}
/** The hold saved for a game this date, if any (sticky skip, Lynold 2026-11-16). */
function heldFor(date, gameId) { const H = (load(date).holds || {})[String(gameId)]; return H && H.held ? H : null; }
function save(date) {
  if (!(date in cache) || date < LOCK_FROM) return;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file(date), JSON.stringify(cache[date], null, 1) + "\n");
}
module.exports = { LOCK_FROM, load, apply, lock, hold, heldFor, save, units: PK.units };
