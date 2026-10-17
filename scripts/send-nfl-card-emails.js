#!/usr/bin/env node
/**
 * Leo: email the NFL card for a slate date to the free list and to members.
 *
 *   node scripts/send-nfl-card-emails.js YYYY-MM-DD          send (needs RESEND_API_KEY, EMAIL_FROM)
 *   node scripts/send-nfl-card-emails.js YYYY-MM-DD --dry    print the email, send nothing
 *
 * Content comes only from data/nfl/matchups/<date>.json, the same frozen
 * pre-kickoff reads the matchup pages and the weekly card show: Leo's winner
 * and chance, its projected total and the two most likely TD scorers per game.
 *
 * Safety:
 *   - Once per slate date. data/email-log/nfl-card-<date>.json records the
 *     send; a rerun of the publish workflow does not email anyone twice.
 *   - Never after the slate's first kickoff. A late scheduled run stays quiet.
 *   - Missing secrets, no games or no recipients: logs and exits 0, so the
 *     publish never fails because of email.
 * Recipients, from the "signups" branch:
 *   members (member-email.csv)  the full card: everything below, plus Leo's
 *                               read on every QB, RB and WR yardage line
 *                               and every touchdown chance of 25% or more
 *   free list (free-preview.csv, minus members)  the short card
 */
const fs = require("fs");
const path = require("path");
const TEAMS = require("./lib/nfl-teams");

const ROOT = path.join(__dirname, "..");
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || "";
const SITE = "https://ndhorizon.com";
const SIGNUPS = "https://raw.githubusercontent.com/flychico/lydiaslab/signups/data/signups";
const DRY = process.argv.includes("--dry");
const DATE = (process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)))
  || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const LOG = path.join(ROOT, "data/email-log", `nfl-card-${DATE}.json`);

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = p => `${Math.round(p * 100)}%`;
const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());
function clock(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  return Number.isFinite(h) ? `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, "0")}${h < 12 ? "am" : "pm"} ET` : "";
}
// Kickoff (ET wall clock) to a Date. EDT until Nov 1 2026, EST after.
function kickoffDate(date, hhmm) {
  const offset = date < "2026-11-01" || date >= "2027-03-14" ? "-04:00" : "-05:00";
  return new Date(`${date}T${hhmm || "13:00"}:00${offset}`);
}

async function list(name) {
  try {
    const res = await fetch(`${SIGNUPS}/${name}.csv?_=${Date.now()}`);
    if (!res.ok) { console.log(`  ${name}: none (HTTP ${res.status})`); return []; }
    return (await res.text()).split(/\r?\n/).slice(1).map(l => (l.split(",")[0] || "").trim().toLowerCase()).filter(isEmail);
  } catch (e) { console.log(`  ${name}: unreadable (${e.message})`); return []; }
}

const UNIT = { QB_PASS_YARDS: "pass yds", RB_RUSH_YARDS: "rush yds", WR_REC_YARDS: "rec yds" };
// Members' extra section: the yardage lines with Leo's number and side, from
// the merged props file (lines attached), and every TD chance of 25%+.
function memberExtra(m, props) {
  const mine = props.filter(p => p.matchup === m.matchup);
  const yards = mine.filter(p => UNIT[p.market] && p.line != null)
    .sort((a, b) => a.market.localeCompare(b.market) || b.projection - a.projection);
  const tds = mine.filter(p => p.market === "ANYTIME_TD" && p.projection >= 0.25).sort((a, b) => b.projection - a.projection);
  if (!yards.length && !tds.length) return { html: "", text: "" };
  const yl = yards.map(p => `${p.player} (${p.team}) ${UNIT[p.market]}: Leo ${p.projection} vs line ${p.line}${p.lean && p.lean !== "none" ? `, leans ${String(p.lean).toUpperCase()}` : ", no lean"}`);
  const tl = tds.map(p => `${p.player} (${p.team}) ${pct(p.projection)}`);
  return {
    html: `<div style="font-size:13px;line-height:1.5;margin-top:8px;padding-top:8px;border-top:1px dashed #e3ddd2">
      ${yl.length ? `<b>Prop reads</b><br>${yl.map(esc).join("<br>")}` : ""}
      ${tl.length ? `<br><b>TD chances 25%+</b><br>${esc(tl.join(", "))}` : ""}</div>`,
    text: (yl.length ? `\n  Prop reads:\n    ${yl.join("\n    ")}` : "") + (tl.length ? `\n  TD chances 25%+: ${tl.join(", ")}` : "")
  };
}

function build(games, props = null) {
  const nice = new Date(`${DATE}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  const week = games[0].week;
  const rows = games.map(m => {
    const g = m.leo && m.leo.game;
    const T = m.td_props || {};
    const top = [...(T[m.away] || []), ...(T[m.home] || [])].filter(x => x.prob != null).sort((a, b) => b.prob - a.prob).slice(0, 2);
    const winner = !g ? "No read yet" : g.call === "too_close_to_call"
      ? `Too Close to Call (leans ${TEAMS.nick(g.pick)} ${pct(g.prob)})`
      : `Leo Pick: ${TEAMS.nick(g.pick)} ${pct(g.prob)}`;
    return { m, g, top, winner };
  });
  const subject = `${props ? "Members: " : ""}Leo NFL card, Week ${week}: ${games.length} game${games.length === 1 ? "" : "s"} ${games.length > 1 ? "on " : ""}${nice}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:580px;margin:0 auto;color:#1A2535">
  <h2 style="margin:0 0 6px">Leo&rsquo;s NFL card, Week ${esc(week)}</h2>
  <p style="margin:0 0 14px;color:#555">${esc(nice)}. Leo&rsquo;s winner and chance, its projected total, and the two players most likely to score in each game. A Leo Pick means more than a 60% chance; below that it is Too Close to Call.</p>
  ${rows.map(({ m, g, top, winner }) => `<div style="border:1px solid #e3ddd2;border-radius:10px;padding:12px 14px;margin:0 0 10px">
    <div style="font-size:12px;color:#777;text-transform:uppercase;letter-spacing:.04em">${esc(clock(m.kickoff))}${m.stadium ? " &middot; " + esc(m.stadium) : ""}</div>
    <div style="font-weight:bold;font-size:16px;margin:2px 0 6px"><a href="${SITE}${esc(m.url)}" style="color:#1A2535;text-decoration:none">${esc(TEAMS.full(m.away))} at ${esc(TEAMS.full(m.home))}</a></div>
    <div style="font-size:14px;line-height:1.5">
      <b>Winner:</b> ${esc(winner)}<br>
      <b>Leo total:</b> ${g && g.proj_total != null ? `${esc(g.proj_total)} points` : "n/a"}<br>
      <b>Most likely TD:</b> ${top.length ? top.map(x => `${esc(x.player)} (${esc(x.team)} ${pct(x.prob)})`).join(", ") : "n/a"}
    </div>${props ? memberExtra(m, props).html : ""}</div>`).join("")}
  ${props ? `<p style="font-size:13px;color:#666">Prop reads are Leo&rsquo;s side of each posted line, not wagers. Inside 5% of the line there is no lean. Season record by market is on <a href="${SITE}/nfl/results/" style="color:#1A2535">Leo&rsquo;s record</a>.</p>` : ""}
  <p><a href="${SITE}/nfl/week/" style="color:#1A2535;font-weight:bold">See the full Week ${esc(week)} card &rarr;</a> &nbsp; <a href="${SITE}/nfl/results/" style="color:#1A2535">Leo&rsquo;s record &rarr;</a></p>
  <p style="font-size:13px;color:#666">Leo&rsquo;s top touchdown pick in a game scored 47% of the time in 2023 to 2025. These are chances, not promises. Every number was frozen before kickoff and is graded on the site after the game.</p>
  <p style="font-size:12px;color:#999;margin-top:22px;border-top:1px solid #eee;padding-top:10px">Leo provides analysis and education only, not betting advice. 21+. If you or someone you know has a gambling problem, call 1-800-MY-RESET (1-800-697-3738).<br>To unsubscribe, reply with "unsubscribe".</p>
</div>`;
  const text = [`Leo's NFL card, Week ${week}, ${nice}`, "",
    ...rows.map(({ m, g, top, winner }) => `${TEAMS.full(m.away)} at ${TEAMS.full(m.home)} (${clock(m.kickoff)})\n  Winner: ${winner}\n  Leo total: ${g && g.proj_total != null ? g.proj_total : "n/a"}\n  Most likely TD: ${top.map(x => `${x.player} ${pct(x.prob)}`).join(", ") || "n/a"}${props ? memberExtra(m, props).text : ""}\n  ${SITE}${m.url}`),
    "", `Full card: ${SITE}/nfl/week/`, "Analysis only, not betting advice. 21+. 1-800-MY-RESET.", 'Reply "unsubscribe" to stop these.'].join("\n");
  return { subject, html, text };
}

async function main() {
  const src = path.join(ROOT, "data/nfl/matchups", `${DATE}.json`);
  if (!fs.existsSync(src)) { console.log(`NFL card: no matchup data for ${DATE}, nothing to send.`); return; }
  const games = JSON.parse(fs.readFileSync(src, "utf8"))
    .sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)));
  if (!games.length) { console.log(`NFL card: no games on ${DATE}.`); return; }
  const pf = path.join(ROOT, "data/nfl", `props-${DATE}.json`);
  const props = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, "utf8")) : [];
  const freeEmail = build(games), memberEmail = build(games, props);
  if (DRY) {
    const which = process.argv.includes("--member") ? memberEmail : freeEmail;
    console.log(`SUBJECT: ${which.subject}\n\n${which.text}`); return;
  }

  if (fs.existsSync(LOG)) { console.log(`NFL card for ${DATE} already sent (${path.relative(ROOT, LOG)}).`); return; }
  const first = kickoffDate(DATE, games[0].kickoff);
  if (Date.now() >= first.getTime()) { console.log(`NFL card: first kickoff (${games[0].kickoff} ET) has passed, not sending.`); return; }
  if (!RESEND_API_KEY || !EMAIL_FROM) { console.log("NFL card: RESEND_API_KEY or EMAIL_FROM not set, skipped."); return; }

  const members = [...new Set(await list("member-email"))];
  const free = [...new Set(await list("free-preview"))].filter(e => !members.includes(e));
  if (!members.length && !free.length) { console.log("NFL card: no recipients yet."); return; }
  let sent = 0, failed = 0;
  for (const [addr, email] of [...members.map(a => [a, memberEmail]), ...free.map(a => [a, freeEmail])]) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: [addr], reply_to: EMAIL_REPLY_TO || undefined,
                             subject: email.subject, html: email.html, text: email.text })
    });
    res.ok ? sent++ : (failed++, console.warn(`  send failed: HTTP ${res.status}`));
    await new Promise(r => setTimeout(r, 600));   // Resend rate limit
  }
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(LOG, JSON.stringify({ date: DATE, sent_at: new Date().toISOString(), games: games.length,
    members: members.length, free: free.length, sent, failed }, null, 2) + "\n");
  console.log(`NFL card ${DATE}: sent ${sent} (${members.length} members, ${free.length} free), failed ${failed}.`);
}

main().catch(e => { console.error("NFL card email error:", e.message); process.exit(0); });
