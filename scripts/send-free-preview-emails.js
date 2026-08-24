#!/usr/bin/env node
/*
  LyDia — send the FREE daily preview email to the free list.

  - Recipients: signups collected by the Cloudflare Worker form receiver
    (replaces Netlify Forms as of 2026-08-24 — see
    cloudflare-worker/signup-worker.js and DEPLOY.md in this same delivery
    folder for why). The Worker appends rows to CSV files on a dedicated
    "signups" branch of this repo; this script reads that branch's raw CSV
    content over HTTPS, no GitHub token required (public repo, public branch).
  - Content: today's slate summary + official-pick count + link to the full preview.
    Intentionally lighter than the paid member brief (no locked card, no movement notes).
  - Skips paid members (signups/member-email.csv) so nobody gets two emails.
  - If secrets are missing, or nothing exists to send, logs and exits 0 —
    the daily workflow is never blocked by this step.

  Env: RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO (optional)
  Usage: node scripts/send-free-preview-emails.js [YYYY-MM-DD]
*/
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
// GitHub Actions turns missing secrets into empty strings.
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || "";

// 2026-08-24: replaces NETLIFY_API_TOKEN / NETLIFY_SITE_ID + api.netlify.com lookups.
const GITHUB_OWNER = "flychico";
const GITHUB_REPO = "lydiaslab";
const SIGNUPS_BRANCH = "signups";
const SIGNUP_CSV_PATHS = {
  "free-preview": "data/signups/free-preview.csv",
  "member-email": "data/signups/member-email.csv"
};

const DATE = (process.argv[2] || "").match(/^\d{4}-\d{2}-\d{2}$/)
  ? process.argv[2]
  : new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim()); }

// Reads data/signups/<list>.csv off the dedicated "signups" branch via raw.githubusercontent.com
// (no auth needed for a public repo/branch). Cache-busted with a timestamp query param since
// raw.githubusercontent.com sits behind a short-lived CDN cache. Returns [] if the file/branch
// doesn't exist yet (nobody has signed up through the new form yet) rather than treating that
// as an error — same "never block the daily pipeline" contract the old Netlify lookup had.
async function getSignupEmails(listName) {
  const csvPath = SIGNUP_CSV_PATHS[listName];
  const url = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${SIGNUPS_BRANCH}/${csvPath}?_=${Date.now()}`;
  const res = await fetch(url);
  if (res.status === 404) { console.log(`No "${listName}" signups yet (${csvPath} not found on ${SIGNUPS_BRANCH}).`); return []; }
  if (!res.ok) { console.warn(`Signup CSV lookup failed for "${listName}": HTTP ${res.status}`); return []; }
  const text = await res.text();
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const emails = new Set();
  // First line is the header (email,submitted_at) — skip it.
  for (const line of lines.slice(1)) {
    const email = (line.split(",")[0] || "").trim();
    if (isValidEmail(email)) emails.add(email.toLowerCase());
  }
  return [...emails];
}

function loadDay() {
  const briefPath = path.join(ROOT, "data", "member-brief", `${DATE}.json`);
  const picksPath = path.join(ROOT, "data", "published-picks", `${DATE}.json`);
  const brief = fs.existsSync(briefPath) ? JSON.parse(fs.readFileSync(briefPath, "utf8")) : null;
  const picks = fs.existsSync(picksPath) ? JSON.parse(fs.readFileSync(picksPath, "utf8")) : null;
  return { brief, picks };
}

function buildEmail({ brief, picks }) {
  const nice = new Date(`${DATE}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  const games = (brief && Array.isArray(brief.games)) ? brief.games : [];
  const official = (picks && Array.isArray(picks.picks)) ? picks.picks : [];
  const subject = `LyDia free daily card — ${nice}: ${games.length} games, ${official.length} official pick${official.length === 1 ? "" : "s"}`;

  const gameLines = games.slice(0, 20).map(g => {
    const away = g.away || (g.matchup || "").split("@")[0] || "";
    const home = g.home || (g.matchup || "").split("@")[1] || "";
    return `<li style="padding:3px 0">${away} @ ${home}</li>`;
  }).join("");

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#222">
    <h2 style="color:#0d1220">LyDia — free daily card, ${nice}</h2>
    <p><strong>${games.length}</strong> games on today's slate. The model labeled <strong>${official.length}</strong> official pick${official.length === 1 ? "" : "s"} today${official.length === 0 ? " — discipline is the product, not volume" : ""}.</p>
    ${gameLines ? `<ul style="padding-left:18px">${gameLines}</ul>` : ""}
    <p><a href="https://lydiaslab.com/previews/${DATE}.html" style="color:#4d9fdc;font-weight:bold">Read every model read, price, and reasoning free →</a></p>
    <p style="font-size:13px;color:#888">Want the picks delivered with full analysis and market-movement notes? <a href="https://lydiaslab.com/membership/" style="color:#4d9fdc">Founding membership is $30/mo</a> — rate locked for as long as you stay.</p>
    <p style="font-size:12px;color:#aaa;margin-top:24px;border-top:1px solid #eee;padding-top:10px">
      LyDia — analysis and education only, not betting advice. 1-800-GAMBLER.<br>
      To unsubscribe, reply with "unsubscribe".
    </p>
  </div>`;

  const text = `LyDia free daily card — ${nice}\n\n${games.length} games today, ${official.length} official pick(s).\n\nFull previews: https://lydiaslab.com/previews/${DATE}.html\nMembership: https://lydiaslab.com/membership/\n\nReply "unsubscribe" to stop these.`;
  return { subject, html, text };
}

async function main() {
  if (!RESEND_API_KEY) { console.log("RESEND_API_KEY not set — free preview email step skipped."); return; }
  if (!EMAIL_FROM) { console.log("EMAIL_FROM not set — free preview email step skipped."); return; }

  const day = loadDay();
  if (!day.brief && !day.picks) { console.log(`No data for ${DATE} — nothing to send.`); return; }

  const free = await getSignupEmails("free-preview");
  const paid = new Set(await getSignupEmails("member-email"));
  const recipients = free.filter(e => !paid.has(e));
  if (!recipients.length) { console.log("Free list is empty (or all free subscribers are already members)."); return; }

  const { subject, html, text } = buildEmail(day);
  let sent = 0, failed = 0;
  for (const to of recipients) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], reply_to: EMAIL_REPLY_TO || undefined, subject, html, text })
    });
    if (res.ok) sent++;
    else { failed++; console.warn(`send to ${to} failed: HTTP ${res.status}`); }
    await new Promise(r => setTimeout(r, 600)); // stay under Resend rate limits
  }
  console.log(`Free daily card: sent ${sent}, failed ${failed}, skipped ${free.length - recipients.length} paid member(s).`);
}

main().catch(e => { console.error("free preview email error:", e.message); process.exit(0); });
