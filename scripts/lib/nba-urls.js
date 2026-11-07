/**
 * Leo NBA game addresses (SEO-09, HO-0023 part C, DEC-20261107-30).
 * One helper for the game page, the nightly page, the card email, the
 * picks data (home page card) and the browser pages, so they always agree.
 *
 *   gameSlug(g)  -> "trail-blazers-vs-suns-prediction-odds-2026-11-07"
 *   gamePath(g)  -> "/nba/<slug>/"
 *
 * g needs away, home, date (and away_name / home_name when available).
 * Games dated before NICK_FROM keep their published abbreviation address
 * (wsh-vs-atl-prediction-odds-2026-11-06): pages already out never move.
 * From NICK_FROM the address uses team nicknames, the words people search
 * ("Trail Blazers vs Suns prediction"), in the same shape as MLB and the NFL.
 */
(function () {
'use strict';

const NICK_FROM = "2026-11-07";

// From data/nba/schedule.json team names: last word, except "Trail Blazers".
const NICK = {
  ATL: "Hawks", BKN: "Nets", BOS: "Celtics", CHA: "Hornets", CHI: "Bulls", CLE: "Cavaliers", DAL: "Mavericks",
  DEN: "Nuggets", DET: "Pistons", GS: "Warriors", HOU: "Rockets", IND: "Pacers", LAC: "Clippers", LAL: "Lakers",
  MEM: "Grizzlies", MIA: "Heat", MIL: "Bucks", MIN: "Timberwolves", NO: "Pelicans", NY: "Knicks", OKC: "Thunder",
  ORL: "Magic", PHI: "76ers", PHX: "Suns", POR: "Trail Blazers", SA: "Spurs", SAC: "Kings", TOR: "Raptors",
  UTAH: "Jazz", WSH: "Wizards"
};

/** Nickname from a full team name ("Portland Trail Blazers" -> "Trail Blazers"). */
function nickFromName(name) {
  const w = String(name || "").trim().split(/\s+/);
  if (!w[0]) return "";
  return w.slice(-2).join(" ") === "Trail Blazers" ? "Trail Blazers" : w[w.length - 1];
}
/** Nickname for a team: the fixed list first, else the full name, else the abbreviation. */
function nick(abbr, name) { return NICK[abbr] || nickFromName(name) || String(abbr || ""); }
/** Lower case; anything that is not a letter or digit becomes a hyphen. */
const slugify = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
/** The part of an address that names one team: nickname from NICK_FROM, abbreviation before. */
function teamSlug(abbr, date, name) { return date && date < NICK_FROM ? String(abbr || "").toLowerCase() : slugify(nick(abbr, name)); }

function gameSlug(g) {
  const date = g.date;
  return `${teamSlug(g.away, date, g.away_name)}-vs-${teamSlug(g.home, date, g.home_name)}-prediction-odds-${date}`;
}
const gamePath = g => `/nba/${gameSlug(g)}/`;

const api = { NICK_FROM, NICK, nick, nickFromName, slugify, teamSlug, gameSlug, gamePath };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else if (typeof window !== "undefined") window.NBA_URLS = api;
})();
