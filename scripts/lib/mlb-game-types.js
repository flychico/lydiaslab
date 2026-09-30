/*
  Which MLB games Leo treats as real games.

  DEC-20260930-02: the postseason is treated exactly like the regular season.
  Before this, every MLB script filtered to gameType "R", so from the day the
  regular season ended the whole pipeline saw an empty schedule.

  Counted:  R regular season, F wild card, D division series,
            L league championship, W world series
  Ignored:  S spring training, E exhibition, A all-star
  A game with no gameType at all is counted -- older captured rows omit it.

  ONE COPY. Every script that reads the MLB schedule imports this, so the
  postseason can never be half-included.
*/
const COUNTED = new Set(["R", "F", "D", "L", "W"]);
const POSTSEASON = new Set(["F", "D", "L", "W"]);

const typeOf = g => (typeof g === "string" ? g : (g && g.gameType));

/** Is this a game Leo prices and grades? */
function isCounted(g) {
  const t = typeOf(g);
  return t === undefined || t === null || t === "" || COUNTED.has(t);
}

/** Postseason, for anything that wants to report the two separately. */
function isPostseason(g) {
  return POSTSEASON.has(typeOf(g));
}

module.exports = { COUNTED, POSTSEASON, isCounted, isPostseason };
