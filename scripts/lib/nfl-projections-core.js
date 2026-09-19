// NFL Projections Core — QB Pass Yards, WR Rec Yards, RB Rush Yards, Anytime TD
// Builds player-level prop projections for tomorrow's games

function projectQBPassingYards(player, seasonStats, opponentStats, gameContext) {
  /*
    QB Passing Yards projection
    Factors: season avg, recent trend, opponent pass defense, game script
  */
  if (!player || !seasonStats) return null;

  const seasonAvg = seasonStats.pass_yards_per_game || 0;
  const recentAvg = seasonStats.last_5_games_pass_yards || seasonAvg;
  const oppPassDefenseRank = opponentStats?.pass_defense_rank || 16; // 1=best, 32=worst
  
  // Blend: 60% recent, 40% season
  const blended = (0.6 * recentAvg) + (0.4 * seasonAvg);
  
  // Opponent difficulty adjustment (worse defense = higher projection)
  // Defensive rank 32 (worst) gets 1.1x boost, rank 1 (best) gets 0.9x
  const difficultyMultiplier = 0.95 + ((oppPassDefenseRank / 32) * 0.1);
  
  const projection = blended * difficultyMultiplier;
  
  return {
    player: player.name,
    position: 'QB',
    projection: Math.round(projection * 10) / 10,
    season_avg: Math.round(seasonAvg * 10) / 10,
    recent_avg: Math.round(recentAvg * 10) / 10,
    opp_rank: oppPassDefenseRank,
    notes: `${difficultyMultiplier.toFixed(2)}x difficulty adjustment`
  };
}

function projectWRReceivingYards(player, seasonStats, opponentStats, gameContext) {
  /*
    WR Receiving Yards projection
    Factors: target share, yards per target, opponent coverage rank, snap count %
  */
  if (!player || !seasonStats) return null;

  const targetShare = seasonStats.target_share || 0.15; // % of team targets
  const yardsPerTarget = seasonStats.yards_per_target || 8;
  const teamPassAttempts = gameContext?.estimated_pass_attempts || 32;
  const snapCountPct = seasonStats.snap_count_pct || 0.85;
  const oppCoverageRank = opponentStats?.pass_coverage_rank || 16;

  // Projected targets = team pass attempts × target share × snap count
  const projectedTargets = teamPassAttempts * targetShare * snapCountPct;
  
  // Coverage adjustment: worse coverage = slightly higher yards per target
  const coverageMultiplier = 0.95 + ((oppCoverageRank / 32) * 0.15);
  const adjustedYPT = yardsPerTarget * coverageMultiplier;
  
  const projection = projectedTargets * adjustedYPT;
  
  return {
    player: player.name,
    position: 'WR',
    projection: Math.round(projection * 10) / 10,
    projected_targets: Math.round(projectedTargets * 10) / 10,
    yards_per_target: Math.round(adjustedYPT * 10) / 10,
    target_share: (targetShare * 100).toFixed(1) + '%',
    snap_count: (snapCountPct * 100).toFixed(1) + '%',
    opp_coverage_rank: oppCoverageRank
  };
}

function projectRBRushingYards(player, seasonStats, opponentStats, gameContext) {
  /*
    RB Rushing Yards projection
    Factors: carry share, yards per carry, opponent run defense, game script
  */
  if (!player || !seasonStats) return null;

  const carryShare = seasonStats.carry_share || 0.40;
  const yardsPerCarry = seasonStats.yards_per_carry || 4.0;
  const teamRushAttempts = gameContext?.estimated_rush_attempts || 20;
  const oppRunDefenseRank = opponentStats?.run_defense_rank || 16;

  // Projected carries = team rush attempts × carry share
  const projectedCarries = teamRushAttempts * carryShare;
  
  // Run defense adjustment: worse run defense = higher YPC
  const defenseMultiplier = 0.90 + ((oppRunDefenseRank / 32) * 0.20);
  const adjustedYPC = yardsPerCarry * defenseMultiplier;
  
  const projection = projectedCarries * adjustedYPC;
  
  return {
    player: player.name,
    position: 'RB',
    projection: Math.round(projection * 10) / 10,
    projected_carries: Math.round(projectedCarries * 10) / 10,
    yards_per_carry: Math.round(adjustedYPC * 10) / 10,
    carry_share: (carryShare * 100).toFixed(1) + '%',
    opp_run_defense_rank: oppRunDefenseRank
  };
}

function projectAnytimeTD(player, seasonStats, opponentStats, gameContext) {
  /*
    Anytime TD projection (binary prop: yes/no)
    Uses: TD rate, red zone opportunity, opponent defensive strength
    Returns: probability 0-1 and recommendation
  */
  if (!player || !seasonStats) return null;

  const seasonTDRate = seasonStats.td_rate || 0.05; // TDs / touches
  const recentTDRate = seasonStats.recent_td_rate || seasonTDRate;
  
  // Blend recent vs season
  const blendedTDRate = (0.65 * recentTDRate) + (0.35 * seasonTDRate);
  
  // Red zone probability: % of team red zone opportunities this player gets
  const redZoneShare = seasonStats.red_zone_share || 0.25;
  const projectedRZOpp = gameContext?.estimated_rz_opportunities || 2.5;
  const playerRZOpp = projectedRZOpp * redZoneShare;
  
  // Opponent defensive strength adjustment
  const oppDefenseRank = opponentStats?.overall_defense_rank || 16;
  const defenseMultiplier = 0.85 + ((oppDefenseRank / 32) * 0.30); // Weaker D = better odds
  
  // Probability = 1 - (1 - rate)^opportunities
  const baseProbability = 1 - Math.pow(1 - blendedTDRate, playerRZOpp);
  const adjustedProbability = Math.min(baseProbability * defenseMultiplier, 0.95);
  
  return {
    player: player.name,
    position: player.position,
    td_probability: Math.round(adjustedProbability * 1000) / 10 + '%',
    probability_decimal: Math.round(adjustedProbability * 100) / 100,
    season_td_rate: (seasonTDRate * 100).toFixed(2) + '%',
    recent_td_rate: (recentTDRate * 100).toFixed(2) + '%',
    rz_opportunity: Math.round(playerRZOpp * 10) / 10,
    recommendation: adjustedProbability > 0.20 ? 'LEAN YES' : adjustedProbability > 0.12 ? 'SLIGHT LEAN YES' : 'LEAN NO'
  };
}

function projectMoneyline(homeTeam, awayTeam, seasonStats, recentForm, injuryReport) {
  /*
    Moneyline projection (Win Probability %)
    Factors: season strength, recent form, key injuries, home advantage
  */
  if (!homeTeam || !awayTeam) return null;

  // Base: season win rates
  const homeWinRate = seasonStats[homeTeam].win_pct || 0.500;
  const awayWinRate = seasonStats[awayTeam].win_pct || 0.500;
  
  // Recent form: last 4 weeks trend
  const homeRecentWinRate = recentForm[homeTeam] || homeWinRate;
  const awayRecentWinRate = recentForm[awayTeam] || awayWinRate;
  
  // Blend: 60% recent, 40% season
  const homeBlended = (0.6 * homeRecentWinRate) + (0.4 * homeWinRate);
  const awayBlended = (0.6 * awayRecentWinRate) + (0.4 * awayWinRate);
  
  // Home field advantage: ~3% boost
  const homeAdvantage = 1.03;
  
  // Injury impact
  const homeInjuryImpact = calculateInjuryImpact(injuryReport[homeTeam] || []);
  const awayInjuryImpact = calculateInjuryImpact(injuryReport[awayTeam] || []);
  
  // Calculate win probability using logistic model
  let homeProb = (homeBlended * homeAdvantage * homeInjuryImpact) / 
                 ((homeBlended * homeAdvantage * homeInjuryImpact) + (awayBlended * awayInjuryImpact));
  
  homeProb = Math.max(0.35, Math.min(0.95, homeProb)); // Clamp to reasonable range
  
  return {
    matchup: `${awayTeam} @ ${homeTeam}`,
    home_team: homeTeam,
    away_team: awayTeam,
    home_win_probability: Math.round(homeProb * 1000) / 10 + '%',
    away_win_probability: Math.round((1 - homeProb) * 1000) / 10 + '%',
    home_prob_decimal: Math.round(homeProb * 100) / 100,
    key_factors: {
      home_recent: (homeRecentWinRate * 100).toFixed(1) + '%',
      away_recent: (awayRecentWinRate * 100).toFixed(1) + '%',
      home_injuries: homeInjuryImpact < 1 ? 'SIGNIFICANT' : 'NONE',
      away_injuries: awayInjuryImpact < 1 ? 'SIGNIFICANT' : 'NONE'
    }
  };
}

function calculateInjuryImpact(injuries) {
  /*
    Rough injury impact: key position impact
    QB out = -0.15, Star RB/WR = -0.05 per player, etc.
  */
  let impact = 1.0;
  
  if (!Array.isArray(injuries)) return impact;
  
  injuries.forEach(inj => {
    if (inj.position === 'QB' && inj.status === 'OUT') impact *= 0.85;
    if ((inj.position === 'RB' || inj.position === 'WR') && inj.importance === 'STAR' && inj.status === 'OUT') impact *= 0.95;
  });
  
  return impact;
}

module.exports = {
  projectQBPassingYards,
  projectWRReceivingYards,
  projectRBRushingYards,
  projectAnytimeTD,
  projectMoneyline
};
