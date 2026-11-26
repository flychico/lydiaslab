#!/usr/bin/env node
/**
 * Leo's analysis panel (the navy "Leo's analysis" box at the top of a game page) as a post image.
 * Lynold, 2026-11-26: "when it comes to the money line / spreads picks, i want us to use this section for
 * our visuals ... we can see also use the chatgpt generated pics but i also would like to include that."
 *
 *   node scripts/render-analysis-panel.js <out-dir> </nfl/...-prediction-odds-date/> [...]
 *
 * Serves the repo on a local port, opens each built game page at a phone-like width and saves the panel
 * (section.lx) as <out-dir>/<slug>-panel.jpg (1500 px wide). Prints JSON: [{ page, file }] for those found.
 * Needs playwright on NODE_PATH (send-x-posts.js installs it). Never fails the caller: a page or panel that
 * is missing is left out.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const [outDir, ...pages] = process.argv.slice(2);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".ico": "image/x-icon" };

function serve() {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p.endsWith("/")) p += "index.html";
    const f = path.join(ROOT, path.normalize(p).replace(/^(\.\.[\/\\])+/, ""));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r(srv)));
}

(async () => {
  const done = [];
  if (!outDir || !pages.length) { console.log("[]"); return; }
  fs.mkdirSync(outDir, { recursive: true });
  const srv = await serve();
  const port = srv.address().port;
  const b = await chromium.launch();
  try {
    // 750 CSS px wide at 2x: the panel reads like the phone page and comes out 1500 px wide for X.
    const ctx = await b.newContext({ viewport: { width: 750, height: 1400 }, deviceScaleFactor: 2 });
    // No sign-up pop up in the picture.
    await ctx.addInitScript(() => { try { localStorage.setItem("leo_popup_closed", String(Date.now())); localStorage.setItem("leo_signed_up", "1"); } catch (e) {} window.__leoPopScheduled = true; });
    for (const page of [...new Set(pages)]) {
      if (!fs.existsSync(path.join(ROOT, page, "index.html"))) { console.error(`panel: no page ${page}`); continue; }
      const p = await ctx.newPage();
      try {
        await p.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => /fonts\.(googleapis|gstatic)\.com/.test(r.request().url()) ? r.continue() : r.abort());
        await p.goto(`http://127.0.0.1:${port}${page}`, { waitUntil: "load", timeout: 30000 });
        await p.evaluate(() => document.fonts && document.fonts.ready);
        await p.addStyleTag({ content: "nav{display:none!important} .lx{margin:0!important;box-shadow:none!important;border-radius:0!important} .lx-foot{display:none!important}"
          + " .lx-brand{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:6px;padding-top:10px;border-top:1px solid rgba(245,240,232,.12);font-weight:800;letter-spacing:.04em;color:#C9A84C;font-size:.95rem}"
          + " .lx-brand img{width:26px;height:26px}" });
        const el = await p.$("section.lx");
        if (!el) { console.error(`panel: no analysis panel on ${page}`); continue; }
        // Post rules: no sportsbook names in anything posted, and the site address on the picture (the post itself has no link).
        await p.evaluate(() => {
          const lx = document.querySelector("section.lx");
          const w = document.createTreeWalker(lx, NodeFilter.SHOW_TEXT);
          for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeValue = n.nodeValue.replace(/\bclose to DraftKings\b/g, "close to the market").replace(/\bDraftKings\b/g, "the market");
          const d = document.createElement("div"); d.className = "lx-brand";
          d.innerHTML = '<img src="/brand/logos/ndh-icon-gold.svg" alt="">ndhorizon.com';
          lx.appendChild(d);
        });
        await p.waitForFunction(() => { const i = document.querySelector(".lx-brand img"); return i && i.complete; }, null, { timeout: 5000 }).catch(() => {});
        const slug = page.split("/").filter(Boolean).pop();
        const file = path.join(outDir, `${slug}-panel.jpg`);
        await el.screenshot({ path: file, type: "jpeg", quality: 88 });
        done.push({ page, file });
      } catch (e) { console.error(`panel: ${page}: ${e.message}`); }
      finally { await p.close(); }
    }
  } finally { await b.close(); srv.close(); }
  console.log(JSON.stringify(done));
})().catch(e => { console.error("panel: " + e.message); console.log("[]"); });
