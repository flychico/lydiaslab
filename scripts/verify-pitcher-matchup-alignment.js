#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const DATE = args.find(value => /^\d{4}-\d{2}-\d{2}$/.test(value));
const rootIndex = args.indexOf("--root");
const ROOT = path.resolve(rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1] : path.join(__dirname, ".."));

if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE || "")) {
  console.error("Usage: node scripts/verify-pitcher-matchup-alignment.js YYYY-MM-DD [--root PATH]");
  process.exit(1);
}

const sourcePath = path.join(ROOT, "data", "pitcher-matchups", `${DATE}.json`);
const manifestPath = path.join(ROOT, "data", "matchup-pages", `${DATE}.json`);

if (!fs.existsSync(sourcePath)) throw new Error(`Missing ${sourcePath}`);
if (!fs.existsSync(manifestPath)) throw new Error(`Missing ${manifestPath}`);

const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

let verified = 0;
let preserved = 0;

for (const page of manifest.pages || []) {
  // Once a game leaves the live Member Brief, its permanent page is a frozen
  // pregame artifact. The canonical pitcher feed continues to change during
  // and after the game, so comparing fresh season aggregates with frozen HTML
  // creates false failures. Freshly generated pages remain strictly verified.
  if (page.preserved) {
    preserved++;
    continue;
  }

  const canonical = source.games && source.games[String(page.game_pk)];
  if (!canonical) throw new Error(`No canonical pitcher row for game ${page.game_pk}`);

  const htmlPath = path.join(ROOT, page.output);
  const html = fs.readFileSync(htmlPath, "utf8");

  for (const side of ["away", "home"]) {
    const pitcher = canonical[side] || {};
    if (pitcher.name && !html.includes(escapeHtml(pitcher.name))) {
      throw new Error(`${page.output} does not contain canonical ${side} pitcher ${pitcher.name}`);
    }

    const ipStart = Number.isFinite(pitcher.ipStart) ? pitcher.ipStart.toFixed(1) : "Not available";
    if (!html.includes(`data-${side}-ip-start="${ipStart}"`)) {
      throw new Error(`${page.output} does not contain canonical ${side} IP/start ${ipStart}`);
    }
  }
  verified++;
}

console.log(
  `PASS: ${verified} freshly generated matchup pages match canonical Pitcher Matchup Tool data for ${DATE}; ` +
  `${preserved} frozen pregame pages retained.`
);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}
