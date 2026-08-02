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

// The canonical Pitcher Matchup Tool data covers every scheduled game
// regardless of status. The Member Brief can legitimately have fewer games
// than that on a day whose first capture ran after a game's first pitch —
// generate-member-lab.js's retention guard skips an already-started game
// with no posted pregame analysis rather than failing the whole run (see
// HANDOFF, 2026-07-30). A game that was skipped for that reason has no card
// in the Unified Picks preview at all, so it cannot be checked for bullpen-
// game text within a card that doesn't exist. Only check games the brief
// actually published.
const briefPks = new Set((brief.games || []).map(game => String(game.game_pk)));

for (const [gamePk, game] of Object.entries(canonical.games || {})) {
  if (!briefPks.has(String(gamePk))) continue;
  for (const side of ["away", "home"]) {
    const pitcher = game[side] || {};
    const isBullpenGame = Boolean(pitcher.bullpenGame || (pitcher.role && pitcher.role.bullpenGame));
    if (!isBullpenGame) continue;
    const team = side === "away" ? game.away_team : game.home_team;
    if (!preview.includes(`${team} is using a bullpen game.`)) {
      throw new Error(`Unified Picks explanation omits bullpen-game impact for ${team}.`);
    }
  }
}
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

/*
  Every matchup page that HAS a Picks card must be linked from it.

  This used to demand a link for every page in the manifest, which contradicted
  the policy stated at the top of this file: the Member Brief can legitimately
  carry fewer games than the canonical set. The manifest is built from the
  canonical Pitcher Matchup Tool data (every scheduled game); the Picks page
  renders one card per BRIEF game. A page in the first set but not the second
  has no card, therefore no <h2> heading, therefore nothing for
  generate-matchup-pages.js linkDailyPreview() to attach a link to — it finds
  no match and moves on without error, and this check then failed three steps
  later blaming the Picks page for a link it was never able to write.

  That is what broke the 2026-08-02 publish run on
  /mlb/phillies-vs-orioles-prediction-odds-2026-08-02/ with all 15 pages
  indexable and the quality gate clean.

  The requirement is now scoped to pages whose game actually has a card. Pages
  without one are reported, not fatal — if that count is ever unexpectedly
  large the log says so, which is the signal worth having. A card that exists
  and is NOT linked is still a hard failure, because that is a real regression
  in internal linking rather than a set difference.
*/
const unlinkedPages = [];
const cardlessPages = [];
for (const page of matchupManifest.pages || []) {
  const pathname = new URL(page.url).pathname;
  if (!briefPks.has(String(page.game_pk))) { cardlessPages.push(pathname); continue; }
  if (!preview.includes(pathname) || !previewHub.includes(pathname)) unlinkedPages.push(pathname);
}
if (unlinkedPages.length) {
  throw new Error(`Unified Picks page is missing matchup link(s) for game(s) it renders a card for: ${unlinkedPages.join(", ")}.`);
}
if (cardlessPages.length) {
  console.log(`${cardlessPages.length} matchup page(s) have no Picks card and were not required to be linked: ${cardlessPages.join(", ")}.`);
}

console.log(`Picks/Bullpen verification passed for ${DATE}: ${briefPks.size} games retained.`);
