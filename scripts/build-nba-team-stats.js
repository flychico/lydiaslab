#!/usr/bin/env node
/**
 * Leo NBA standings, ratings and team stats for /nba/stats/.
 *
 *   node scripts/build-nba-team-stats.js      writes data/nba/team-stats.json
 *
 * From this season's team box scores (ESPN via the sportsdataverse release):
 * record, home and away, last 10, streak, points for and against, pace
 * (possessions per game) and points per 100 possessions on offence and
 * defence. The Leo rating is the same ridge rating the nightly card uses
 * (scripts/lib/nba-model.js ratings(), pulled toward last season), so the
 * stats page and the card never disagree. Display only.
 */
const fs = require("fs");
const path = require("path");
const M = require("./lib/nba-model");
const P = require("./lib/nba-points");

const DIR = path.join(__dirname, "..", "data", "nba");
// Conferences and divisions, ESPN abbreviations (2026-27).
const DIVS = {
  "East: Atlantic": ["BOS", "BKN", "NY", "PHI", "TOR"], "East: Central": ["CHI", "CLE", "DET", "IND", "MIL"],
  "East: Southeast": ["ATL", "CHA", "MIA", "ORL", "WSH"], "West: Northwest": ["DEN", "MIN", "OKC", "POR", "UTAH"],
  "West: Pacific": ["GS", "LAC", "LAL", "PHX", "SAC"], "West: Southwest": ["DAL", "HOU", "MEM", "NO", "SA"]
};
const DIV_OF = Object.fromEntries(Object.entries(DIVS).flatMap(([d, ts]) => ts.map(t => [t, d])));

(async () => {
  const model = JSON.parse(fs.readFileSync(path.join(DIR, "model.json"), "utf8"));
  const season = model.season;
  const games = await P.loadTeamGames(season);
  const teams = Object.keys(DIV_OF).sort();
  if (!games.length) { console.log("NBA team stats: no games yet; nothing written."); return; }
  const flat = games.map(g => ({ game_id: g.game_id, date: g.date, home: g.home.team, away: g.away.team, margin: g.home.pts - g.away.pts }));
  const { r, hca } = M.ratings(flat, [...new Set([...teams, ...flat.flatMap(g => [g.home, g.away])])].sort(), model.prior_ratings);
  const out = teams.map(t => {
    const mine = games.filter(g => g.home.team === t || g.away.team === t).map(g => {
      const home = g.home.team === t, me = home ? g.home : g.away, op = home ? g.away : g.home;
      return { date: g.date, home, opp: op.team, pf: me.pts, pa: op.pts, won: me.pts > op.pts, poss: (me.poss + op.poss) / 2, myPoss: me.poss, opPoss: op.poss };
    });
    const rec = a => ({ w: a.filter(x => x.won).length, l: a.filter(x => !x.won).length });
    const sum = (a, k) => a.reduce((s, x) => s + x[k], 0);
    const n = mine.length;
    let streak = "";
    if (n) { const last = mine[n - 1].won; let k = 0; for (let i = n - 1; i >= 0 && mine[i].won === last; i--) k++; streak = (last ? "W" : "L") + k; }
    const r1 = v => Math.round(v * 10) / 10;
    return {
      team: t, div: DIV_OF[t], gp: n, ...rec(mine),
      home: rec(mine.filter(x => x.home)), away: rec(mine.filter(x => !x.home)), last10: rec(mine.slice(-10)), streak,
      ppg: n ? r1(sum(mine, "pf") / n) : null, opp_ppg: n ? r1(sum(mine, "pa") / n) : null, margin: n ? r1((sum(mine, "pf") - sum(mine, "pa")) / n) : null,
      pace: n ? r1(sum(mine, "poss") / n) : null,
      off_rtg: n ? r1(100 * sum(mine, "pf") / sum(mine, "myPoss")) : null, def_rtg: n ? r1(100 * sum(mine, "pa") / sum(mine, "opPoss")) : null,
      leo_rating: r[t] == null ? null : r1(r[t])
    };
  });
  const ranked = out.slice().sort((a, b) => (b.leo_rating ?? -99) - (a.leo_rating ?? -99));
  ranked.forEach((x, i) => { x.leo_rank = i + 1; });
  const through = games[games.length - 1].date;
  fs.writeFileSync(path.join(DIR, "team-stats.json"), JSON.stringify({
    season, data_through: through, updated_at: new Date().toISOString(), games: games.length,
    home_court: Math.round(hca * 10) / 10, divisions: Object.keys(DIVS), teams: out
  }, null, 1) + "\n");
  console.log(`NBA team stats ${season}: ${games.length} games through ${through}. Top Leo rating ${ranked[0].team} ${ranked[0].leo_rating}.`);
})().catch(e => { console.error(e); process.exit(1); });
