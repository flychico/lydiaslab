#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const file = path.join(ROOT, "results", "index.html");

if (!fs.existsSync(file)) {
  throw new Error("results/index.html is missing. Run scripts/grade-results.js first.");
}

let html = fs.readFileSync(file, "utf8");

const liveBlock = `<section id="live-pick-results" class="card" style="margin:16px 0 24px">
  <h2 style="margin-top:0">Today's Pick Status</h2>
  <div class="loading">Loading live pick results...</div>
</section>`;

if (!html.includes('id="live-pick-results"')) {
  html = html.replace(/(<p class="subtitle">[\s\S]*?<\/p>)/, `$1\n${liveBlock}`);
}

if (!html.includes('/js/live-results.js')) {
  html = html.replace("</body>", '<script src="/js/live-results.js"></script>\n</body>');
}

html = html.replace(
  /Picks are published every morning[\s\S]*?A reminder that even good models have losing stretches: judge the process over hundreds of picks, not a hot or cold week\./,
  "Today's pick status updates in the browser while games are live. The official record is committed to the repository by automation after games finish, so the history still has a public timestamp trail. A reminder that even good models have losing stretches: judge the process over hundreds of picks, not a hot or cold week."
);

fs.writeFileSync(file, html, "utf8");
console.log("results/index.html live results block verified");
