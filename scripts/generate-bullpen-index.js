#!/usr/bin/env node
"use strict";

/*
  Generate LyDia bullpen fatigue JSON only.
  This is useful for testing the bullpen module separately from the full daily picks workflow.
*/

const fs = require("fs");
const { buildBullpenSource, localISODate } = require("./lib/bullpen-fatigue-core");

const args = parseArgs(process.argv.slice(2));
const DATE = args.date || localISODate(new Date());

main().catch(err => { console.error(err); process.exit(1); });

async function main() {
  fs.mkdirSync("data/bullpen", { recursive: true });

  const sched = await fetchJson(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}&hydrate=probablePitcher`);
  const games = ((((sched.dates || [])[0]) || {}).games || [])
    .filter(g => g.status && ["Preview", "Live"].includes(g.status.abstractGameState))
    .sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate));

  const generatedAt = new Date().toISOString();
  const bullpen = await buildBullpenSource({ date: DATE, todayGames: games, fetchJson, generatedAt });

  writeJson(`data/bullpen/${DATE}.json`, bullpen);
  writeJson("data/bullpen/today.json", bullpen);

  console.log(`Generated bullpen fatigue source for ${DATE}. Teams: ${bullpen.teams.length}. High risk: ${bullpen.summary.high_risk}.`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (!v.startsWith("--")) continue;
    const key = v.slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith("--") ? next : "true";
    if (next && !next.startsWith("--")) i++;
  }
  return out;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
