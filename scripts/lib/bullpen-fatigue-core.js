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

function processBoxSide(box, side, teamId, date, teams) {
  const team = teams[teamId];
  if (!team) return;

  const tb = box.teams && box.teams[side];
  if (!tb || !tb.pitchers || !tb.players) return;

  let totalIP = 0;
  let starterIP = 0;
  let starterRuns = 0;
  let starterId = null;
  let relievers = 0;
  let bpRuns = 0;
  const relieverIds = [];

  for (let i = 0; i < tb.pitchers.length; i++) {
    const id = tb.pitchers[i];
    const player = tb.players["ID" + id];
    const ip = ipToNum(player && player.stats && player.stats.pitching && player.stats.pitching.inningsPitched);
    totalIP += ip;

    if (i === 0) {
      starterIP = ip;
      starterId = id;
      starterRuns = Number(player && player.stats && player.stats.pitching && player.stats.pitching.runs) || 0;
    } else {
      relievers += 1;
      bpRuns += Number(player && player.stats && player.stats.pitching && player.stats.pitching.runs) || 0;
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
    if (!team.pitcherDates[starterId]) team.pitcherDates[starterId] = new Set();
    team.pitcherDates[starterId].add(date);
  }
  team.games.push({
    date,
    bpIP: Math.max(0, openerGame ? totalIP : totalIP - starterIP),
    relievers,
    bpRuns,
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
  const games = [...(team.games || [])].sort((a, b) => new Date(b.date) - new Date(a.date));
  const last = games[0] || { bpIP: 0, relievers: 0, bpRuns: 0, date: null };
  const last3BP = games.reduce((s, g) => s + g.bpIP, 0);
  const last3Runs = games.reduce((s, g) => s + (g.bpRuns || 0), 0);
  const last3Relievers = games.reduce((s, g) => s + g.relievers, 0);
  const b2b = countBackToBackArms(team.pitcherDates);
  const gamesTracked = games.length;

  // Active owned formula v3. Reliever counts remain context-only.
  const components = {
    baseline: 45,
    last3_bp_ip: (last3BP - 9) * 3.5,
    last_game_bp_ip: (last.bpIP - 3) * 4,
    back_to_back_arms: b2b * 6,
    bp_runs_allowed_3d: gamesTracked ? clamp((last3Runs - 4) * 1.5, -6, 12) : 0,
    reliever_counts_context_only: 0,
    no_recent_games_credit: gamesTracked === 0 ? -18 : 0
  };

  const rawScore = components.baseline
    + components.last3_bp_ip
    + components.last_game_bp_ip
    + components.back_to_back_arms
    + components.bp_runs_allowed_3d
    + components.reliever_counts_context_only
    + components.no_recent_games_credit;

  const score = Math.round(clamp(rawScore, 0, 100));

  let label = "Normal";
  if (score >= 82) label = "High risk";
  else if (score >= 62) label = "Tired";
  else if (score < 35) label = "Fresh";

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
    score_reason: scoreReason({ label, score, last, last3BP, last3Runs, last3Relievers, b2b, gamesTracked }),
    formula: "45 + ((Last 3 BP IP - 9) x 3.5) + ((Last game BP IP - 3) x 4) + (Back-to-back arms x 6) + clamp((Last 3 BP runs - 4) x 1.5, -6, 12)",
    last_game_date: last.date,
    last_game_bp_ip: round(last.bpIP, 1),
    last3_bp_ip: round(last3BP, 1),
    last3_bp_runs: last3Runs,
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
      bp_runs_allowed_3d: round(components.bp_runs_allowed_3d, 1),
      reliever_counts_context_only: 0,
      no_recent_games_credit: round(components.no_recent_games_credit, 1),
      raw_score: round(rawScore, 1)
    }
  };
}

function workloadRead(label) {
  if (label === "Fresh") return "Low recent workload. No major bullpen fatigue flag from the last three days.";
  if (label === "Tired") return "Elevated recent workload. Full-game angles deserve extra late-inning caution.";
  if (label === "High risk") return "Heavy recent workload. Late-game pitching condition could materially affect the read.";
  return "Manageable recent workload. Bullpen should still be part of the full-game read.";
}

function scoreReason({ label, score, last, last3BP, last3Runs, last3Relievers, b2b, gamesTracked }) {
  if (!gamesTracked) return `${label} (${(score/10).toFixed(1)}/10). No completed games in the last three days — the pen comes in rested.`;
  const bits = [];
  bits.push(`${round(last3BP, 1)} relief innings over the last three days` + (last.bpIP >= 4 ? ` — ${round(last.bpIP, 1)} of them in the last game` : ""));
  if (b2b > 0) bits.push(`${b2b} arm${b2b === 1 ? "" : "s"} pitched back-to-back days`);
  if (last3Runs >= 6) bits.push(`and the pen was hit hard for ${last3Runs} runs in that stretch`);
  else if (last3Runs >= 1) bits.push(`allowing ${last3Runs} run${last3Runs === 1 ? "" : "s"}`);
  else bits.push(`without allowing a run`);
  return `${label} (${(score/10).toFixed(1)}/10): ` + bits.join(", ") + `. ${last3Relievers} reliever appearances in the window.`;
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
        processBoxSide(box, "away", awayId, priorDate, teams);
        processBoxSide(box, "home", homeId, priorDate, teams);
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
