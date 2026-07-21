#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const PitcherCore = require("../js/pitcher-matchup-core.js");

const ROOT = path.join(__dirname, "..");
const DATE = process.argv[2] || easternDate();

if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error(`Invalid date: ${DATE}. Expected YYYY-MM-DD.`);
  process.exit(1);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

async function main() {
  const briefPath = path.join(ROOT, "data", "member-brief", `${DATE}.json`);
  if (!fs.existsSync(briefPath)) {
    throw new Error(
      `Missing data/member-brief/${DATE}.json. ` +
      `Run generate-member-lab.js before generating pitcher matchup data.`
    );
  }

  const brief = JSON.parse(fs.readFileSync(briefPath, "utf8"));
  if (!Array.isArray(brief.games) || !brief.games.length) {
    throw new Error(`Member brief for ${DATE} has no games.`);
  }

  const schedule = await getJson(
    `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}&hydrate=probablePitcher`
  );
  const scheduleGames = ((((schedule.dates || [])[0]) || {}).games || [])
    .filter(game => game.gameType === "R" || game.gameType === undefined);

  const games = selectBriefGames(scheduleGames, brief.games)
    .sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate));

  const source = await PitcherCore.buildSource({
    date: DATE,
    games,
    getJson,
    generatedAt: new Date().toISOString()
  });

  source.member_brief_source = `data/member-brief/${DATE}.json`;
  source.scope = "Exact game list published by the LyDia member brief.";

  writeJson(`data/pitcher-matchups/${DATE}.json`, source);
  if (DATE === easternDate()) writeJson("data/pitcher-matchups/today.json", source);

  console.log(
    `Generated canonical pitcher data for ${DATE}: ` +
    `${Object.keys(source.games).length} member-brief games, ` +
    `${Object.keys(source.pitchers_by_id).length} pitchers.`
  );
}

function selectBriefGames(scheduleGames, briefGames) {
  const scheduleByPk = new Map(
    (scheduleGames || []).map(game => [String(game.gamePk), game])
  );
  const selected = [];
  const missing = [];

  for (const briefGame of briefGames || []) {
    const gamePk = String(briefGame.game_pk || "");
    const scheduleGame = scheduleByPk.get(gamePk);
    if (!scheduleGame) {
      missing.push(gamePk || briefGame.game || "unknown game");
      continue;
    }
    selected.push(scheduleGame);
  }

  if (missing.length) {
    throw new Error(
      `MLB schedule is missing ${missing.length} member-brief game(s): ` +
      missing.join(", ")
    );
  }

  return selected;
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "LyDia pitcher matchup source generator" }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

function writeJson(relativePath, value) {
  const target = path.join(ROOT, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function easternDate() {
  const date = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  return (
    `${date.getFullYear()}-` +
    `${String(date.getMonth() + 1).padStart(2, "0")}-` +
    `${String(date.getDate()).padStart(2, "0")}`
  );
}

module.exports = { selectBriefGames };
