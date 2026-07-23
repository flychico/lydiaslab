#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATE = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE || "")) {
  throw new Error("Usage: node scripts/verify-picks-bullpen.js YYYY-MM-DD");
}

const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");
const json = rel => JSON.parse(read(rel));
const slug = value => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

const nav = read("js/app.js");
if (!nav.includes('["/previews/", "Picks"]') || nav.includes('["/previews/", "Previews"]')) {
  throw new Error("Navigation has not consolidated Previews into Picks.");
}

const retired = read("picks/index.html");
if (!retired.includes('window.location.replace("/previews/"')) {
  throw new Error("The retired Picks page does not redirect to the unified page.");
}

const brief = json(`data/member-brief/${DATE}.json`);
const bullpen = json(`data/bullpen/${DATE}.json`);
const preview = read(`previews/${DATE}.html`);
const previewHub = read("previews/index.html");
const canonical = json(`data/pitcher-matchups/${DATE}.json`);
const matchupManifest = json(`data/matchup-pages/${DATE}.json`);

if (!preview.includes("Lynold Mercado") || !preview.includes("/writers/lynold/")) {
  throw new Error("Unified Picks cards are missing author attribution.");
}

const briefPks = new Set((brief.games || []).map(game => String(game.game_pk)));
const bullpenPks = new Set((bullpen.teams || []).map(team => String(team.game_pk)));
const missingBullpenGames = [...briefPks].filter(gamePk => !bullpenPks.has(gamePk));
if (missingBullpenGames.length) {
  throw new Error(`Bullpen tool dropped daily game(s): ${missingBullpenGames.join(",")}`);
}

let verifiedPitcherLinks = 0;
for (const game of brief.games || []) {
  const source = (canonical.games || {})[String(game.game_pk)] || {};
  const edge = game.pitcher_edge || {};
  for (const side of ["away", "home"]) {
    const name = edge[`${side}_pitcher`];
    if (!name || name === "TBD") continue;
    const canonicalPitcher = source[side] || {};
    const id = edge[`${side}_pitcher_id`] ||
      (canonicalPitcher.name === name ? canonicalPitcher.id : null);
    // A locked pregame pitcher can differ from a later probable-pitcher
    // refresh. Do not demand a link for a different pitcher that Picks does
    // not display, and do not block publication when the locked row predates
    // ID capture.
    if (!id) continue;
    const expected = `https://www.mlb.com/player/${slug(name)}-${id}`;
    if (!preview.includes(expected)) {
      throw new Error(`Unified Picks page is missing MLB link for displayed pitcher ${name}.`);
    }
    verifiedPitcherLinks++;
  }
}
if (!verifiedPitcherLinks) {
  throw new Error("Unified Picks verification could not validate any displayed pitcher links.");
}

for (const page of matchupManifest.pages || []) {
  const pathname = new URL(page.url).pathname;
  if (!preview.includes(pathname) || !previewHub.includes(pathname)) {
    throw new Error(`Unified Picks page is missing matchup link ${pathname}.`);
  }
}

console.log(`Picks/Bullpen verification passed for ${DATE}: ${briefPks.size} games retained.`);
