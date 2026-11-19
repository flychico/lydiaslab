#!/usr/bin/env node
/**
 * Tells Bing and the other IndexNow engines about new or changed pages
 * (SEO-27, OD-07; Lynold chose "Yes, every run" in the Manager chat, Nov 19).
 *
 *   node scripts/indexnow-ping.js            pages changed by the last commit (HEAD~1..HEAD)
 *   node scripts/indexnow-ping.js --since=<ref>   pages changed since <ref>
 *   node scripts/indexnow-ping.js --all      every address in sitemap.xml (the one-time full send)
 *   add --dry to print the list without sending
 *
 * Only addresses listed in sitemap.xml are sent, so noindex pages, the /x/
 * forwarding pages and the left-out MLB pages never go. One POST of up to
 * 10,000 addresses to api.indexnow.org, which shares it with every
 * participating engine (Bing, Yandex, Seznam, Naver ...). Google does not take
 * IndexNow; the Search Console queue (SEO-25) is unchanged.
 * The key is public by design (it sits in the site root). Never fails a run.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const ROOT = path.join(__dirname, "..");
const HOST = "ndhorizon.com";
const KEY = "7743953e4bf9c350cac430a25827a455";
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const ALL = args.includes("--all");
const since = (args.find(a => a.startsWith("--since=")) || "--since=HEAD~1").slice(8);

function sitemap() {
  try {
    const xml = fs.readFileSync(path.join(ROOT, "sitemap.xml"), "utf8");
    return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]);
  } catch (e) { return []; }
}

// "nfl/week/index.html" -> "https://ndhorizon.com/nfl/week/"; "index.html" -> "https://ndhorizon.com/"
function toUrl(file) {
  if (!/(^|\/)index\.html$/.test(file)) return null;
  return `https://${HOST}/` + file.replace(/(^|\/)index\.html$/, "$1");
}

function changed() {
  try {
    return cp.execSync(`git diff --name-only ${since} HEAD`, { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch (e) { console.log(`::warning::indexnow: could not read changes since ${since}: ${e.message.split("\n")[0]}`); return []; }
}

(async () => {
  const listed = new Set(sitemap());
  if (!listed.size) { console.log("indexnow: sitemap.xml not readable; nothing sent"); return; }
  const urls = ALL ? [...listed] : [...new Set(changed().map(toUrl).filter(u => u && listed.has(u)))];
  if (!urls.length) { console.log("indexnow: no new or changed indexable pages"); return; }
  const batch = urls.slice(0, 10000);
  console.log(`indexnow: ${batch.length} address${batch.length === 1 ? "" : "es"}${ALL ? " (whole sitemap)" : ` changed since ${since}`}`);
  batch.slice(0, 15).forEach(u => console.log("  " + u));
  if (batch.length > 15) console.log(`  ... and ${batch.length - 15} more`);
  if (DRY) return;
  try {
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList: batch }),
    });
    const ok = res.status === 200 || res.status === 202;
    console.log(`${ok ? "" : "::warning::"}indexnow: answer ${res.status}${ok ? " (received)" : " " + (await res.text()).slice(0, 200)}`);
  } catch (e) { console.log("::warning::indexnow: send failed: " + e.message); }
})().catch(e => console.log("::warning::indexnow: " + e.message));
