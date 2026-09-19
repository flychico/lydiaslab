#!/usr/bin/env node
/* Fails if public HTML exposes internal implementation language or hardcoded shell markup. */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const forbidden = [
  { re: /scripts\/generate-/i, label: "script path" },
  { re: /source_of_truth/i, label: "internal JSON field" },
  { re: /Official record source/i, label: "internal source label" },
  { re: /Source:\s*scripts/i, label: "script source label" },
  { re: /Generated\s+20\d{2}-\d{2}-\d{2}T/i, label: "raw timestamp" },
  { re: /Generated:\s*20\d{2}-\d{2}-\d{2}T/i, label: "raw timestamp" },
  { re: /<nav(?![^>]*id=["']nav["'])/i, label: "hardcoded nav instead of shared nav" },
  { re: /<footer(?![^>]*id=["']footer["'])/i, label: "hardcoded footer instead of shared footer" },
  // Internal company lingo that must never face members:
  { re: /member-lab/i, label: "internal lingo: member-lab" },
  { re: /(publish|daily|member-lab|maintenance|refresh lines|GitHub) workflow/i, label: "internal lingo: workflow" },
  { re: /generated JSON/i, label: "internal lingo: JSON" },
  { re: /learning ledger|shadow ledger/i, label: "internal lingo: ledger" },
  { re: /\bcron\b/i, label: "internal lingo: cron" },
  { re: /API key/i, label: "internal lingo: API key" }
];

const roots = [".", "picks", "member-brief", "tools", "previews", "recaps", "results", "membership", "articles", "scoreboard", "stats"];
const files = [];
for (const root of roots) collect(path.join(ROOT, root));

const hits = [];
for (const file of [...new Set(files)]) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const txt = fs.readFileSync(file, "utf8");
  for (const f of forbidden) {
    if (f.re.test(txt)) hits.push(`${rel}: ${f.label}`);
  }
}

if (hits.length) {
  console.error("Public-clean check failed:");
  for (const hit of hits.slice(0, 50)) console.error(`- ${hit}`);
  if (hits.length > 50) console.error(`...and ${hits.length - 50} more`);
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
    if ([".git", "node_modules", "gym", "lab-v3", "learning", "odds"].includes(item)) continue;
    collect(path.join(dir, item));
  }
}
