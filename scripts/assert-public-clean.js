#!/usr/bin/env node
/* Fails if public HTML exposes internal implementation language. */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const forbidden = [
  { re: /scripts\/generate-/i, label: "script path" },
  { re: /source_of_truth/i, label: "internal JSON field" },
  { re: /Official record source/i, label: "internal source label" },
  { re: /Source:\s*scripts/i, label: "script source label" },
  { re: /Generated\s+20\d{2}-\d{2}-\d{2}T/i, label: "raw timestamp" }
];
const roots = [".", "picks", "member-brief", "tools", "previews", "recaps", "results", "membership", "articles", "dashboard", "stats", "odds"];
const files = [];
for (const root of roots) collect(path.join(ROOT, root));
const hits = [];
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const txt = fs.readFileSync(file, "utf8");
  for (const f of forbidden) {
    if (f.re.test(txt)) hits.push(`${rel}: ${f.label}`);
  }
}
if (hits.length) {
  console.error("Public-clean check failed:");
  for (const hit of hits) console.error(`- ${hit}`);
  process.exit(1);
}
console.log(`Public-clean check passed for ${files.length} HTML file(s).`);
function collect(dir) {
  if (!fs.existsSync(dir)) return;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    if (dir.endsWith(".html")) files.push(dir);
    return;
  }
  for (const item of fs.readdirSync(dir)) {
    if ([".git", "node_modules"].includes(item)) continue;
    collect(path.join(dir, item));
  }
}
