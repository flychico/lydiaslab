"use strict";
/**
 * "Players to use" line for the ChatGPT card brief (business/CHATGPT_VISUALS.md).
 * Lynold, Nov 19: each picks email names a player per picked team, so the
 * graphic never features a star who is sitting out.
 *
 * players(sport, date, post) -> "Lakers: Luka Doncic, Mavericks: ..." or "".
 *   NBA: the team's top scorer this season (points per game, 3+ games) who is not
 *        on the injury report Leo read for that game (data/nba/picks-<date>.json).
 *   NFL: the starting quarterback in Leo's read (data/nfl/picks-<date>.json).
 * Teams come from the post lines: picks lines, and on results posts the winning
 * lines (✅). No-pick posts name a player for each team Leo likes. Display help only; changes no number.
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const read = f => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch (e) { return null; } };

const lastWord = n => /Trail Blazers$/.test(n || "") ? "Trail Blazers" : String(n || "").split(" ").pop();

function teamsInPost(post, nickOf) {
  if (!post) return [];
  // No-pick nights name a healthy player for each team Leo likes too (Lynold, Nov 19: Zach Edey was shown while out).
  const lines = (post.lines || []).filter(l => !/^No (Leo )?picks? /i.test(l)).filter(l => post.kind === "picks" || post.kind === "reads" || /✅/.test(l))
    .map(l => l.replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]\uFE0F?\s*/u, ""));
  const out = [];
  for (const l of lines) {
    // longest nickname that starts the line ("Trail Blazers ML -150", "49ers -3", "Steelers ML -218 ✅")
    const hit = Object.keys(nickOf).sort((a, b) => b.length - a.length).find(n => l === n || l.startsWith(n + " "));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

function nba(date, post) {
  const card = read(`data/nba/picks-${date}.json`), log = read("data/nba/player-log.json");
  if (!card || !log) return "";
  const nickOf = {};
  for (const g of card.games || []) for (const side of ["away", "home"]) nickOf[lastWord(g[side + "_name"])] = { g, side, code: g[side] };
  return teamsInPost(post, nickOf).map(n => {
    const { g, side, code } = nickOf[n];
    const listed = new Set(((g.leo && g.leo.missing && g.leo.missing[side]) || []).map(p => p.name));
    const best = (log.players || []).filter(p => p.team === code && (p.gp || 0) >= 3 && !listed.has(p.name))
      .sort((a, b) => (b.ppg || 0) - (a.ppg || 0))[0];
    return best ? `${n}: ${best.name}` : "";
  }).filter(Boolean).join(", ");
}

function nfl(date, post) {
  const list = read(`data/nfl/picks-${date}.json`);
  if (!Array.isArray(list)) return "";
  const T = require("./nfl-teams");
  const nickOf = {};
  for (const g of list) for (const side of ["away", "home"]) nickOf[T.nick(g[side])] = { qb: g[side + "_qb"] };
  return teamsInPost(post, nickOf).map(n => nickOf[n].qb ? `${n}: ${nickOf[n].qb}` : "").filter(Boolean).join(", ");
}

function players(sport, date, post) {
  try {
    if (sport === "parlay") {   // Leo Parlay: each leg by its sport emoji
      const pick = re => ({ ...post, lines: (post.lines || []).filter(l => re.test(l)) });
      return [nba(date, pick(/^🏀/u)), nfl(date, pick(/^🏈/u))].filter(Boolean).join(", ");
    }
    return sport === "nba" ? nba(date, post) : sport === "nfl" ? nfl(date, post) : "";
  } catch (e) { return ""; }
}

module.exports = { players };
