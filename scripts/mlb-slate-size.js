#!/usr/bin/env node
/*
  How many MLB games Leo would price on a date.

  Prints a single number, or "unknown" if the schedule could not be read.
  Used by the workflows to tell two things apart that look identical in a
  failed run: a day with no games (clean skip) and a pipeline that broke.

  Counts what the models count: regular season AND postseason
  (scripts/lib/mlb-game-types.js), never spring training or the all-star game.

  USAGE
    node scripts/mlb-slate-size.js 2026-09-30
*/
const { isCounted } = require("./lib/mlb-game-types");
const DATE = process.argv[2] || new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);

(async () => {
  try {
    const r = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}`,
                          { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const games = (j.dates || []).flatMap(d => d.games || [])
      .filter(isCounted);
    console.log(String(games.length));
  } catch (e) {
    // Never fail the caller: an unreadable schedule must not be read as
    // "no games", which would skip a real slate silently.
    console.error(`schedule unavailable: ${e.message}`);
    console.log("unknown");
  }
})();
