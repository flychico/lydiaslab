#!/usr/bin/env node
/**
 * Leo NBA morning-after review, to members only (HO-0061 item 2).
 *
 *   node scripts/send-nba-member-review.js [YYYY-MM-DD]          send (date = the graded night; default yesterday ET)
 *   node scripts/send-nba-member-review.js YYYY-MM-DD --dry      print the email, send nothing
 *   node scripts/send-nba-member-review.js YYYY-MM-DD --html=<file>   write the HTML preview, send nothing
 *   node scripts/send-nba-member-review.js YYYY-MM-DD --test     one copy to the owner (AUDIT_EMAIL secret),
 *        subject marked TEST. No timing gates, no members, no email log.
 *
 * Content is that night's entry in data/nba/results-days.json, built at
 * grading by scripts/build-nba-results-page.js (miss labels from
 * scripts/lib/nba-misses.js, the same as /nba/results/). Layout in
 * scripts/lib/nba-member-email.js review().
 *
 * Safety:
 *   - Only once the night is graded (the date is in results-days.json).
 *   - Morning only: between 7am and 1pm ET, never overnight. Outside it, logs and exits 0.
 *   - Once per date: data/email-log/nba-review-<date>.json records it.
 *   - Members only: getList("member-email"), each body through personalize().
 *   - Missing secrets or no members: logs and exits 0.
 */
const fs = require("fs");
const path = require("path");
const M = require("./lib/nba-member-email");

const ROOT = path.join(__dirname, "..");
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || "";
const DRY = process.argv.includes("--dry"), TEST = process.argv.includes("--test");
const HTML = (process.argv.find(a => a.startsWith("--html=")) || "").slice(7);
const etNow = () => new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
const DATE = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || (() => {
  const d = etNow(); d.setDate(d.getDate() - 1); return d.toLocaleDateString("en-CA");
})();
const LOG = path.join(ROOT, "data/email-log", `nba-review-${DATE}.json`);
const FROM_H = 7, UNTIL_H = 13;

async function send(to, e) {
  const { personalize } = require("./lib/subscribers");
  const body = { from: EMAIL_FROM, to: [to], reply_to: EMAIL_REPLY_TO || undefined, subject: e.subject, html: e.html, text: e.text };
  return fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(TEST ? body : personalize(body))
  });
}

async function main() {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(ROOT, "data/nba/results-days.json"), "utf8")); }
  catch (e) { console.log("NBA review: data/nba/results-days.json not readable, nothing to send."); return; }
  const day = (doc.days || []).find(d => d.date === DATE);
  if (!day || !day.games || !day.games.length) { console.log(`NBA review: ${DATE} is not graded yet (or had no games), nothing to send.`); return; }
  const email = M.review(day, { season: doc.season });
  if (HTML) { fs.writeFileSync(HTML, email.html); console.log(`NBA review preview written to ${HTML}. ${email.subject}`); return; }
  if (DRY) { console.log(`SUBJECT: ${email.subject}\n\n${email.text}`); return; }
  if (TEST) {
    const to = (process.env.AUDIT_EMAIL || "").trim();
    if (!RESEND_API_KEY || !EMAIL_FROM || !to) { console.log("NBA review test: RESEND_API_KEY, EMAIL_FROM or AUDIT_EMAIL not set."); process.exitCode = 1; return; }
    const res = await send(to, { ...email, subject: "TEST: " + email.subject });
    console.log(res.ok ? `NBA review test for ${DATE} sent to the owner address.` : `NBA review test failed: HTTP ${res.status} ${await res.text()}`);
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (fs.existsSync(LOG)) { console.log(`NBA review for ${DATE} already sent (${path.relative(ROOT, LOG)}).`); return; }
  const h = etNow().getHours();
  if (h < FROM_H || h >= UNTIL_H) { console.log(`NBA review: it is ${h}:00 ET; the review goes out between ${FROM_H}am and ${UNTIL_H - 12}pm ET only.`); return; }
  if (!RESEND_API_KEY || !EMAIL_FROM) { console.log("NBA review: RESEND_API_KEY or EMAIL_FROM not set, skipped."); return; }
  const { getList } = require("./lib/subscribers");
  const members = [...new Set(await getList("member-email"))];
  if (!members.length) { console.log("NBA review: no members yet."); return; }
  let sent = 0, failed = 0;
  for (const addr of members) {
    const res = await send(addr, email);
    res.ok ? sent++ : (failed++, console.warn(`  send failed: HTTP ${res.status}`));
    await new Promise(r => setTimeout(r, 600));   // Resend rate limit
  }
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(LOG, JSON.stringify({ date: DATE, sent_at: new Date().toISOString(), games: day.games.length, misses: email.misses, members: members.length, sent, failed }, null, 2) + "\n");
  console.log(`NBA review ${DATE}: sent ${sent} to members, failed ${failed}.`);
}
main().catch(e => { console.error("NBA review error:", e.message); process.exit(0); });
