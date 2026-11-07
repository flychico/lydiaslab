#!/usr/bin/env node
// Pins the NFL game page addresses (SEO-09, DEC-20261107-50).
const assert = require("assert");
const U = require("../lib/nfl-urls");
const TEAMS = require("../lib/nfl-teams");

for (const abbr of Object.keys(TEAMS.NAMES)) assert.strictEqual(U.NICK[abbr], TEAMS.nick(abbr), `nickname for ${abbr}`);
assert.strictEqual(Object.keys(U.NICK).length, 32);

// Before Week 10: abbreviations, unchanged.
assert.strictEqual(U.gameSlug("CHI", "SEA", "2026-11-02"), "chi-vs-sea-prediction-odds-2026-11-02");
assert.strictEqual(U.gameUrl("BUF", "MIN", "2026-11-08"), "/nfl/buf-vs-min-prediction-odds-2026-11-08/");
// From Week 10: nicknames.
assert.strictEqual(U.gameSlug("WAS", "NYG", "2026-11-12"), "commanders-vs-giants-prediction-odds-2026-11-12");
assert.strictEqual(U.gameSlug("SF", "LA", "2026-11-15"), "49ers-vs-rams-prediction-odds-2026-11-15");
assert.strictEqual(U.oldSlug("WAS", "NYG", "2026-11-12"), "was-vs-nyg-prediction-odds-2026-11-12");
// Unknown abbreviation falls back to itself.
assert.strictEqual(U.gameSlug("XYZ", "NYG", "2026-11-12"), "xyz-vs-giants-prediction-odds-2026-11-12");
console.log("test-nfl-urls: all passed");
