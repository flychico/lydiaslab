/**
 * NFL team names by nflverse abbreviation. One copy for page titles, the
 * weekly card and emails. People search "Bears vs Packers", not "CHI vs GB".
 */
const NAMES = {
  ARI: "Arizona Cardinals", ATL: "Atlanta Falcons", BAL: "Baltimore Ravens", BUF: "Buffalo Bills",
  CAR: "Carolina Panthers", CHI: "Chicago Bears", CIN: "Cincinnati Bengals", CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys", DEN: "Denver Broncos", DET: "Detroit Lions", GB: "Green Bay Packers",
  HOU: "Houston Texans", IND: "Indianapolis Colts", JAX: "Jacksonville Jaguars", KC: "Kansas City Chiefs",
  LA: "Los Angeles Rams", LAC: "Los Angeles Chargers", LV: "Las Vegas Raiders", MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings", NE: "New England Patriots", NO: "New Orleans Saints", NYG: "New York Giants",
  NYJ: "New York Jets", PHI: "Philadelphia Eagles", PIT: "Pittsburgh Steelers", SEA: "Seattle Seahawks",
  SF: "San Francisco 49ers", TB: "Tampa Bay Buccaneers", TEN: "Tennessee Titans", WAS: "Washington Commanders"
};
const full = abbr => NAMES[abbr] || abbr;
// "Chicago Bears" -> "Bears"; "San Francisco 49ers" -> "49ers".
const nick = abbr => (NAMES[abbr] ? NAMES[abbr].split(" ").pop() : abbr);
module.exports = { NAMES, full, nick };
