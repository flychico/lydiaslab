#!/usr/bin/env node
/*
  LyDia — email the Daily Member Brief to paid members.

  Source:
  - Prefer data/member-brief/<date>.json from scripts/generate-member-lab.js
  - Fallback to data/picks/<date>.json only if the member brief file is missing

  Member list:
  - 2026-08-24: pulled from data/signups/member-email.csv on the dedicated
    "signups" branch, fetched over raw.githubusercontent.com — replaces the
    old Netlify Forms "member-email" form lookup (dead since the DNS cutover
    off Netlify; GitHub Pages has no server-side form processing). Rows are
    appended to that CSV by the Cloudflare Worker in cloudflare-worker/
    signup-worker.js. No token needed to read a public repo's raw content.

  Sending:
  - Uses Resend with RESEND_API_KEY
  - EMAIL_FROM, EMAIL_REPLY_TO, OWNER_EMAIL are optional overrides

  Safety:
  - If secrets are missing, or nothing exists to send, the script logs and exits 0.
*/

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const RESEND_API_KEY = (process.env.RESEND_API_KEY || "").trim();
const EMAIL_FROM = (process.env.EMAIL_FROM || "LyDia Picks <picks@lydiaslab.com>").trim();
const EMAIL_REPLY_TO = (process.env.EMAIL_REPLY_TO || "").trim();

// 2026-08-24: replaces NETLIFY_API_TOKEN / NETLIFY_SITE_ID.
const GITHUB_OWNER = "flychico";
const GITHUB_REPO = "lydiaslab";
const SIGNUPS_BRANCH = "signups";
const MEMBER_EMAIL_CSV_PATH = "data/signups/member-email.csv";

// Important:
// GitHub Actions turns missing secrets into empty strings.
// The old version treated an empty OWNER_EMAIL secret as "disable owner copy."
// This version only disables the owner copy if OWNER_EMAIL is exactly "disabled" or "none".
const OWNER_EMAIL_RAW = (process.env.OWNER_EMAIL || "").trim();
const OWNER_EMAIL = (OWNER_EMAIL_RAW && !["disabled", "none", "false", "off"].includes(OWNER_EMAIL_RAW.toLowerCase()))
  ? OWNER_EMAIL_RAW
  : (!OWNER_EMAIL_RAW ? "lynoldmercado@gmail.com" : "");

function etToday() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}

const DATE = process.argv[2] || etToday();

function niceDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  });
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}[c]));

const fmtAm = am => {
  if (am === null || am === undefined || Number.isNaN(Number(am))) return "—";
  am = Math.round(Number(am));
  return am > 0 ? "+" + am : String(am);
};

const pct = p => p === null || p === undefined || Number.isNaN(Number(p)) ? "—" : (Number(p) * 100).toFixed(1) + "%";
const edge = e => e === null || e === undefined || Number.isNaN(Number(e)) ? "—" : (Number(e) >= 0 ? "+" : "") + (Number(e) * 100).toFixed(1) + "%";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isValidEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());

function loadDailyData(dateStr) {
  const briefFile = path.join(ROOT, "data", "member-brief", `${dateStr}.json`);
  if (fs.existsSync(briefFile)) {
    const brief = JSON.parse(fs.readFileSync(briefFile, "utf8"));
    return { type: "brief", brief, file: briefFile };
  }

  const todayBrief = path.join(ROOT, "data", "member-brief", "today.json");
  if (dateStr === etToday() && fs.existsSync(todayBrief)) {
    const brief = JSON.parse(fs.readFileSync(todayBrief, "utf8"));
    return { type: "brief", brief, file: todayBrief };
  }

  const picksFile = path.join(ROOT, "data", "picks", `${dateStr}.json`);
  if (fs.existsSync(picksFile)) {
    const picks = JSON.parse(fs.readFileSync(picksFile, "utf8"));
    return { type: "legacy-picks", picks, file: picksFile };
  }

  return null;
}

function lineForGame(g) {
  const market = g.market || {};
  const pitcher = g.pitcher_edge || {};
  const bullpen = g.bullpen || {};

  const statusLabel = g.status === "official_pick" ? "Official Pick"
    : g.status === "watchlist" ? "Watchlist"
    : "Pass";

  return {
    game: g.game || `${g.away || ""} @ ${g.home || ""}`,
    status: statusLabel,
    pick: g.pick_team || (g.moneyline && g.moneyline.pick) || "—",
    labScore: g.lab_score ?? g.labScore ?? (g.moneyline && g.moneyline.edgeScore) ?? "—",
    modelProb: g.model_probability ?? (g.moneyline && g.moneyline.prob) ?? null,
    marketProb: market.no_vig_probability ?? (g.moneyline && g.moneyline.mktProb) ?? null,
    price: market.best_price ?? (g.moneyline && g.moneyline.bestAm) ?? null,
    rawEdge: g.edge ?? (g.moneyline && g.moneyline.rawEdge) ?? null,
    pitcherEdge: pitcher.team || (g.pitcherEdge && g.pitcherEdge.team) || "—",
    bullpenRead: bullpen.label || "—",
    read: g.read || (g.moneyline && g.moneyline.why) || "",
    risk: (g.moneyline && g.moneyline.risk) || "",
    passReason: g.pass_reason || ""
  };
}

function buildFromBrief(dateStr, brief, isPreview) {
  const nice = niceDate(dateStr);
  const games = Array.isArray(brief.games) ? brief.games : [];
  const official = games.filter(g => g.status === "official_pick");
  const watchlist = games.filter(g => g.status === "watchlist");
  const passes = games.filter(g => g.status === "pass");

  const subjectBase = official.length
    ? `LyDia Daily Member Brief — ${nice} (${official.length} official pick${official.length > 1 ? "s" : ""})`
    : `LyDia Daily Member Brief — ${nice} (no official picks)`;

  const subject = isPreview ? `[Preview — owner copy] ${subjectBase}` : subjectBase;

  const previewBanner = isPreview
    ? `<div style="background:#fff3cd;color:#664d03;font-size:12px;padding:8px 12px;border-radius:6px;margin-bottom:14px">
        Preview send — no paid members found yet, so this is going to the owner inbox only.
      </div>`
    : "";

  const officialHtml = official.length
    ? official.map(g => {
        const x = lineForGame(g);
        return `<div style="border-left:3px solid #d6508e;padding:10px 0 10px 12px;margin:14px 0">
          <div style="font-weight:800">${esc(x.game)}</div>
          <div style="margin-top:4px"><b>${esc(x.status)}:</b> ${esc(x.pick)} ML · Lab Rating ${esc((Number(x.labScore)/10).toFixed(1))}/10 · ${fmtAm(x.price)}</div>
          <div style="font-size:13px;color:#555;margin-top:4px">
            Model ${pct(x.modelProb)} · Market ${pct(x.marketProb)} · Edge ${edge(x.rawEdge)}
          </div>
          <div style="font-size:13px;color:#555;margin-top:4px">
            Pitcher edge: ${esc(x.pitcherEdge)} · Bullpen: ${esc(x.bullpenRead)}
          </div>
          ${x.read ? `<div style="font-size:13px;color:#555;margin-top:5px"><b>Read:</b> ${esc(x.read)}</div>` : ""}
          ${x.risk ? `<div style="font-size:13px;color:#555;margin-top:3px"><b>Risk:</b> ${esc(x.risk)}</div>` : ""}
        </div>`;
      }).join("")
    : `<p style="color:#888;font-style:italic">Nothing cleared the full official-pick threshold today.</p>`;

  const watchHtml = watchlist.length
    ? `<p style="font-size:13px;color:#555"><b>Watchlist:</b> ${watchlist.map(g => esc(`${g.game} (${g.pick_team || "—"}, Lab ${g.lab_score ?? "—"})`)).join(" · ")}</p>`
    : "";

  const passHtml = passes.length
    ? `<p style="font-size:12.5px;color:#888"><b>Passes / no clear setup:</b> ${passes.length} game${passes.length === 1 ? "" : "s"}. Full pass reasons are on the member brief page.</p>`
    : "";

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:620px;margin:0 auto;color:#1a1a1a">
    ${previewBanner}
    <h2 style="margin-bottom:4px;color:#d6508e">LyDia Daily Member Brief — ${esc(nice)}</h2>
    <p style="color:#666;font-size:14px">${esc(brief.summary || `${official.length} official picks, ${watchlist.length} watchlist games, ${passes.length} passes.`)}</p>
    ${officialHtml}
    ${watchHtml}
    ${passHtml}
    <p style="font-size:13px;color:#888;margin-top:20px">
      Full member brief: <a href="https://lydiaslab.com/member-brief/" style="color:#4d9fdc">lydiaslab.com/member-brief/</a><br>
      Public preview: <a href="https://lydiaslab.com/previews/${dateStr}.html" style="color:#4d9fdc">lydiaslab.com/previews/${dateStr}.html</a><br>
      Results history: <a href="https://lydiaslab.com/results/" style="color:#4d9fdc">lydiaslab.com/results/</a>
    </p>
    <p style="font-size:12px;color:#888;margin-top:14px">Your Lab: <a href="https://lydiaslab.com/member-brief/" style="color:#4d9fdc">Member Brief</a> · <a href="https://lydiaslab.com/tools/pitcher-matchups/" style="color:#4d9fdc">Pitchers</a> · <a href="https://lydiaslab.com/tools/offense-matchups/" style="color:#4d9fdc">Offense</a> · <a href="https://lydiaslab.com/tools/bullpen-fatigue/" style="color:#4d9fdc">Bullpens</a> · <a href="https://lydiaslab.com/tools/strikeout-projections/" style="color:#4d9fdc">Strikeouts</a> · <a href="https://lydiaslab.com/tools/totals-projections/" style="color:#4d9fdc">Totals</a></p>
    <p style="font-size:12px;color:#aaa;margin-top:24px;border-top:1px solid #eee;padding-top:10px">
      LyDia — analysis and education only, not betting advice. No win rate is guaranteed. Please bet responsibly;
      if gambling stops being fun, call 1-800-GAMBLER. Manage your subscription from your PayPal account.
      Questions? Just reply to this email.
    </p>
  </div>`;

  const officialText = official.length
    ? official.map(g => {
        const x = lineForGame(g);
        return `${x.game}
  ${x.status}: ${x.pick} ML · Lab Rating ${(Number(x.labScore)/10).toFixed(1)}/10 · ${fmtAm(x.price)}
  Model ${pct(x.modelProb)} · Market ${pct(x.marketProb)} · Edge ${edge(x.rawEdge)}
  Pitcher edge: ${x.pitcherEdge} · Bullpen: ${x.bullpenRead}
  Read: ${x.read || "—"}
  Risk: ${x.risk || "—"}`;
      }).join("\n\n")
    : "Nothing cleared the full official-pick threshold today.";

  const watchText = watchlist.length
    ? `\n\nWatchlist: ${watchlist.map(g => `${g.game} (${g.pick_team || "—"}, Lab ${g.lab_score ?? "—"})`).join(" · ")}`
    : "";

  const text = `${isPreview ? "PREVIEW SEND — owner copy.\n\n" : ""}LyDia Daily Member Brief — ${nice}

${brief.summary || ""}

${officialText}${watchText}

Passes / no clear setup: ${passes.length}

Full member brief: https://lydiaslab.com/member-brief/
Public preview: https://lydiaslab.com/previews/${dateStr}.html
Results history: https://lydiaslab.com/results/

LyDia — analysis and education only, not betting advice. 1-800-GAMBLER.`;

  return { subject, html, text };
}

function buildFromLegacyPicks(dateStr, picksFile, isPreview) {
  const nice = niceDate(dateStr);
  const picks = Array.isArray(picksFile.picks) ? picksFile.picks : [];
  const active = picks.filter(p => p.moneyline && p.moneyline.pick && !p.moneyline.isPass);

  const subjectBase = active.length
    ? `LyDia Picks — ${nice} (${active.length} official pick${active.length > 1 ? "s" : ""})`
    : `LyDia Picks — ${nice} (no official picks)`;

  const subject = isPreview ? `[Preview — owner copy] ${subjectBase}` : subjectBase;

  const rowsHtml = active.map(p => {
    const ml = p.moneyline || {};
    return `<div style="border-left:3px solid #d6508e;padding:8px 0 8px 12px;margin:12px 0">
      <div style="font-weight:700">${esc(p.away)} @ ${esc(p.home)}</div>
      <div>Moneyline: ${esc(ml.pick)} (${pct(ml.prob)}, ${fmtAm(ml.bestAm)}) · ${esc(ml.tier || "Official pick")}</div>
      ${ml.why ? `<div style="font-size:12.5px;color:#555;margin:2px 0"><b>Why:</b> ${esc(ml.why)}</div>` : ""}
      ${ml.risk ? `<div style="font-size:12.5px;color:#555;margin:2px 0 0"><b>Risk:</b> ${esc(ml.risk)}</div>` : ""}
    </div>`;
  }).join("");

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
    ${isPreview ? `<div style="background:#fff3cd;color:#664d03;font-size:12px;padding:8px 12px;border-radius:6px;margin-bottom:14px">Preview send — owner copy.</div>` : ""}
    <h2 style="margin-bottom:4px;color:#d6508e">LyDia Picks — ${esc(nice)}</h2>
    <p style="color:#666;font-size:14px">${active.length ? `${active.length} official pick${active.length > 1 ? "s" : ""}.` : `No official picks today.`}</p>
    ${rowsHtml || `<p style="color:#888;font-style:italic">Nothing cleared the bar today.</p>`}
    <p style="font-size:13px;color:#888;margin-top:20px">
      Full reasoning: <a href="https://lydiaslab.com/previews/${dateStr}.html" style="color:#4d9fdc">lydiaslab.com/previews/${dateStr}.html</a><br>
      Results history: <a href="https://lydiaslab.com/results/" style="color:#4d9fdc">lydiaslab.com/results/</a>
    </p>
    <p style="font-size:12px;color:#888;margin-top:14px">Your Lab: <a href="https://lydiaslab.com/member-brief/" style="color:#4d9fdc">Member Brief</a> · <a href="https://lydiaslab.com/tools/pitcher-matchups/" style="color:#4d9fdc">Pitchers</a> · <a href="https://lydiaslab.com/tools/offense-matchups/" style="color:#4d9fdc">Offense</a> · <a href="https://lydiaslab.com/tools/bullpen-fatigue/" style="color:#4d9fdc">Bullpens</a> · <a href="https://lydiaslab.com/tools/strikeout-projections/" style="color:#4d9fdc">Strikeouts</a> · <a href="https://lydiaslab.com/tools/totals-projections/" style="color:#4d9fdc">Totals</a></p>
    <p style="font-size:12px;color:#aaa;margin-top:24px;border-top:1px solid #eee;padding-top:10px">
      LyDia — analysis and education only, not betting advice. 1-800-GAMBLER.
    </p>
  </div>`;

  const text = `${isPreview ? "PREVIEW SEND — owner copy.\n\n" : ""}LyDia Picks — ${nice}\n\n` +
    (active.length
      ? active.map(p => `${p.away} @ ${p.home}\n  Moneyline: ${p.moneyline.pick} (${pct(p.moneyline.prob)}, ${fmtAm(p.moneyline.bestAm)})`).join("\n\n")
      : "Nothing cleared the bar today.") +
    `\n\nFull reasoning: https://lydiaslab.com/previews/${dateStr}.html\nResults history: https://lydiaslab.com/results/`;

  return { subject, html, text };
}

// Reads data/signups/member-email.csv off the dedicated "signups" branch. See the file-header
// comment for why this replaces the old Netlify Forms API lookup. Cache-busted since
// raw.githubusercontent.com sits behind a short-lived CDN cache. Missing file/branch (nobody
// has signed up through the new form yet) is not an error — same contract as the old lookup.
async function getMemberEmails() {
  const url = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${SIGNUPS_BRANCH}/${MEMBER_EMAIL_CSV_PATH}?_=${Date.now()}`;
  const res = await fetch(url);
  if (res.status === 404) { console.log(`No member signups yet (${MEMBER_EMAIL_CSV_PATH} not found on ${SIGNUPS_BRANCH}).`); return []; }
  if (!res.ok) { console.warn("Member signup CSV lookup failed: HTTP", res.status); return []; }
  const text = await res.text();
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const emails = new Set();
  for (const line of lines.slice(1)) { // skip header row
    const email = (line.split(",")[0] || "").trim();
    if (isValidEmail(email)) emails.add(email.toLowerCase());
  }
  return [...emails];
}

async function sendEmail(to, subject, html, text) {
  const body = { from: EMAIL_FROM, to: [to], subject, html, text };
  if (EMAIL_REPLY_TO) body.reply_to = EMAIL_REPLY_TO;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Resend HTTP ${res.status}: ${errText.slice(0, 500)}`);
  }
}

async function main() {
  console.log(`Email script date: ${DATE}`);
  console.log(`EMAIL_FROM set: ${EMAIL_FROM ? "yes" : "no"}`);
  console.log(`EMAIL_REPLY_TO set: ${EMAIL_REPLY_TO ? "yes" : "no"}`);
  console.log(`OWNER_EMAIL resolved: ${OWNER_EMAIL || "(disabled)"}`);
  console.log(`RESEND_API_KEY set: ${RESEND_API_KEY ? "yes" : "no"}`);

  if (!RESEND_API_KEY) {
    console.log("RESEND_API_KEY not set — email step skipped.");
    return;
  }

  const data = loadDailyData(DATE);
  if (!data) {
    console.log(`No member brief or picks file for ${DATE} — nothing to email.`);
    return;
  }

  console.log(`Loaded email data source: ${data.type} (${data.file})`);

  const realMembers = await getMemberEmails();
  console.log(`Member emails found from signups branch: ${realMembers.length}`);

  const isPreview = realMembers.length === 0;
  const sendSet = new Set(realMembers);

  if (OWNER_EMAIL && isValidEmail(OWNER_EMAIL)) {
    sendSet.add(OWNER_EMAIL.trim().toLowerCase());
    console.log(`Owner copy enabled: ${OWNER_EMAIL}`);
  } else {
    console.log("Owner copy not enabled.");
  }

  const emails = [...sendSet];
  console.log(`Final recipient count: ${emails.length}`);

  if (!emails.length) {
    console.log("No member emails and no OWNER_EMAIL fallback — nothing to send today.");
    return;
  }

  if (isPreview) {
    console.log(`No paid members found — sending Daily Member Brief owner preview copy.`);
  }

  const email = data.type === "brief"
    ? buildFromBrief(DATE, data.brief, isPreview)
    : buildFromLegacyPicks(DATE, data.picks, isPreview);

  let sent = 0;
  let failed = 0;

  for (const address of emails) {
    try {
      await sendEmail(address, email.subject, email.html, email.text);
      console.log(`Sent email to ${address}`);
      sent++;
    } catch (e) {
      console.error("Failed to email", address, "-", e.message);
      failed++;
    }
    await sleep(600);
  }

  console.log(`Emailed ${sent} recipient(s)${failed ? `, ${failed} failure(s)` : ""} for ${DATE}. Source: ${data.type}.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
