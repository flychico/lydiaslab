#!/usr/bin/env node
/**
 * Emails Lynold each new X post as a graphic plus ready-to-paste text, from the
 * site itself (Leo Manager, 2026-11-18). Replaces the six Claude post tasks.
 *
 * Why: on Nov 18 the updated NBA picks post (3 picks) went out from Lynold's
 * own Gmail to himself and Gmail filed it under Sent only, so he never saw it.
 * He chose "Site sends them": the publish and grade runs that write the post
 * now draw it (scripts/render-post-card.js) and send it from
 * Leo <cards@ndhorizon.com> through Resend, like the card emails.
 *
 *   node scripts/send-x-posts.js <nba|nfl> <date> [<date> ...] [--dry]
 *
 * Reads data/<sport>/social/<date>.json (written by scripts/build-<sport>-social.js,
 * the sport chat's words; nothing here changes a word). For each post:
 *   - results posts (waves and the day post): sent once.
 *   - the picks post: sent once; sent again as "(updated)" when its pick lines
 *     change before the first start (the builders freeze it after that).
 * Log: data/email-log/x-posts-<sport>-<date>.json {sent: {id: {at, hash}}}.
 * Recipient: the AUDIT_EMAIL secret (Lynold). Never fails the run.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");
const { sendOne } = require("./lib/nba-send");
const { players } = require("./lib/post-players");   // ChatGPT card brief (business/CHATGPT_VISUALS.md)

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const [sportArg, ...rest] = args.filter(a => !a.startsWith("--"));
const sport = String(sportArg || "").toLowerCase();
const dates = rest.join(" ").split(/[\s,]+/).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
if (!["nba", "nfl", "parlay"].includes(sport) || !dates.length) { console.log("usage: send-x-posts.js <nba|nfl|parlay> <date> [...]"); process.exit(0); }

const KEY = process.env.RESEND_API_KEY, TO = process.env.AUDIT_EMAIL;
const FROM = "Leo <cards@ndhorizon.com>";
const PW_DIR = "/tmp/leo-pw";

const hashOf = p => crypto.createHash("sha1").update(JSON.stringify(p.lines || p.text || "")).digest("hex").slice(0, 12);
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Links shown as clean anchors so Gmail never rewrites the visible address (Lynold copies it into X).
const linkify = s => esc(s).replace(/https:\/\/ndhorizon\.com\/[^\s<]*/g, u => `<a href="${u}" style="color:#1A4E8A">${u}</a>`);

let pwReady = false;
function ensurePlaywright() {
  if (pwReady) return true;
  try {
    if (!fs.existsSync(path.join(PW_DIR, "node_modules", "playwright"))) {
      cp.execSync(`npm i --silent --no-audit --no-fund --prefix ${PW_DIR} playwright@1.63.0`, { stdio: "inherit" });
    }
    cp.execSync(`npx --prefix ${PW_DIR} playwright install --with-deps chromium`, { stdio: "inherit", cwd: PW_DIR });
    pwReady = true;
  } catch (e) { console.log("::warning::playwright install failed: " + e.message); }
  return pwReady;
}

function render(file, id, out) {
  const env = { ...process.env, NODE_PATH: [path.join(PW_DIR, "node_modules"), process.env.NODE_PATH || ""].filter(Boolean).join(":") };
  const r = cp.execFileSync("node", [path.join(__dirname, "render-post-card.js"), file, id, out], { env, encoding: "utf8" });
  const j = JSON.parse(r.slice(r.indexOf("{")));
  return j;
}

function bodies(post, note, gpt) {
  // One block to copy into the "Leo cards" ChatGPT project (Lynold, Nov 20: "if i copy the text from
  // the email and send it to chat, chat would know what graphic to make"). Same words as latest.txt.
  const text = (note ? note + "\n\n" : "") + "POST TEXT FOR X:\n\n" + post.text +
    "\n\nCOPY THIS INTO CHATGPT (Leo cards project) FOR THE GRAPHIC:\n\n" + gpt +
    "\n\nLeo's own graphic is attached as a backup.";
  const box = "border:1px solid #D9CFBD;padding:14px;white-space:pre-wrap;font-family:Arial,sans-serif";
  const html = `<!doctype html><html><head><meta name="color-scheme" content="light only"></head>
<body style="margin:0;background:#FFFFFF" bgcolor="#FFFFFF"><table width="100%" cellpadding="0" cellspacing="0" bgcolor="#FFFFFF"><tr><td style="padding:16px">
<table cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1F2329">
${note ? `<tr><td style="padding:0 0 12px;font-weight:bold;color:#7A5E12">${esc(note)}</td></tr>` : ""}
<tr><td style="padding:0 0 6px;font-weight:bold;color:#1A2535">Post text for X</td></tr>
<tr><td style="${box}">${linkify(post.text)}</td></tr>
<tr><td style="padding:18px 0 6px;font-weight:bold;color:#1A2535">Copy this into ChatGPT for the graphic</td></tr>
<tr><td style="${box};background:#F7F4EE" bgcolor="#F7F4EE">${esc(gpt)}</td></tr>
<tr><td style="padding:12px 0 0;color:#3D3830">Leo's own graphic is attached as a backup.</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}


// The ChatGPT scheduled task reads one fixed page per sport and draws the card
// in Lynold's ChatGPT (Pro covers it). Lynold, Nov 19: "why would i do something
// thats going to charge me per image when i have chatgpt pro?"; chose to test a
// ChatGPT scheduled task. ndhorizon.com/data/<sport>/social/latest.txt holds the
// newest post of the newest date, as the daily message of business/CHATGPT_VISUALS.md.
function cardType(post) {
  const noPick = post.kind === "picks" && (post.nopick || (post.lines || []).some(l => /^No (Leo )?picks? /i.test(l)));
  if (post.kind === "reads") return { noPick: false, type: post.id === "upset" ? "upset watch" : /^g\d$/.test(post.id) ? "game spotlight" : "Leo's reads" };
  if (post.id === "rday") return { noPick: false, type: "results (Leo's reads)" };
  return { noPick, type: post.parlay ? (post.kind === "picks" ? "Leo Parlay" : "Leo Parlay results") : post.kind !== "picks" ? "results" : noPick ? "no picks" : "picks" };
}
// The daily message of business/CHATGPT_VISUALS.md PART 2, ready to paste.
function chatMessage(sport, date, post) {
  const { noPick, type } = cardType(post);
  const who = players(sport, date, post);
  return [
    "Make today's Leo card. Card type: " + type + ".",
    post.kind === "reads" ? `Use the picks card look with the headline "${String(post.hero || "Leo's reads").toUpperCase()}" and the line "${post.note || "Win chances, not picks"}". These are Leo's win chances, NOT picks: never write PICKS or LEO PICKS on it, show each line on its own bar with the percent in gold.` : null,
    post.id === "rday" ? 'Use the results card look with the headline "LEO\'S READS" and the line "' + post.record + ' winners"; these are win chances graded, not picks.' : null,
    who ? "Players to use: " + who : null,
    noPick && post.note ? "Reason line: " + post.note : null,
    "Post:",
    post.text,
  ].filter(x => x != null).join("\n");
}
function writeLatest(sport, date, doc) {
  const posts = (doc.posts || []).filter(p => p.text);
  if (!posts.length) return;
  const f = path.join(ROOT, "data", sport, "social", "latest.txt");
  try { const old = fs.readFileSync(f, "utf8"); const m = /^Date: (\d{4}-\d{2}-\d{2})/m.exec(old); if (m && m[1] > date) return; } catch (e) {}
  const post = posts[posts.length - 1];
  const out = [
    `Date: ${date}`,
    `Post: ${sport.toUpperCase()} ${post.id}`,
    `Updated: ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}`,
    "",
    chatMessage(sport, date, post),
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, out);
}


// When to post, in the subject line (Lynold, Nov 19: "tell me when to post them"; X posting stays manual).
// Picks posts: before the first game starts. Results posts: whenever he can.
function firstStart(sport, date) {
  const r = f => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch (e) { return null; } };
  const t = [];
  if (sport === "nba" || sport === "parlay") { const c = r(`data/nba/picks-${date}.json`); for (const g of (c && c.games) || []) if (g.tip_utc) t.push(Date.parse(g.tip_utc)); }
  if (sport === "nfl" || sport === "parlay") {
    const l = r(`data/nfl/picks-${date}.json`);
    for (const g of Array.isArray(l) ? l : []) if (g.date && /^\d{1,2}:\d{2}$/.test(g.kickoff || "")) {
      const [h, m] = g.kickoff.split(":").map(Number);
      const guess = Date.UTC(+g.date.slice(0, 4), +g.date.slice(5, 7) - 1, +g.date.slice(8, 10), h, m);
      const et = new Date(guess).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit" });
      t.push(guess + ((h - (+et % 24) + 24) % 24) * 36e5);
    }
  }
  if (sport === "parlay") { const p = r(`data/parlay/${date}.json`); if (p && p.legs) return Math.min(...p.legs.map(l => Date.parse(l.start_utc)).filter(Boolean)); }
  return t.length ? Math.min(...t) : null;
}
function postBy(sport, date, post) {
  if (post.kind === "reads" && post.tip_utc) {   // reads, upset watch, spotlights: before that game (or the first game) starts
    const t = Date.parse(post.tip_utc), when = new Date(t).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
    return t > Date.now() ? `post before ${when} ET` : "games already started";
  }
  if (post.kind !== "picks") return "post when you can";
  const t = firstStart(sport, date);
  if (!t || isNaN(t)) return "post before the first game";
  const when = new Date(t).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  return t > Date.now() ? `post before ${when} ET` : "games already started";
}

(async () => {
  for (const date of dates) {
    const file = path.join(ROOT, "data", sport, "social", `${date}.json`);
    if (!fs.existsSync(file)) { console.log(`${sport} ${date}: no social file`); continue; }
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    try { writeLatest(sport, date, doc); } catch (e) { console.log("::warning::latest card page: " + e.message); }
    const logFile = path.join(ROOT, "data", "email-log", `x-posts-${sport}-${date}.json`);
    let log = { sport, date, sent: {} };
    try { log = JSON.parse(fs.readFileSync(logFile, "utf8")); log.sent = log.sent || {}; } catch (e) {}

    for (const post of doc.posts || []) {
      if (!post.text) continue;
      const h = hashOf(post), prev = log.sent[post.id];
      let note = "";
      if (prev) {
        if (post.kind !== "picks" || prev.hash === h) continue;
        note = "This replaces the earlier picks email: a later read changed Leo's picks.";
      }
      const subject = `Leo ${sport.toUpperCase()} post ${date} ${post.id}${note ? " (updated)" : ""} · ${postBy(sport, date, post)}`;
      if (DRY) { console.log(`[dry] would send: ${subject}`); continue; }
      if (!KEY || !TO) { console.log("::warning::RESEND_API_KEY or AUDIT_EMAIL missing; post not sent"); return; }
      if (!ensurePlaywright()) return;
      const out = `/tmp/${sport}-${date}-${post.id}.jpg`;
      let card;
      try { card = render(file, post.id, out); } catch (e) { console.log(`::warning::render failed for ${subject}: ${e.message}`); continue; }
      if (card.overflow) console.log(`::warning::${subject}: graphic overflows, sent anyway`);
      const { text, html } = bodies(post, note, chatMessage(sport, date, post));
      const res = await sendOne({
        from: FROM, to: [TO], subject, text, html,
        attachments: [{ filename: `${sport}-${date}-${post.id}.jpg`, content: fs.readFileSync(out).toString("base64") }],
      }, { key: KEY });
      if (res.ok) {
        log.sent[post.id] = { at: new Date().toISOString(), hash: h, updated: !!note };
        console.log(`sent: ${subject}`);
      } else {
        (log.errors = log.errors || []).push({ at: new Date().toISOString(), id: post.id, status: res.status, name: res.name, message: res.message });
        console.log(`::warning::not sent: ${subject}: ${res.status} ${res.name} ${res.message}`);
      }
    }
    if (!DRY) { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, JSON.stringify(log, null, 1) + "\n"); }
  }
})().catch(e => { console.log("::warning::send-x-posts: " + e.message); });
