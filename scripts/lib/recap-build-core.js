"use strict";

/*
  Shared recap builder: turns a game's pregame reasoning (member-brief record +
  canonical pitcher source) plus the actual boxscore into a RecapReview
  ({ paragraphs, data }). Used by BOTH generate-matchup-pages.js (live, at
  render time) and backfill-recaps.js (after the fact), so there is exactly one
  implementation of "how the analysis held up" — never two.
*/

const RecapReview = require("./recap-review-core");

function known(v) { return v !== null && v !== undefined && v !== ""; }

async function fetchBoxscore(gamePk) {
  const url = `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`;
  try {
    const response = await fetch(url, { headers: { "user-agent": "LyDia recap builder" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.warn(`Boxscore unavailable for game ${gamePk}: ${error.message}`);
    return null;
  }
}

/* MLB reports innings pitched as X.0 / X.1 / X.2 (whole innings plus zero, one,
   or two outs) -- not a decimal. Convert to a true decimal for ERA math. */
function parseIpToDecimal(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  const whole = Math.trunc(raw);
  const outs = Math.round((raw - whole) * 10);
  return whole + Math.min(outs, 2) / 3;
}

/* Pull the actual per-team pitching line out of a boxscore: the starter
   (matched against the pregame plan's starter pitcher_id, not list position)
   and every other pitcher aggregated as the bullpen's actual relief line. */
function extractPitchingActuals(boxscore, game) {
  if (!boxscore || !boxscore.teams) return null;
  const sideOf = (mlbSide, memberBriefSide) => {
    const team = boxscore.teams[mlbSide];
    if (!team || !team.players || !Array.isArray(team.pitchers)) return null;
    const plan = (game.pitching_plan && game.pitching_plan[memberBriefSide]) || null;
    const starterSegment = plan && Array.isArray(plan.segments)
      ? plan.segments.find(s => s.role !== "bullpen" && s.pitcher_id)
      : null;
    const starterPid = starterSegment ? String(starterSegment.pitcher_id) : String(team.pitchers[0] || "");

    let starter = null;
    const bullpenAgg = { ip: 0, er: 0, h: 0, bb: 0, k: 0 };
    let bullpenUsed = false;
    for (const pid of team.pitchers) {
      const entry = team.players[`ID${pid}`];
      const stats = entry && entry.stats && entry.stats.pitching;
      if (!stats) continue;
      const ip = parseIpToDecimal(stats.inningsPitched);
      const line = { ip, er: Number(stats.earnedRuns), h: Number(stats.hits), bb: Number(stats.baseOnBalls), k: Number(stats.strikeOuts) };
      if (String(pid) === starterPid) {
        starter = { name: entry.person && entry.person.fullName, ...line };
      } else if (ip !== null) {
        bullpenUsed = true;
        bullpenAgg.ip += ip; bullpenAgg.er += line.er; bullpenAgg.h += line.h; bullpenAgg.bb += line.bb; bullpenAgg.k += line.k;
      }
    }
    const teamPitching = team.teamStats && team.teamStats.pitching;
    return {
      starter,
      bullpen: bullpenUsed ? bullpenAgg : null,
      teamRunsAllowed: teamPitching ? Number(teamPitching.runs) : null,
      teamEarnedRunsAllowed: teamPitching ? Number(teamPitching.earnedRuns) : null
    };
  };
  const away = sideOf("away", "away");
  const home = sideOf("home", "home");
  if (!away && !home) return null;
  return { away, home };
}

function mapBullpen(game) {
  const bullpen = game.bullpen || {};
  if (!bullpen.pick_team || !bullpen.opponent) return { away: null, home: null };
  if (game.pick_team === game.away_team) return { away: bullpen.pick_team, home: bullpen.opponent };
  if (game.pick_team === game.home_team) return { away: bullpen.opponent, home: bullpen.pick_team };
  return { away: null, home: null };
}

/* Pure builder: pregame reasoning vs a boxscore already in hand. Returns the
   RecapReview or null. Runs for any Final game regardless of pick status. */
function buildReviewFromBoxscore(game, scheduleGame, pitcherGame, boxscore) {
  const actuals = extractPitchingActuals(boxscore, game);
  if (!actuals) return null;

  const finalAwayScore = known(scheduleGame && scheduleGame.teams && scheduleGame.teams.away && scheduleGame.teams.away.score)
    ? scheduleGame.teams.away.score : null;
  const finalHomeScore = known(scheduleGame && scheduleGame.teams && scheduleGame.teams.home && scheduleGame.teams.home.score)
    ? scheduleGame.teams.home.score : null;
  const actualInnings = scheduleGame && scheduleGame.linescore && Number.isFinite(Number(scheduleGame.linescore.currentInning))
    ? Number(scheduleGame.linescore.currentInning) : null;

  const bp = mapBullpen(game);
  const pitcher = pitcherGame || {};
  const projected = game.projected_runs || {};
  const offense = game.offense_form || {};

  const review = RecapReview.buildRecapReview({
    pickTeam: game.pick_team, awayTeam: game.away_team, homeTeam: game.home_team,
    finalAwayScore, finalHomeScore, actualInnings,
    strengthProbabilityPick: game.legacy_strength_probability,
    runModelProbabilityPick: game.run_model_probability,
    pitcherEdgeTeam: pitcher.edge_team, pitcherGap: pitcher.gap,
    awayPitcherName: pitcher.away && pitcher.away.name, homePitcherName: pitcher.home && pitcher.home.name,
    awayStarterActual: actuals.away && actuals.away.starter, homeStarterActual: actuals.home && actuals.home.starter,
    awayBullpenLabel: bp.away && bp.away.risk_label, homeBullpenLabel: bp.home && bp.home.risk_label,
    awayBullpenScore: bp.away && (bp.away.risk_index ?? bp.away.score), homeBullpenScore: bp.home && (bp.home.risk_index ?? bp.home.score),
    awayBullpenActual: actuals.away && actuals.away.bullpen, homeBullpenActual: actuals.home && actuals.home.bullpen,
    awayRunsAllowedByOpposingOffense: finalHomeScore, awayEarnedRunsAllowedByOpposingOffense: actuals.away && actuals.away.teamEarnedRunsAllowed,
    homeRunsAllowedByOpposingOffense: finalAwayScore, homeEarnedRunsAllowedByOpposingOffense: actuals.home && actuals.home.teamEarnedRunsAllowed,
    projectedAwayRuns: known(projected.away) ? Number(projected.away) : null,
    projectedHomeRuns: known(projected.home) ? Number(projected.home) : null,
    awayDeltaOps: offense.away && Number.isFinite(offense.away.delta_ops) ? offense.away.delta_ops : null,
    homeDeltaOps: offense.home && Number.isFinite(offense.home.delta_ops) ? offense.home.delta_ops : null
  });
  if (!review || !review.paragraphs.length) return null;
  return review;
}

module.exports = { fetchBoxscore, parseIpToDecimal, extractPitchingActuals, mapBullpen, buildReviewFromBoxscore };
