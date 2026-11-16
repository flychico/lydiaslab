/**
 * Final scores for NFL game grading on game day (HO-0076 part A, DEC-20261115-52).
 *
 * nflverse's games.csv is the source of record, but it fills a game's result
 * hours after the final whistle (on Nov 15, 2026 the 4:25pm game still had no
 * score at 8pm). ESPN's public scoreboard marks a game completed within
 * minutes. espnOverlay() fills ONLY the games nflverse has not finished,
 * and ONLY when ESPN says the game is completed, so a wave run an hour after a
 * window ends can grade it. A score nflverse already has is never replaced.
 *
 * The row it fills looks like an nflverse row (away_score, home_score, result
 * = home margin, overtime "1" or "0") plus finals_source "espn".
 *
 * Testing without network: NFL_ESPN_FILE=<path to a saved scoreboard json>.
 */
"use strict";
const fs = require("fs");
const { execFileSync } = require("child_process");

// ESPN abbreviations that differ from nflverse's.
const FROM_ESPN = { LAR: "LA", WSH: "WAS" };
const fromEspn = a => FROM_ESPN[a] || a;

function scoreboard(date) {
  if (process.env.NFL_ESPN_FILE) return JSON.parse(fs.readFileSync(process.env.NFL_ESPN_FILE, "utf8"));
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${date.replace(/-/g, "")}`;
  return JSON.parse(execFileSync("curl", ["-sSL", "--fail", "--max-time", "60", url], { encoding: "utf8", maxBuffer: 1 << 26 }));
}

// { "AWAY@HOME": { as, hs, overtime } } for every game ESPN marks completed.
function espnFinals(date) {
  let d;
  try { d = scoreboard(date); } catch (e) { console.log(`  ESPN scoreboard unavailable (${e.message.split("\n")[0]}); nflverse only.`); return {}; }
  const out = {};
  for (const ev of d.events || []) {
    const c = (ev.competitions || [])[0] || {};
    const st = c.status || ev.status || {};
    const t = st.type || {};
    if (!(t.completed === true || t.state === "post")) continue;
    if (/postponed|canceled|cancelled|suspended/i.test(String(t.name || "") + " " + String(t.description || ""))) continue;
    const h = (c.competitors || []).find(x => x.homeAway === "home"), a = (c.competitors || []).find(x => x.homeAway === "away");
    if (!h || !a) continue;
    const as = Number(a.score), hs = Number(h.score);
    if (!Number.isFinite(as) || !Number.isFinite(hs)) continue;
    out[`${fromEspn(a.team.abbreviation)}@${fromEspn(h.team.abbreviation)}`] = { as, hs, overtime: Number(st.period) > 4 };
  }
  return out;
}

/**
 * games: nflverse rows (any dates). Returns the same array with the given
 * date's unfinished games filled from ESPN where ESPN has a final.
 */
function espnOverlay(games, date) {
  const need = games.filter(g => g.gameday === date && String(g.result ?? "").trim() === "");
  if (!need.length) return games;
  const F = espnFinals(date);
  let filled = 0;
  for (const g of need) {
    const f = F[`${g.away_team}@${g.home_team}`];
    if (!f) continue;
    g.away_score = String(f.as); g.home_score = String(f.hs);
    g.result = String(f.hs - f.as); g.total = String(f.as + f.hs);
    g.overtime = f.overtime ? "1" : "0";
    g.finals_source = "espn";
    filled++;
  }
  if (filled) console.log(`  ${filled} final(s) for ${date} taken from ESPN (nflverse not posted yet).`);
  return games;
}

module.exports = { espnOverlay, espnFinals, fromEspn };
