"use strict";

/*
  LyDia Bullpen Fatigue Core v2.0-clean

  One source of truth for bullpen workload scoring.
  Used by:
  - scripts/generate-bullpen-index.js
  - scripts/generate-member-lab.js
  - tools/bullpen-fatigue/index.html through generated JSON only

  Design rule:
  Browser pages display generated bullpen data. They do not maintain a separate scoring model.
*/

const VERSION = "bullpen-fatigue-v2.0-clean";
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
  let relievers = 0;
  const relieverIds = [];

  for (let i = 0; i < tb.pitchers.length; i++) {
    const id = tb.pitchers[i];
    const player = tb.players["ID" + id];
    const ip = ipToNum(player && player.stats && player.stats.pitching && player.stats.pitching.inningsPitched);
    totalIP += ip;

    if (i === 0) {
      starterIP = ip;
    } else {
      relievers += 1;
      relieverIds.push(id);
      if (!team.pitcherDates[id]) team.pitcherDates[id] = new Set();
      team.pitcherDates[id].add(date);
    }
  }

  team.games.push({
    date,
    bpIP: Math.max(0, totalIP - starterIP),
    relievers,
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
  const last = games[0] || { bpIP: 0, relievers: 0, date: null };
  const last3BP = games.reduce((s, g) => s + g.bpIP, 0);
  const last3Relievers = games.reduce((s, g) => s + g.relievers, 0);
  const b2b = countBackToBackArms(team.pitcherDates);
  const gamesTracked = games.length;

  // Clean v2 scoring model:
  // Start at normal workload, then add/subtract capped components.
  // This prevents every normal-heavy team from pinning at 100 while still allowing true extreme spots.
  const components = {
    baseline: 45,
    last3_bp_ip: clamp((last3BP - 9) * 2.8, -22, 32),
    last_game_bp_ip: clamp((last.bpIP - 3) * 4.5, -16, 22),
    back_to_back_arms: clamp(b2b * 5, 0, 20),
    last3_relievers: clamp((last3Relievers - 9) * 1.2, -8, 10),
    no_recent_games_credit: gamesTracked === 0 ? -18 : 0
  };

  const rawScore = Object.values(components).reduce((s, v) => s + v, 0);
  const extremeWorkload = last3BP >= 18 || (last.bpIP >= 7 && b2b >= 2) || (last3BP >= 15 && last3Relievers >= 14 && b2b >= 3);
  let score = Math.round(clamp(rawScore, 0, 100));

  // 100 should mean extreme, not simply above average.
  if (score >= 97 && !extremeWorkload) score = 96;

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
    score_reason: scoreReason({ label, score, last, last3BP, last3Relievers, b2b, gamesTracked }),
    last_game_date: last.date,
    last_game_bp_ip: round(last.bpIP, 1),
    last3_bp_ip: round(last3BP, 1),
    last_game_relievers: last.relievers || 0,
    last3_relievers: last3Relievers,
    back_to_back_arms: b2b,
    recent_games_tracked: gamesTracked,
    component_scores: {
      baseline: round(components.baseline, 1),
      last3_bp_ip: round(components.last3_bp_ip, 1),
      last_game_bp_ip: round(components.last_game_bp_ip, 1),
      back_to_back_arms: round(components.back_to_back_arms, 1),
      last3_relievers: round(components.last3_relievers, 1),
      no_recent_games_credit: round(components.no_recent_games_credit, 1),
      raw_score: round(rawScore, 1),
      extreme_workload: extremeWorkload
    }
  };
}

function workloadRead(label) {
  if (label === "Fresh") return "Low recent workload. No major bullpen fatigue flag from the last three days.";
  if (label === "Tired") return "Elevated recent workload. Full-game angles deserve extra late-inning caution.";
  if (label === "High risk") return "Heavy recent workload. Late-game pitching condition could materially affect the read.";
  return "Manageable recent workload. Bullpen should still be part of the full-game read.";
}

function scoreReason({ label, score, last, last3BP, last3Relievers, b2b, gamesTracked }) {
  if (!gamesTracked) return `Score ${score}/100. No recent completed games found in the three-day lookback, so bullpen fatigue is treated as fresh unless later news says otherwise.`;
  const pieces = [
    `Score ${score}/100 (${label}).`,
    `Last game bullpen IP: ${round(last.bpIP, 1)}.`,
    `Three-day bullpen IP: ${round(last3BP, 1)}.`,
    `Three-day relievers used: ${last3Relievers}.`,
    `Back-to-back arms: ${b2b}.`
  ];
  return pieces.join(" ");
}

function buildTeamsByName(rows) {
  const out = {};
  for (const row of rows || []) {
    out[row.team] = {
      score: row.score,
      label: row.label,
      last_game_bp_ip: row.last_game_bp_ip,
      last3_bp_ip: row.last3_bp_ip,
      last_game_relievers: row.last_game_relievers,
      last3_relievers: row.last3_relievers,
      back_to_back_arms: row.back_to_back_arms,
      workload_read: row.workload_read,
      score_reason: row.score_reason,
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
      const awayId = g.teams && g.teams.away && g.teams.away.team && g.teams.away.team.id;
      const homeId = g.teams && g.teams.home && g.teams.home.team && g.teams.home.team.id;
      if (!teams[awayId] && !teams[homeId]) continue;

      try {
        const box = await fetchJson(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`);
        processBoxSide(box, "away", awayId, priorDate, teams);
        processBoxSide(box, "home", homeId, priorDate, teams);
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
    note: "Use this file for Bullpen Fatigue Index, Daily Member Brief, and LyDia model consumption.",
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
