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

for (const page of manifest.pages || []) {
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
}

console.log(`PASS: ${manifest.pages.length} matchup pages match the canonical Pitcher Matchup Tool data for ${DATE}.`);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}
