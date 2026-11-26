#!/usr/bin/env node
/**
 * One email to the free list the morning after Thanksgiving: how Leo's
 * Thanksgiving calls did, the record since Nov 2, and "try a week for $10".
 * Lynold, 2026-11-25 (DEC-20261125-02): "Yes, send Friday 9am", after Gemini's
 * review asked to follow the free member brief while it is fresh.
 * Shared file, owned by the Leo Manager chat.
 *
 *   node scripts/send-free-week-offer.js                 send (Fri Nov 27, 7am to 1pm ET only)
 *   node scripts/send-free-week-offer.js --dry           print the email, send nothing
 *   node scripts/send-free-week-offer.js --html=<file>   write the HTML preview, send nothing
 *   node scripts/send-free-week-offer.js --test          one copy to the AUDIT_EMAIL secret, subject TEST
 *   node scripts/send-free-week-offer.js --force         send outside the time window (still once)
 *
 * Safety: free list only, members left out (they already have it), each body
 * through personalize(); once (data/email-log/free-week-offer-<date>.json);
 * missing secrets or nobody on the list: logs and exits 0.
 * Copy rules: no promise of a record, no betting advice, numbers only from
 * the files, under 50 graded calls is an early read, no dashes or exclamation marks.
 */
const fs = require("fs");
const path = require("path");
const E = require("./lib/email-theme");
const C = require("./lib/nfl-calls");
const TEAMS = require("./lib/nfl-teams");

const ROOT = path.join(__dirname, "..");
const DATE = "2026-11-26";          // Thanksgiving
const SEND_DAY = "2026-11-27";      // the Friday after
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || "";
const DRY = process.argv.includes("--dry"), TEST = process.argv.includes("--test"), FORCE = process.argv.includes("--force");
const HTML = (process.argv.find(a => a.startsWith("--html=")) || "").slice(7);
const LOGDIR = path.join(ROOT, "data/email-log");
const LOG = path.join(LOGDIR, `free-week-offer-${SEND_DAY}.json`);
const JOIN = `${E.SITE}/membership/?utm_source=email&utm_medium=email&utm_campaign=thanksgiving-week-offer`;

const read = p => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")); } catch (e) { return null; } };
const esc = E.esc;
const u = x => (x > 0 ? "+" : "") + Number(x || 0).toFixed(2) + "u";
const rec = r => `${r.w}-${r.l}${r.p ? `-${r.p}` : ""}`;
const n = r => (r.w || 0) + (r.l || 0);
const early = k => k < 50 ? `early read, ${k} of 50` : `${k} graded`;
const mark = r => r === "W" ? "✅" : r === "L" ? "❌" : r === "P" ? "push" : "";

/** Thanksgiving games: graded rows from results-review.json, else Leo's calls from the card. */
function thanksgiving() {
  const rv = read("data/nfl/results-review.json") || {};
  const graded = (rv.games || []).filter(g => g.date === DATE);
  const card = read(`data/nfl/picks-${DATE}.json`) || [];
  const out = [];
  for (const g of card) {
    const A = TEAMS.nick(g.away), H = TEAMS.nick(g.home);
    const gr = graded.find(x => x.away === g.away && x.home === g.home);
    const c = C.calls(g);
    const lean = c.ml && c.ml.team ? `Leo had the ${TEAMS.nick(c.ml.team)} at ${Math.round(c.ml.prob * 100)}%` : "";
    if (gr && gr.score) {
      const w = TEAMS.nick(gr.winner), sc = `${Math.max(gr.score.away, gr.score.home)}-${Math.min(gr.score.away, gr.score.home)}`;
      out.push({ title: `${A} at ${H}`, line: `${w} won ${sc}. ${lean}${gr.leo_right_winner ? ", right winner." : ", wrong winner."}`,
        calls: (gr.calls || []).map(x => ({ text: x.text.split(",")[0], result: x.result, units: x.units })), graded: true });
    } else {
      const calls = [];
      if (c.ml && c.ml.call) calls.push({ text: `${TEAMS.nick(c.ml.call)} moneyline ${c.ml.price > 0 ? "+" : ""}${c.ml.price}` });
      if (c.spread && c.spread.call) calls.push({ text: `${TEAMS.nick(c.spread.call)} ${c.spread.line}` });
      out.push({ title: `${A} at ${H}`, line: `${lean}.`, calls, graded: false });
    }
  }
  return out;
}

function build() {
  const rv = read("data/nfl/results-review.json") || {};
  const t = rv.three || { ml: { w: 0, l: 0, units: 0 }, spread: { w: 0, l: 0, units: 0 } };
  const nba = ((read("data/nba/results-days.json") || {}).season || {}).picks || { w: 0, l: 0, units: 0 };
  const games = thanksgiving();
  const done = games.filter(g => g.graded), dayCalls = done.flatMap(g => g.calls);
  const day = { w: dayCalls.filter(c => c.result === "W").length, l: dayCalls.filter(c => c.result === "L").length, p: dayCalls.filter(c => c.result === "P").length,
    units: dayCalls.reduce((a, c) => a + (Number(c.units) || 0), 0) };
  const html = [], text = [];
  const sub = done.length
    ? `Yesterday you got the full member brief for free. Here is how Leo's Thanksgiving calls did, graded in public like every call since November 2.`
    : `Yesterday you got the full member brief for free. Every Thanksgiving call is graded in public on the record page, like every call since November 2.`;
  html.push(E.header("Free card"));
  html.push(E.hero({ eyebrow: "Leo · the day after Thanksgiving", title: "That was the member brief", subtitle: esc(sub) }));
  text.push("That was the member brief", "", sub, "");

  const tiles = [];
  if (done.length) tiles.push({ label: "Thanksgiving calls", value: n(day) ? rec(day) : "No calls graded", sub: n(day) ? u(day.units) : "" });
  tiles.push({ label: "NFL spread calls", value: rec(t.spread), sub: `${u(t.spread.units)} · ${early(n(t.spread))}` });
  tiles.push({ label: "NFL moneyline calls", value: rec(t.ml), sub: `${u(t.ml.units)} · ${early(n(t.ml))}` });
  tiles.push({ label: "NBA Leo Picks", value: rec(nba), sub: `${u(nba.units)} · ${early(n(nba))}` });
  html.push(E.tiles(tiles.slice(0, 2)));
  html.push(E.tiles(tiles.slice(2)));
  text.push(tiles.map(x => `${x.label}: ${x.value}${x.sub ? ` (${x.sub})` : ""}`).join(". ") + ".", "");

  const gi = games.map(g => `<p style="margin:0 0 10px;font-size:14px;line-height:1.55"><b>${esc(g.title)}</b><br>${esc(g.line)}${g.calls.length
    ? "<br>" + g.calls.map(c => `${esc(c.text)}${c.result ? ` ${mark(c.result)} ${esc(u(c.units))}` : ""}`).join("<br>") : "<br><span style=\"color:" + E.T.dim + "\">No call: Leo's number was not far enough from the line.</span>"}</p>`).join("");
  html.push(E.panel("Thanksgiving, game by game", gi + (done.length < games.length ? `<p style="margin:0;font-size:13px;color:${E.T.dim}">Grades for every game: <a href="${E.SITE}/nfl/results/" style="color:${E.T.navy}">the NFL record</a>.</p>` : "")));
  text.push("Thanksgiving, game by game");
  for (const g of games) text.push(`${g.title}: ${g.line}`, ...(g.calls.length ? g.calls.map(c => `  ${c.text}${c.result ? ` ${c.result} ${u(c.units)}` : ""}`) : ["  No call."]));
  text.push("");

  const why = [
    "The member brief before every NFL and NBA slate: Leo's call or no call for every game, and the reasons behind each number.",
    "The morning after review: every miss, why it happened, and what Leo got right.",
    "A weekly note on what Leo is testing and what changed, and what was left alone.",
    "The free card stays free: win chances and calls, without the reasoning."
  ];
  html.push(E.panel("Keep getting the brief", `<ul style="margin:0 0 12px;padding-left:18px;font-size:14px;line-height:1.55">${why.map(w => `<li style="margin:0 0 6px">${esc(w)}</li>`).join("")}</ul>
<p style="margin:0 0 14px;font-size:14px;line-height:1.55"><b>$10 for a week.</b> Try it through the next NFL Sunday and a week of NBA nights. Cancel any time in PayPal; you keep the emails until your week runs out. Or $50 a month.</p>
<p style="margin:0"><a href="${JOIN}" style="display:inline-block;background:${E.T.navy};color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 20px;border-radius:10px">Try a week for $10</a></p>`));
  text.push("Keep getting the brief", ...why.map(w => `  ${w}`), "", "$10 for a week. Cancel any time in PayPal; you keep the emails until your week runs out. Or $50 a month.", `Try a week for $10: ${JOIN}`, "");

  html.push(E.footer({ links: [[`${E.SITE}/nfl/results/`, "NFL record"], [`${E.SITE}/nba/results/`, "NBA record"]], note: "You get this because you signed up for Leo's free card. Every number is frozen before the game and graded after it, wins and losses alike. Under 50 graded calls is an early read." }));
  const addr = (process.env.EMAIL_POSTAL_ADDRESS || "").trim();
  text.push("Analysis and education only, not betting advice. 21+. 1-800-MY-RESET (1-800-697-3738).", ...(addr ? [addr] : []), 'Reply "unsubscribe" to stop these.');
  const subject = done.length && n(day) ? `Thanksgiving with Leo: ${rec(day)}, and a week for $10` : "That was the member brief. Try a week for $10";
  return { subject, text: text.join("\n"), html: E.shell({ title: subject, preheader: "How Leo's Thanksgiving calls did, and the member brief for $10 a week", body: html.join("\n") }), graded: done.length, games: games.length };
}

async function send(to, e) {
  const { personalize } = require("./lib/subscribers");
  const body = { from: EMAIL_FROM, to: [to], reply_to: EMAIL_REPLY_TO || undefined, subject: (TEST ? "TEST: " : "") + e.subject, html: e.html, text: e.text };
  return fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(TEST ? body : personalize(body))
  });
}

async function main() {
  const email = build();
  if (HTML) { fs.writeFileSync(HTML, email.html); console.log(`Preview written to ${HTML}. ${email.subject} (${email.graded} of ${email.games} games graded)`); return; }
  if (DRY) { console.log(`SUBJECT: ${email.subject}\n\n${email.text}`); return; }
  if (TEST) {
    const to = (process.env.AUDIT_EMAIL || "").trim();
    if (!RESEND_API_KEY || !EMAIL_FROM || !to) { console.log("Test: RESEND_API_KEY, EMAIL_FROM or AUDIT_EMAIL not set."); process.exitCode = 1; return; }
    const res = await send(to, email);
    console.log(`Test: ${res.ok ? "sent" : "failed HTTP " + res.status}.`); return;
  }
  if (fs.existsSync(LOG)) { console.log("Thanksgiving week offer already sent."); return; }
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  if (!FORCE && (now.toLocaleDateString("en-CA") !== SEND_DAY || now.getHours() < 7 || now.getHours() >= 13)) { console.log(`Week offer: sent ${SEND_DAY} 7am to 1pm ET only.`); return; }
  if (!RESEND_API_KEY || !EMAIL_FROM) { console.log("Week offer: RESEND_API_KEY or EMAIL_FROM not set, skipped."); return; }
  const { getList } = require("./lib/subscribers");
  const members = new Set(await getList("member-email"));
  const free = [...new Set(await getList("free-preview"))].filter(a => !members.has(a));
  let sent = 0, failed = 0;
  for (const a of free) {
    const res = await send(a, email);
    res.ok ? sent++ : (failed++, console.warn(`  send failed: HTTP ${res.status}`));
    await new Promise(r => setTimeout(r, 600));
  }
  fs.mkdirSync(LOGDIR, { recursive: true });
  fs.writeFileSync(LOG, JSON.stringify({ sent_at: new Date().toISOString(), subject: email.subject, list: free.length, sent, failed, graded_games: email.graded }, null, 2) + "\n");
  console.log(`Week offer: sent ${sent} of ${free.length}, failed ${failed}.`);
}

main().catch(e => { console.error("Week offer error:", e.message); process.exit(0); });
