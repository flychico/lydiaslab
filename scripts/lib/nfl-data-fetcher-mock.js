// Mock NFL Data Fetcher — Uses hardcoded 2026 NFL schedule for MVP testing
// In production, replace with real ESPN/NFL.com API calls

function fetchNFLSchedule(date) {
  /*
    Mock schedule for Sept 20, 2026 (NFL Week 2)
  */
  
  const mockGames = {
    '2026-09-20': [
      {
        id: 'game1',
        date: '2026-09-20T13:00:00Z',
        home_team: 'Kansas City Chiefs',
        away_team: 'Cincinnati Bengals',
        spread: -3.5,
        over_under: 44.5,
        time: '2026-09-20T13:00:00Z'
      },
      {
        id: 'game2',
        date: '2026-09-20T13:00:00Z',
        home_team: 'Buffalo Bills',
        away_team: 'Denver Broncos',
        spread: -8.0,
        over_under: 42.0,
        time: '2026-09-20T13:00:00Z'
      },
      {
        id: 'game3',
        date: '2026-09-20T13:00:00Z',
        home_team: 'Pittsburgh Steelers',
        away_team: 'New York Jets',
        spread: -4.0,
        over_under: 40.5,
        time: '2026-09-20T13:00:00Z'
      },
      {
        id: 'game4',
        date: '2026-09-20T16:05:00Z',
        home_team: 'Dallas Cowboys',
        away_team: 'New Orleans Saints',
        spread: -7.5,
        over_under: 47.0,
        time: '2026-09-20T16:05:00Z'
      }
    ]
  };
  
  return Promise.resolve(mockGames[date] || []);
}

function getPlayerSeasonStats(playerName, position) {
  const stats = {
    'QB': {
      pass_yards_per_game: 280,
      last_5_games_pass_yards: 290,
      td_per_game: 2.1,
      interceptions_per_game: 0.9
    },
    'WR': {
      target_share: 0.18,
      yards_per_target: 8.2,
      snap_count_pct: 0.88,
      catch_rate: 0.68,
      td_rate: 0.045,
      red_zone_share: 0.15
    },
    'RB': {
      carry_share: 0.45,
      yards_per_carry: 4.2,
      snap_count_pct: 0.75,
      red_zone_share: 0.30,
      td_rate: 0.06,
      recent_td_rate: 0.08
    }
  };
  
  return stats[position] || {};
}

function getTeamDefenseStats(teamName) {
  const defenses = {
    'Kansas City Chiefs': { pass_defense_rank: 8, run_defense_rank: 12, overall_defense_rank: 10, pass_coverage_rank: 7 },
    'Cincinnati Bengals': { pass_defense_rank: 15, run_defense_rank: 18, overall_defense_rank: 16, pass_coverage_rank: 14 },
    'Buffalo Bills': { pass_defense_rank: 5, run_defense_rank: 8, overall_defense_rank: 6, pass_coverage_rank: 4 },
    'Denver Broncos': { pass_defense_rank: 12, run_defense_rank: 10, overall_defense_rank: 11, pass_coverage_rank: 13 },
    'Pittsburgh Steelers': { pass_defense_rank: 3, run_defense_rank: 15, overall_defense_rank: 8, pass_coverage_rank: 2 },
    'New York Jets': { pass_defense_rank: 20, run_defense_rank: 22, overall_defense_rank: 21, pass_coverage_rank: 19 },
    'Dallas Cowboys': { pass_defense_rank: 18, run_defense_rank: 16, overall_defense_rank: 17, pass_coverage_rank: 20 },
    'New Orleans Saints': { pass_defense_rank: 10, run_defense_rank: 14, overall_defense_rank: 12, pass_coverage_rank: 11 }
  };
  
  return defenses[teamName] || { 
    pass_defense_rank: 16, 
    run_defense_rank: 16, 
    overall_defense_rank: 16,
    pass_coverage_rank: 16
  };
}

function getTeamSeasonStats(teamName) {
  return {
    win_pct: 0.500,
    offensive_points_per_game: 24.5,
    defensive_points_allowed: 23.1,
    pass_attempts_per_game: 32,
    rush_attempts_per_game: 20
  };
}

function getRecentFormWinRate(teamName, numGames = 4) {
  return 0.500;
}

function fetchOdds(homeTeam, awayTeam) {
  return {
    moneyline: { home: -120, away: +100 },
    spread: -3,
    over_under: 44.5,
    props: {}
  };
}

module.exports = {
  fetchNFLSchedule,
  getPlayerSeasonStats,
  getTeamDefenseStats,
  getTeamSeasonStats,
  getRecentFormWinRate,
  fetchOdds
};
