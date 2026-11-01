#!/usr/bin/env node
/**
 * Leo: email the NFL card for a slate date to the free list and to members.
 *
 *   node scripts/send-nfl-card-emails.js YYYY-MM-DD          send (needs RESEND_API_KEY, EMAIL_FROM)
 *   node scripts/send-nfl-card-emails.js YYYY-MM-DD --dry    print the email, send nothing
 *
 * Content comes only from data/nfl/matchups/<date>.json, the same frozen
 * pre-kickoff reads the matchup pages and the weekly card show: each team's
 * win chance, its projected total and the two most likely TD scorers per game.
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
const E = require("./lib/email-cards");   // the website's look (DEC-20261101-04)

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
  const cell = `style="font-family:${E.SANS};font-size:12px;padding:5px 0;border-top:1px solid ${E.X.line};color:${E.T.text}"`;
  const yrows = yards.map(p => { const side = p.lean && p.lean !== "none" ? String(p.lean).toUpperCase() : "";
    return `<tr><td ${cell}><b>${esc(p.player)}</b> <span style="color:${E.T.dim}">${esc(p.team)} ${esc(UNIT[p.market])}</span></td><td align="right" ${cell}>Leo <b>${esc(p.projection)}</b></td><td align="right" ${cell}>line ${esc(p.line)}</td><td align="right" ${cell}>${side ? E.pill(side, side === "UNDER" ? "gold" : "navy") : `<span style="color:${E.T.dim}">no lean</span>`}</td></tr>`; }).join("");
  return {
    html: `${yl.length ? `<div style="font-weight:800;color:${E.T.text};margin-bottom:4px">Prop reads (members)</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${yrows}</table>` : ""}
      ${tl.length ? `<div style="margin-top:8px"><b style="color:${E.T.text}">Touchdown chances 25%+:</b> ${esc(tl.join(", "))}</div>` : ""}`,
    text: (yl.length ? `\n  Prop reads:\n    ${yl.join("\n    ")}` : "") + (tl.length ? `\n  TD chances 25%+: ${tl.join(", ")}` : "")
  };
}

// QBs as Leo used them (depth chart, DEC-20261031-08); the schedule feed's
// names can be stale. picks-<date>.json carries them.
const PICKS = (() => { try { return Object.fromEntries(JSON.parse(fs.readFileSync(path.join(ROOT, "data/nfl", `picks-${DATE}.json`), "utf8")).map(p => [p.matchup, p])); } catch (e) { return {}; } })();
const fav = (m, x) => x == null ? "n/a" : x > 0 ? `${m.home} by ${Math.round(x * 10) / 10}` : x < 0 ? `${m.away} by ${Math.round(-x * 10) / 10}` : "level";
const spreadTxt = (m, l) => l == null ? "n/a" : l > 0 ? `${m.home} -${l}` : l < 0 ? `${m.away} -${-l}` : "PK";
const am = v => v == null || v === "" ? "" : (+v > 0 ? "+" : "") + v;

function cardHtml(games, rows, props, nice, week, subject) {
  const picks = rows.filter(r => r.g && r.g.call === "leo_pick");
  const firstKick = games[0] ? clock(games[0].kickoff) : "";
  const allTd = rows.flatMap(r => r.top).sort((a, b) => b.prob - a.prob);
  const body = [
    E.header("NFL"),
    E.hero({ eyebrow: `Leo NFL &middot; Week ${esc(week)} &middot; ${esc(nice)}`,
      title: `Week ${esc(week)} card: ${games.length} game${games.length === 1 ? "" : "s"}`,
      subtitle: "Leo&rsquo;s pick where he gives a team more than a 60% chance, his spread and total beside the market, and the players most likely to score. Every number is frozen before kickoff and graded on the site.",
      chips: ["&#127944; Full slate", "&#129657; Injury report built in", "&#128274; Frozen before kickoff", "&#128202; Graded every game"] }),
    E.tiles([
      { label: "Games", value: games.length, sub: esc(nice.split(",")[0]) },
      { label: "First kickoff", value: esc(firstKick.replace(" ET", "")), sub: "Eastern time" },
      { label: "Leo picks", value: picks.length, sub: "more than 60%" },
      { label: "Top TD chance", value: allTd[0] ? `${Math.round(allTd[0].prob * 100)}%` : "n/a", sub: allTd[0] ? esc(allTd[0].player) : "" }
    ]),
    E.panel("Leo&rsquo;s picks", E.rows(picks.map(({ m, g }) => [
      `<b>${esc(TEAMS.full(g.pick))}</b> ${Math.round(g.prob * 100)}%${g.price != null && g.price !== "" ? ` <span style="color:${E.T.dim}">${esc(am(g.price))}</span>` : ""}`,
      `${esc(m.away)} at ${esc(m.home)} &middot; ${esc(clock(m.kickoff))}`]),
      "No team clears 60% on this slate, so Leo makes no pick. Every game below still has his read.")),
    ...rows.map(({ m, g, top }) => {
      const [ac, hc] = E.pairColors(E.NFL_COLORS, m.away, m.home);
      const P = PICKS[m.matchup] || {};
      const leoHome = g && g.prob != null ? (g.pick === m.home ? g.prob : 1 - g.prob) : null;
      const isPick = g && g.call === "leo_pick";
      const href = `${E.SITE}${m.url}`;
      const team = (abbr, side) => ({
        abbr, logo: `${E.SITE}/img/nfl/${encodeURIComponent(abbr)}.png`, name: TEAMS.full(abbr),
        sub: (P[side + "_qb"] || m[side + "_qb_name"]) ? `QB ${esc(P[side + "_qb"] || m[side + "_qb_name"])}` : "",
        right: esc(am(m[side + "_moneyline"])) || "&nbsp;",
        rightSub: leoHome == null ? "" : `Leo ${Math.round((side === "home" ? leoHome : 1 - leoHome) * 100)}%`
      });
      const td = top.length ? `<b style="color:${E.T.text}">Most likely to score:</b> ${top.map(x => `${esc(x.player)} <span style="color:${E.T.text}">${Math.round(x.prob * 100)}%</span>`).join(", ")}` : "";
      return E.gameCard({
        href, awayColor: ac, homeColor: hc,
        time: esc(clock(m.kickoff)), venue: esc(m.stadium || ""),
        badges: [isPick ? E.pill(`Leo pick ${esc(g.pick)}`, "good") : g ? E.pill("Too close to call", "muted") : E.pill("Read pending", "muted")],
        away: team(m.away, "away"), home: team(m.home, "home"),
        prob: leoHome == null ? null : { away: 1 - leoHome, label: "Leo win chance", text: `${esc(m.away)} ${Math.round((1 - leoHome) * 100)}% &middot; ${esc(m.home)} ${Math.round(leoHome * 100)}%` },
        boxes: [
          { label: "Spread", value: esc(spreadTxt(m, g ? g.spread_line : m.spread_line)), sub: g ? `Leo ${esc(fav(m, g.exp_margin))}` : "" , tone: "steel" },
          { label: "Total", value: esc(g && g.total_line != null ? g.total_line : (m.total_line ?? "n/a")), sub: g && g.proj_total != null ? `Leo ${esc(g.proj_total)}` : "", tone: "steel" },
          { label: isPick ? "Leo pick" : "Leo", value: g ? `${esc(g.pick)} ${Math.round(g.prob * 100)}%` : "n/a", sub: isPick ? "more than 60%, graded" : "under 60%, no pick", tone: isPick ? "good" : "gold" }
        ],
        notes: [td, props ? memberExtra(m, props).html : ""],
        cta: "Full preview: injuries, props and why"
      });
    }),
    E.footer({
      links: [[`${E.SITE}/nfl/scoreboard/`, "Live scores"], [`${E.SITE}/nfl/results/`, "Leo&rsquo;s record"]],
      note: (props ? "Prop reads are Leo&rsquo;s side of each posted line, not wagers. Inside 5% of the line there is no lean.<br>" : "") + "Leo&rsquo;s top touchdown pick in a game scored 47% of the time in 2023 to 2025. These are chances, not promises."
    })
  ].join("\n");
  return E.shell({ title: subject, preheader: picks.length ? `Leo picks: ${picks.map(({ g }) => `${g.pick} ${Math.round(g.prob * 100)}%`).join(", ")}` : `${games.length} games, Leo's read on each`, body });
}

function build(games, props = null) {
  const nice = new Date(`${DATE}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  const week = games[0].week;
  const rows = games.map(m => {
    const g = m.leo && m.leo.game;
    const T = m.td_props || {};
    const top = [...(T[m.away] || []), ...(T[m.home] || [])].filter(x => x.prob != null).sort((a, b) => b.prob - a.prob).slice(0, 2);
    // Leo pick above 60% (DEC-20261101-01, back from 2026-11-01); otherwise
    // too close to call with the win chance shown.
    const winner = !g ? "No read yet" : g.call === "leo_pick" ? `Leo pick: ${TEAMS.nick(g.pick)} ${pct(g.prob)}` : `Too close to call (${TEAMS.nick(g.pick)} ${pct(g.prob)})`;
    return { m, g, top, winner };
  });
  const subject = `${props ? "Members: " : ""}Leo NFL card, Week ${week}: ${games.length} game${games.length === 1 ? "" : "s"} ${games.length > 1 ? "on " : ""}${nice}`;
  const html = cardHtml(games, rows, props, nice, week, subject);
  const text = [`Leo's NFL card, Week ${week}, ${nice}`, "",
    ...rows.map(({ m, g, top, winner }) => `${TEAMS.full(m.away)} at ${TEAMS.full(m.home)} (${clock(m.kickoff)})\n  Leo: ${winner}\n  Leo total: ${g && g.proj_total != null ? g.proj_total : "n/a"}\n  Most likely TD: ${top.map(x => `${x.player} ${pct(x.prob)}`).join(", ") || "n/a"}${props ? memberExtra(m, props).text : ""}\n  ${SITE}${m.url}`),
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
  const HTMLOUT = (process.argv.find(a => a.startsWith("--html=")) || "").slice(7);
  if (HTMLOUT) { fs.writeFileSync(HTMLOUT, (process.argv.includes("--member") ? memberEmail : freeEmail).html); console.log(`NFL card preview written to ${HTMLOUT}`); return; }
  if (DRY) {
    const which = process.argv.includes("--member") ? memberEmail : freeEmail;
    console.log(`SUBJECT: ${which.subject}\n\n${which.text}`); return;
  }

  if (fs.existsSync(LOG)) { console.log(`NFL card for ${DATE} already sent (${path.relative(ROOT, LOG)}).`); return; }
  const first = kickoffDate(DATE, games[0].kickoff);
  if (Date.now() >= first.getTime()) { console.log(`NFL card: first kickoff (${games[0].kickoff} ET) has passed, not sending.`); return; }
  if (!RESEND_API_KEY || !EMAIL_FROM) { console.log("NFL card: RESEND_API_KEY or EMAIL_FROM not set, skipped."); return; }

  const { getList } = require("./lib/subscribers");
  const members = [...new Set(await getList("member-email"))];
  const free = [...new Set(await getList("free-preview"))].filter(e => !members.includes(e));
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
