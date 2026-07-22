"use strict";

/*
  LyDia Bullpen Core v4, fatigue and efficiency split

  One source of truth for bullpen scoring.
  Used by:
  - scripts/generate-bullpen-index.js
  - scripts/generate-member-lab.js
  - tools/bullpen-fatigue/index.html through generated JSON only

  Three scores per team:
  Fatigue (workload only) = 45
    + ((Last 3 days BP IP - 3 x games played) x 3.5)
    + ((Last game BP IP - 3) x 4)
    + (Back-to-back arms x 6)
  Efficiency (performance only) = 50 centered on league-average reliever
    ERA 4.20 and WHIP 1.30, confidence-weighted for thin samples.
  risk_index = Fatigue - 0.5 x (Efficiency - 50). Every downstream consumer
  reads risk_index. Runs allowed lives in efficiency, never in fatigue.

  Reliever counts are context only. They are displayed, but they do not add hidden points.

  Design rule:
  Browser pages display generated bullpen data. They do not maintain a separate scoring model.
*/

const VERSION = "bullpen-fatigue-v5-recency-weighted";
const SOURCE_OF_TRUTH = "scripts/lib/bullpen-fatigue-core.js";
const LOOKBACK_DAYS = 5;        // scan 5 days so a rest/rainout day does not drop all games
const RECENCY_HALF_LIFE = 2;   // a game's fatigue weight halves every 2 days
const FATIGUE_IP_K = 4.2;      // points per weighted relief inning above the per-game baseline
const FATIGUE_B2B_K = 8;       // points per recency-weighted back-to-back arm

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function round(n, dp = 1) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const m = Math.pow(10, dp);
  return Math.round(n * m) / m;
}

function localISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dateShift(base, n) {
  const d = new Date(base + "T12:00:00");
  d.setDate(d.getDate() + n);
  return localISODate(d);
}

function ipToNum(ip) {
  if (!ip || ip === "-.--") return 0;
  const [whole, frac] = String(ip).split(".");
  return Number(whole || 0) + (Number(frac || 0) / 3);
}

async function getGamesForDate(date, fetchJson) {
  const data = await fetchJson(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`);
  return (((data.dates || [])[0]) || {}).games || [];
}

function createTeamState(todayGames) {
  const teams = {};
  for (const g of todayGames || []) {
    const away = g.teams && g.teams.away && g.teams.away.team;
    const home = g.teams && g.teams.home && g.teams.home.team;
    if (!away || !home) continue;
    teams[away.id] = {
      team_id: away.id,
      team: away.name,
      side: "away",
      opponent: home.name,
      game: `${away.name} @ ${home.name}`,
      game_pk: g.gamePk,
      game_time_iso: g.gameDate,
      games: [],
      pitcherDates: {}
    };
    teams[home.id] = {
      team_id: home.id,
      team: home.name,
      side: "home",
      opponent: away.name,
      game: `${away.name} @ ${home.name}`,
      game_pk: g.gamePk,
      game_time_iso: g.gameDate,
      games: [],
      pitcherDates: {}
    };
  }
  return teams;
}

function processBoxSide(box, side, teamId, date, teams, seq) {
  const team = teams[teamId];
  if (!team) return;

  const tb = box.teams && box.teams[side];
  if (!tb || !tb.pitchers || !tb.players) return;

  let totalIP = 0;
  let starterIP = 0;
  let starterRuns = 0;
  let starterER = 0;
  let starterH = 0;
  let starterBB = 0;
  let starterId = null;
  let relievers = 0;
  let bpRuns = 0;
  let bpER = 0;
  let bpH = 0;
  let bpBB = 0;
  const relieverIds = [];

  const pstat = player => (player && player.stats && player.stats.pitching) || {};

  for (let i = 0; i < tb.pitchers.length; i++) {
    const id = tb.pitchers[i];
    const player = tb.players["ID" + id];
    const stats = pstat(player);
    const ip = ipToNum(stats.inningsPitched);
    totalIP += ip;

    if (i === 0) {
      starterIP = ip;
      starterId = id;
      starterRuns = Number(stats.runs) || 0;
      starterER = Number(stats.earnedRuns) || 0;
      starterH = Number(stats.hits) || 0;
      starterBB = Number(stats.baseOnBalls) || 0;
    } else {
      relievers += 1;
      bpRuns += Number(stats.runs) || 0;
      bpER += Number(stats.earnedRuns) || 0;
      bpH += Number(stats.hits) || 0;
      bpBB += Number(stats.baseOnBalls) || 0;
      relieverIds.push(id);
      if (!team.pitcherDates[id]) team.pitcherDates[id] = new Set();
      team.pitcherDates[id].add(date);
    }
  }

  // Opener rule: a "starter" who threw ≤2 IP in a multi-pitcher game is pen
  // workload too (bullpen games, openers, blowup starts) — his innings, runs,
  // and availability count against the pen. Without this, bullpen games
  // undercount by exactly the opener's share.
  const openerGame = starterIP <= 2 && tb.pitchers.length >= 3;
  if (openerGame && starterId) {
    relievers += 1;
    bpRuns += starterRuns;
    bpER += starterER;
    bpH += starterH;
    bpBB += starterBB;
    if (!team.pitcherDates[starterId]) team.pitcherDates[starterId] = new Set();
    team.pitcherDates[starterId].add(date);
  }
  team.games.push({
    date,
    seq,
    bpIP: Math.max(0, openerGame ? totalIP : totalIP - starterIP),
    relievers,
    bpRuns,
    bpER,
    bpH,
    bpBB,
    opener_game: openerGame,
    relieverIds
  });
}

function daysAgoBetween(targetDate, gameDate) {
  const t = new Date(targetDate + "T12:00:00");
  const g = new Date(gameDate + "T12:00:00");
  return Math.max(1, Math.round((t - g) / 86400000));
}
function recencyWeight(daysAgo) {
  // 1.0 for a game the day before the target, halving every RECENCY_HALF_LIFE days.
  return Math.pow(0.5, (daysAgo - 1) / RECENCY_HALF_LIFE);
}
// Back-to-back arms, weighted by how recent the second appearance was. An arm
// that worked consecutive days ending yesterday counts full; one that ended
// three days ago counts little, because the rest since then has recovered it.
function weightedBackToBackArms(pitcherDates, targetDate) {
  let weighted = 0, rawCount = 0;
  for (const dates of Object.values(pitcherDates || {})) {
    const arr = [...dates].sort();
    let latestPairSecond = null;
    for (let i = 1; i < arr.length; i++) {
      const prev = new Date(arr[i - 1] + "T12:00:00");
      const curr = new Date(arr[i] + "T12:00:00");
      if ((curr - prev) / 86400000 === 1) latestPairSecond = arr[i];
    }
    if (latestPairSecond) {
      rawCount += 1;
      weighted += recencyWeight(daysAgoBetween(targetDate, latestPairSecond));
    }
  }
  return { weighted, rawCount };
}

function countBackToBackArms(pitcherDates) {
  let count = 0;
  for (const dates of Object.values(pitcherDates || {})) {
    const arr = [...dates].sort();
    for (let i = 1; i < arr.length; i++) {
      const prev = new Date(arr[i - 1] + "T12:00:00");
      const curr = new Date(arr[i] + "T12:00:00");
      if ((curr - prev) / 86400000 === 1) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

function scoreTeam(team, targetDate) {
  // Sort most-recent-game-first. Same calendar date can hold two games
  // (doubleheader) — date alone can't order those, so seq (assigned in
  // schedule/gameNumber order during collection) breaks the tie and puts
  // the later game of the day first, not whichever game happened to get
  // pushed first.
  const games = [...(team.games || [])].sort((a, b) => (new Date(b.date) - new Date(a.date)) || ((b.seq || 0) - (a.seq || 0)));
  const last = games[0] || { bpIP: 0, relievers: 0, bpRuns: 0, bpER: 0, bpH: 0, bpBB: 0, date: null };
  const ref = targetDate || (last.date ? dateShift(last.date, 1) : null);

  // The SCORE uses the full 5-day window with recency decay so a rest day
  // lowers fatigue. But every DISPLAYED stat and the efficiency calc use only
  // the true last-3-days games, so "last 3 days: 15.3 IP" stays honest and
  // matches what the score reason and the tool page show. A game 4-5 days out
  // still nudges the decayed score but never inflates the displayed 3-day sum.
  const recent3 = ref ? games.filter(g => daysAgoBetween(ref, g.date) <= 3) : games;
  const last3BP = recent3.reduce((s, g) => s + g.bpIP, 0);
  const last3Runs = recent3.reduce((s, g) => s + (g.bpRuns || 0), 0);
  const last3ER = recent3.reduce((s, g) => s + (g.bpER || 0), 0);
  const last3H = recent3.reduce((s, g) => s + (g.bpH || 0), 0);
  const last3BB = recent3.reduce((s, g) => s + (g.bpBB || 0), 0);
  const last3Relievers = recent3.reduce((s, g) => s + g.relievers, 0);
  const gamesTracked = recent3.length;

  // RECENCY-WEIGHTED FATIGUE. Each game's relief innings are weighted by how
  // many days before the target game it was pitched, decaying by half every
  // RECENCY_HALF_LIFE days. A rest day (including a rainout) pushes every game
  // one day older and lowers its weight, so an idle day genuinely reduces
  // fatigue instead of the old fixed-window behaviour where it did nothing.
  let weightedIP = 0, weightedExpected = 0;
  for (const g of games) {
    const w = ref ? recencyWeight(daysAgoBetween(ref, g.date)) : 1;
    weightedIP += g.bpIP * w;
    weightedExpected += 3 * w;   // 3 relief innings per game is the neutral load
  }
  const b2bInfo = ref ? weightedBackToBackArms(team.pitcherDates, ref) : { weighted: countBackToBackArms(team.pitcherDates), rawCount: countBackToBackArms(team.pitcherDates) };
  const b2b = b2bInfo.rawCount;
  const daysRest = ref && last.date ? daysAgoBetween(ref, last.date) : null;

  const components = {
    baseline: 45,
    weighted_bp_ip: (weightedIP - weightedExpected) * FATIGUE_IP_K,
    back_to_back_arms: b2bInfo.weighted * FATIGUE_B2B_K,
    reliever_counts_context_only: 0,
    no_recent_games_credit: gamesTracked === 0 ? -18 : 0
  };

  const rawScore = components.baseline
    + components.weighted_bp_ip
    + components.back_to_back_arms
    + components.reliever_counts_context_only
    + components.no_recent_games_credit;

  const score = Math.round(clamp(rawScore, 0, 100));

  let label = "Normal";
  if (score >= 82) label = "High risk";
  else if (score >= 62) label = "Tired";
  else if (score < 35) label = "Fresh";

  // EFFICIENCY: pure outcome, independent of workload. ERA and WHIP against
  // this window's bullpen innings, each measured against a league-average
  // reliever baseline (ERA 4.20, WHIP 1.30). A confidence multiplier shrinks
  // both terms toward the 50 baseline when the sample is thin (a few relief
  // innings can produce an extreme rate stat by pure small-sample noise) and
  // reaches full weight at 6+ bullpen innings.
  const era3d = last3BP > 0 ? (last3ER / last3BP) * 9 : null;
  const whip3d = last3BP > 0 ? (last3H + last3BB) / last3BP : null;
  const confidence = clamp(last3BP / 6, 0.35, 1);
  const eraTerm = era3d === null ? 0 : clamp(-(era3d - 4.20) * 6, -25, 25) * confidence;
  const whipTerm = whip3d === null ? 0 : clamp(-(whip3d - 1.30) * 15, -20, 20) * confidence;
  const efficiencyRaw = gamesTracked && last3BP > 0 ? 50 + eraTerm + whipTerm : null;
  const efficiencyScore = efficiencyRaw === null ? null : Math.round(clamp(efficiencyRaw, 0, 100));

  // 50 is the league-average neutral point (see baseline above), so bands
  // are centered on it — a pen sitting right at 50 reads "Average," not
  // "Below average." Previously "Below average" started at 55, which meant
  // a pen with a BETTER-than-average ERA could still land in that band.
  let efficiencyLabel = "No data";
  if (efficiencyScore !== null) {
    if (efficiencyScore >= 75) efficiencyLabel = "Dominant";
    else if (efficiencyScore >= 55) efficiencyLabel = "Effective";
    else if (efficiencyScore >= 45) efficiencyLabel = "Average";
    else if (efficiencyScore >= 30) efficiencyLabel = "Below average";
    else efficiencyLabel = "Struggling";
  }

  // COMBINED RISK: what probability, Lab Rating, and the totals model
  // actually consume. A tired-but-dominant pen reads less risky than fatigue
  // alone would say; a fresh-but-bad pen reads more risky than fatigue alone
  // would say. Efficiency is centered at 50, so this is a no-op when
  // efficiency is exactly average.
  const riskIndex = Math.round(clamp(score - 0.5 * ((efficiencyScore ?? 50) - 50), 0, 100));
  // Same band cutoffs as the fatigue label, applied to the blended number —
  // this is the label every other page's "High risk"/"Adds caution" wording
  // should be reading, not the fatigue-only one.
  let riskLabel = "Normal";
  if (riskIndex >= 82) riskLabel = "High risk";
  else if (riskIndex >= 62) riskLabel = "Tired";
  else if (riskIndex < 35) riskLabel = "Fresh";

  return {
    team_id: team.team_id,
    team: team.team,
    side: team.side,
    opponent: team.opponent,
    game: team.game,
    game_pk: team.game_pk,
    game_time_iso: team.game_time_iso,
    score,
    label,
    workload_read: workloadRead(label),
    score_reason: scoreReason({ label, score, last, last3BP, last3Relievers, b2b, gamesTracked, daysRest }),
    formula: "45 + (recency-weighted (BP IP - 3/game) x 4.2) + (recency-weighted back-to-back arms x 8). Each game decays by half every 2 days, so rest days lower the score.",
    efficiency_score: efficiencyScore,
    efficiency_label: efficiencyLabel,
    efficiency_reason: efficiencyReason({ efficiencyLabel, efficiencyScore, era3d, whip3d, last3ER, last3H, last3BB, last3BP, gamesTracked }),
    efficiency_formula: "50 - clamp((ERA - 4.20) x 6, -25, 25) x confidence - clamp((WHIP - 1.30) x 15, -20, 20) x confidence, confidence = clamp(BP IP / 6, 0.35, 1)",
    risk_index: riskIndex,
    risk_label: riskLabel,
    days_rest: daysRest,
    last_game_date: last.date,
    last_game_bp_ip: round(last.bpIP, 1),
    last3_bp_ip: round(last3BP, 1),
    last3_bp_runs: last3Runs,
    last3_bp_er: last3ER,
    last3_bp_hits: last3H,
    last3_bp_bb: last3BB,
    era_3d: era3d === null ? null : round(era3d, 2),
    whip_3d: whip3d === null ? null : round(whip3d, 2),
    last_game_relievers: last.relievers || 0,
    last3_relievers: last3Relievers,
    back_to_back_arms: b2b,
    recent_games_tracked: gamesTracked,
    context_only: {
      last_game_relievers: last.relievers || 0,
      last3_relievers: last3Relievers,
      note: "Reliever counts are displayed for context only and do not add score points."
    },
    component_scores: {
      baseline: round(components.baseline, 1),
      weighted_bp_ip: round(components.weighted_bp_ip, 1),
      back_to_back_arms: round(components.back_to_back_arms, 1),
      reliever_counts_context_only: 0,
      no_recent_games_credit: round(components.no_recent_games_credit, 1),
      raw_score: round(rawScore, 1)
    },
    efficiency_component_scores: efficiencyRaw === null ? null : {
      baseline: 50,
      era_term: round(eraTerm, 1),
      whip_term: round(whipTerm, 1),
      confidence: round(confidence, 2),
      raw_score: round(efficiencyRaw, 1)
    }
  };
}

function efficiencyReason({ efficiencyLabel, efficiencyScore, era3d, whip3d, last3ER, last3H, last3BB, last3BP, gamesTracked }) {
  if (!gamesTracked || era3d === null) return "No completed bullpen innings in the last three days to grade.";
  return `${efficiencyLabel} (${(efficiencyScore / 10).toFixed(1)}/10): ${round(era3d, 2)} ERA and ${round(whip3d, 2)} WHIP over ${round(last3BP, 1)} relief innings (${last3ER} ER, ${last3H} H, ${last3BB} BB) in the last three days.`;
}

function workloadRead(label) {
  if (label === "Fresh") return "Low recent workload. No major bullpen fatigue flag from the last three days.";
  if (label === "Tired") return "Elevated recent workload. Full-game angles deserve extra late-inning caution.";
  if (label === "High risk") return "Heavy recent workload. Late-game pitching condition could materially affect the read.";
  return "Manageable recent workload. Bullpen should still be part of the full-game read.";
}

function scoreReason({ label, score, last, last3BP, last3Relievers, b2b, gamesTracked, daysRest }) {
  if (!gamesTracked) return `${label} (${(score/10).toFixed(1)}/10). No completed games in the recent window — the pen comes in rested.`;
  const restText = daysRest === 1 ? "pitched yesterday" : daysRest ? `${daysRest} days since last game` : "";
  const bits = [];
  bits.push(`${round(last3BP, 1)} recent relief innings, recency-weighted` + (last.bpIP >= 4 ? ` — ${round(last.bpIP, 1)} in the last game (${restText})` : restText ? ` (${restText})` : ""));
  if (b2b > 0) bits.push(`${b2b} arm${b2b === 1 ? "" : "s"} worked back-to-back days`);
  return `${label} (${(score/10).toFixed(1)}/10): ` + bits.join(", ") + `. Recent innings count more; rest days lower the score. Workload only — see efficiency for how well the pen has pitched.`;
}

function buildTeamsByName(rows) {
  const out = {};
  for (const row of rows || []) {
    out[row.team] = {
      score: row.score,
      label: row.label,
      last_game_bp_ip: row.last_game_bp_ip,
      last3_bp_ip: row.last3_bp_ip,
      last3_bp_runs: row.last3_bp_runs,
      last_game_relievers: row.last_game_relievers,
      last3_relievers: row.last3_relievers,
      back_to_back_arms: row.back_to_back_arms,
      workload_read: row.workload_read,
      score_reason: row.score_reason,
      formula: row.formula,
      context_only: row.context_only,
      component_scores: row.component_scores,
      efficiency_score: row.efficiency_score,
      efficiency_label: row.efficiency_label,
      efficiency_reason: row.efficiency_reason,
      efficiency_formula: row.efficiency_formula,
      efficiency_component_scores: row.efficiency_component_scores,
      era_3d: row.era_3d,
      whip_3d: row.whip_3d,
      risk_index: row.risk_index,
      risk_label: row.risk_label,
      days_rest: row.days_rest,
      source_version: VERSION
    };
  }
  return out;
}

async function buildBullpenSource({ date, todayGames, fetchJson, generatedAt }) {
  if (!date) throw new Error("buildBullpenSource requires a date");
  if (typeof fetchJson !== "function") throw new Error("buildBullpenSource requires fetchJson");

  const teams = createTeamState(todayGames || []);
  const lookupWarnings = [];
  // A postponed/suspended game's ORIGINAL listing can still report
  // abstractGameState "Final" even though detailedState says it never
  // played that day (MLB schedule API quirk). If a doubleheader makeup
  // lands inside the same 3-day window, the same gamePk then appears
  // under two different dates and would otherwise get boxscore-processed
  // twice — double-counting one game's entire relief line. Dedupe by
  // gamePk across the whole window, and explicitly skip listings that
  // weren't actually played, regardless of abstractGameState.
  const NOT_PLAYED_STATES = new Set(["Postponed", "Suspended", "Cancelled", "Suspended: Rain"]);
  const processedGamePks = new Set();
  let gameSeq = 0;

  for (const priorDate of Array.from({ length: LOOKBACK_DAYS }, (_, i) => dateShift(date, -(i + 1)))) {
    let schedule = [];
    try {
      schedule = await getGamesForDate(priorDate, fetchJson);
    } catch (err) {
      lookupWarnings.push(`Could not load schedule for ${priorDate}: ${err.message}`);
      continue;
    }

    for (const g of schedule) {
      if (!g.status || g.status.abstractGameState !== "Final") continue;
      if (g.status.detailedState && NOT_PLAYED_STATES.has(g.status.detailedState)) continue;
      if (processedGamePks.has(g.gamePk)) continue;
      const awayId = g.teams && g.teams.away && g.teams.away.team && g.teams.away.team.id;
      const homeId = g.teams && g.teams.home && g.teams.home.team && g.teams.home.team.id;
      if (!teams[awayId] && !teams[homeId]) continue;

      try {
        const box = await fetchJson(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`);
        const seq = gameSeq++;
        processBoxSide(box, "away", awayId, priorDate, teams, seq);
        processBoxSide(box, "home", homeId, priorDate, teams, seq);
        processedGamePks.add(g.gamePk);
      } catch (err) {
        lookupWarnings.push(`Could not load boxscore ${g.gamePk}: ${err.message}`);
      }
    }
  }

  const teamsRows = Object.values(teams).map(t => scoreTeam(t, date)).sort((a, b) => b.score - a.score || String(a.team).localeCompare(String(b.team)));
  const highRisk = teamsRows.filter(t => t.label === "High risk").length;
  const tired = teamsRows.filter(t => t.label === "Tired").length;
  const fresh = teamsRows.filter(t => t.label === "Fresh").length;

  return {
    date,
    generated_at: generatedAt || new Date().toISOString(),
    source_of_truth: SOURCE_OF_TRUTH,
    version: VERSION,
    method: "Generated single source of truth. Website pages display this JSON and do not calculate separate bullpen scores in the browser.",
    note: "v5: fatigue is recency-weighted workload (rest days lower it), efficiency is ERA and WHIP, risk_index blends the two. Reliever counts are context only.",
    formula: "Fatigue = 45 + (recency-weighted relief innings above 3/game x 4.2) + (recency-weighted back-to-back arms x 8). Half-life 2 days, so an idle or rained-out day lowers fatigue. Runs allowed live in the efficiency score.",
    lookback_days: LOOKBACK_DAYS,
    summary: {
      teams_tracked: teamsRows.length,
      high_risk: highRisk,
      tired,
      fresh,
      normal: teamsRows.length - highRisk - tired - fresh
    },
    warnings: lookupWarnings,
    teams: teamsRows,
    teams_by_name: buildTeamsByName(teamsRows)
  };
}

module.exports = {
  VERSION,
  SOURCE_OF_TRUTH,
  LOOKBACK_DAYS,
  buildBullpenSource,
  scoreTeam,
  ipToNum,
  dateShift,
  localISODate
};
