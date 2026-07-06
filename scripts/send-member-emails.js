#!/usr/bin/env node
/* LyDia — email today's picks to paid members.
   Usage: node scripts/send-member-emails.js [YYYY-MM-DD] (default: today in US Eastern)

   Reads: data/picks/<date>.json (written by generate-previews.js)
   Member list: pulled live from Netlify Forms (form name "member-email") using
   NETLIFY_API_TOKEN + NETLIFY_SITE_ID. Sends via Resend using RESEND_API_KEY.

   Designed to fail soft: if any required secret is missing, or there's nothing to
   send, it logs why and exits 0 — it should never break the daily site-generation
   run. The workflow also sets continue-on-error on this step as a second safety net.

   Known limitation (documented, not hidden): the member list trusts whatever the
   "member-email" Netlify form has collected. There's no server-side check against
   PayPal that a given submission is an active paying subscriber. Good enough for
   the founding stretch; if abuse becomes a real problem, the fix is a Netlify
   Function that verifies the subscription-id against PayPal's API before adding
   someone to the send list. */

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NETLIFY_API_TOKEN = process.env.NETLIFY_API_TOKEN;
const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID;
const EMAIL_FROM = process.env.EMAIL_FROM || "LyDia Picks <picks@mlbedges.com>";
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || "";
// Owner oversight address — while there are no real paying members yet, every
// day's cards route here so the daily send can actually be seen and checked.
// Once real members exist, this address is still included as a standing copy
// for monitoring (set OWNER_EMAIL to override or "" to disable).
const OWNER_EMAIL = process.env.OWNER_EMAIL !== undefined ? process.env.OWNER_EMAIL : "lynoldmercado@gmail.com";

function etToday() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}
const DATE = process.argv[2] || etToday();

function niceDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtAm = am => { if (am === null || am === undefined) return ""; am = Math.round(am); return am > 0 ? "+" + am : String(am); };
const pct = p => p === null || p === undefined ? "" : (p * 100).toFixed(0) + "%";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isValidEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());

function pickLines(p) {
  const lines = [];
  if (p.moneyline && p.moneyline.pick) {
    if (p.moneyline.isPass) {
      lines.push(`Moneyline: pass — no edge`);
    } else {
      const tierTxt = p.moneyline.tier ? ` [${p.moneyline.tier}, edge score ${p.moneyline.edgeScore}/100]` : "";
      lines.push(`Moneyline: ${p.moneyline.pick} (${pct(p.moneyline.prob)}${p.moneyline.bestAm ? `, ${fmtAm(p.moneyline.bestAm)}` : ""})${p.moneyline.valueTag ? " — " + p.moneyline.valueTag : ""}${tierTxt}`);
      if (p.moneyline.why) lines.push(`Why we like it: ${p.moneyline.why}`);
      if (p.moneyline.risk) lines.push(`What could go wrong: ${p.moneyline.risk}`);
    }
  }
  if (p.total && p.total.pick) {
    lines.push(`Total: ${p.total.pick} ${p.total.line} (model ${p.total.projTotal} runs${p.total.bestAm ? `, ${fmtAm(p.total.bestAm)}` : ""})`);
  }
  if (p.runLine && p.runLine.pick) {
    lines.push(`Run line: ${p.runLine.pick} ${p.runLine.point > 0 ? "+" : ""}${p.runLine.point} (projected margin ${p.runLine.projMargin > 0 ? "+" : ""}${p.runLine.projMargin}${p.runLine.bestAm ? `, ${fmtAm(p.runLine.bestAm)}` : ""})`);
  }
  return lines;
}

function buildEmail(dateStr, picks, isPreview) {
  const nice = niceDate(dateStr);
  const playCount = picks.reduce((n, p) => {
    let c = 0;
    if (p.moneyline && p.moneyline.pick && !p.moneyline.isPass) c++;
    if (p.total && p.total.pick) c++;
    if (p.runLine && p.runLine.pick) c++;
    return n + c;
  }, 0);

  const subjectBase = playCount
    ? `LyDia Picks — ${nice} (${playCount} play${playCount > 1 ? "s" : ""})`
    : `LyDia — no plays today (${nice})`;
  const subject = isPreview ? `[Preview — no paid members yet] ${subjectBase}` : subjectBase;
  const previewBanner = isPreview
    ? `<div style="background:#fff3cd;color:#664d03;font-size:12px;padding:8px 12px;border-radius:6px;margin-bottom:14px">
        Preview send — there are no paid members yet, so this is going to the owner inbox only, exactly as a real member would receive it.
      </div>`
    : "";
  const previewBannerText = isPreview ? "PREVIEW SEND — no paid members yet, owner-only copy.\n\n" : "";

  const rowsHtml = picks.map(p => {
    const lines = pickLines(p);
    const body = lines.length
      ? lines.map(l => `<div style="margin:4px 0">${esc(l)}</div>`).join("")
      : `<div style="color:#888;font-style:italic">No official play</div>`;
    return `<div style="border-left:3px solid #d6336c;padding:8px 0 8px 12px;margin:14px 0">
      <div style="font-weight:700">${esc(p.away)} @ ${esc(p.home)}</div>
      ${body}
    </div>`;
  }).join("");

  const rowsText = picks.map(p => {
    const lines = pickLines(p);
    return `${p.away} @ ${p.home}\n` + (lines.length ? lines.map(l => "  " + l).join("\n") : "  No official play") + "\n";
  }).join("\n");

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
    ${previewBanner}
    <h2 style="margin-bottom:4px">LyDia Picks — ${esc(nice)}</h2>
    <p style="color:#666;font-size:14px">${playCount ? `${playCount} play${playCount > 1 ? "s" : ""} on today's ${picks.length}-game slate.` : `No edge anywhere on today's ${picks.length}-game slate — the model is passing across the board.`}</p>
    ${rowsHtml}
    <p style="font-size:13px;color:#888;margin-top:20px">Full reasoning for every game: <a href="https://mlbedges.com/previews/${dateStr}">mlbedges.com/previews/${dateStr}</a><br>
    Every pick graded publicly: <a href="https://mlbedges.com/results/">mlbedges.com/results/</a></p>
    <p style="font-size:12px;color:#aaa;margin-top:24px;border-top:1px solid #eee;padding-top:10px">
    LyDia — analysis and education only, not betting advice. No win rate is guaranteed. Please bet responsibly;
    if gambling stops being fun, call 1-800-GAMBLER. Manage your subscription from your PayPal account.
    Questions? Just reply to this email.</p>
  </div>`;

  const text = `${previewBannerText}LyDia Picks — ${nice}\n\n${rowsText}\nFull reasoning: https://mlbedges.com/previews/${dateStr}\nResults history: https://mlbedges.com/results/\n\nLyDia — analysis and education only, not betting advice. 1-800-GAMBLER.`;

  return { subject, html, text };
}

async function getMemberEmails() {
  if (!NETLIFY_API_TOKEN || !NETLIFY_SITE_ID) {
    console.log("NETLIFY_API_TOKEN / NETLIFY_SITE_ID not set — skipping member lookup.");
    return [];
  }
  const headers = { Authorization: `Bearer ${NETLIFY_API_TOKEN}` };
  const formsRes = await fetch(`https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/forms`, { headers });
  if (!formsRes.ok) { console.warn("Netlify forms lookup failed: HTTP", formsRes.status); return []; }
  const forms = await formsRes.json();
  const form = forms.find(f => f.name === "member-email");
  if (!form) { console.log('No "member-email" form found yet on Netlify (no signups collected so far).'); return []; }

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

async function sendEmail(to, subject, html, text) {
  const body = { from: EMAIL_FROM, to: [to], subject, html, text };
  if (EMAIL_REPLY_TO) body.reply_to = EMAIL_REPLY_TO;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Resend HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
}

async function main() {
  if (!RESEND_API_KEY) {
    console.log("RESEND_API_KEY not set — email step skipped (site generation is unaffected).");
    return;
  }

  const picksFile = path.join(ROOT, "data", "picks", `${DATE}.json`);
  if (!fs.existsSync(picksFile)) { console.log(`No picks file for ${DATE} — nothing to email.`); return; }
  const { picks } = JSON.parse(fs.readFileSync(picksFile, "utf8"));
  if (!picks || !picks.length) { console.log(`No games in ${DATE} picks file — nothing to email.`); return; }

  const realMembers = await getMemberEmails();
  const isPreview = realMembers.length === 0;
  const sendSet = new Set(realMembers);
  if (OWNER_EMAIL && isValidEmail(OWNER_EMAIL)) sendSet.add(OWNER_EMAIL.trim().toLowerCase());
  const emails = [...sendSet];
  if (!emails.length) { console.log("No member emails and no OWNER_EMAIL set — nothing to send today."); return; }
  if (isPreview) console.log(`No paid members yet — sending today's cards to the owner inbox (${OWNER_EMAIL}) for review.`);

  const { subject, html, text } = buildEmail(DATE, picks, isPreview);
  let sent = 0, failed = 0;
  for (const email of emails) {
    try {
      await sendEmail(email, subject, html, text);
      sent++;
    } catch (e) {
      console.error("Failed to email", email, "-", e.message);
      failed++;
    }
    await sleep(600); // gentle pacing against ESP rate limits
  }
  console.log(`Emailed ${sent} member(s)${failed ? `, ${failed} failure(s)` : ""} for ${DATE}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
