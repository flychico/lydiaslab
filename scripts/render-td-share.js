#!/usr/bin/env node
/**
 * Share card (og:image, 1200x630) for the NFL anytime touchdown page: the week's five likeliest scorers in the
 * First Light look. Lynold, 2026-11-27, on the X link preview of /nfl/anytime-touchdowns/: "How can we improve this
 * preview? It's so bland and generic".
 *
 *   node scripts/render-td-share.js
 *
 * Reads data/nfl/td-share.json (written by build-nfl-td-page.js, one card per week page) and writes each PNG it names
 * (img/share/nfl-td-<season>-w<week>.png, a new name each week so X fetches it fresh). Runs in prerender-hubs.yml,
 * which has Chromium. Never fails the caller.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const WOLF = (() => { try { return fs.readFileSync(path.join(ROOT, "brand/logos/ndh-icon-gold.svg"), "utf8").replace(/<\?xml[^>]*>/, ""); } catch (e) { return ""; } })();

function html(d) {
  const rows = d.top.slice(0, 5).map((p, i) => `
  <div class="row">
    <div class="rank">${i + 1}</div>
    <img class="logo" src="/img/nfl/${encodeURIComponent(p.team)}.png" alt="">
    <div class="who"><div class="name">${esc(p.player)}</div><div class="meta">${esc(p.meta)}</div></div>
    <div class="bar"><span style="width:${Math.round(p.chance * 100)}%"></span></div>
    <div class="pct">${Math.round(p.chance * 100)}%</div>
  </div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Onest:wght@500;700;800;900&family=EB+Garamond:wght@500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{width:1200px;height:630px;overflow:hidden;font-family:Onest,Arial,sans-serif;color:#F5F0E8;
 background:radial-gradient(900px 520px at 1030px 640px,rgba(232,190,96,.38),rgba(201,168,76,.10) 45%,rgba(26,37,53,0) 70%),linear-gradient(180deg,#141d2b 0%,#1A2535 60%,#212d40 100%)}
.wrap{position:absolute;inset:0;padding:46px 60px}
.top{display:flex;align-items:center;gap:14px}
.top svg{width:46px;height:46px}
.brand{font-family:"EB Garamond",Georgia,serif;font-size:34px;font-weight:600;letter-spacing:.01em}
.brand small{font-family:Onest,Arial;font-size:15px;color:rgba(245,240,232,.6);letter-spacing:.14em;text-transform:uppercase;margin-left:10px;font-weight:700}
.eye{margin-top:26px;color:#C9A84C;font-weight:800;font-size:19px;letter-spacing:.16em;text-transform:uppercase}
h1{font-family:"EB Garamond",Georgia,serif;font-weight:600;font-size:54px;line-height:1.02;margin-top:6px}
.list{position:absolute;left:60px;right:60px;top:236px}
.row{display:grid;grid-template-columns:34px 52px 400px 1fr 96px;align-items:center;column-gap:16px;height:56px;border-bottom:1px solid rgba(245,240,232,.10)}
.row:last-child{border-bottom:0}
.rank{font-family:"EB Garamond",Georgia,serif;color:#C9A84C;font-size:32px;font-weight:600;text-align:center}
.logo{width:44px;height:44px;background:#F5F0E8;border-radius:50%;padding:5px}
.name{font-weight:800;font-size:25px;line-height:1.1}
.meta{font-size:15px;color:rgba(245,240,232,.62);margin-top:2px}
.bar{height:10px;border-radius:5px;background:rgba(245,240,232,.12);overflow:hidden}
.bar span{display:block;height:100%;border-radius:5px;background:linear-gradient(90deg,#9c7f33,#C9A84C,#E8CF86)}
.pct{font-size:36px;font-weight:900;text-align:right}
.foot{position:absolute;left:60px;right:60px;bottom:30px;display:flex;justify-content:space-between;align-items:center;font-size:17px;color:rgba(245,240,232,.7)}
.foot b{color:#F5F0E8;font-weight:800}
.line{position:absolute;left:0;right:0;bottom:0;height:6px;background:linear-gradient(90deg,#9c7f33,#C9A84C,#E8CF86)}
</style></head><body><div class="wrap">
<div class="top">${WOLF}<div class="brand">Leo<small>by New Dawn Horizon</small></div></div>
<div class="eye">NFL Week ${esc(d.week)} · Anytime touchdowns</div>
<h1>Who's most likely to score</h1>
<div class="list">${rows}</div>
<div class="foot"><span><b>ndhorizon.com</b> · every player's chance, set before kickoff and graded after</span><span>${esc(d.updated)}</span></div>
</div><div class="line"></div></body></html>`;
}

async function main() {
  const f = path.join(ROOT, "data/nfl/td-share.json");
  if (!fs.existsSync(f)) { console.log("td share: no data/nfl/td-share.json"); return; }
  const doc = JSON.parse(fs.readFileSync(f, "utf8"));
  const cards = (doc.cards || [doc]).filter(d => d && d.top && d.top.length && d.image);
  if (!cards.length) { console.log("td share: nothing to draw"); return; }
  const { chromium } = require("playwright");
  let page = "";
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/card.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(page); }
    const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[\/\\])+/, ""));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": file.endsWith(".png") ? "image/png" : file.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const b = await chromium.launch();
  try {
    const pg = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    for (const d of cards) {
      page = html(d);
      await pg.goto(`http://127.0.0.1:${srv.address().port}/card.html?w=${d.week}`, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
      await pg.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
      const out = path.join(ROOT, d.image.replace(/^\//, ""));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await pg.screenshot({ path: out, type: "png" });
      console.log(`td share: wrote ${d.image}`);
    }
  } finally { await b.close(); srv.close(); }
}
main().catch(e => { console.error("td share: " + e.message); });
