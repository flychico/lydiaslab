#!/usr/bin/env node
/*
  Prerender the hub pages so search engines see their content.

  Why (SEO-13, 2026-11-02): the scoreboards, picks, results, recaps, stats and
  injury trackers build everything in the browser. Their HTML held a heading
  and "Loading..." (58 to 170 words), which is all a crawler reads before it
  runs JavaScript. This opens each hub in headless Chromium against a local
  copy of the site, waits until it has finished loading, and writes the
  finished <main> and <nav> back into the page's HTML.

  Visitors see no difference: each page's script still runs on load and
  replaces those sections with fresh data (every hub writes its sections with
  innerHTML =, never appends). The saved copy is what Google reads.

  Display only: reads the pages and data files already in the repo, changes
  no number. A page is left untouched if it fails to load, still says
  "Loading" after the wait, or logs a script error.

  Usage: node scripts/prerender-hubs.js [path ...]   (needs the playwright package)
*/
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const PAGES = [
  "/",
  "/nfl/scoreboard/", "/nfl/previews/", "/nfl/results/", "/nfl/recaps/", "/nfl/stats/", "/nfl/tools/injury-tracker/",
  "/nba/scoreboard/", "/nba/previews/", "/nba/results/", "/nba/recaps/", "/nba/stats/", "/nba/tools/injury-tracker/",
];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".csv": "text/csv", ".xml": "application/xml" };

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p.endsWith("/")) p += "index.html";
      const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// Replace the first <tag ...id="id"...>...</tag> (or <main>...</main>) in src.
// Elements of the same tag nested inside are counted so the right close is used.
function spliceElement(src, tag, idAttr, inner) {
  const open = idAttr ? new RegExp(`<${tag}\\b[^>]*\\bid="${idAttr}"[^>]*>`, "i") : new RegExp(`<${tag}\\b[^>]*>`, "i");
  const m = open.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length;
  const re = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, "gi");
  re.lastIndex = start;
  let depth = 1, t;
  while ((t = re.exec(src))) {
    depth += t[0][1] === "/" ? -1 : 1;
    if (depth === 0) return src.slice(0, start) + inner + src.slice(t.index);
  }
  return null;
}

async function main() {
  const { chromium } = require("playwright");
  const only = process.argv.slice(2);
  const pages = only.length ? only : PAGES;
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ timezoneId: "America/New_York", locale: "en-US", viewport: { width: 1280, height: 900 } });
  let written = 0, skipped = 0;
  for (const p of pages) {
    const file = path.join(ROOT, p, "index.html");
    if (!fs.existsSync(file)) { console.log(`skip ${p}: no file`); skipped++; continue; }
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(String(e.message || e)));
    try {
      await page.goto(base + p, { waitUntil: "networkidle", timeout: 45000 });
      // Wait until nothing in <main> still says Loading (charts and live
      // scores can take a moment after network idle).
      await page.waitForFunction(() => {
        const m = document.querySelector("main");
        return m && !/Loading/i.test(m.innerText);
      }, null, { timeout: 20000 }).catch(() => {});
      const out = await page.evaluate(() => {
        // Selected options and typed values live in properties, not in the
        // HTML; write them into attributes so the saved copy shows the same
        // choice (the date picker showed its first day otherwise).
        document.querySelectorAll("main select option").forEach(o => o.toggleAttribute("selected", o.selected));
        document.querySelectorAll("main input").forEach(i => { if (i.type === "checkbox" || i.type === "radio") i.toggleAttribute("checked", i.checked); else if (i.value) i.setAttribute("value", i.value); });
        const m = document.querySelector("main"), n = document.getElementById("nav");
        return { main: m ? m.innerHTML : null, nav: n ? n.innerHTML : null, text: m ? m.innerText : "" };
      });
      if (!out.main) { console.log(`skip ${p}: no <main>`); skipped++; continue; }
      if (/Loading/i.test(out.text)) { console.log(`skip ${p}: still loading after the wait`); skipped++; continue; }
      if (errors.length) { console.log(`skip ${p}: script error: ${errors[0].slice(0, 160)}`); skipped++; continue; }
      let src = fs.readFileSync(file, "utf8");
      const stamp = `\n<!-- prerendered ${new Date().toISOString()} by scripts/prerender-hubs.js; replaced by the page script on load -->\n`;
      const inner = stamp + out.main.replace(/<!--\s*prerendered [^>]*-->\s*/g, "").trim() + "\n";
      let next = spliceElement(src, "main", null, inner);
      if (next && out.nav) next = spliceElement(next, "nav", "nav", out.nav) || next;
      if (!next) { console.log(`skip ${p}: could not find <main> in the file`); skipped++; continue; }
      const words = out.text.split(/\s+/).filter(Boolean).length;
      if (next !== src) { fs.writeFileSync(file, next); written++; }
      console.log(`ok   ${p}: ${words} words`);
    } catch (e) {
      console.log(`skip ${p}: ${String(e.message || e).split("\n")[0]}`); skipped++;
    } finally {
      await page.close();
    }
  }
  await browser.close();
  srv.close();
  console.log(`prerender: ${written} written, ${skipped} skipped`);
}

main().catch(e => { console.error(e); process.exit(1); });
