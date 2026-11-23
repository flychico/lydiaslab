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
 * the sport chat's words; nothing here changes a word). Since Nov 22: one email per slate
 * with the picks post and the best read, one recap email after the games (see the loop),
 * and the picks post again as "(updated)" when its pick lines change before the first start.
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
// Bare ndhorizon.com links become real anchors too, so Gmail never stretches a link into the next line's hashtag (Nov 21).
const linkify = s => esc(s).replace(/(https:\/\/)?ndhorizon\.com\/[^\s<#]*/g, u => `<a href="${u.startsWith("http") ? u : "https://" + u}" style="color:#1A4E8A">${u}</a>`);

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
  if (post.kind === "stat") return { noPick: false, type: "stat line" };
  if (post.id === "nuke" || post.hero === "Leo's nuke") return { noPick: false, type: "nuke" };
  if (post.id === "qbfacts") return { noPick: false, type: "QB matchup facts" };
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
    post.id === "qbfacts" ? 'Use the picks card look with the headline "QB MATCHUPS", each quarterback\'s record on its own bar, small photoreal headshots of the quarterbacks named. These are facts, not picks.' : null,
    post.kind === "reads" && post.id !== "qbfacts" ? `Use the picks card look with the headline "${String(post.hero || "Leo's reads").toUpperCase()}" and the line "${post.note || "Win chances, not picks"}". These are Leo's win chances, NOT picks: never write PICKS or LEO PICKS on it, show each line on its own bar with the percent in gold.` : null,
    post.kind === "stat" ? `Bleacher Report style highlight card: a photorealistic action shot of ${post.player || "the player"} (${post.team || ""}) in his current uniform, the headline "${post.header.replace(/\s*\S+$/u, "")}", each stat on its own line, and the result line. Not a pick.` : null,
    type === "nuke" ? 'Use the picks card look with the headline "NUKE" and a radioactive symbol, one big hero player for the team, the pick and price in gold. Do not show any bet amount or payout.' : null,
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

    // One email per slate with 2 or 3 posts (Lynold, 2026-11-22, chose the outside review's "One email, 2 to 3
    // posts"): before the games, the picks post (cheat sheet, nuke or no picks) and the one best read (upset watch,
    // else the first spotlight); after the games, one recap (the picks results "day" post, else Leo's reads results).
    // The builders still write every post to the social file and the site; only these are emailed. The parlay,
    // wave, stat and extra read posts are no longer emailed. A picks post whose pick lines change before the first
    // start is sent again on its own as "(updated)".
    if (sport === "parlay") { console.log("parlay posts are not emailed (one email per slate, Nov 22)"); continue; }
    // One owner email a day (Lynold, 2026-11-22, "Single Daily Owner Email Spec"): the per-post emails are off.
    // The posts still go to the social files, the site and x/latest for ChatGPT, and the morning Leo Daily Brief
    // carries the post menu from data/daily-recap-latest.json. X_POST_EMAILS=on brings these emails back.
    if (process.env.X_POST_EMAILS !== "on") { console.log(`${sport} ${date}: post emails off, the Leo Daily Brief carries the posts`); continue; }
    const byId = new Map((doc.posts || []).filter(p => p.text).map(p => [p.id, p]));
    const groups = [];
    const picks = byId.get("picks");
    if (picks) {
      const prev = log.sent.picks;
      if (!prev) groups.push({ key: "slate", label: "posts", ids: ["picks", byId.has("upset") ? "upset" : byId.has("g1") ? "g1" : null].filter(Boolean) });
      else if (prev.hash !== hashOf(picks)) groups.push({ key: "slate-updated", label: "picks (updated)", ids: ["picks"],
        note: "This replaces the earlier picks: a later read changed Leo's picks. Post this one instead." });
    }
    const recapId = byId.has("day") ? "day" : byId.has("rday") ? "rday" : null;
    if (recapId && !log.sent.day && !log.sent.rday) groups.push({ key: "recap", label: "results", ids: [recapId] });

    for (const g of groups) {
      const posts = g.ids.map(id => byId.get(id));
      const when = postBy(sport, date, posts[0]);
      const subject = `Leo ${sport.toUpperCase()} ${g.label} ${date} · ${when}`;
      if (DRY) { console.log(`[dry] would send: ${subject} (${g.ids.join(", ")})`); continue; }
      if (!KEY || !TO) { console.log("::warning::RESEND_API_KEY or AUDIT_EMAIL missing; posts not sent"); return; }
      if (!ensurePlaywright()) return;
      const parts = [], attachments = [];
      for (const post of posts) {
        const out = `/tmp/${sport}-${date}-${post.id}.jpg`;
        try { const card = render(file, post.id, out); if (card.overflow) console.log(`::warning::${post.id}: graphic overflows, sent anyway`);
          attachments.push({ filename: `${sport}-${date}-${post.id}.jpg`, content: fs.readFileSync(out).toString("base64") }); }
        catch (e) { console.log(`::warning::render failed for ${post.id}: ${e.message}`); }
        parts.push(bodies(post, "", chatMessage(sport, date, post)));
      }
      const order = posts.length > 1 ? posts.map((p, i) => `${i + 1}. ${cardType(p).type}`).join("   ") : "";
      const intro = [g.note, order ? "Post in this order: " + order : ""].filter(Boolean).join("\n");
      const text = (intro ? intro + "\n\n" : "") + parts.map((x, i) => `===== POST ${i + 1} =====\n\n` + x.text).join("\n\n");
      const html = parts.map((x, i) => {
        const inner = x.html.slice(x.html.indexOf("<table cellpadding"), x.html.lastIndexOf("</td></tr></table></body>"));
        return `<tr><td style="padding:18px 16px 4px;font-family:Arial,sans-serif;font-size:13px;letter-spacing:.06em;color:#7A5E12;font-weight:bold">POST ${i + 1} OF ${parts.length}: ${esc(cardType(posts[i]).type.toUpperCase())}</td></tr><tr><td style="padding:0 16px 10px">${inner}</td></tr>`;
      }).join('<tr><td style="padding:0 16px"><hr style="border:0;border-top:1px solid #D9CFBD"></td></tr>');
      const page = `<!doctype html><html><head><meta name="color-scheme" content="light only"></head><body style="margin:0;background:#FFFFFF" bgcolor="#FFFFFF"><table width="100%" cellpadding="0" cellspacing="0" bgcolor="#FFFFFF">${intro ? `<tr><td style="padding:16px 16px 0;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;color:#1A2535;white-space:pre-wrap">${esc(intro)}</td></tr>` : ""}${html}</table></body></html>`;
      const res = await sendOne({ from: FROM, to: [TO], subject, text, html: page, attachments }, { key: KEY });
      if (res.ok) {
        for (const post of posts) log.sent[post.id] = { at: new Date().toISOString(), hash: hashOf(post), updated: g.key === "slate-updated" };
        console.log(`sent: ${subject} (${g.ids.join(", ")})`);
      } else {
        (log.errors = log.errors || []).push({ at: new Date().toISOString(), id: g.ids.join("+"), status: res.status, name: res.name, message: res.message });
        console.log(`::warning::not sent: ${subject}: ${res.status} ${res.name} ${res.message}`);
      }
    }
    if (!DRY) { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, JSON.stringify(log, null, 1) + "\n"); }
  }
})().catch(e => { console.log("::warning::send-x-posts: " + e.message); });
