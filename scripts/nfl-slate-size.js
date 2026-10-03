#!/usr/bin/env node
/*
  How many NFL games are scheduled on a date.

  Prints a single number, or "unknown" if the schedule could not be read.
  The workflows use it to skip a day with no games instead of running a
  whole gather for an empty slate.

  Same feed the models use: nflverse games.csv, matched on gameday.

  USAGE
    node scripts/nfl-slate-size.js 2026-10-05
*/
const FEED = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";
const DATE = process.argv[2] || new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);

(async () => {
  try {
    const r = await fetch(FEED, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    const head = lines[0].split(",");
    const iDate = head.indexOf("gameday");
    if (iDate < 0) throw new Error("no gameday column");
    const n = lines.slice(1).filter(l => l.split(",")[iDate] === DATE).length;
    console.log(String(n));
  } catch (e) {
    // Never fail the caller: an unreadable feed must not be read as
    // "no games", which would skip a real slate silently.
    console.error(`schedule unavailable: ${e.message}`);
    console.log("unknown");
  }
})();
