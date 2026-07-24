"use strict";

const fs = require("fs");
const path = require("path");

const VERSION = "pitching-plan-v1";
const REGULATION_INNINGS = 9;

function round(value, digits = 1) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function load(root, date) {
  const file = path.join(root, "data", "pitching-plans", `${date}.json`);
  if (!fs.existsSync(file)) return { version: VERSION, date, games: {} };
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data.date !== date) throw new Error(`Pitching-plan date mismatch in ${file}.`);
  validate(data);
  return data;
}

function validate(data) {
  for (const [gamePk, game] of Object.entries(data.games || {})) {
    for (const side of ["away", "home"]) {
      const plan = game[side];
      if (!plan) continue;
      if (!Array.isArray(plan.segments) || !plan.segments.length) {
        throw new Error(`Pitching plan ${gamePk}/${side} has no segments.`);
      }
      const total = plan.segments.reduce((sum, segment) => sum + Number(segment.expected_innings || 0), 0);
      if (Math.abs(total - REGULATION_INNINGS) > 0.01) {
        throw new Error(`Pitching plan ${gamePk}/${side} covers ${total} innings, expected 9.0.`);
      }
      for (const segment of plan.segments) {
        if (!["opener", "bulk", "starter", "bullpen"].includes(segment.role)) {
          throw new Error(`Pitching plan ${gamePk}/${side} has invalid role ${segment.role}.`);
        }
        if (segment.role !== "bullpen" && (!segment.pitcher_id || !segment.pitcher)) {
          throw new Error(`Pitching plan ${gamePk}/${side} is missing a pitcher identity.`);
        }
      }
    }
  }
}

function getSidePlan(data, gamePk, side) {
  return data && data.games && data.games[String(gamePk)]
    ? data.games[String(gamePk)][side] || null
    : null;
}

function participantIds(data) {
  const ids = [];
  for (const game of Object.values((data && data.games) || {})) {
    for (const side of ["away", "home"]) {
      for (const segment of ((game[side] || {}).segments || [])) {
        if (segment.pitcher_id) ids.push(Number(segment.pitcher_id));
      }
    }
  }
  return [...new Set(ids.filter(Number.isFinite))];
}

function fallbackPlan(pitcher, role) {
  const pitcherInnings = Number(role.expectedInnings);
  return {
    type: role.bullpenGame ? "opener_bullpen" : "starter_bullpen",
    confidence: role.confidence,
    reported: false,
    segments: [
      {
        role: role.bullpenGame ? "opener" : "starter",
        pitcher_id: pitcher && pitcher.id ? Number(pitcher.id) : null,
        pitcher: pitcher && (pitcher.fullName || pitcher.name) || "TBD",
        expected_innings: pitcherInnings
      },
      { role: "bullpen", expected_innings: REGULATION_INNINGS - pitcherInnings }
    ]
  };
}

function resolveSidePlan(data, gamePk, side, probablePitcher, role) {
  const reported = getSidePlan(data, gamePk, side);
  return reported ? { ...reported, reported: true } : fallbackPlan(probablePitcher, role);
}

function describe(plan) {
  return (plan.segments || []).map(segment => {
    const who = segment.role === "bullpen" ? "remaining bullpen" : segment.pitcher;
    return `${who} ${round(segment.expected_innings).toFixed(1)} IP`;
  }).join(" + ");
}

function inningsToNumber(value) {
  const [whole, outs = "0"] = String(value || "0").split(".");
  return Number(whole) + Number(outs) / 3;
}

async function fetchBulkRoleStats(data, date, getJson, leagueEra = 4.2) {
  const bulkIds = [];
  for (const game of Object.values((data && data.games) || {})) {
    for (const side of ["away", "home"]) {
      for (const segment of ((game[side] || {}).segments || [])) {
        if (segment.role === "bulk" && segment.pitcher_id) bulkIds.push(Number(segment.pitcher_id));
      }
    }
  }
  const rows = await Promise.all([...new Set(bulkIds)].map(async id => {
    const url = `https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=gameLog&group=pitching&season=${String(date).slice(0, 4)}`;
    const data = await getJson(url);
    let ip = 0, er = 0, hr = 0, bb = 0, so = 0, bf = 0;
    for (const split of (((data.stats || [])[0] || {}).splits || [])) {
      const stat = split.stat || {};
      if (Number(stat.gamesStarted) !== 0) continue;
      ip += inningsToNumber(stat.inningsPitched);
      er += Number(stat.earnedRuns) || 0;
      hr += Number(stat.homeRuns) || 0;
      bb += Number(stat.baseOnBalls) || 0;
      so += Number(stat.strikeOuts) || 0;
      bf += Number(stat.battersFaced) || 0;
    }
    if (ip < 5) return [id, null];
    const rawFip = (13 * hr + 3 * bb - 2 * so) / ip + 3.15;
    const weight = Math.min(ip, 40) / 40;
    const fip = Math.min(6, Math.max(2.75, rawFip * weight + leagueEra * (1 - weight)));
    return [id, {
      role: "bulk",
      sample: "non-start appearances",
      ip: round(ip, 1),
      era: round(er * 9 / ip, 2),
      fip_lite: round(fip, 2),
      so,
      bb,
      hr,
      bf
    }];
  }));
  return Object.fromEntries(rows.filter(([, value]) => value));
}

module.exports = {
  VERSION,
  REGULATION_INNINGS,
  load,
  validate,
  getSidePlan,
  participantIds,
  fallbackPlan,
  resolveSidePlan,
  describe,
  fetchBulkRoleStats
};
