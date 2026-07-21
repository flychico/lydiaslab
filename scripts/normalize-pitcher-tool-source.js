#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "tools", "pitcher-matchups", "index.html");
if (!fs.existsSync(file)) throw new Error(`Missing ${file}`);

let html = fs.readFileSync(file, "utf8");
let changed = false;

if (!html.includes('/js/pitcher-matchup-core.js')) {
  const anchor = '<footer id="footer"></footer><script src="/js/app.js"></script>';
  if (!html.includes(anchor)) throw new Error("Pitcher tool app.js anchor not found.");
  html = html.replace(
    anchor,
    `${anchor}\n<script src="/js/pitcher-matchup-core.js"></script>`
  );
  changed = true;
}

const oldLoad = 'const [pitcherStats] = await Promise.all([fetchPitchers(ids, date), loadBullpen(date)]);';
const newLoad = 'const [pitcherStats] = await Promise.all([LyDiaPitcherCore.loadPitchersForDate(ids, date), loadBullpen(date)]);';
if (html.includes(oldLoad)) {
  html = html.replace(oldLoad, newLoad);
  changed = true;
} else if (!html.includes(newLoad)) {
  throw new Error("Pitcher tool data-source line not found.");
}

const oldMissing = 'if (!p) return scorePitcher({ name: "TBD", missing: true });';
const newMissing = 'if (!p) return LyDiaPitcherCore.scorePitcher({ name: "TBD", missing: true });';
if (html.includes(oldMissing)) {
  html = html.replace(oldMissing, newMissing);
  changed = true;
} else if (!html.includes(newMissing)) {
  throw new Error("Pitcher tool TBD scoring line not found.");
}

const oldScore = 'return scorePitcher(st);';
const newScore = 'return LyDiaPitcherCore.scorePitcher(st);';
if (html.includes(oldScore)) {
  html = html.replace(oldScore, newScore);
  changed = true;
} else if (!html.includes(newScore)) {
  throw new Error("Pitcher tool scoring line not found.");
}

if (changed) {
  fs.writeFileSync(file, html, "utf8");
  console.log("Updated Pitcher Matchup Tool to use the canonical shared pitcher source.");
} else {
  console.log("Pitcher Matchup Tool already uses the canonical shared pitcher source.");
}
