#!/usr/bin/env node
// Rebuild sitemap.xml from the live pages, or with --check fail if it is out of date.
const path = require("path");
const { writeSitemap, checkSitemap } = require("./lib/sitemap");
const ROOT = path.join(__dirname, "..");
if (process.argv.includes("--check")) {
  const { dead, missing } = checkSitemap(ROOT);
  if (dead.length || missing.length) {
    console.error(`sitemap.xml is out of date: ${dead.length} dead URL(s), ${missing.length} page(s) missing.`);
    dead.slice(0, 10).forEach(u => console.error(`  dead:    ${u}`));
    missing.slice(0, 10).forEach(u => console.error(`  missing: ${u}`));
    process.exit(1);
  }
  console.log("sitemap.xml matches the live pages.");
} else {
  console.log(`wrote sitemap.xml with ${writeSitemap(ROOT)} pages`);
}
