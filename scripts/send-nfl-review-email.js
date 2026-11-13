#!/usr/bin/env node
/**
 * Leo NFL morning after review, to members only (HO-0060 item 2, DEC-20261113-50).
 *
 *   node scripts/send-nfl-review-email.js [YYYY-MM-DD ...]          send (needs RESEND_API_KEY, EMAIL_FROM)
 *   node scripts/send-nfl-review-email.js YYYY-MM-DD --dry          print it, send nothing
 *   node scripts/send-nfl-review-email.js YYYY-MM-DD --html=f.html  write the html
 *   node scripts/send-nfl-review-email.js YYYY-MM-DD --test         send now to the AUDIT_EMAIL secret,
 *                                                                   subject marked TEST, no log
 * Without dates it looks at yesterday and today (Eastern).
 *
 * Content: scripts/lib/nfl-member-email.js review(), from
 * data/nfl/results-review.json (the same reasons as /nfl/results/).
 *
 * Safety:
 *   - Once per game day: data/email-log/nfl-review-<date>.json.
 *   - Only when every game of the day with a Leo read is final, graded and in
 *     the results review.
 *   - Never overnight: not before 7:00am Eastern. Runs in nfl-grade-results.yml,
 *     so the 7:39am grade dispatch sends it.
 *   - Only for a game day in the last 3 days, so a regrade of an old date
 *     never mails anyone.
 *   - Members only (getList("member-email")); every body goes through
 *     personalize() for the reader's own unsubscribe link.
 *   - Missing secrets or no members: logs and exits 0.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const M = require("./lib/nfl-member-email");

const ROOT = path.join(__dirname, "..");
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || "";
const args = process.argv.slice(2);
const DRY = args.includes("--dry"), TEST = args.includes("--test");
const HTMLOUT = (args.find(a => a.startsWith("--html=")) || "").slice(7);
const etDate = d => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const etHour = () => +new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }) % 24;
const today = etDate(new Date());
const DATES = args.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (!DATES.length) DATES.push(etDate(new Date(Date.now() - 864e5)), today);
const daysAgo = d => Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${d}T12:00:00Z`)) / 864e5);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };

// Every game of the day that Leo read is final, graded and in the review.
function complete(date, rv) {
  const games = readJson(path.join(ROOT, "data/nfl/matchups", `${date}.json`)) || [];
  const read = games.filter(m => m.leo && m.leo.game);
  if (!read.length) return { ok: false, why: "no Leo reads" };
  const graded = read.filter(m => m.final_report && m.final_report.graded);
  const inReview = rv.games.filter(g => g.date === date).length;
  if (graded.length < read.length) return { ok: false, why: `${graded.length}/${read.length} games graded` };
  if (inReview < read.length) return { ok: false, why: `${inReview}/${read.length} games in the results review` };
  return { ok: true };
}

async function send(to, email) {
  const { personalize } = require("./lib/subscribers");
  const body = { from: EMAIL_FROM, to: [to], reply_to: EMAIL_REPLY_TO || undefined, subject: email.subject, html: email.html, text: email.text };
  const res = await fetch("https://api.resend.com/emails", { method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(TEST ? body : personalize(body)) });
  if (!res.ok) console.warn(`  send failed: HTTP ${res.status}`);
  return res.ok;
}

async function one(date, rv) {
  const email = M.review(rv, date);
  if (!email) { console.log(`NFL review ${date}: no graded games.`); return; }
  if (HTMLOUT) { fs.writeFileSync(HTMLOUT, email.html); console.log(`NFL review preview written to ${HTMLOUT}`); return; }
  if (DRY) { console.log(`SUBJECT: ${email.subject}\n\n${email.text}`); return; }
  if (TEST) {
    const to = (process.env.AUDIT_EMAIL || "").trim();
    if (!RESEND_API_KEY || !EMAIL_FROM || !to) { console.log("NFL review test: RESEND_API_KEY, EMAIL_FROM or AUDIT_EMAIL not set."); process.exitCode = 1; return; }
    const ok = await send(to, { ...email, subject: `TEST ${email.subject}` });
    console.log(`NFL review test ${date}: ${ok ? "sent" : "failed"}`); if (!ok) process.exitCode = 1;
    return;
  }

  const LOG = path.join(ROOT, "data/email-log", `nfl-review-${date}.json`);
  if (fs.existsSync(LOG)) { console.log(`NFL review ${date}: already sent.`); return; }
  if (daysAgo(date) > 3 || daysAgo(date) < 0) { console.log(`NFL review ${date}: not a recent game day, not sending.`); return; }
  const c = complete(date, rv);
  if (!c.ok) { console.log(`NFL review ${date}: waiting (${c.why}).`); return; }
  if (etHour() < 7) { console.log(`NFL review ${date}: before 7am ET, waiting for the morning run.`); return; }
  if (!RESEND_API_KEY || !EMAIL_FROM) { console.log("NFL review: RESEND_API_KEY or EMAIL_FROM not set, skipped."); return; }

  const { getList } = require("./lib/subscribers");
  const members = [...new Set(await getList("member-email"))];
  if (!members.length) { console.log(`NFL review ${date}: no members yet.`); return; }
  let sent = 0, failed = 0;
  for (const addr of members) {
    (await send(addr, email)) ? sent++ : failed++;
    await new Promise(r => setTimeout(r, 600));   // Resend rate limit
  }
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(LOG, JSON.stringify({ date, sent_at: new Date().toISOString(), games: email.games, misses: email.misses,
    members: members.length, sent, failed }, null, 2) + "\n");
  console.log(`NFL review ${date}: sent ${sent} to members, failed ${failed}.`);
}

async function main() {
  const rv = readJson(path.join(ROOT, "data/nfl/results-review.json"));
  if (!rv || !Array.isArray(rv.games)) { console.log("NFL review: no results review yet."); return; }
  for (const d of [...new Set(DATES)]) await one(d, rv);
}

main().catch(e => { console.error("NFL review email error:", e.message); process.exit(0); });
