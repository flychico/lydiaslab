/**
 * Leo NFL game page addresses (SEO-09, HO-0023 part B, DEC-20261107-50).
 *
 * From the 2026-11-12 slate (Week 10) a game page lives at
 *   /nfl/<away nickname>-vs-<home nickname>-prediction-odds-<date>/
 * e.g. /nfl/commanders-vs-giants-prediction-odds-2026-11-12/, because people
 * search "Commanders vs Giants prediction", not "WAS vs NYG". Earlier pages
 * keep their abbreviation addresses (/nfl/buf-vs-min-prediction-odds-...),
 * so nothing already published moves.
 *
 * One copy for the matchup data (slug, url), the health check, the
 * scoreboard and the Picks page. Pure; works in Node and the browser
 * (window.NFL_URLS). Nicknames match scripts/lib/nfl-teams.js nick()
 * (checked by scripts/test/test-nfl-urls.js).
 */
(function () {
'use strict';

const NICK_FROM = "2026-11-12";
const NICK = {
  ARI: "Cardinals", ATL: "Falcons", BAL: "Ravens", BUF: "Bills", CAR: "Panthers", CHI: "Bears",
  CIN: "Bengals", CLE: "Browns", DAL: "Cowboys", DEN: "Broncos", DET: "Lions", GB: "Packers",
  HOU: "Texans", IND: "Colts", JAX: "Jaguars", KC: "Chiefs", LA: "Rams", LAC: "Chargers",
  LV: "Raiders", MIA: "Dolphins", MIN: "Vikings", NE: "Patriots", NO: "Saints", NYG: "Giants",
  NYJ: "Jets", PHI: "Eagles", PIT: "Steelers", SEA: "Seahawks", SF: "49ers", TB: "Buccaneers",
  TEN: "Titans", WAS: "Commanders"
};
const clean = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const teamPart = (abbr, date) => clean(date >= NICK_FROM && NICK[String(abbr).toUpperCase()] ? NICK[String(abbr).toUpperCase()] : abbr);

/** Old abbreviation folder name (every page before NICK_FROM). */
function oldSlug(away, home, date) { return `${clean(away)}-vs-${clean(home)}-prediction-odds-${date}`; }
/** Folder name of the game page for this date. */
function gameSlug(away, home, date) { return `${teamPart(away, date)}-vs-${teamPart(home, date)}-prediction-odds-${date}`; }
/** Site path of the game page, with slashes. */
function gameUrl(away, home, date) { return `/nfl/${gameSlug(away, home, date)}/`; }

const api = { NICK_FROM, NICK, gameSlug, gameUrl, oldSlug };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else if (typeof window !== "undefined") window.NFL_URLS = api;
})();
