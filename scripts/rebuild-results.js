#!/usr/bin/env node
/*
  LyDia — rebuild data/results.json and results/index.html from
  data/results_log.csv alone. No network access, no re-grading.

  Run this after hand-editing a row in data/results_log.csv to correct a
  result (or the `actual` stat it was graded against). Rebuilds every date
  currently in the log, not just one day, so a correction to an old date
  updates the lifetime totals on results/index.html too.

  Usage: node scripts/rebuild-results.js
*/
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const { rebuildAll, rebuildResultsPage } = require("./lib/results-rebuild");

function main() {
  const results = rebuildAll();
  const dateCount = Object.keys(results.days).length;
  if (!dateCount) {
    console.log("data/results_log.csv has no rows yet — nothing to rebuild.");
    return;
  }

  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "results.json"), JSON.stringify(results, null, 2) + "\n");

  fs.mkdirSync(path.join(ROOT, "results"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "results", "index.html"), rebuildResultsPage(results));

  console.log(`Rebuilt data/results.json and results/index.html from ${dateCount} date(s) in results_log.csv.`);
}

main();
