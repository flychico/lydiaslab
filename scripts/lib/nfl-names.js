/*
  Leo — NFL player name matching between nflverse and the-odds-api.

  These two sources spell the same player differently often enough that a
  naive exact match loses real lines. Observed classes of mismatch:

    nflverse                the-odds-api
    ----------------------  ----------------------
    Kenneth Walker III      Kenneth Walker
    Marvin Harrison Jr.     Marvin Harrison Jr
    Amon-Ra St. Brown       Amon Ra St Brown
    D.K. Metcalf            DK Metcalf
    Michael Pittman Jr.     Michael Pittman

  WATCH LIST #23 APPLIES HERE. A name that fails to match looks EXACTLY like
  a player with no posted line -- both produce "no market". That is the silent
  failure this module exists to prevent, so matchPlayers() returns the
  unmatched list and callers are expected to print it, not swallow it.

  Matching is deliberately scoped: candidates are only ever compared WITHIN
  the same game and the same market. Two players sharing a normalized key
  across the league is common; sharing one inside a single game's single
  market is not. Any residual ambiguity is reported as unmatched rather than
  guessed -- a wrong line is far worse than a missing one.
*/

const SUFFIXES = /\b(jr|sr|ii|iii|iv|v)\b/g;

// Lowercase, strip accents, turn punctuation into spaces. Punctuation is the
// main offender: "Amon-Ra St. Brown" and "Amon Ra St Brown" must collapse to
// the same string, and "D.K." must become "d k".
function normName(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'`’‘\-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Primary key: normalized, generational suffix removed. Suffixes are dropped
// because the books are inconsistent about them and they never disambiguate
// two players inside one game.
function keyFull(s) {
  return normName(s).replace(SUFFIXES, "").replace(/\s+/g, " ").trim();
}

// Fallback key: first initial + last name. Catches "DK Metcalf" vs "D K
// Metcalf" and shortened first names. Looser, so it is only consulted after
// every exact match has been made.
function keyInitialLast(s) {
  const p = keyFull(s).split(" ").filter(Boolean);
  if (p.length < 2) return null;
  return `${p[0][0]} ${p[p.length - 1]}`;
}

/*
  Match a list of our players against a list of book players.

  ours  : [{ player, ...}]        -- carries whatever the caller needs back
  theirs: Map<string, object>     -- keyed by the book's raw player name

  Returns { matched: Map<ourPlayer, bookEntry>, unmatched: [ourPlayer],
            ambiguous: [{player, candidates}] }
*/
function matchPlayers(ours, theirs) {
  const matched = new Map();
  const unmatched = [];
  const ambiguous = [];

  // Index the book's players by both keys. Arrays, not single values, so
  // collisions are visible instead of silently overwriting each other.
  const byFull = new Map();
  const byInit = new Map();
  for (const [rawName, entry] of theirs.entries()) {
    const kf = keyFull(rawName);
    if (kf) { if (!byFull.has(kf)) byFull.set(kf, []); byFull.get(kf).push(entry); }
    const ki = keyInitialLast(rawName);
    if (ki) { if (!byInit.has(ki)) byInit.set(ki, []); byInit.get(ki).push(entry); }
  }

  const claimed = new Set();

  // Pass 1: exact key. Pass 2: initial+last, for whatever pass 1 left over.
  for (const pass of ["full", "init"]) {
    for (const o of ours) {
      if (matched.has(o.player)) continue;
      const k = pass === "full" ? keyFull(o.player) : keyInitialLast(o.player);
      if (!k) continue;
      const cands = ((pass === "full" ? byFull : byInit).get(k) || [])
        .filter(c => !claimed.has(c));
      if (cands.length === 1) {
        matched.set(o.player, cands[0]);
        claimed.add(cands[0]);
      } else if (cands.length > 1) {
        // Two book entries collapse to one key inside a single game+market.
        // Refuse rather than pick: a wrong line is worse than no line.
        ambiguous.push({ player: o.player, candidates: cands.map(c => c.name) });
      }
    }
  }

  for (const o of ours) {
    if (!matched.has(o.player) && !ambiguous.some(a => a.player === o.player)) {
      unmatched.push(o.player);
    }
  }
  return { matched, unmatched, ambiguous };
}

/*
  the-odds-api uses full club names; every one of our data files uses the
  nflverse abbreviation. Static because it is a fixed 32-row fact that has no
  business being a network dependency -- but assertTeamMap() below is wired
  into the health check so a relocation or rename fails LOUDLY rather than
  silently dropping one game's lines.

  Note LA (Rams) not LAR: that is the abbreviation nflverse uses and therefore
  the one every file in this repo uses.
*/
const TEAM_BY_FULL_NAME = {
  "Arizona Cardinals": "ARI",      "Atlanta Falcons": "ATL",
  "Baltimore Ravens": "BAL",       "Buffalo Bills": "BUF",
  "Carolina Panthers": "CAR",      "Chicago Bears": "CHI",
  "Cincinnati Bengals": "CIN",     "Cleveland Browns": "CLE",
  "Dallas Cowboys": "DAL",         "Denver Broncos": "DEN",
  "Detroit Lions": "DET",          "Green Bay Packers": "GB",
  "Houston Texans": "HOU",         "Indianapolis Colts": "IND",
  "Jacksonville Jaguars": "JAX",   "Kansas City Chiefs": "KC",
  "Las Vegas Raiders": "LV",       "Los Angeles Chargers": "LAC",
  "Los Angeles Rams": "LA",        "Miami Dolphins": "MIA",
  "Minnesota Vikings": "MIN",      "New England Patriots": "NE",
  "New Orleans Saints": "NO",      "New York Giants": "NYG",
  "New York Jets": "NYJ",          "Philadelphia Eagles": "PHI",
  "Pittsburgh Steelers": "PIT",    "San Francisco 49ers": "SF",
  "Seattle Seahawks": "SEA",       "Tampa Bay Buccaneers": "TB",
  "Tennessee Titans": "TEN",       "Washington Commanders": "WAS"
};

function abbrFor(fullName) {
  return TEAM_BY_FULL_NAME[String(fullName || "").trim()] || null;
}

// "Indianapolis Colts @ Kansas City Chiefs" -> "IND @ KC"
function gameKeyFromFullNames(away, home) {
  const a = abbrFor(away), h = abbrFor(home);
  return (a && h) ? `${a} @ ${h}` : null;
}

// Verifies the map against the abbreviations actually present in our data.
// Returns { ok, missing, extra } -- callers should FAIL on !ok.
function assertTeamMap(abbrevsInUse) {
  const mapped = new Set(Object.values(TEAM_BY_FULL_NAME));
  const inUse = new Set(abbrevsInUse);
  const missing = [...inUse].filter(t => !mapped.has(t));   // our data has it, map doesn't
  const extra   = [...mapped].filter(t => !inUse.has(t));   // map has it, our data doesn't
  return { ok: missing.length === 0, missing, extra, mapped: mapped.size };
}

module.exports = { normName, keyFull, keyInitialLast, matchPlayers,
                   TEAM_BY_FULL_NAME, abbrFor, gameKeyFromFullNames, assertTeamMap };
