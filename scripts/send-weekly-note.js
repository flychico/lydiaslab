#!/usr/bin/env node
/**
 * Leo weekly note to members: "What Leo learned" (launch plan section 3, item c).
 * Shared file, owned by the Leo Manager chat.
 *
 *   node scripts/send-weekly-note.js [YYYY-MM-DD]          send (date = last day of the week; default yesterday ET)
 *   node scripts/send-weekly-note.js YYYY-MM-DD --dry      print the email, send nothing
 *   node scripts/send-weekly-note.js YYYY-MM-DD --html=<file>   write the HTML preview, send nothing
 *   node scripts/send-weekly-note.js YYYY-MM-DD --test     one copy to the AUDIT_EMAIL secret, subject TEST,
 *        no timing gate, no members, no email log.
 *
 * The week is the 7 days ending on the date (normally Tuesday through Monday,
 * so the NFL's Monday night game is in it; sent Tuesday morning after the
 * NFL grade). Per sport, from the same files as the record pages:
 *   NFL  data/nfl/results-review.json  (three calls since Nov 2, miss reasons)
 *        data/nfl/learning.json        (tests: testing, tracking, adopted, rejected)
 *   NBA  data/nba/results-days.json    (Leo Picks per night, miss reasons)
 *        data/nba/learning.json        (tests: next, testing, measuring, proposed, adopted, rejected)
 * "What changed this week" compares each test's status with the last note's
 * log (data/email-log/weekly-note-<date>.json keeps the statuses it sent).
 *
 * Safety: members only (getList("member-email"), each body through
 * personalize()); once per week (the log); Tuesday 7am to 1pm ET only for a
 * scheduled send; missing secrets or no members: logs and exits 0.
 * Copy rules: no promise of a record, no betting advice, numbers only from
 * the files, under 50 graded calls is an early read, no dashes or exclamation marks.
 */
const fs = require("fs");
const path = require("path");
const E = require("./lib/email-theme");

const ROOT = path.join(__dirname, "..");
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || "";
const DRY = process.argv.includes("--dry"), TEST = process.argv.includes("--test");
const HTML = (process.argv.find(a => a.startsWith("--html=")) || "").slice(7);
const etNow = () => new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
const ymd = d => d.toLocaleDateString("en-CA");
const END = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || (() => { const d = etNow(); d.setDate(d.getDate() - 1); return ymd(d); })();
const addDays = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const START = addDays(END, -6);
const LOGDIR = path.join(ROOT, "data/email-log");
const LOG = path.join(LOGDIR, `weekly-note-${END}.json`);
const inWeek = d => d >= START && d <= END;

const read = p => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")); } catch (e) { return null; } };
const esc = E.esc;
const u = x => (x > 0 ? "+" : "") + Number(x || 0).toFixed(2) + "u";
const early = n => n < 50 ? `early read, ${n} of 50` : `${n} graded`;
const longDay = s => new Date(s + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
const LABELS = { injury_input: "Injury input", market_knew: "Market knew", overtime: "Overtime", blowout: "Blowout", variance: "Variance", model_error: "Model error" };
const ORDER = ["injury_input", "market_knew", "overtime", "blowout", "variance", "model_error"];
const tallyText = t => ORDER.filter(k => t[k]).map(k => `${LABELS[k]} ${t[k]}`).join(", ") || "none";
const add = (t, k) => { if (k) t[k] = (t[k] || 0) + 1; };

function nflPart() {
  const r = read("data/nfl/results-review.json");
  if (!r) return null;
  const games = (r.games || []).filter(g => g.three && Array.isArray(g.calls) && g.calls.length);
  const sum = gs => { const c = gs.flatMap(g => g.calls); return { w: c.filter(x => x.result === "W").length, l: c.filter(x => x.result === "L").length, p: c.filter(x => x.result === "P").length, units: c.reduce((a, x) => a + (Number(x.units) || 0), 0) }; };
  const week = games.filter(g => inWeek(g.date)), season = games;
  const wk = sum(week), ss = sum(season);
  const tw = {}, ts = {};
  (r.games || []).filter(g => g.miss && g.date >= ((r.three && r.three.from) || "2026-11-02")).forEach(g => { add(ts, g.miss.reason); if (inWeek(g.date)) add(tw, g.miss.reason); });
  return { sport: "NFL", unit: "three calls (moneyline, spread, total)", week: wk, season: ss, gamesWeek: week.length, tw, ts, record: "/nfl/results/" };
}

function nbaPart() {
  const d = read("data/nba/results-days.json");
  if (!d) return null;
  const days = d.days || [];
  const z = () => ({ w: 0, l: 0, p: 0, units: 0 });
  const wk = z(); let nights = 0;
  const tw = {}, ts = {};
  for (const day of days) {
    const c = day.calls || {};
    if (inWeek(day.date)) { nights++; wk.w += c.w || 0; wk.l += c.l || 0; wk.p += c.p || 0; wk.units += c.units || 0; }
    for (const g of day.games || []) if (g.miss && g.miss.reason) { add(ts, g.miss.reason); if (inWeek(day.date)) add(tw, g.miss.reason); }
  }
  const s = (d.season && (d.season.picks || d.season.calls)) || z();
  return { sport: "NBA", unit: "Leo Picks", week: wk, season: { w: s.w || 0, l: s.l || 0, p: s.p || 0, units: s.units || 0 }, gamesWeek: nights, tw, ts, record: "/nba/results/" };
}

const GROUPS = [
  ["Adopted", ["adopted"]],
  ["Rejected", ["rejected"]],
  ["Being tested or measured", ["testing", "measuring", "tracking", "next", "proposed"]]
];
function tests(file) {
  const j = read(file);
  return (j && Array.isArray(j.tests) ? j.tests : []).map(t => ({ id: t.id, title: t.title, status: t.status, result: t.result }));
}

function lastLog() {
  try {
    const f = fs.readdirSync(LOGDIR).filter(n => /^weekly-note-\d{4}-\d{2}-\d{2}\.json$/.test(n) && n.slice(12, 22) < END).sort().pop();
    return f ? JSON.parse(fs.readFileSync(path.join(LOGDIR, f), "utf8")) : null;
  } catch (e) { return null; }
}

function build() {
  const prev = lastLog();
  const prevStatus = {};
  if (prev && prev.tests) for (const [sport, list] of Object.entries(prev.tests)) for (const t of list) prevStatus[sport + ":" + t.id] = t.status;
  const parts = [nflPart(), nbaPart()].filter(Boolean);
  const T = { NFL: tests("data/nfl/learning.json"), NBA: tests("data/nba/learning.json") };
  const range = `${longDay(START)} to ${longDay(END)}`;
  const html = [], text = [];
  html.push(E.header("Members"));
  html.push(E.hero({ eyebrow: "Leo members · weekly note", title: "What Leo learned", subtitle: `The week of ${esc(range)}: how the calls did, why the misses happened, and what was tested, changed or left alone. Changes are made one at a time and only after a backtest on past seasons. Nothing changes because of one night.` }));
  text.push(`What Leo learned, the week of ${range}`, "", "Changes are made one at a time and only after a backtest on past seasons. Nothing changes because of one night.", "");

  for (const p of parts) {
    const wn = p.week.w + p.week.l, sn = p.season.w + p.season.l;
    html.push(E.tiles([
      { label: `${p.sport} this week`, value: wn ? `${p.week.w}-${p.week.l}${p.week.p ? `-${p.week.p}` : ""}` : "No calls", sub: wn ? `${u(p.week.units)} · ${p.sport === "NFL" ? `${p.gamesWeek} games with calls` : `${p.gamesWeek} nights`}` : `${p.sport === "NFL" ? "No graded NFL calls" : "No graded Leo Picks"} this week` },
      { label: `${p.sport} season`, value: `${p.season.w}-${p.season.l}${p.season.p ? `-${p.season.p}` : ""}`, sub: `${u(p.season.units)} · ${early(sn)}` }
    ]));
    const changed = [];
    const groups = GROUPS.map(([name, sts]) => [name, T[p.sport].filter(t => sts.includes(t.status))]).filter(([, l]) => l.length);
    for (const t of T[p.sport]) { const was = prevStatus[p.sport + ":" + t.id]; if (prev && was !== t.status) changed.push(`${t.title} ${was ? `moved from ${was} to ${t.status}` : `was added (${t.status})`}.`); }
    const li = s => `<li style="margin:0 0 6px">${s}</li>`;
    const inner = [
      `<p style="margin:0 0 8px;font-size:14px;line-height:1.55"><b>Misses this week, by reason:</b> ${esc(tallyText(p.tw))}. <span style="color:${E.T.dim}">Season: ${esc(tallyText(p.ts))}.</span> <a href="${E.SITE}${p.record}" style="color:${E.T.navy}">Every miss and its evidence &rarr;</a></p>`,
      `<p style="margin:10px 0 4px;font-size:14px"><b>What changed this week</b></p>`,
      prev ? (changed.length ? `<ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.5">${changed.map(c => li(esc(c))).join("")}</ul>` : `<p style="margin:0;font-size:14px">Nothing in the ${p.sport} model changed this week.</p>`)
           : `<p style="margin:0;font-size:14px">This is the first weekly note, so here is everything on the ${p.sport} list.</p>`,
      ...groups.map(([name, l]) => `<p style="margin:12px 0 4px;font-size:14px"><b>${esc(name)}</b></p><ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.5">${l.map(t => li(`${esc(t.title)} <span style="color:${E.T.dim}">${esc(t.result || "")}</span>`)).join("")}</ul>`)
    ].join("");
    html.push(E.panel(`${p.sport}: what Leo is learning`, inner));
    text.push(`${p.sport} this week: ${wn ? `${p.week.w}-${p.week.l}, ${u(p.week.units)}` : "no graded calls"}. Season: ${p.season.w}-${p.season.l}, ${u(p.season.units)} (${early(sn)}).`,
      `Misses this week by reason: ${tallyText(p.tw)}. Season: ${tallyText(p.ts)}.`,
      prev ? (changed.length ? "What changed: " + changed.join(" ") : `Nothing in the ${p.sport} model changed this week.`) : `First weekly note: everything on the ${p.sport} list follows.`,
      ...groups.map(([name, l]) => `${name}: ` + l.map(t => `${t.title} (${t.result || t.status})`).join("; ")), `Record: ${E.SITE}${p.record}`, "");
  }
  html.push(E.footer({ links: [[`${E.SITE}/nfl/results/`, "NFL record"], [`${E.SITE}/nba/results/`, "NBA record"]], note: "You get this as a Leo member. Every number is frozen before the game and graded after it, wins and losses alike. Under 50 graded calls is an early read." }));
  const addr = (process.env.EMAIL_POSTAL_ADDRESS || "").trim();
  text.push("Analysis and education only, not betting advice. 21+. 1-800-MY-RESET (1-800-697-3738).", ...(addr ? [addr] : []), 'Reply "unsubscribe" to stop these.');
  const subject = `What Leo learned: the week of ${range}`;
  return {
    subject, text: text.join("\n"),
    html: E.shell({ title: subject, preheader: parts.map(p => `${p.sport} ${p.week.w}-${p.week.l} this week`).join(", "), body: html.join("\n") }),
    snapshot: { NFL: T.NFL.map(t => ({ id: t.id, status: t.status })), NBA: T.NBA.map(t => ({ id: t.id, status: t.status })) }
  };
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
  if (HTML) { fs.writeFileSync(HTML, email.html); console.log(`Weekly note preview written to ${HTML}. ${email.subject}`); return; }
  if (DRY) { console.log(`SUBJECT: ${email.subject}\n\n${email.text}`); return; }
  if (TEST) {
    const to = (process.env.AUDIT_EMAIL || "").trim();
    if (!RESEND_API_KEY || !EMAIL_FROM || !to) { console.log("Weekly note test: RESEND_API_KEY, EMAIL_FROM or AUDIT_EMAIL not set."); process.exitCode = 1; return; }
    const res = await send(to, email);
    console.log(`Weekly note test: ${res.ok ? "sent" : "failed HTTP " + res.status}.`); return;
  }
  if (fs.existsSync(LOG)) { console.log(`Weekly note for the week ending ${END} already sent.`); return; }
  const now = etNow();
  const manual = process.argv.some(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!manual && (now.getDay() !== 2 || now.getHours() < 7 || now.getHours() >= 13)) { console.log("Weekly note: sent Tuesdays 7am to 1pm ET only."); return; }
  if (!RESEND_API_KEY || !EMAIL_FROM) { console.log("Weekly note: RESEND_API_KEY or EMAIL_FROM not set, skipped."); return; }
  const { getList } = require("./lib/subscribers");
  const members = [...new Set(await getList("member-email"))];
  let sent = 0, failed = 0;
  for (const addr of members) {
    const res = await send(addr, email);
    res.ok ? sent++ : (failed++, console.warn(`  send failed: HTTP ${res.status}`));
    await new Promise(r => setTimeout(r, 600));
  }
  // The log is written even with no members, so next week's "what changed" compares against this week.
  fs.mkdirSync(LOGDIR, { recursive: true });
  fs.writeFileSync(LOG, JSON.stringify({ week_start: START, week_end: END, sent_at: new Date().toISOString(), members: members.length, sent, failed, tests: email.snapshot }, null, 2) + "\n");
  console.log(`Weekly note ${START} to ${END}: sent ${sent} of ${members.length} members, failed ${failed}.`);
}

main().catch(e => { console.error("Weekly note error:", e.message); process.exit(0); });
