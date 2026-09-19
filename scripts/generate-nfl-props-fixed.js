#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// Sept 20, 2026 schedule
const SCHEDULE = [
  { matchup: "Cincinnati Bengals @ Kansas City Chiefs", away: "Cincinnati Bengals", home: "Kansas City Chiefs", awayId: "CIN", homeId: "KC" },
  { matchup: "Denver Broncos @ Buffalo Bills", away: "Denver Broncos", home: "Buffalo Bills", awayId: "DEN", homeId: "BUF" },
  { matchup: "New York Jets @ Pittsburgh Steelers", away: "New York Jets", home: "Pittsburgh Steelers", awayId: "NYJ", homeId: "PIT" },
  { matchup: "New Orleans Saints @ Dallas Cowboys", away: "New Orleans Saints", home: "Dallas Cowboys", awayId: "NO", homeId: "DAL" }
];

const TEAM_STATS = {
  KC: { passDefRank: 8, rushDefRank: 12, offRank: 2, passingYardsAvg: 285, rushingYardsAvg: 145, name: "Kansas City Chiefs", qb: "Patrick Mahomes", wr: ["Travis Kelce", "Rashee Rice"], rb: "Isiah Pacheco" },
  CIN: { passDefRank: 20, rushDefRank: 18, offRank: 8, passingYardsAvg: 280, rushingYardsAvg: 110, name: "Cincinnati Bengals", qb: "Joe Burrow", wr: ["Ja'Marr Chase", "Tyler Boyd"], rb: "Evan McPherson" },
  BUF: { passDefRank: 5, rushDefRank: 3, offRank: 3, passingYardsAvg: 290, rushingYardsAvg: 125, name: "Buffalo Bills", qb: "Josh Allen", wr: ["Stefon Diggs", "Gabe Davis"], rb: "James Cook" },
  DEN: { passDefRank: 15, rushDefRank: 14, offRank: 18, passingYardsAvg: 240, rushingYardsAvg: 100, name: "Denver Broncos", qb: "Bo Nix", wr: ["Courtland Sutton", "Jerry Jeudy"], rb: "Javonte Williams" },
  PIT: { passDefRank: 6, rushDefRank: 8, offRank: 12, passingYardsAvg: 260, rushingYardsAvg: 120, name: "Pittsburgh Steelers", qb: "Russell Wilson", wr: ["George Pickens", "Diontae Johnson"], rb: "Najee Harris" },
  NYJ: { passDefRank: 22, rushDefRank: 20, offRank: 20, passingYardsAvg: 235, rushingYardsAvg: 95, name: "New York Jets", qb: "Aaron Rodgers", wr: ["Garrett Wilson", "Chris Moore"], rb: "Breece Hall" },
  DAL: { passDefRank: 12, rushDefRank: 10, offRank: 1, passingYardsAvg: 295, rushingYardsAvg: 135, name: "Dallas Cowboys", qb: "Dak Prescott", wr: ["CeeDee Lamb", "Michael Gallup"], rb: "Ezekiel Elliott" },
  NO: { passDefRank: 25, rushDefRank: 24, offRank: 22, passingYardsAvg: 265, rushingYardsAvg: 105, name: "New Orleans Saints", qb: "Derek Carr", wr: ["Chris Olave", "Rashid Shaheed"], rb: "Alvin Kamara" }
};

function projectQBPassYards(teamId, oppDefRank) {
  const base = TEAM_STATS[teamId].passingYardsAvg;
  return Math.round(base * (0.95 + oppDefRank / 32 * 0.1));
}

function projectWRRecYards(teamId, oppDefRank) {
  const base = TEAM_STATS[teamId].passingYardsAvg;
  const wrShare = base * 0.15;
  return Math.round(wrShare * (0.93 + oppDefRank / 32 * 0.12));
}

function projectRBRushYards(teamId, oppDefRank) {
  const base = TEAM_STATS[teamId].rushingYardsAvg;
  return Math.round(base * (0.90 + oppDefRank / 32 * 0.15));
}

function projectAnytimeTD(probability) {
  return Math.round(probability * 1000) / 1000;
}

function calculateMoneylineProb(homeId, awayId) {
  const home = TEAM_STATS[homeId];
  const away = TEAM_STATS[awayId];
  const homeFactor = (33 - home.offRank) / 32;
  const awayDefFactor = (33 - away.passDefRank - away.rushDefRank) / 64;
  let prob = 0.5 + homeFactor * 0.15 + awayDefFactor * 0.1;
  prob = Math.max(0.45, Math.min(0.65, prob));
  return Math.round(prob * 1000) / 1000;
}

console.log("🏈 Generating NFL props for Sept 20, 2026\n");

fs.mkdirSync(path.join(ROOT, "data/nfl"), { recursive: true });

let props = [];
let csvRows = ["date,type,matchup,player,team,projection,line,actual,result"];

SCHEDULE.forEach(game => {
  console.log(`⚔️  ${game.matchup}`);

  // Moneyline (DECIMAL format: 0.549 not "54.9%")
  const mlProb = calculateMoneylineProb(game.homeId, game.awayId);
  props.push({
    date: "2026-09-20",
    type: "MONEYLINE",
    matchup: game.matchup,
    player: null,
    team: game.home,
    projection: mlProb
  });
  csvRows.push(`2026-09-20,MONEYLINE,${game.matchup},,,${(mlProb*100).toFixed(1)}%,,`);

  // QB Pass Yards
  const homeQBYards = projectQBPassYards(game.homeId, TEAM_STATS[game.awayId].passDefRank);
  const awayQBYards = projectQBPassYards(game.awayId, TEAM_STATS[game.homeId].passDefRank);
  props.push({ date: "2026-09-20", type: "QB_PASS_YARDS", matchup: game.matchup, player: TEAM_STATS[game.homeId].qb, team: game.home, projection: homeQBYards });
  props.push({ date: "2026-09-20", type: "QB_PASS_YARDS", matchup: game.matchup, player: TEAM_STATS[game.awayId].qb, team: game.away, projection: awayQBYards });
  csvRows.push(`2026-09-20,QB_PASS_YARDS,${game.matchup},${TEAM_STATS[game.homeId].qb},${game.home},${homeQBYards},,`);
  csvRows.push(`2026-09-20,QB_PASS_YARDS,${game.matchup},${TEAM_STATS[game.awayId].qb},${game.away},${awayQBYards},,`);

  // WR Rec Yards
  const homeWRYards = projectWRRecYards(game.homeId, TEAM_STATS[game.awayId].passDefRank);
  const awayWRYards = projectWRRecYards(game.awayId, TEAM_STATS[game.homeId].passDefRank);
  props.push({ date: "2026-09-20", type: "WR_REC_YARDS", matchup: game.matchup, player: TEAM_STATS[game.homeId].wr[0], team: game.home, projection: homeWRYards });
  props.push({ date: "2026-09-20", type: "WR_REC_YARDS", matchup: game.matchup, player: TEAM_STATS[game.awayId].wr[0], team: game.away, projection: awayWRYards });
  csvRows.push(`2026-09-20,WR_REC_YARDS,${game.matchup},${TEAM_STATS[game.homeId].wr[0]},${game.home},${homeWRYards},,`);
  csvRows.push(`2026-09-20,WR_REC_YARDS,${game.matchup},${TEAM_STATS[game.awayId].wr[0]},${game.away},${awayWRYards},,`);

  // RB Rush Yards
  const homeRBYards = projectRBRushYards(game.homeId, TEAM_STATS[game.awayId].rushDefRank);
  const awayRBYards = projectRBRushYards(game.awayId, TEAM_STATS[game.homeId].rushDefRank);
  props.push({ date: "2026-09-20", type: "RB_RUSH_YARDS", matchup: game.matchup, player: TEAM_STATS[game.homeId].rb, team: game.home, projection: homeRBYards });
  props.push({ date: "2026-09-20", type: "RB_RUSH_YARDS", matchup: game.matchup, player: TEAM_STATS[game.awayId].rb, team: game.away, projection: awayRBYards });
  csvRows.push(`2026-09-20,RB_RUSH_YARDS,${game.matchup},${TEAM_STATS[game.homeId].rb},${game.home},${homeRBYards},,`);
  csvRows.push(`2026-09-20,RB_RUSH_YARDS,${game.matchup},${TEAM_STATS[game.awayId].rb},${game.away},${awayRBYards},,`);

  // Anytime TD (DECIMAL format: 0.05 not "5%")
  const tdProb = 0.05;
  [TEAM_STATS[game.homeId].qb, ...TEAM_STATS[game.homeId].wr, TEAM_STATS[game.homeId].rb].forEach(player => {
    props.push({ date: "2026-09-20", type: "ANYTIME_TD", matchup: game.matchup, player, team: game.home, projection: tdProb });
    csvRows.push(`2026-09-20,ANYTIME_TD,${game.matchup},${player},${game.home},${(tdProb*100).toFixed(1)}%,,`);
  });
  [TEAM_STATS[game.awayId].qb, ...TEAM_STATS[game.awayId].wr, TEAM_STATS[game.awayId].rb].forEach(player => {
    props.push({ date: "2026-09-20", type: "ANYTIME_TD", matchup: game.matchup, player, team: game.away, projection: tdProb });
    csvRows.push(`2026-09-20,ANYTIME_TD,${game.matchup},${player},${game.away},${(tdProb*100).toFixed(1)}%,,`);
  });

  console.log(`  💰 Moneyline: ${(mlProb*100).toFixed(1)}% (home)`);
  console.log(`  📊 QB: ${homeQBYards}, ${awayQBYards}`);
  console.log(`  🎯 WR: ${homeWRYards}, ${awayWRYards}`);
  console.log(`  🏃 RB: ${homeRBYards}, ${awayRBYards}`);
  console.log(`  🏈 TD: 6 players projected\n`);
});

fs.writeFileSync(path.join(ROOT, "data/nfl/props-2026-09-20.json"), JSON.stringify(props, null, 2));
fs.writeFileSync(path.join(ROOT, "data/nfl/nfl-props-log.csv"), csvRows.join("\n"));

console.log(`✅ Saved ${props.length} props to /data/nfl/props-2026-09-20.json`);
console.log(`📊 Logged to CSV\n`);
console.log(`🎯 Ready for 2026-09-20`);
