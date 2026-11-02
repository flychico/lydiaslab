#!/usr/bin/env node
/**
 * Leo NFL owner brief: the slate as Leo reads it before kickoff, as a PDF,
 * emailed to the owner (DEC-20261031-09). Private. Never sent to the list.
 *
 *   node scripts/send-nfl-owner-brief.js YYYY-MM-DD           send if inside the window
 *   node scripts/send-nfl-owner-brief.js YYYY-MM-DD --force   send now (still once per date)
 *   node scripts/send-nfl-owner-brief.js YYYY-MM-DD --pdf=out.pdf   build the PDF only, send nothing
 *   node scripts/send-nfl-owner-brief.js YYYY-MM-DD --test    send now, subject marked TEST, any date
 *                                                            (past slates too), and no send log, so the
 *                                                            real brief for that date still goes out
 *
 * Runs in nfl-prepare-slate.yml after the prop lines are attached, so it
 * reads exactly what that capture wrote: data/nfl/picks-<date>.json,
 * props-<date>.json (with lines), injuries-<date>.json and tracker.json.
 * Nothing is recomputed here.
 *
 * Contents: per game, Leo's win chance beside the market's, Leo's margin and
 * total beside the posted lines and Leo's side where he is outside the
 * no-call floors (spread 1.0 point; totals carry no side while sides are off),
 * the starting QBs, every QB/RB/WR projection with the line and Leo's side
 * (props floor 5% of the line), the most likely touchdown scorers, and who is
 * Out or Doubtful. Season record by market on the first page for context.
 * Information only: no bet is recommended, and the season record says the
 * line has been the better number.
 *
 * When: once per date (data/email-log/nfl-brief-<date>.json), never after the
 * first kickoff, and only from the gather closest to it: within 3 hours of
 * the first kickoff (Sunday: the 11:30am EST last capture), or within 9 hours
 * of a night-only slate (Thursday, Monday: the 12pm EST gather).
 *
 * PDF: headless Chrome (google-chrome on GitHub's ubuntu runners; CHROME_BIN
 * overrides). Email: Resend, recipient from the AUDIT_EMAIL secret (falls back
 * to OWNER_EMAIL), never from the repo, which is public.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const TEAMS = require("./lib/nfl-teams");
const { kickoffUtc } = require("./lib/prediction-history");

const ROOT = path.join(__dirname, "..");
const D = p => path.join(ROOT, "data/nfl", p);
const args = process.argv.slice(2);
const DATE = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a))
  || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const TEST = args.includes("--test");
const FORCE = args.includes("--force") || TEST;
const PDF_ONLY = (args.find(a => a.startsWith("--pdf=")) || "").slice(6);
const TO = (process.env.AUDIT_EMAIL || process.env.OWNER_EMAIL || "").trim();
const KEY = process.env.RESEND_API_KEY || "", FROM = process.env.EMAIL_FROM || "";
const LOG = path.join(ROOT, "data/email-log", `nfl-brief-${DATE}.json`);
const WINDOW_H = 3, NIGHT_WINDOW_H = 9, NIGHT_FIRST_KICK = "18:00", SPREAD_FLOOR = 1.0, PROP_FLOOR = 0.05;

const read = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = v => { const x = Number.parseFloat(v); return Number.isFinite(x) ? x : null; };
const pct = p => p == null ? "n/a" : `${Math.round(p * 100)}%`;
const r1 = x => x == null ? "n/a" : String(Math.round(x * 10) / 10);
function clock(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})/); if (!m) return "TBD";
  let h = Number(m[1]); const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12;
  return `${h}:${m[2]}${ap} ET`;
}
const prettyDate = d => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
// Values are home-side margins (positive: home wins by that much).
const byMargin = (g, m) => m == null ? "n/a" : m > 0 ? `${g.home} by ${r1(m)}` : m < 0 ? `${g.away} by ${r1(-m)}` : "level";
const spreadText = (g, l) => l == null ? "no line" : l > 0 ? `${g.home} -${r1(l)}` : l < 0 ? `${g.away} -${r1(-l)}` : "even";
function spreadSide(g) {
  const m = num(g.exp_margin), l = num(g.spread_line);
  if (m == null || l == null || Math.abs(m - l) < SPREAD_FLOOR) return null;
  const side = m > l ? g.home : g.away;
  const h = side === g.home ? -l : l;
  return `${side} ${h > 0 ? "+" + r1(h) : h < 0 ? r1(h) : "even"}`;
}
const MK = { QB_PASS_YARDS: ["QB", "pass yds"], RB_RUSH_YARDS: ["RB", "rush yds"], WR_REC_YARDS: ["WR", "rec yds"] };

function build() {
  const games = (read(D(`picks-${DATE}.json`)) || []).slice()
    .sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)) || a.matchup.localeCompare(b.matchup));
  const props = read(D(`props-${DATE}.json`)) || [];
  const injuries = read(D(`injuries-${DATE}.json`)) || [];
  const tracker = read(D("tracker.json"));
  const clv = read(D("clv.json"));
  if (!games.length) return null;

  const yard = props.filter(p => MK[p.market]);
  const withLine = yard.filter(p => num(p.line) != null);
  const sideOf = p => {
    const line = num(p.line), proj = num(p.projection);
    if (line == null || proj == null || p.lean_blocked) return null;
    if (Math.abs(proj - line) < PROP_FLOOR * line) return null;
    return proj > line ? "OVER" : "UNDER";
  };
  const capturedMin = withLine.map(p => num(p.line_minutes_before_kickoff)).filter(x => x != null);
  const week = games[0].week;

  const s = tracker && tracker.summary ? tracker.summary.props : null;
  const recLine = k => s && s[k] ? `${s[k].w}-${s[k].l}` : "n/a";
  const record = s ? `Season so far (frozen reads, through ${esc(tracker.through)}): QB ${recLine("QB")}, RB ${recLine("RB")}, WR ${recLine("WR")}, all props ${recLine("all")}. On average the line has landed closer to the result than Leo at every position.` : "";

  const css = `
  @page { size: letter; margin: 0.55in 0.5in; }
  /* The website's palette and type (DEC-20261101-04). */
  body { font-family: "Onest", -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #2A2620; font-size: 10.5px; line-height: 1.38; background: #F5F0E8; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .brand { font-weight: 900; font-size: 22px; color: #C9A84C; letter-spacing: -.02em; }
  .eyebrow { font-size: 9px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color: #7A5D14; }
  h1 { font-family: "EB Garamond", Georgia, serif; font-weight: 600; font-size: 26px; margin: 2px 0 2px; letter-spacing: -.01em; }
  h2 { font-size: 14px; margin: 0 0 4px; font-weight: 800; }
  .sub { color: #675D4F; margin: 0 0 10px; } .note { color: #675D4F; font-size: 9.5px; }
  table { border-collapse: collapse; width: 100%; margin: 4px 0 8px; }
  th, td { text-align: left; padding: 3px 5px; border-bottom: 1px solid #E6DCCB; vertical-align: top; }
  th { font-size: 8.5px; text-transform: uppercase; letter-spacing: .06em; color: #675D4F; border-bottom: 1.5px solid #1A2535; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  .game { break-inside: avoid; background: #FDFBF7; border: 1px solid #D3D3D3; border-top: 5px solid #1A2535; border-radius: 12px; padding: 9px 11px; margin: 0 0 10px; }
  .game.pick { border-top-color: #2F6E4A; }
  .meta { color: #555; margin-bottom: 4px; } .side { font-weight: 700; }
  .cols { display: flex; gap: 14px; } .cols > div { flex: 1; }
  .box { background: #FDFBF7; border: 1px solid #DED4C2; border-left: 4px solid #C9A84C; border-radius: 10px; padding: 8px 10px; margin: 0 0 12px; }
  .summary { background: #FDFBF7; border-radius: 10px; }`;

  // DEC-20261102-01: from Nov 5 the summary is Leo's three calls per game.
  const CALLS = require("./lib/nfl-calls");
  const newRules = DATE >= CALLS.RULES.FROM;
  const cv = c => c.call ? `<b style="color:#2F6E4A">${esc(c.label)}</b>` : `<span style="color:#8A8174">PASS</span>`;
  const callRows = games.map(g => { const C = CALLS.calls(g);
    return `<tr><td>${esc(clock(g.kickoff))}</td><td>${esc(g.matchup)}</td><td>${esc(g.away_qb || "")} / ${esc(g.home_qb || "")}</td>
      <td>${cv(C.ml)}<br><span class="note">${C.ml.call ? esc(g.pick) + " " + pct(g.model_prob) : esc(C.ml.pass)}</span></td>
      <td>${cv(C.spread)}<br><span class="note">Leo ${esc(byMargin(g, num(g.exp_margin)))}; line ${esc(spreadText(g, num(g.spread_line)))}</span></td>
      <td>${cv(C.total)}<br><span class="note">Leo ${r1(num(g.proj_total))}; line ${r1(num(g.total_line))}</span></td></tr>`; }).join("");
  const summaryRows = games.map(g => {
    const side = spreadSide(g);
    return `<tr><td>${esc(clock(g.kickoff))}</td><td>${esc(g.matchup)}</td>
      <td>${esc(g.away_qb || "")} / ${esc(g.home_qb || "")}</td>
      <td>${num(g.model_prob) > 0.60 ? "<b>PICK</b> " : ""}${esc(g.pick)} ${pct(g.model_prob)}${num(g.model_prob) > 0.60 && g.price != null && g.price !== "" ? " (" + esc((+g.price > 0 ? "+" : "") + g.price) + ")" : ""}</td><td>${g.market_prob != null ? esc(g.pick) + " " + pct(g.market_prob) : "n/a"}</td>
      <td>${esc(byMargin(g, num(g.exp_margin)))}</td><td>${esc(spreadText(g, num(g.spread_line)))}</td>
      <td class="side">${side ? esc(side) : "no call"}</td>
      <td class="n">${r1(num(g.proj_total))}</td><td class="n">${r1(num(g.total_line))}</td></tr>`;
  }).join("");

  const sideCount = { QB: [0, 0], RB: [0, 0], WR: [0, 0] };
  withLine.forEach(p => { const s2 = sideOf(p); const k = MK[p.market][0]; sideCount[k][0]++; if (s2) sideCount[k][1]++; });

  const gameBlocks = games.map(g => {
    const mine = props.filter(p => p.matchup === g.matchup);
    const rows = mine.filter(p => MK[p.market])
      .sort((a, b) => Object.keys(MK).indexOf(a.market) - Object.keys(MK).indexOf(b.market) || a.team.localeCompare(b.team) || num(b.projection) - num(a.projection))
      .map(p => { const sd = sideOf(p);
        return `<tr><td>${esc(MK[p.market][0])}</td><td>${esc(p.team)}</td><td>${esc(p.player)}</td>
          <td class="n">${esc(p.projection)}</td><td class="n">${num(p.line) != null ? esc(p.line) : "no line"}</td>
          <td class="side">${sd || (num(p.line) != null ? "no call" : "")}</td><td class="n">${p.books || ""}</td></tr>`; }).join("");
    const td = mine.filter(p => p.market === "ANYTIME_TD").sort((a, b) => num(b.projection) - num(a.projection)).slice(0, 5)
      .map(p => `${esc(p.player)} (${esc(p.team)}) ${pct(num(p.projection))}`).join(", ");
    const hurt = injuries.filter(i => (i.team === g.away || i.team === g.home) && /^(Out|Doubtful)$/i.test(i.status || ""))
      .map(i => `${esc(i.team)} ${esc(i.player)} ${esc(i.position)}, ${esc(i.status)}${i.injury ? " (" + esc(i.injury) + ")" : ""}`).join("; ");
    const side = newRules ? (CALLS.calls(g).spread.label || null) : spreadSide(g);
    return `<div class="game${num(g.model_prob) > 0.60 ? " pick" : ""}">
      <h2>${esc(TEAMS.full(g.away))} at ${esc(TEAMS.full(g.home))}</h2>
      <div class="meta">${esc(clock(g.kickoff))}${g.stadium ? " &middot; " + esc(g.stadium) : ""} &middot; QBs ${esc(g.away_qb || "n/a")} and ${esc(g.home_qb || "n/a")}</div>
      <div class="cols">
        <div><b>${newRules ? (CALLS.calls(g).ml.call ? "Moneyline call " + esc(CALLS.calls(g).ml.label) : "Moneyline PASS") : num(g.model_prob) > 0.60 ? "Leo pick" : "Win chance (too close to call)"}</b><br>Leo ${esc(g.pick)} ${pct(g.model_prob)}${g.price != null && g.price !== "" ? " at " + esc((+g.price > 0 ? "+" : "") + g.price) : ""}; market ${g.market_prob != null ? esc(g.pick) + " " + pct(g.market_prob) : "n/a"}</div>
        <div><b>Spread</b><br>Leo ${esc(byMargin(g, num(g.exp_margin)))}; line ${esc(spreadText(g, num(g.spread_line)))}; <span class="side">${side ? (newRules ? "call " : "Leo's side ") + esc(side) : (newRules ? "PASS" : "no call")}</span></div>
        <div><b>Total</b><br>Leo ${r1(num(g.proj_total))}; line ${r1(num(g.total_line))}; ${newRules ? (CALLS.calls(g).total.call ? "<span class=\"side\">call " + esc(CALLS.calls(g).total.label) + "</span>" : "PASS") : "no side (off since Oct 17)"}</div>
      </div>
      ${rows ? `<table><tr><th>Pos</th><th>Team</th><th>Player</th><th class="n">Leo</th><th class="n">Line</th><th>Leo's side</th><th class="n">Books</th></tr>${rows}</table>` : `<p class="note">No yardage projections for this game.</p>`}
      <div><b>Most likely touchdown scorers:</b> ${td || "n/a"}</div>
      <div class="note"><b>Out or Doubtful:</b> ${hurt || "none listed"}</div>
    </div>`;
  }).join("");

  // Tests running since Nov 1 (DEC-20261101-01, -03), with closing line value.
  const t = clv && clv.tests ? clv.tests : null;
  const tl = (lbl, x) => x && x.calls ? `${lbl} ${x.record}, ${x.units >= 0 ? "+" : ""}${x.units}u, line moved toward Leo ${x.moved_toward_pct}% / against ${x.moved_against_pct}%` : `${lbl} no graded calls yet`;
  const testsNote = t ? `Tests since ${esc(clv.tests_from)}: ${esc(tl("Leo picks", t.leo_picks))}; ${esc(tl("WR unders", t.wr_unders))}; ${esc(tl("RB unders", t.rb_unders))}.` : "";
  const capNote = capturedMin.length
    ? `Prop lines captured ${Math.min(...capturedMin)} to ${Math.max(...capturedMin)} minutes before kickoff, ${withLine.length} of ${yard.length} projections have a line.`
    : `No prop lines were attached to this capture, so props show Leo's number only.`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Leo NFL brief ${esc(DATE)}</title><link href="https://fonts.googleapis.com/css2?family=Onest:wght@400;700;800;900&family=EB+Garamond:wght@600&display=swap" rel="stylesheet"><style>${css}</style></head><body>
    <div class="brand">Leo</div><div class="eyebrow">Owner brief &middot; NFL</div>
    <h1>Leo NFL brief</h1>
    <p class="sub">${esc(prettyDate(DATE))}, Week ${esc(week)} &middot; ${games.length} games &middot; built ${esc(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }))} ET</p>
    <div class="box">Information only, for the owner. Leo's side is where his number sits relative to the posted line; it is not a bet recommendation. ${record} ${esc(capNote)} Calls: QB ${sideCount.QB[1]} of ${sideCount.QB[0]}, RB ${sideCount.RB[1]} of ${sideCount.RB[0]}, WR ${sideCount.WR[1]} of ${sideCount.WR[0]} lined props are outside the 5% floor. ${testsNote}</div>
    ${newRules
      ? `<table><tr><th>Kick</th><th>Game</th><th>QBs</th><th>Moneyline</th><th>Spread</th><th>Total</th></tr>${callRows}</table><p class="note">PASS means no call. Moneyline: more than 60% and a price better than -230. Spread: Leo 1 point off the line, and his margin and win chance agree on the winner. Total: Leo 1.5 to 7 points off the line.</p>`
      : `<table><tr><th>Kick</th><th>Game</th><th>QBs</th><th>Leo win</th><th>Market</th><th>Leo margin</th><th>Spread</th><th>Leo's side</th><th class="n">Leo total</th><th class="n">Line</th></tr>${summaryRows}</table>`}
    <p class="note">Spread side needs 1.0 point between Leo's margin and the line. A Leo pick is a team Leo gives more than 60%; it is graded at the price shown when Leo made it. Under 60% is too close to call.</p>
    ${gameBlocks}
  </body></html>`;

  const text = `Leo NFL brief, ${prettyDate(DATE)}, Week ${week}. ${games.length} games. The full brief is attached as a PDF. Information only, not a bet recommendation.\n\n` +
    games.map(g => `${clock(g.kickoff)}  ${g.matchup}: Leo ${g.pick} ${pct(g.model_prob)}, margin ${byMargin(g, num(g.exp_margin))}, line ${spreadText(g, num(g.spread_line))}, total ${r1(num(g.proj_total))} vs ${r1(num(g.total_line))}`).join("\n");
  const E = require("./lib/email-cards");
  const picks = newRules ? games.filter(g => CALLS.calls(g).ml.call) : games.filter(g => num(g.model_prob) > 0.60);
  const emailHtml = E.shell({ title: `Leo NFL brief ${DATE}`, preheader: `${games.length} games, ${picks.length} Leo picks. Full brief attached.`, body: [
    E.header("NFL"),
    E.hero({ eyebrow: `Owner brief &middot; Week ${esc(week)} &middot; ${esc(prettyDate(DATE))}`, title: "Leo NFL brief", subtitle: `The full brief is attached as a PDF: every game, every prop with its line, the touchdown chances and the injury report. Information only, not a bet recommendation. ${testsNote}` }),
    E.panel("Leo&rsquo;s picks", E.rows(picks.map(g => [`<b>${esc(TEAMS.full(g.pick))}</b> ${pct(num(g.model_prob))}${g.price != null && g.price !== "" ? ` <span style="color:${E.T.dim}">${esc((+g.price > 0 ? "+" : "") + g.price)}</span>` : ""}`, `${esc(g.matchup)} &middot; ${esc(clock(g.kickoff))}`]), "No team clears 60% on this slate.")),
    E.panel("Every game", E.rows(games.map(g => [`${esc(g.matchup)} <span style="color:${E.T.dim}">${esc(clock(g.kickoff))}</span>`, `Leo ${esc(byMargin(g, num(g.exp_margin)))} &middot; line ${esc(spreadText(g, num(g.spread_line)))} &middot; total ${r1(num(g.proj_total))} vs ${r1(num(g.total_line))}`]), "")),
    E.footer({ links: [[`${E.SITE}/nfl/scoreboard/`, "Scoreboard"]], note: "Private to the owner. Leo&rsquo;s side is where his number sits against the line, never a recommendation to bet." })
  ].join("\n") });
  return { html, text, games, week, lined: withLine.length, emailHtml };
}

function toPdf(html, out) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leo-brief-"));
  const src = path.join(dir, "brief.html");
  fs.writeFileSync(src, html);
  const bins = [process.env.CHROME_BIN, "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].filter(Boolean);
  let lastErr;
  for (const bin of bins) {
    try {
      execFileSync(bin, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer",
        `--print-to-pdf=${out}`, `file://${src}`], { stdio: "pipe", timeout: 120000 });
      if (fs.existsSync(out) && fs.statSync(out).size > 1000) return out;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`no headless Chrome produced a PDF (${lastErr ? lastErr.message.split("\n")[0] : "none found"})`);
}

async function main() {
  const b = build();
  if (!b) { console.log(`NFL brief ${DATE}: no slate file, nothing to send.`); return; }
  if (PDF_ONLY) { toPdf(b.html, path.resolve(PDF_ONLY)); console.log(`NFL brief ${DATE}: wrote ${PDF_ONLY} (${b.games.length} games, ${b.lined} lined props).`); return; }
  if (!TEST && fs.existsSync(LOG)) { console.log(`NFL brief ${DATE} already sent.`); return; }

  const first = b.games.map(g => Date.parse(kickoffUtc(DATE, g.kickoff))).filter(Number.isFinite).sort((x, y) => x - y)[0];
  const now = Date.now();
  if (!TEST && first && now >= first) { console.log(`NFL brief ${DATE}: first kickoff has passed, not sending.`); return; }
  const nightOnly = String(b.games[0].kickoff) >= NIGHT_FIRST_KICK;
  const inWindow = first && (first - now) <= WINDOW_H * 3600e3;
  // A night-only slate (Thursday, Monday) sends from the midday gather, not
  // the 8am one, which comes before most prop lines are posted.
  const inNightWindow = nightOnly && first && (first - now) <= NIGHT_WINDOW_H * 3600e3;
  if (!FORCE && !inWindow && !inNightWindow) {
    console.log(`NFL brief ${DATE}: ${first ? Math.round((first - now) / 6e4) : "?"} min to first kickoff; waiting for the capture within ${WINDOW_H}h.`); return;
  }
  if (!KEY || !FROM || !TO) { console.log("NFL brief: RESEND_API_KEY, EMAIL_FROM or AUDIT_EMAIL not set, skipped."); if (TEST) process.exitCode = 1; return; }

  const pdf = toPdf(b.html, path.join(os.tmpdir(), `leo-nfl-brief-${DATE}.pdf`));
  const content = fs.readFileSync(pdf).toString("base64");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM, to: [TO], subject: `${TEST ? "TEST " : ""}Leo NFL brief: ${prettyDate(DATE)}, Week ${b.week}`,
      text: b.text, html: b.emailHtml,
      attachments: [{ filename: `leo-nfl-brief-${DATE}.pdf`, content }]
    })
  });
  if (!res.ok) { console.warn(`NFL brief send failed: HTTP ${res.status} ${await res.text().catch(() => "")}`); if (TEST) process.exitCode = 1; return; }
  if (TEST) { console.log(`NFL brief ${DATE}: TEST sent with PDF (no send log written).`); return; }
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(LOG, JSON.stringify({ date: DATE, sent_at: new Date().toISOString(), games: b.games.length, lined_props: b.lined }, null, 2) + "\n");
  console.log(`NFL brief ${DATE} sent with PDF.`);
}
main().catch(e => { console.error("NFL brief error:", e.message); process.exit(0); });
