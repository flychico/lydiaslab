"use strict";

/*
  LyDia Bullpen Fatigue Core v3-runs-aware

  One source of truth for bullpen workload scoring.
  Used by:
  - scripts/generate-bullpen-index.js
  - scripts/generate-member-lab.js
  - tools/bullpen-fatigue/index.html through generated JSON only

  Active owned scoring rule (v3, runs-aware):
  Score = 45
    + ((Last 3 BP IP - 9) × 3.5)
    + ((Last game BP IP - 3) × 4)
    + (Back-to-back arms × 6)
    + clamp((Last 3 BP runs allowed - 4) × 1.5, -6, 12)
  A shelled pen is a stressed pen: runs allowed capture blown leads, long
  outings from leverage arms, and manager trust burned — workload IP alone misses that.

  Reliever counts are context only. They are displayed, but they do not add hidden points.

  Design rule:
  Browser pages display generated bullpen data. They do not maintain a separate scoring model.
*/

const VERSION = "bullpen-fatigue-v3-runs-aware";
const SOURCE_OF_TRUTH = "scripts/lib/bullpen-fatigue-core.js";
const LOOKBACK_DAYS = 3;

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

function scoreTeam(team) {
  // Sort most-recent-game-first. Same calendar date can hold two games
  // (doubleheader) — date alone can't order those, so seq (assigned in
  // schedule/gameNumber order during collection) breaks the tie and puts
  // the later game of the day first, not whichever game happened to get
  // pushed first.
  const games = [...(team.games || [])].sort((a, b) => (new Date(b.date) - new Date(a.date)) || ((b.seq || 0) - (a.seq || 0)));
  const last = games[0] || { bpIP: 0, relievers: 0, bpRuns: 0, bpER: 0, bpH: 0, bpBB: 0, date: null };
  const last3BP = games.reduce((s, g) => s + g.bpIP, 0);
  const last3Runs = games.reduce((s, g) => s + (g.bpRuns || 0), 0);
  const last3ER = games.reduce((s, g) => s + (g.bpER || 0), 0);
  const last3H = games.reduce((s, g) => s + (g.bpH || 0), 0);
  const last3BB = games.reduce((s, g) => s + (g.bpBB || 0), 0);
  const last3Relievers = games.reduce((s, g) => s + g.relievers, 0);
  const b2b = countBackToBackArms(team.pitcherDates);
  const gamesTracked = games.length;
  // Expected bullpen IP baseline scales with actual games played in the
  // window, not calendar days — a doubleheader means 4 team-games can land
  // inside a 3-calendar-day lookback, and comparing that against a flat
  // 3-game assumption (9 IP) overstates fatigue for volume that was never
  // unusual per game, just unusually scheduled. 3 IP/game matches the same
  // assumption already used for the single-game baseline below.
  const expectedBP = 3 * gamesTracked;

  // FATIGUE: pure workload/rest. No outcome data — how much a pen has
  // pitched and how little rest it's had, nothing about how well it pitched.
  const components = {
    baseline: 45,
    last3_bp_ip: (last3BP - expectedBP) * 3.5,
    last_game_bp_ip: (last.bpIP - 3) * 4,
    back_to_back_arms: b2b * 6,
    reliever_counts_context_only: 0,
    no_recent_games_credit: gamesTracked === 0 ? -18 : 0
  };

  const rawScore = components.baseline
    + components.last3_bp_ip
    + components.last_game_bp_ip
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
    score_reason: scoreReason({ label, score, last, last3BP, last3Relievers, b2b, gamesTracked }),
    formula: "45 + ((Last 3 BP IP - 9) x 3.5) + ((Last game BP IP - 3) x 4) + (Back-to-back arms x 6)",
    efficiency_score: efficiencyScore,
    efficiency_label: efficiencyLabel,
    efficiency_reason: efficiencyReason({ efficiencyLabel, efficiencyScore, era3d, whip3d, last3ER, last3H, last3BB, last3BP, gamesTracked }),
    efficiency_formula: "50 - clamp((ERA - 4.20) x 6, -25, 25) x confidence - clamp((WHIP - 1.30) x 15, -20, 20) x confidence, confidence = clamp(BP IP / 6, 0.35, 1)",
    risk_index: riskIndex,
    risk_label: riskLabel,
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
      last3_bp_ip: round(components.last3_bp_ip, 1),
      last_game_bp_ip: round(components.last_game_bp_ip, 1),
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

function scoreReason({ label, score, last, last3BP, last3Relievers, b2b, gamesTracked }) {
  if (!gamesTracked) return `${label} (${(score/10).toFixed(1)}/10). No completed games in the last three days — the pen comes in rested.`;
  const bits = [];
  bits.push(`${round(last3BP, 1)} relief innings over the last three days` + (last.bpIP >= 4 ? ` — ${round(last.bpIP, 1)} of them in the last game` : ""));
  if (b2b > 0) bits.push(`${b2b} arm${b2b === 1 ? "" : "s"} pitched back-to-back days`);
  return `${label} (${(score/10).toFixed(1)}/10): ` + bits.join(", ") + `. ${last3Relievers} reliever appearances in the window. Workload only — see efficiency for how well the pen has actually pitched.`;
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

  const teamsRows = Object.values(teams).map(scoreTeam).sort((a, b) => b.score - a.score || String(a.team).localeCompare(String(b.team)));
  const highRisk = teamsRows.filter(t => t.label === "High risk").length;
  const tired = teamsRows.filter(t => t.label === "Tired").length;
  const fresh = teamsRows.filter(t => t.label === "Fresh").length;

  return {
    date,
    generated_at: generatedAt || new Date().toISOString(),
    source_of_truth: SOURCE_OF_TRUTH,
    version: VERSION,
    method: "Generated single source of truth. Website pages display this JSON and do not calculate separate bullpen scores in the browser.",
    note: "v3 runs-aware formula. Reliever counts are context only and do not add hidden score points.",
    formula: "45 + ((Last 3 BP IP - 9) x 3.5) + ((Last game BP IP - 3) x 4) + (Back-to-back arms x 6) + clamp((Last 3 BP runs - 4) x 1.5, -6, 12)",
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
