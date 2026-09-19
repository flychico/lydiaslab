#!/usr/bin/env node
"use strict";

/*
  One-time and repeat-safe public-truth normalizer.
  It does not alter model calculations or JSON field names.
  Internal lab_score remains 0-100.
*/

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

function patch(rel, transforms) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) return;
  let text = fs.readFileSync(file, "utf8");
  const before = text;
  for (const [from, to] of transforms) {
    text = typeof from === "string" ? text.split(from).join(to) : text.replace(from, to);
  }
  if (text !== before) {
    fs.writeFileSync(file, text, "utf8");
    console.log("Normalized", rel);
  }
}

const publicLabTerms = [
  ["Lab Score grades setup quality", "Lab Rating grades setup quality"],
  ["Lab Score is not win probability", "Lab Rating is not win probability"],
  ["a Lab Score of at least 80/100", "a Lab Rating of at least 8.0/10"],
  ["Lab Score is not win probability.", "Lab Rating is not win probability."],
  ["strong Lab Score", "strong Lab Rating"],
  [">Lab Score<", ">Lab Rating<"],
  ["Lab Score:", "Lab Rating:"],
  ["Lab Score ", "Lab Rating "]
];

patch("index.html", [
  ...publicLabTerms,
  ["both model probability and Lab Rating clear the stricter gates", "both model probability and Lab Rating clear the stricter gates"],
  ["The current official model is moneyline-only.", "The current official model is moneyline-only."]
]);

patch("results/index.html", publicLabTerms);
patch("tools/market/index.html", [
  ...publicLabTerms,
  [/\$\{x\.lab_score \?\? "-"\}/g, '${typeof x.lab_score === "number" ? (x.lab_score / 10).toFixed(1) + "/10" : "-"}']
]);

patch("scripts/generate-member-lab.js", [
  ['note: "Lab Score is setup quality. It is not win probability. Official picks require both strong win probability and strong setup quality."', 'note: "Lab Rating is setup quality. It is not win probability. Official picks require both strong win probability and strong setup quality."'],
  ['note: "Lab Score grades setup quality. It is not win probability."', 'note: "Lab Rating grades setup quality. It is not win probability."'],
  ["Lab Score >= 80", "Lab Rating >= 8.0/10"],
  ["Lab Score gates", "Lab Rating gates"],
  ["Lab Score of ", "Lab Rating of "]
]);

patch("scripts/lib/bullpen-fatigue-core.js", [
  ["Leo Bullpen Fatigue Core v2.1-locked-formula", "Leo Bullpen Fatigue Core v3-runs-aware"],
  ["Scoring rule (v3, runs-aware):", "Active owned scoring rule (v3, runs-aware):"],
  ["// Audit formula v3. Reliever counts remain context-only.", "// Active owned formula v3. Reliever counts remain context-only."],
  ['const VERSION = "bullpen-fatigue-v3-runs-aware";', 'const VERSION = "bullpen-fatigue-v3-runs-aware";']
]);

console.log("Public truth normalization complete. Internal formulas and lab_score fields were not changed.");
