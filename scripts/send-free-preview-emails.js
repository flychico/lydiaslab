#!/usr/bin/env node
/*
  LyDia — send the FREE daily preview email to the free list.

  - Recipients: Netlify Forms form name "free-preview" (footer + homepage signup).
  - Content: today's slate summary + official-pick count + link to the full preview.
    Intentionally lighter than the paid member brief (no locked card, no movement notes).
  - Skips paid members (form "member-email") so nobody gets two emails.
  - If secrets are missing, or nothing exists to send, logs and exits 0 —
    the daily workflow is never blocked by this step.

  Env: RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO (optional),
       NETLIFY_API_TOKEN, NETLIFY_SITE_ID
  Usage: node scripts/send-free-preview-emails.js [YYYY-MM-DD]
*/
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
// GitHub Actions turns missing secrets into empty strings.
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || "";
const NETLIFY_API_TOKEN = process.env.NETLIFY_API_TOKEN || "";
const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID || "";

const DATE = (process.argv[2] || "").match(/^\d{4}-\d{2}-\d{2}$/)
  ? process.argv[2]
  : new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim()); }

async function getFormEmails(formName) {
  if (!NETLIFY_API_TOKEN || !NETLIFY_SITE_ID) return null;
  const headers = { Authorization: `Bearer ${NETLIFY_API_TOKEN}` };
  const formsRes = await fetch(`https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/forms`, { headers });
  if (!formsRes.ok) { console.warn("Netlify forms lookup failed: HTTP", formsRes.status); return []; }
  const forms = await formsRes.json();
  const form = forms.find(f => f.name === formName);
  if (!form) { console.log(`No "${formName}" form found yet on Netlify.`); return []; }
  const subsRes = await fetch(`https://api.netlify.com/api/v1/forms/${form.id}/submissions`, { headers });
  if (!subsRes.ok) { console.warn("Netlify submissions lookup failed: HTTP", subsRes.status); return []; }
  const subs = await subsRes.json();
  const emails = new Set();
  for (const s of subs) {
    const email = (s.data && (s.data.email || s.data.Email)) || "";
    if (isValidEmail(email)) emails.add(email.trim().toLowerCase());
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
    <p><a href="https://mlbedges.com/previews/${DATE}.html" style="color:#4d9fdc;font-weight:bold">Read every model read, price, and reasoning free →</a></p>
    <p style="font-size:13px;color:#888">Want the picks delivered with full analysis and market-movement notes? <a href="https://mlbedges.com/membership/" style="color:#4d9fdc">Founding membership is $30/mo</a> — rate locked for as long as you stay.</p>
    <p style="font-size:12px;color:#aaa;margin-top:24px;border-top:1px solid #eee;padding-top:10px">
      LyDia — analysis and education only, not betting advice. 1-800-GAMBLER.<br>
      To unsubscribe, reply with "unsubscribe".
    </p>
  </div>`;

  const text = `LyDia free daily card — ${nice}\n\n${games.length} games today, ${official.length} official pick(s).\n\nFull previews: https://mlbedges.com/previews/${DATE}.html\nMembership: https://mlbedges.com/membership/\n\nReply "unsubscribe" to stop these.`;
  return { subject, html, text };
}

async function main() {
  if (!RESEND_API_KEY) { console.log("RESEND_API_KEY not set — free preview email step skipped."); return; }
  if (!EMAIL_FROM) { console.log("EMAIL_FROM not set — free preview email step skipped."); return; }

  const day = loadDay();
  if (!day.brief && !day.picks) { console.log(`No data for ${DATE} — nothing to send.`); return; }

  const free = await getFormEmails("free-preview");
  if (free === null) { console.log("NETLIFY_API_TOKEN / NETLIFY_SITE_ID not set — skipping free list lookup."); return; }
  const paid = new Set((await getFormEmails("member-email")) || []);
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
