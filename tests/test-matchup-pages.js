#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const packageRoot = path.join(__dirname, "..");
const fixtureRoot = path.join(__dirname, "fixtures");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lydia-matchups-"));

function write(rel, content) {
  const target = path.join(temp, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

write("data/member-brief/2026-07-21.json", fs.readFileSync(path.join(fixtureRoot, "member-brief.json"), "utf8"));
write("data/totals/2026-07-21.json", fs.readFileSync(path.join(fixtureRoot, "totals.json"), "utf8"));
write("data/pitcher-matchups/2026-07-21.json", fs.readFileSync(path.join(fixtureRoot, "pitcher-matchups.json"), "utf8"));
write("data/results.json", fs.readFileSync(path.join(fixtureRoot, "results.json"), "utf8"));
write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://lydiaslab.com/</loc></url></urlset>\n`);
write("previews/2026-07-21.html", `<!DOCTYPE html><html><body><h2>Pittsburgh Pirates @ New York Yankees</h2><h2>Example Away @ Example Home</h2></body></html>`);

const run = spawnSync(process.execPath, [
  path.join(packageRoot, "scripts", "generate-matchup-pages.js"),
  "2026-07-21", "--root", temp, "--offline", "--skip-weather"
], { encoding: "utf8" });

if (run.status !== 0) {
  console.error(run.stdout);
  console.error(run.stderr);
  process.exit(run.status || 1);
}


const verify = spawnSync(process.execPath, [
  path.join(packageRoot, "scripts", "verify-pitcher-matchup-alignment.js"),
  "2026-07-21", "--root", temp
], { encoding: "utf8" });

if (verify.status !== 0) {
  console.error(verify.stdout);
  console.error(verify.stderr);
  process.exit(verify.status || 1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(temp, "data/matchup-pages/2026-07-21.json"), "utf8"));
assert.strictEqual(manifest.total_pages, 2);
assert.strictEqual(manifest.indexable_pages, 1);
assert.strictEqual(manifest.noindex_pages, 1);

const complete = manifest.pages.find(page => page.game.includes("Pirates"));
const incomplete = manifest.pages.find(page => page.game.includes("Example"));
assert(complete && complete.indexable);
assert(incomplete && !incomplete.indexable);

const completeHtml = fs.readFileSync(path.join(temp, complete.output), "utf8");
const incompleteHtml = fs.readFileSync(path.join(temp, incomplete.output), "utf8");
assert(completeHtml.includes('name="robots" content="index,follow,max-image-preview:large"'));
assert(incompleteHtml.includes('name="robots" content="noindex,follow"'));
assert(completeHtml.includes("Starting pitcher matchup"));
assert(completeHtml.includes('data-away-ip-start="5.4"'));
assert(completeHtml.includes('data-home-ip-start="5.2"'));
assert(completeHtml.includes("canonical data source used by LyDia's Pitcher Matchup Tool"));
assert(completeHtml.includes("Bullpen matchup"));
assert(completeHtml.includes("Run total projection"));
assert(incompleteHtml.includes("Analysis still building"));

const sitemap = fs.readFileSync(path.join(temp, "sitemap.xml"), "utf8");
assert(sitemap.includes(complete.url));
assert(!sitemap.includes(incomplete.url));
assert(sitemap.includes("https://lydiaslab.com/mlb/matchups/"));

const preview = fs.readFileSync(path.join(temp, "previews/2026-07-21.html"), "utf8");
assert(preview.includes(`/mlb/${complete.slug}/`));
assert(preview.includes(`/mlb/${incomplete.slug}/`));

const archive = fs.readFileSync(path.join(temp, "mlb/matchups/index.html"), "utf8");
assert(archive.includes("Pittsburgh Pirates @ New York Yankees"));
assert(archive.includes("Analysis building"));

console.log("PASS: generated complete and noindex pages, archive, preview links and gated sitemap.");
console.log(`Fixture output: ${temp}`);
