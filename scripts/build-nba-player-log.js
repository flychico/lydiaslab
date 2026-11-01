#!/usr/bin/env node
/**
 * Leo NBA player scoring log for /nba/players/ and the matchup pages.
 *
 *   node scripts/build-nba-player-log.js     writes data/nba/player-log.json
 *
 * Every player's game-by-game line this season: points, minutes, rebounds,
 * assists. Sources, merged by game and player:
 *   1. the sportsdataverse player box file (ESPN data; about a day behind)
 *   2. data/nba/boxscores/<date>.json, saved from ESPN's game summary at
 *      grading (the night before, so the log is current each morning)
 * A game in both counts once. Display only: nothing here feeds Leo's numbers.
 */
const fs = require("fs");
const path = require("path");
const M = require("./lib/nba-model");

const DIR = path.join(__dirname, "..", "data", "nba");
const BOX = path.join(DIR, "boxscores");
const n = v => { const x = parseFloat(String(v ?? "").replace(/^\+/, "")); return Number.isFinite(x) ? x : 0; };

(async () => {
  const model = JSON.parse(fs.readFileSync(path.join(DIR, "model.json"), "utf8"));
  const season = model.season;
  const lines = new Map();      // game_id|player id -> line
  const oppOf = new Map();      // game_id|team -> opponent
  let releaseThrough = null;
  try {
    const { games, players } = await M.loadSeason(season);
    for (const g of games) { oppOf.set(g.game_id + "|" + g.home, g.away); oppOf.set(g.game_id + "|" + g.away, g.home); }
    for (const p of players) {
      lines.set(p.game_id + "|" + p.id, { game_id: p.game_id, date: p.date, id: p.id, name: p.name, team: p.team,
        min: Math.round(p.minutes), pts: p.pts, reb: p.reb, ast: p.ast, played: !!p.played });
      if (!releaseThrough || p.date > releaseThrough) releaseThrough = p.date;
    }
  } catch (e) { console.log("Release file not read: " + e.message); }
  let espnGames = 0;
  if (fs.existsSync(BOX)) for (const f of fs.readdirSync(BOX).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()) {
    const day = JSON.parse(fs.readFileSync(path.join(BOX, f), "utf8"));
    for (const g of day.games || []) {
      espnGames++;
      oppOf.set(g.game_id + "|" + g.home, g.away); oppOf.set(g.game_id + "|" + g.away, g.home);
      for (const p of g.players || []) {
        if (!p.id) continue;
        const s = p.stats || {};
        lines.set(g.game_id + "|" + p.id, { game_id: g.game_id, date: day.date, id: p.id, name: p.name, team: p.team,
          min: Math.round(p.minutes || 0), pts: n(s.points), reb: n(s.rebounds), ast: n(s.assists), played: !p.dnp && (p.minutes || 0) > 0 });
      }
    }
  }
  const byPlayer = new Map();
  for (const l of lines.values()) { if (!byPlayer.has(l.id)) byPlayer.set(l.id, []); byPlayer.get(l.id).push(l); }
  const r1 = v => Math.round(v * 10) / 10;
  const players = [];
  for (const [id, ls] of byPlayer) {
    ls.sort((a, b) => a.date.localeCompare(b.date));
    const played = ls.filter(l => l.played);
    if (!played.length) continue;
    const last = ls[ls.length - 1], sum = k => played.reduce((s, l) => s + l[k], 0), gp = played.length;
    players.push({
      id, name: last.name, team: last.team, gp, ppg: r1(sum("pts") / gp), mpg: r1(sum("min") / gp), rpg: r1(sum("reb") / gp), apg: r1(sum("ast") / gp),
      high: Math.max(...played.map(l => l.pts)), last5: r1(played.slice(-5).reduce((s, l) => s + l.pts, 0) / Math.min(5, gp)),
      // game log, oldest first: [date, opponent, minutes, points, rebounds, assists] (minutes 0 = did not play)
      log: ls.map(l => [l.date, oppOf.get(l.game_id + "|" + l.team) || "", l.played ? l.min : 0, l.played ? l.pts : null, l.played ? l.reb : null, l.played ? l.ast : null])
    });
  }
  players.sort((a, b) => b.ppg - a.ppg || b.gp - a.gp);
  const through = [...lines.values()].reduce((m, l) => l.date > m ? l.date : m, "");
  fs.writeFileSync(path.join(DIR, "player-log.json"), JSON.stringify({
    season, data_through: through, release_through: releaseThrough, espn_games: espnGames, updated_at: new Date().toISOString(), players
  }) + "\n");
  console.log(`NBA player log ${season}: ${players.length} players through ${through} (release through ${releaseThrough}, ${espnGames} ESPN box scores). Top scorer ${players[0] && players[0].name} ${players[0] && players[0].ppg}.`);
})().catch(e => { console.error(e); process.exit(1); });
