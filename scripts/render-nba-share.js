#!/usr/bin/env node
/**
 * Share card (og:image, 1200x630) for the NBA night pages and the NBA picks page: the night's five highest Leo win
 * chances in the First Light look. The NBA side of the NFL touchdown share card (scripts/render-td-share.js, Lynold,
 * Nov 27: the X preview was "so bland and generic"); Lynold, 2026-11-28: "if an update we make for nfl applies to the
 * nba, you need to do it as well".
 *
 *   node scripts/render-nba-share.js            (today and the next three days that have a card)
 *   node scripts/render-nba-share.js 2026-11-28 (given dates)
 *
 * Reads data/nba/picks-<date>.json and writes img/share/nba-night-<date>.png (a new name each night so X fetches it
 * fresh), then points the og:image and twitter:image of /nba/predictions/<date>/ at it, and those of /nba/previews/
 * at the card for the next night with games still to play. Runs in prerender-hubs.yml, which has Chromium. Display
 * only; never fails the caller.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const ORIGIN = "https://ndhorizon.com";
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const WOLF = (() => { try { return fs.readFileSync(path.join(ROOT, "brand/logos/ndh-icon-gold.svg"), "utf8").replace(/<\?xml[^>]*>/, ""); } catch (e) { return ""; } })();
let COLOR = {};
try { COLOR = require("./lib/nba-card-email").COLOR || {}; } catch (e) { /* plain circles */ }
const PKS = (() => { try { return require("./lib/nba-picks"); } catch (e) { return null; } })();
const nick = n => /Blazers$/.test(String(n)) ? "Trail Blazers" : String(n || "").split(" ").pop();
const iso = k => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(Date.now() + k * 864e5));
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };
const tip = t => t ? new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET" : "";

/** The card's data for one night, or null when the night has no read. */
function cardFor(date) {
  const c = readJson(path.join(ROOT, "data/nba", `picks-${date}.json`));
  const games = ((c && c.games) || []).filter(g => g.leo && g.leo.p_home != null);
  if (!games.length) return null;
  const top = games.map(g => { const h = g.leo.p_home >= 0.5, PT = PKS && !c.early ? PKS.pickText({ ...g, date }) : null;
    return { t: h ? g.home : g.away, team: nick(h ? g.home_name : g.away_name), opp: nick(h ? g.away_name : g.home_name), at: h ? "vs" : "at",
      p: h ? g.leo.p_home : 1 - g.leo.p_home, tip: tip(g.tip_utc), pick: !!(PT && PT.ok) }; })
    .sort((a, b) => b.p - a.p).slice(0, 5);
  const day = new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
  return { date, day, early: !!c.early, games: games.length, top, left: games.filter(g => !g.completed).length, image: `/img/share/nba-night-${date}.png` };
}

function html(d) {
  const rows = d.top.map((p, i) => `
  <div class="row">
    <div class="rank">${i + 1}</div>
    <div class="logo" style="background:#${COLOR[p.t] || "C9A84C"}">${esc(p.t)}</div>
    <div class="who"><div class="name">${esc(p.team)}</div><div class="meta">${esc(p.at)} ${esc(p.opp)} · ${esc(p.tip)}${p.pick ? " · Leo Pick" : ""}</div></div>
    <div class="bar"><span style="width:${Math.round(p.p * 100)}%"></span></div>
    <div class="pct">${Math.round(p.p * 100)}%</div>
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
.logo{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:13px;color:#fff;border:2px solid rgba(245,240,232,.85)}
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
<div class="eye">NBA · ${esc(d.day)} · ${d.games} game${d.games === 1 ? "" : "s"}${d.early ? " · early read" : ""}</div>
<h1>Who Leo likes ${d.date === iso(0) ? "tonight" : "on " + esc(d.day.split(",")[0])}</h1>
<div class="list">${rows}</div>
<div class="foot"><span><b>ndhorizon.com</b> · every game's win chance, set before tip and graded after</span><span>Leo win chance</span></div>
</div><div class="line"></div></body></html>`;
}

/** Point a page's og:image and twitter:image at the card (adds twitter:image when missing). */
function patchHead(file, image) {
  if (!fs.existsSync(file)) return false;
  const url = ORIGIN + image;
  let s = fs.readFileSync(file, "utf8"); const before = s;
  s = s.replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${url}$2`);
  if (/<meta name="twitter:image" content="/.test(s)) s = s.replace(/(<meta name="twitter:image" content=")[^"]*(")/, `$1${url}$2`);
  else s = s.replace(/(<meta name="twitter:card" content="summary_large_image">)/, `$1<meta name="twitter:image" content="${url}">`);
  if (s !== before) fs.writeFileSync(file, s);
  return s !== before;
}

async function main() {
  const asked = process.argv.slice(2).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const cards = (asked.length ? asked : [0, 1, 2, 3].map(iso)).map(cardFor).filter(Boolean);
  if (!cards.length) { console.log("nba share: no NBA card to draw"); return; }
  const { chromium } = require("playwright");
  let page = "";
  const srv = http.createServer((req, res) => {
    if (req.url.split("?")[0] === "/card.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(page); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const b = await chromium.launch();
  try {
    const pg = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    for (const d of cards) {
      page = html(d);
      await pg.goto(`http://127.0.0.1:${srv.address().port}/card.html?d=${d.date}`, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
      await pg.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
      const out = path.join(ROOT, d.image.slice(1));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await pg.screenshot({ path: out, type: "png" });
      const night = patchHead(path.join(ROOT, "nba/predictions", d.date, "index.html"), d.image);
      console.log(`nba share: wrote ${d.image}${night ? ", night page head updated" : ""}`);
    }
  } finally { await b.close(); srv.close(); }
  // The picks page leads with the next night that still has games to play (as its page script does).
  const lead = cards.find(c => c.left > 0) || cards[0];
  if (patchHead(path.join(ROOT, "nba/previews/index.html"), lead.image)) console.log(`nba share: /nba/previews/ now shares ${lead.image}`);
}
main().catch(e => { console.error("nba share: " + e.message); });
