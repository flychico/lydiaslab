#!/usr/bin/env node
"use strict";

const assert = require("assert");
const PitcherCore = require("../js/pitcher-matchup-core.js");

(async () => {
  const seasonResponse = {
    people: [{
      id: 999,
      fullName: "Kendry Rojas",
      pitchHand: { code: "L" },
      stats: [{
        splits: [{
          stat: {
            era: "2.79",
            whip: "1.60",
            inningsPitched: "9.2",
            strikeOuts: 8,
            baseOnBalls: 5,
            homeRuns: 1,
            gamesStarted: 1,
            gamesPitched: 3,
            wins: 1,
            losses: 1,
            battersFaced: 42,
            groundOuts: 10,
            airOuts: 9,
            hits: 11,
            atBats: 36,
            sacFlies: 1
          }
        }]
      }]
    }]
  };

  const gameLogResponse = {
    stats: [{
      splits: [
        { stat: { gamesStarted: 1, inningsPitched: "3.0" } },
        { stat: { gamesStarted: 0, inningsPitched: "4.0" } },
        { stat: { gamesStarted: 0, inningsPitched: "2.2" } }
      ]
    }]
  };

  const getJson = async url => {
    if (url.includes("stats=gameLog")) return gameLogResponse;
    return seasonResponse;
  };

  const stats = await PitcherCore.fetchPitchers([999], "2026-07-21", getJson);
  const scored = PitcherCore.scorePitcher(stats[999]);

  assert.strictEqual(scored.ipStart, 3.0);
  assert.notStrictEqual(scored.ipStart, 9.7);
  console.log("PASS: mixed-role pitcher IP/start uses starter-only game logs (Kendry Rojas = 3.0).");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
