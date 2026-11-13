#!/usr/bin/env node
/**
 * Leo: email the NBA card for a slate date to the free list and to members.
 *
 *   node scripts/send-nba-card-emails.js YYYY-MM-DD          send (needs RESEND_API_KEY, EMAIL_FROM)
 *   node scripts/send-nba-card-emails.js YYYY-MM-DD --dry    print the email, send nothing
 *   node scripts/send-nba-card-emails.js YYYY-MM-DD --html=<file>   write the HTML preview, send nothing
 *   node scripts/send-nba-card-emails.js YYYY-MM-DD --html=<file> --member   the member brief preview
 *   node scripts/send-nba-card-emails.js YYYY-MM-DD --test   one copy of each email (member brief and
 *        free card) to the owner (AUDIT_EMAIL secret) through Resend, subjects
 *        marked TEST. No timing gates, no subscribers, no email log.
 *        Workflow: "NBA card email (test send)".
 *
 * Content is data/nba/picks-<date>.json. Members get the member brief
 * (scripts/lib/nba-member-email.js: every call with the reasoning and the
 * inputs as Leo read them; HO-0061). The free list gets the short card
 * (scripts/lib/nba-card-email.js) with one line pointing to membership.
 * A member is never also sent the free card.
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
const M = require("./lib/nba-member-email");

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
  const record = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "data/nba/results.json"), "utf8")).season.picks || null; } catch (e) { return null; } })();
  const email = E.build(doc, { why: WHY, record, memberLine: true });
  const brief = M.brief(doc, { record });
  const MEMBER = process.argv.includes("--member");
  if (HTML) { const e = MEMBER ? brief : email; fs.writeFileSync(HTML, e.html); console.log(`NBA ${MEMBER ? "member brief" : "card email"} preview written to ${HTML}. ${e.subject}`); return; }
  if (DRY) { const e = MEMBER ? brief : email; console.log(`SUBJECT: ${e.subject}\n\n${e.text}`); return; }
  if (process.argv.includes("--test")) {
    const to = (process.env.AUDIT_EMAIL || "").trim();
    if (!RESEND_API_KEY || !EMAIL_FROM || !to) { console.log("NBA card test: RESEND_API_KEY, EMAIL_FROM or AUDIT_EMAIL not set."); process.exitCode = 1; return; }
    for (const [name, e] of [["member brief", brief], ["free card", email]]) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: EMAIL_FROM, to: [to], reply_to: EMAIL_REPLY_TO || undefined, subject: "TEST: " + e.subject, html: e.html, text: e.text })
      });
      console.log(res.ok ? `NBA ${name} test for ${DATE} sent to the owner address.` : `NBA ${name} test failed: HTTP ${res.status} ${await res.text()}`);
      if (!res.ok) process.exitCode = 1;
      await new Promise(r => setTimeout(r, 600));
    }
    return;
  }
  if (fs.existsSync(LOG)) { console.log(`NBA card for ${DATE} already sent (${path.relative(ROOT, LOG)}).`); return; }
  const first = new Date(games.map(g => g.tip_utc).sort()[0]);
  const now = Date.now();
  if (now >= first.getTime()) { console.log(`NBA card email: first tip (${first.toISOString()}) has passed, not sending.`); return; }
  if (first.getTime() - now > WINDOW_H * 36e5) { console.log(`NBA card email: first tip is more than ${WINDOW_H} hours away; a later run sends it.`); return; }
  if (!RESEND_API_KEY || !EMAIL_FROM) { console.log("NBA card email: RESEND_API_KEY or EMAIL_FROM not set, skipped."); return; }
  const { getList, personalize } = require("./lib/subscribers");
  const members = [...new Set(await getList("member-email"))];
  const free = [...new Set(await getList("free-preview"))].filter(e => !members.includes(e));
  const to = [...members.map(a => [a, brief]), ...free.map(a => [a, email])];
  if (!to.length) { console.log("NBA card email: no recipients yet."); return; }
  let sent = 0, failed = 0;
  for (const [addr, e] of to) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(personalize({ from: EMAIL_FROM, to: [addr], reply_to: EMAIL_REPLY_TO || undefined, subject: e.subject, html: e.html, text: e.text }))
    });
    res.ok ? sent++ : (failed++, console.warn(`  send failed: HTTP ${res.status}`));
    await new Promise(r => setTimeout(r, 600));   // Resend rate limit
  }
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(LOG, JSON.stringify({ date: DATE, sent_at: new Date().toISOString(), games: games.length, picks: brief.picks,
    members: members.length, free: free.length, sent, failed }, null, 2) + "\n");
  console.log(`NBA card ${DATE}: sent ${sent} (${members.length} members, ${free.length} free), failed ${failed}.`);
}
main().catch(e => { console.error("NBA card email error:", e.message); process.exit(0); });
