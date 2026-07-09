#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const file = path.join(ROOT, "data", "clv", "clv_log.csv");

if (!fs.existsSync(file)) {
  console.log("No CLV log found. Nothing to dedupe.");
  process.exit(0);
}

const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
const header = lines.shift() || "date,market,matchup,pick,price_taken,result";
const seen = new Set();
const kept = [];

function splitCsv(line) {
  return line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(v => v.replace(/^"|"$/g, ""));
}

for (const line of lines) {
  if (!line.trim()) continue;
  const cols = splitCsv(line);
  const key = cols.slice(0, 4).join("|");
  if (seen.has(key)) continue;
  seen.add(key);
  kept.push(line);
}

fs.writeFileSync(file, [header, ...kept].join("\n") + "\n", "utf8");
console.log(`CLV log deduped. Rows kept: ${kept.length}.`);
