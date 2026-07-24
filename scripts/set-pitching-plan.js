#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const PitchingPlan = require("./lib/pitching-plan-core.js");

const ROOT = path.join(__dirname, "..");

function option(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : fallback;
}

async function getJson(url) {
  const response = await fetch(url, { headers: { "user-agent": "LyDia manual pitching-plan editor" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function shortTeamName(name) {
  const parts = String(name || "").split(/\s+/);
  const last = parts[parts.length - 1] || "";
  return ["Sox", "Jays"].includes(last) ? parts.slice(-2).join(" ") : last;
}

async function resolvePlayer(name) {
  if (!name) throw new Error("Pitcher name is required.");
  const data = await getJson(`https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(name)}`);
  const people = data.people || [];
  const exact = people.filter(person => normalizeName(person.fullName) === normalizeName(name));
  const matches = exact.length ? exact : people;
  if (matches.length !== 1) {
    throw new Error(`Could not uniquely resolve MLB pitcher "${name}". Matches: ${matches.map(person => person.fullName).join(", ") || "none"}.`);
  }
  return { pitcher_id: Number(matches[0].id), pitcher: matches[0].fullName };
}

function innings(value, label) {
  const number = Number(value);
  if (!(number > 0 && number < 9)) throw new Error(`${label} must be greater than 0 and less than 9.`);
  return Number(number.toFixed(1));
}

async function main() {
  const date = option("date");
  const action = option("action", "set");
  const gameInput = option("game-pk");
  const side = option("side");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("A valid --date YYYY-MM-DD is required.");
  if (!["set", "clear"].includes(action)) throw new Error("--action must be set or clear.");
  if (!gameInput) throw new Error("--game-pk requires an MLB game ID or matchup name.");
  if (!["away", "home"].includes(side)) throw new Error("--side must be away or home.");

  const schedule = await getJson(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher`);
  const games = (((schedule.dates || [])[0] || {}).games || []);
  const matchupKey = normalizeName(gameInput.replace(/https?:\/\/[^/]+/i, ""));
  const matches = games.filter(row => {
    if (String(row.gamePk) === gameInput) return true;
    const label = `${row.teams.away.team.name} @ ${row.teams.home.team.name}`;
    const shortLabel = `${shortTeamName(row.teams.away.team.name)} @ ${shortTeamName(row.teams.home.team.name)}`;
    return normalizeName(label) === matchupKey
      || normalizeName(shortLabel) === matchupKey
      || matchupKey.includes(normalizeName(label));
  });
  if (matches.length !== 1) {
    throw new Error(`Could not uniquely resolve "${gameInput}" on ${date}. Matches: ${matches.map(row => `${row.gamePk} ${row.teams.away.team.name} @ ${row.teams.home.team.name}`).join("; ") || "none"}. Use the numeric MLB game ID for doubleheaders.`);
  }
  const game = matches[0];
  const gamePk = String(game.gamePk);

  const file = path.join(ROOT, "data", "pitching-plans", `${date}.json`);
  const data = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { version: PitchingPlan.VERSION, date, games: {} };
  data.games = data.games || {};

  if (action === "clear") {
    if (data.games[gamePk]) {
      delete data.games[gamePk][side];
      if (!data.games[gamePk].away && !data.games[gamePk].home) delete data.games[gamePk];
    }
  } else {
    const opener = await resolvePlayer(option("opener"));
    const openerInnings = innings(option("opener-innings"), "Opener innings");
    const bulkName = option("bulk");
    const bulkInningsRaw = option("bulk-innings");
    if (Boolean(bulkName) !== Boolean(bulkInningsRaw)) {
      throw new Error("Bulk pitcher and bulk innings must either both be supplied or both be blank.");
    }
    const bulk = bulkName ? await resolvePlayer(bulkName) : null;
    const bulkInnings = bulk ? innings(bulkInningsRaw, "Bulk innings") : 0;
    const bullpenInnings = Number((9 - openerInnings - bulkInnings).toFixed(1));
    if (!(bullpenInnings > 0)) throw new Error("Opener plus bulk innings must leave at least one bullpen inning.");

    const team = game.teams[side].team.name;
    const segments = [
      { role: "opener", ...opener, expected_innings: openerInnings },
      ...(bulk ? [{ role: "bulk", ...bulk, expected_innings: bulkInnings }] : []),
      { role: "bullpen", expected_innings: bullpenInnings }
    ];
    data.games[gamePk] = data.games[gamePk] || {
      game: `${game.teams.away.team.name} @ ${game.teams.home.team.name}`
    };
    data.games[gamePk][side] = {
      team,
      type: bulk ? "opener_bulk" : "opener_bullpen",
      confidence: "manual",
      source_note: `Manual override submitted through the Publish workflow: ${segments.map(segment => `${segment.pitcher || "bullpen"} ${segment.expected_innings} IP`).join(", ")}.`,
      segments
    };
  }

  PitchingPlan.validate(data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, file);
  console.log(`${action === "clear" ? "Cleared" : "Saved"} pitching-plan override for ${date}, game ${gamePk}, ${side}.`);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
