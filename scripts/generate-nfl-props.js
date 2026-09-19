#!/usr/bin/env node
/*
  Leo NFL Props Generator — Moneyline, QB Pass Yards, WR Rec Yards, RB Rush Yards, Anytime TD
  Generates projections for tomorrow's games
  
  Usage: node scripts/generate-nfl-props.js [--date YYYY-MM-DD]
*/

const fs = require('fs');
const path = require('path');
const projections = require('./lib/nfl-projections-core');
const fetcher = require('./lib/nfl-data-fetcher-mock');

const DATE = process.argv[2] === '--date' ? process.argv[3] : getTomorrowDate();
const DATA_DIR = path.join(__dirname, '../data/nfl');
const LOG_FILE = path.join(DATA_DIR, 'nfl-props-log.csv');

async function generateNFLProps() {
  console.log(`🏈 Generating Leo NFL Props for ${DATE}`);
  
  try {
    // 1. Fetch tomorrow's schedule
    console.log('📋 Fetching schedule...');
    const schedule = await fetcher.fetchNFLSchedule(DATE);
    
    if (!schedule || schedule.length === 0) {
      console.log('No games found for this date');
      return;
    }
    
    console.log(`Found ${schedule.length} games`);
    
    let allProps = [];
    
    // 2. Generate props for each game
    for (const game of schedule) {
      console.log(`\n⚔️  ${game.away_team} @ ${game.home_team}`);
      
      const gameProps = [];
      
      // MONEYLINE
      const moneyline = projections.projectMoneyline(
        game.home_team,
        game.away_team,
        buildSeasonStats([game.home_team, game.away_team]),
        buildRecentForm([game.home_team, game.away_team]),
        {}
      );
      
      gameProps.push({
        date: DATE,
        type: 'MONEYLINE',
        matchup: moneyline.matchup,
        home_team: game.home_team,
        away_team: game.away_team,
        projection: moneyline.home_win_probability,
        data: moneyline
      });
      
      console.log(`  💰 Moneyline: ${moneyline.home_win_probability} (home)`);
      
      // QB PASS YARDS
      const homeQB = { name: 'QB1', position: 'QB' };
      const awayQB = { name: 'QB2', position: 'QB' };
      
      const homeQBStats = fetcher.getPlayerSeasonStats(homeQB.name, 'QB');
      const awayDefense = fetcher.getTeamDefenseStats(game.away_team);
      const homeQBProj = projections.projectQBPassingYards(homeQB, homeQBStats, awayDefense, {});
      
      gameProps.push({
        date: DATE,
        type: 'QB_PASS_YARDS',
        matchup: game.away_team + ' @ ' + game.home_team,
        player: homeQB.name,
        team: game.home_team,
        projection: homeQBProj.projection,
        data: homeQBProj
      });
      
      const awayQBStats = fetcher.getPlayerSeasonStats(awayQB.name, 'QB');
      const homeDefense = fetcher.getTeamDefenseStats(game.home_team);
      const awayQBProj = projections.projectQBPassingYards(awayQB, awayQBStats, homeDefense, {});
      
      gameProps.push({
        date: DATE,
        type: 'QB_PASS_YARDS',
        matchup: game.away_team + ' @ ' + game.home_team,
        player: awayQB.name,
        team: game.away_team,
        projection: awayQBProj.projection,
        data: awayQBProj
      });
      
      console.log(`  📊 QB Pass Yards: ${homeQBProj.projection} (${game.home_team}), ${awayQBProj.projection} (${game.away_team})`);
      
      // WR RECEIVING YARDS
      const homeWR = { name: 'WR1', position: 'WR' };
      const awayWR = { name: 'WR2', position: 'WR' };
      
      const homeWRStats = fetcher.getPlayerSeasonStats(homeWR.name, 'WR');
      const homeWRProj = projections.projectWRReceivingYards(homeWR, homeWRStats, awayDefense, {});
      
      gameProps.push({
        date: DATE,
        type: 'WR_REC_YARDS',
        matchup: game.away_team + ' @ ' + game.home_team,
        player: homeWR.name,
        team: game.home_team,
        projection: homeWRProj.projection,
        data: homeWRProj
      });
      
      const awayWRStats = fetcher.getPlayerSeasonStats(awayWR.name, 'WR');
      const awayWRProj = projections.projectWRReceivingYards(awayWR, awayWRStats, homeDefense, {});
      
      gameProps.push({
        date: DATE,
        type: 'WR_REC_YARDS',
        matchup: game.away_team + ' @ ' + game.home_team,
        player: awayWR.name,
        team: game.away_team,
        projection: awayWRProj.projection,
        data: awayWRProj
      });
      
      console.log(`  🎯 WR Rec Yards: ${homeWRProj.projection} (${game.home_team}), ${awayWRProj.projection} (${game.away_team})`);
      
      // RB RUSHING YARDS
      const homeRB = { name: 'RB1', position: 'RB' };
      const awayRB = { name: 'RB2', position: 'RB' };
      
      const homeRBStats = fetcher.getPlayerSeasonStats(homeRB.name, 'RB');
      const homeRBProj = projections.projectRBRushingYards(homeRB, homeRBStats, awayDefense, {});
      
      gameProps.push({
        date: DATE,
        type: 'RB_RUSH_YARDS',
        matchup: game.away_team + ' @ ' + game.home_team,
        player: homeRB.name,
        team: game.home_team,
        projection: homeRBProj.projection,
        data: homeRBProj
      });
      
      const awayRBStats = fetcher.getPlayerSeasonStats(awayRB.name, 'RB');
      const awayRBProj = projections.projectRBRushingYards(awayRB, awayRBStats, homeDefense, {});
      
      gameProps.push({
        date: DATE,
        type: 'RB_RUSH_YARDS',
        matchup: game.away_team + ' @ ' + game.home_team,
        player: awayRB.name,
        team: game.away_team,
        projection: awayRBProj.projection,
        data: awayRBProj
      });
      
      console.log(`  🏃 RB Rush Yards: ${homeRBProj.projection} (${game.home_team}), ${awayRBProj.projection} (${game.away_team})`);
      
      // ANYTIME TOUCHDOWN
      const allPlayers = [homeQB, awayQB, homeWR, awayWR, homeRB, awayRB];
      
      allPlayers.forEach(player => {
        let stats;
        if (player.name === homeQB.name || player.name === awayQB.name) {
          stats = player.name === homeQB.name ? homeQBStats : awayQBStats;
        } else if (player.name === homeWR.name || player.name === awayWR.name) {
          stats = player.name === homeWR.name ? homeWRStats : awayWRStats;
        } else {
          stats = player.name === homeRB.name ? homeRBStats : awayRBStats;
        }
        
        const tdProj = projections.projectAnytimeTD(player, stats, {}, {});
        
        gameProps.push({
          date: DATE,
          type: 'ANYTIME_TD',
          matchup: game.away_team + ' @ ' + game.home_team,
          player: player.name,
          team: player.name === homeQB.name || player.name === homeWR.name || player.name === homeRB.name ? game.home_team : game.away_team,
          projection: tdProj.td_probability,
          data: tdProj
        });
      });
      
      console.log(`  🏈 Anytime TD: ${allPlayers.length} players projected`);
      
      allProps.push(...gameProps);
    }
    
    // 3. Save to JSON
    const outputFile = path.join(DATA_DIR, `props-${DATE}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(allProps, null, 2));
    console.log(`\n✅ Saved ${allProps.length} props to ${outputFile}`);
    
    // 4. Log to CSV for tracking
    logPropsToCSV(allProps);
    
    console.log(`\n🎯 Ready for ${DATE}`);
    return allProps;
    
  } catch (error) {
    console.error('Error generating NFL props:', error);
    process.exit(1);
  }
}

function logPropsToCSV(props) {
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, 'date,type,matchup,player,team,projection,line,actual,result\n');
  }
  
  const lines = props.map(p => {
    return [
      p.date,
      p.type,
      p.matchup,
      p.player || '',
      p.team || '',
      p.projection,
      '',
      '',
      ''
    ].join(',');
  });
  
  fs.appendFileSync(LOG_FILE, lines.join('\n') + '\n');
  console.log(`📊 Logged ${lines.length} props to CSV`);
}

function buildSeasonStats(teams) {
  const stats = {};
  teams.forEach(team => {
    stats[team] = fetcher.getTeamSeasonStats(team);
  });
  return stats;
}

function buildRecentForm(teams) {
  const form = {};
  teams.forEach(team => {
    form[team] = fetcher.getRecentFormWinRate(team);
  });
  return form;
}

function getTomorrowDate() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toISOString().split('T')[0];
}

if (require.main === module) {
  generateNFLProps().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { generateNFLProps };
