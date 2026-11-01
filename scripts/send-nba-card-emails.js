#!/usr/bin/env node
/**
 * Leo: email the NBA card for a slate date to the free list and to members.
 *
 *   node scripts/send-nba-card-emails.js YYYY-MM-DD          send (needs RESEND_API_KEY, EMAIL_FROM)
 *   node scripts/send-nba-card-emails.js YYYY-MM-DD --dry    print the email, send nothing
 *   node scripts/send-nba-card-emails.js YYYY-MM-DD --html=<file>   write the HTML preview, send nothing
 *
 * Content is data/nba/picks-<date>.json, the card the site shows, laid out
 * like the scoreboard cards (scripts/lib/nba-card-email.js). Free list and
 * members get the same card: NBA has no member-only content yet.
 *
 * When it sends: the first publish run that is within 3 hours of the slate's
 * first tip, so the injury report is as late as possible (a 7pm slate goes
 * at the 6:40pm run; a 3:30pm slate at the 12:40pm run).
 * Safety (same as the NFL card):
 *   - Once per slate date. data/email-log/nba-card-<date>.json records it.
 *   - Never after the first tip. A late run stays quiet.
 *   - Missing secrets, no games or no recipients: logs and exits 0, so the
 *     publish never fails because of email.
 */
const fs = require("fs");
const path = require("path");
const E = require("./lib/nba-card-email");
const WHY = require("./lib/nba-why");

const ROOT = path.join(__dirname, "..");
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || "";
const DRY = process.argv.includes("--dry");
const HTML = (process.argv.find(a => a.startsWith("--html=")) || "").slice(7);
const DATE = (process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)))
  || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const LOG = path.join(ROOT, "data/email-log", `nba-card-${DATE}.json`);
const WINDOW_H = 3;

async function main() {
  const src = path.join(ROOT, "data/nba", `picks-${DATE}.json`);
  if (!fs.existsSync(src)) { console.log(`NBA card email: no card for ${DATE}, nothing to send.`); return; }
  const doc = JSON.parse(fs.readFileSync(src, "utf8"));
  const games = (doc.games || []).filter(g => g.leo);
  if (!games.length) { console.log(`NBA card email: no games on ${DATE}.`); return; }
  const email = E.build(doc, { why: WHY });
  if (HTML) { fs.writeFileSync(HTML, email.html); console.log(`NBA card email preview written to ${HTML}. ${email.subject}`); return; }
  if (DRY) { console.log(`SUBJECT: ${email.subject}\n\n${email.text}`); return; }
  if (fs.existsSync(LOG)) { console.log(`NBA card for ${DATE} already sent (${path.relative(ROOT, LOG)}).`); return; }
  const first = new Date(games.map(g => g.tip_utc).sort()[0]);
  const now = Date.now();
  if (now >= first.getTime()) { console.log(`NBA card email: first tip (${first.toISOString()}) has passed, not sending.`); return; }
  if (first.getTime() - now > WINDOW_H * 36e5) { console.log(`NBA card email: first tip is more than ${WINDOW_H} hours away; a later run sends it.`); return; }
  if (!RESEND_API_KEY || !EMAIL_FROM) { console.log("NBA card email: RESEND_API_KEY or EMAIL_FROM not set, skipped."); return; }
  const { getList } = require("./lib/subscribers");
  const members = [...new Set(await getList("member-email"))];
  const free = [...new Set(await getList("free-preview"))].filter(e => !members.includes(e));
  const to = [...members, ...free];
  if (!to.length) { console.log("NBA card email: no recipients yet."); return; }
  let sent = 0, failed = 0;
  for (const addr of to) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: [addr], reply_to: EMAIL_REPLY_TO || undefined, subject: email.subject, html: email.html, text: email.text })
    });
    res.ok ? sent++ : (failed++, console.warn(`  send failed: HTTP ${res.status}`));
    await new Promise(r => setTimeout(r, 600));   // Resend rate limit
  }
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(LOG, JSON.stringify({ date: DATE, sent_at: new Date().toISOString(), games: games.length, leans: email.leans,
    members: members.length, free: free.length, sent, failed }, null, 2) + "\n");
  console.log(`NBA card ${DATE}: sent ${sent} (${members.length} members, ${free.length} free), failed ${failed}.`);
}
main().catch(e => { console.error("NBA card email error:", e.message); process.exit(0); });
