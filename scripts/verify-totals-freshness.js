#!/usr/bin/env node
"use strict";

/*
  Totals freshness guard.

  The moneyline's starter term (effective ERA) is read from the totals run
  projection's pitching plan. If that capture is stale relative to the confirmed
  probable pitcher -- still "TBD" after the pitcher posted, or a different arm
  than the schedule now lists -- the published page shows the real starter while
  the price is still built off the old one. (Live example: Dodgers @ Cubs
  2026-08-03 priced the Dodgers as TBD after Justin Wrobleski was confirmed.)

  This is the same class of check as verify-pitching-plans.js, but for the
  schedule's probable pitchers rather than the manual opener/bulk plans. It runs
  in Publish, before the model pass, and fails loudly so the fix is obvious:
  re-run Prepare slate so update-totals rebuilds the projection.

  Usage: node scripts/verify-totals-freshness.js [YYYY-MM-DD]
*/

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATE = process.argv[2] || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

// The named starter a totals pitching-plan side was built for (its first
// non-bullpen segment). Kept identical to generate-member-lab.js.
function planStarterIdentity(sidePlan) {
  if (!sidePlan) return { id: null, name: null };
  const seg = Array.isArray(sidePlan.segments)
    ? sidePlan.segments.find(segment => segment.role !== "bullpen")
    : null;
  const id = seg && seg.pitcher_id != null ? String(seg.pitcher_id) : null;
  const name = (seg && seg.pitcher) || sidePlan.pitcher || null;
  return { id, name };
}

async function fetchSchedule(date) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${encodeURIComponent(date)}&hydrate=probablePitcher`;
  const response = await fetch(url, { headers: { "user-agent": "LyDia totals freshness check" } });
  if (!response.ok) throw new Error(`schedule HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const totalsPath = path.join(ROOT, "data", "totals", `${DATE}.json`);
  if (!fs.existsSync(totalsPath)) {
    console.log(`Totals freshness: no totals capture for ${DATE}; nothing to check.`);
    return;
  }
  const totals = JSON.parse(fs.readFileSync(totalsPath, "utf8"));

  let schedule;
  try {
    schedule = await fetchSchedule(DATE);
  } catch (error) {
    // A transient schedule fetch failure must not block a publish. The check is
    // a guard, not a data source; it warns and yields rather than failing hard.
    console.warn(`Totals freshness: schedule unavailable (${error.message}); skipping the live comparison.`);
    return;
  }

  const games = (((schedule.dates || [])[0]) || {}).games || [];
  const stale = [];

  for (const g of games) {
    if (!g.status || !["Preview", "Live"].includes(g.status.abstractGameState)) continue;
    const totalGame = totals.games && totals.games[String(g.gamePk)];
    if (!totalGame || !totalGame.pitching_plan) continue; // no plan captured for this game

    for (const side of ["away", "home"]) {
      const probable = g.teams[side].probablePitcher;
      if (!probable) continue; // schedule itself is still TBD -- nothing to be stale against
      const plan = planStarterIdentity(totalGame.pitching_plan[side]);
      const matches = (plan.id && String(probable.id) === plan.id)
        || (plan.name && probable.fullName
            && plan.name.trim().toLowerCase() === probable.fullName.trim().toLowerCase());
      if (!matches) {
        stale.push(`${g.teams.away.team.name} @ ${g.teams.home.team.name} (${side}): `
          + `totals plan has "${plan.name || "TBD"}", schedule confirms "${probable.fullName}"`);
      }
    }
  }

  if (stale.length) {
    console.error(`Totals capture is stale for ${DATE} -- it does not match the confirmed starting pitchers:`);
    for (const line of stale) console.error(`  - ${line}`);
    console.error(`\nRe-run "Prepare slate (gather data)" for ${DATE} before publishing, so update-totals `
      + `rebuilds the run projection and the moneyline prices the confirmed starter.`);
    process.exit(1);
  }

  console.log(`Totals freshness: every captured pitching plan matches the confirmed probable for ${DATE}.`);
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
