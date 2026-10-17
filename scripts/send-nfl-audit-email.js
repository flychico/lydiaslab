#!/usr/bin/env node
/**
 * Leo NFL game audit: every game of a graded date, Leo's frozen pre-game read
 * against what happened, emailed to the owner.
 *
 *   node scripts/send-nfl-audit-email.js YYYY-MM-DD          send (RESEND_API_KEY, EMAIL_FROM, AUDIT_EMAIL)
 *   node scripts/send-nfl-audit-email.js YYYY-MM-DD --dry    print it, send nothing
 *   node scripts/send-nfl-audit-email.js YYYY-MM-DD --html   write the HTML to stdout
 *
 * Runs in nfl-grade-results.yml after grading and the matchup rebuild, so
 * every number comes from the graded ledgers and data/nfl/matchups/<date>.json
 * (the frozen pre-kickoff read and the final report). Nothing is recomputed.
 *
 * Per game: final score; win chance, total and margin against the result;
 * every QB/RB/WR projection with the line, the actual, the call and why it
 * missed (volume or efficiency, in yards); every player who scored with the
 * chance Leo gave him; the injury report Leo had. Day summary on top.
 *
 * Sends once per date (data/email-log/nfl-audit-<date>.json) and only when
 * every game of the date is final and graded. The recipient comes from the
 * AUDIT_EMAIL secret (falls back to OWNER_EMAIL), never from the repo, which
 * is public.
 */
const fs = require("fs");
const path = require("path");
const TEAMS = require("./lib/nfl-teams");

const ROOT = path.join(__dirname, "..");
const DRY = process.argv.includes("--dry"), HTML = process.argv.includes("--html");
const DATE = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a))
  || new Date(Date.now() - 864e5).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const TO = (process.env.AUDIT_EMAIL || process.env.OWNER_EMAIL || "").trim();
const KEY = process.env.RESEND_API_KEY || "", FROM = process.env.EMAIL_FROM || "";
const LOG = path.join(ROOT, "data/email-log", `nfl-audit-${DATE}.json`);
const SITE = "https://ndhorizon.com";

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = v => { const x = Number.parseFloat(v); return Number.isFinite(x) ? x : null; };
const pct = p => p == null ? "n/a" : `${Math.round(p * 100)}%`;
const r1 = x => x == null ? "n/a" : (Math.round(x * 10) / 10).toString();
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const UNIT = { QB_PASS_YARDS: ["pass yds", "att"], RB_RUSH_YARDS: ["rush yds", "car"], WR_REC_YARDS: ["rec yds", "tgt"] };

function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; } else if (c !== "\r") f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const h = rows.shift();
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ""])));
}

// Why a projection missed: the larger of the volume and efficiency effects.
function why(p) {
  const pr = num(p.projection), ac = num(p.actual);
  if (pr == null || ac == null) return "";
  if (Math.abs(ac - pr) <= Math.max(8, 0.12 * pr)) return "on target";
  const re = num(p.rate_effect), ve = num(p.volume_effect);
  if (re == null || ve == null) return "";
  const unit = (UNIT[p.market] || [, "volume"])[1];
  return Math.abs(ve) >= Math.abs(re)
    ? `${num(p.actual_volume) < num(p.expected_volume) ? "fewer" : "more"} ${unit} (${r1(num(p.actual_volume))} vs ${r1(num(p.expected_volume))})`
    : `${num(p.actual_rate) < num(p.rate_used) ? "less" : "more"} efficient (${r1(num(p.actual_rate))} vs ${r1(num(p.rate_used))} per ${unit})`;
}

function load() {
  const mf = path.join(ROOT, "data/nfl/matchups", `${DATE}.json`);
  if (!fs.existsSync(mf)) return null;
  const games = JSON.parse(fs.readFileSync(mf, "utf8"));
  const ids = new Set(games.map(g => g.game_id));
  const dedupe = (rows, key) => { const m = new Map(); rows.forEach(r => m.set(key(r), r)); return [...m.values()]; };
  const props = dedupe(readCsv(path.join(ROOT, "data/nfl/nfl-props-graded.csv")).filter(r => ids.has(r.game_id)),
                       r => `${r.game_id}|${r.player}|${r.market}`);
  const lines = dedupe(readCsv(path.join(ROOT, "data/nfl/nfl-results-log.csv")).filter(r => ids.has(r.game_id)),
                       r => `${r.game_id}|${r.market}`);
  return { games, props, lines };
}

function summary({ games, props, lines }) {
  const calls = props.filter(p => UNIT[p.market] && ["W", "L", "P"].includes(p.result) && p.excluded !== "Y");
  const yard = props.filter(p => UNIT[p.market] && p.actual !== "" && p.excluded !== "Y" && p.projection !== "");
  const td = props.filter(p => p.market === "ANYTIME_TD" && p.actual !== "" && p.excluded !== "Y");
  const ml = lines.filter(r => r.market === "moneyline" && r.actual_value && r.actual_value !== "TIE");
  const tot = lines.filter(r => r.market === "total" && r.actual_value !== "" && r.leo_value !== "");
  const by = g => { const x = calls.filter(p => p.market.startsWith(g)); return `${x.filter(p => p.result === "W").length}-${x.filter(p => p.result === "L").length}`; };
  const tdBrier = td.length ? mean(td.map(p => (num(p.projection) - (num(p.actual) > 0 ? 1 : 0)) ** 2)) : null;
  // Top TD pick per game
  const byGame = new Map(); td.forEach(p => { const a = byGame.get(p.game_id) || []; a.push(p); byGame.set(p.game_id, a); });
  const tops = [...byGame.values()].map(a => a.sort((x, y) => num(y.projection) - num(x.projection))[0]);
  const mlLeo = ml.map(r => { const won = r.actual_value === r.leo_side ? 1 : 0; return [(num(r.leo_value) - won) ** 2, r.market_value ? (num(r.market_value) - won) ** 2 : null]; });
  const misses = yard.map(p => ({ p, e: Math.abs(num(p.actual) - num(p.projection)) })).sort((a, b) => b.e - a.e);
  const best = calls.filter(p => p.result === "W" && p.line_abs_error !== "")
    .map(p => ({ p, gain: num(p.line_abs_error) - num(p.abs_error) })).sort((a, b) => b.gain - a.gain);
  return {
    games: games.length,
    props: `${calls.filter(p => p.result === "W").length}-${calls.filter(p => p.result === "L").length}`,
    qb: by("QB"), rb: by("RB"), wr: by("WR"),
    beat: calls.length ? `${calls.filter(p => p.beat_line === "Y").length}/${calls.length}` : "n/a",
    mae: r1(mean(yard.map(p => Math.abs(num(p.actual) - num(p.projection))))),
    lineMae: r1(mean(yard.filter(p => p.line_abs_error !== "").map(p => num(p.line_abs_error)))),
    tdBrier: tdBrier == null ? "n/a" : tdBrier.toFixed(3),
    tdTop: tops.length ? `${tops.filter(p => num(p.actual) > 0).length} of ${tops.length}` : "n/a",
    mlBrier: mlLeo.length ? mean(mlLeo.map(x => x[0])).toFixed(3) : "n/a",
    mktBrier: mlLeo.filter(x => x[1] != null).length ? mean(mlLeo.filter(x => x[1] != null).map(x => x[1])).toFixed(3) : "n/a",
    favWon: ml.length ? `${ml.filter(r => r.actual_value === r.leo_side).length} of ${ml.length}` : "n/a",
    totMae: r1(mean(tot.map(r => Math.abs(num(r.leo_value) - num(r.actual_value))))),
    totLine: r1(mean(tot.filter(r => r.market_value !== "").map(r => Math.abs(num(r.market_value) - num(r.actual_value))))),
    misses: misses.slice(0, 3), best: best.slice(0, 3)
  };
}

function gameBlock(m, data) {
  const F = m.final_report, L = m.leo && m.leo.game;
  const gp = data.props.filter(p => p.game_id === m.game_id);
  const yard = gp.filter(p => UNIT[p.market] && p.excluded !== "Y" && p.actual !== "")
    .sort((a, b) => a.market.localeCompare(b.market) || num(b.projection) - num(a.projection));
  const out = gp.filter(p => p.excluded === "Y").map(p => `${p.player} (${p.exclude_reason || "excluded"})`);
  const td = gp.filter(p => p.market === "ANYTIME_TD" && p.actual !== "");
  const scored = F && F.td_scored ? Object.entries(F.td_scored).filter(([, n]) => n > 0) : [];
  const tdChance = name => { const r = td.find(p => p.player === name); return r ? pct(num(r.projection)) : "not projected"; };
  const winner = F && F.winner;
  const margin = F ? F.home_score - F.away_score : null;
  const inj = m.injuries ? ["away", "home"].map(s => {
    const side = m.injuries[s]; if (!side) return "";
    const key = (side.listed || []).filter(x => ["Out", "Doubtful"].includes(x.status) && ["QB", "RB", "WR", "TE"].includes(x.pos));
    return key.length ? `${side.team}: ${key.map(x => `${x.player} ${x.pos} (${x.status})`).join(", ")}` : "";
  }).filter(Boolean) : [];

  const rows = [
    ["Win chance", L ? `${esc(L.pick)} ${pct(L.prob)}` : "no pre-game read", winner ? `${esc(winner)} won` : "", L && winner ? (winner === L.pick ? "Leo's side won" : "Leo's side lost") : ""],
    ["Total", L ? `${r1(L.proj_total)} (line ${r1(m.total_line)})` : "n/a", F ? `${F.total}` : "", L && F ? `Leo off by ${r1(Math.abs(L.proj_total - F.total))}, line off by ${r1(Math.abs((m.total_line ?? F.total) - F.total))}` : ""],
    ["Home margin", L ? `${r1(L.exp_margin ?? L.proj_spread)}` : "n/a", margin != null ? `${margin}` : "", L && margin != null ? `off by ${r1(Math.abs((L.exp_margin ?? L.proj_spread) - margin))}` : ""]
  ];
  const td_ = (s, st = "") => `<td style="padding:4px 6px;border-bottom:1px solid #eee;${st}">${s}</td>`;
  const tbl = (head, body) => `<table style="border-collapse:collapse;width:100%;font-size:13px;margin:6px 0 10px"><tr>${head.map(h => `<th style="text-align:left;padding:4px 6px;border-bottom:2px solid #ddd;font-size:11px;color:#666;text-transform:uppercase">${h}</th>`).join("")}</tr>${body}</table>`;
  const html = `<div style="border:1px solid #e3ddd2;border-radius:10px;padding:12px 14px;margin:0 0 14px">
  <div style="font-weight:bold;font-size:16px"><a href="${SITE}${esc(m.url)}" style="color:#1A2535;text-decoration:none">${esc(TEAMS.full(m.away))} ${F ? F.away_score : ""}, ${esc(TEAMS.full(m.home))} ${F ? F.home_score : ""}</a>${F && F.overtime ? " (OT)" : ""}</div>
  ${tbl(["Game", "Leo pre-game", "Actual", "Read"], rows.map(r => `<tr>${r.map((c, i) => td_(c, i === 0 ? "font-weight:bold" : "")).join("")}</tr>`).join(""))}
  ${yard.length ? tbl(["Player", "Leo", "Line", "Actual", "Call", "Why"], yard.map(p => `<tr>${td_(`${esc(p.player)} <span style="color:#888">${esc(p.team)} ${esc(UNIT[p.market][0])}</span>`)}${td_(esc(p.projection))}${td_(esc(p.line || "none"))}${td_(`<b>${esc(p.actual)}</b>`)}${td_(p.result === "W" ? `<span style="color:#2f6e4a">${esc(p.lean)} right</span>` : p.result === "L" ? `<span style="color:#a63a2e">${esc(p.lean)} wrong</span>` : '<span style="color:#888">no call</span>')}${td_(esc(why(p)))}</tr>`).join("")) : ""}
  <div style="font-size:13px;line-height:1.5"><b>Touchdowns:</b> ${scored.length ? scored.map(([n, k]) => `${esc(n)}${k > 1 ? ` x${k}` : ""} (Leo ${esc(tdChance(n))})`).join(", ") : "none by tracked players"}<br>
  ${inj.length ? `<b>Out or doubtful before kickoff:</b> ${esc(inj.join("; "))}<br>` : ""}
  ${out.length ? `<b>Excluded from grading:</b> ${esc(out.join(", "))}` : ""}</div>
</div>`;
  const text = `${TEAMS.full(m.away)} ${F ? F.away_score : ""}, ${TEAMS.full(m.home)} ${F ? F.home_score : ""}\n` +
    rows.map(r => `  ${r[0]}: Leo ${r[1].replace(/<[^>]+>/g, "")} | actual ${r[2]} | ${r[3]}`).join("\n") + "\n" +
    yard.map(p => `  ${p.player} ${UNIT[p.market][0]}: Leo ${p.projection}, line ${p.line || "none"}, actual ${p.actual}, ${p.result === "W" ? "right" : p.result === "L" ? "wrong" : "no call"}${why(p) ? ", " + why(p) : ""}`).join("\n") +
    `\n  TDs: ${scored.map(([n]) => `${n} (Leo ${tdChance(n)})`).join(", ") || "none"}\n`;
  return { html, text };
}

function build(data) {
  const S = summary(data);
  const nice = new Date(`${DATE}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  const blocks = data.games.filter(g => g.final_report).sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff))).map(g => gameBlock(g, data));
  const line = x => `${esc(x.p.player)} ${esc((UNIT[x.p.market] || [""])[0])}: Leo ${esc(x.p.projection)}, actual ${esc(x.p.actual)}${x.p.line ? `, line ${esc(x.p.line)}` : ""}`;
  const subject = `Leo audit, ${nice}: props ${S.props}, ${S.games} game${S.games === 1 ? "" : "s"}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:720px;margin:0 auto;color:#1A2535">
  <h2 style="margin:0 0 4px">Leo NFL audit, ${esc(nice)}</h2>
  <p style="margin:0 0 12px;color:#666">Leo's frozen pre-game read against what happened, for every game. Graded from the ledgers on the site.</p>
  <div style="background:#f6f2ea;border-radius:10px;padding:12px 14px;margin:0 0 14px;font-size:14px;line-height:1.6">
    <b>Prop calls:</b> ${S.props} (QB ${S.qb}, RB ${S.rb}, WR ${S.wr}), beat the line ${S.beat}. Average miss ${S.mae} yds vs the line's ${S.lineMae}.<br>
    <b>Touchdowns:</b> Brier ${S.tdBrier} (lower is better). Leo's top scorer in each game scored in ${S.tdTop}.<br>
    <b>Win chance:</b> Brier ${S.mlBrier} vs the market's ${S.mktBrier}. Leo's favoured side won ${S.favWon}.<br>
    <b>Totals:</b> Leo off by ${S.totMae} pts on average vs the line's ${S.totLine}.<br>
    <b>Biggest misses:</b> ${S.misses.map(line).join("; ") || "n/a"}<br>
    <b>Best calls:</b> ${S.best.map(line).join("; ") || "n/a"}
  </div>
  ${blocks.map(b => b.html).join("\n")}
  <p style="font-size:12px;color:#999">Season record: <a href="${SITE}/nfl/results/">${SITE}/nfl/results/</a>. This is the owner audit; it is not sent to members.</p>
</div>`;
  const text = `Leo NFL audit, ${nice}\nProps ${S.props} (QB ${S.qb}, RB ${S.rb}, WR ${S.wr}), beat line ${S.beat}, miss ${S.mae} vs line ${S.lineMae}\n` +
    `TD Brier ${S.tdBrier}, top scorer hit ${S.tdTop}. Win-chance Brier ${S.mlBrier} vs market ${S.mktBrier}. Totals miss ${S.totMae} vs line ${S.totLine}\n\n` +
    blocks.map(b => b.text).join("\n");
  return { subject, html, text, summary: S };
}

async function main() {
  const data = load();
  if (!data || !data.games.length) { console.log(`NFL audit: no matchup data for ${DATE}.`); return; }
  const final = data.games.filter(g => g.final_report);
  const email = build(data);
  if (HTML) { process.stdout.write(email.html); return; }
  if (DRY) { console.log(`SUBJECT: ${email.subject}\n\n${email.text}`); return; }
  if (fs.existsSync(LOG)) { console.log(`NFL audit for ${DATE} already sent.`); return; }
  // Wait for the whole date: every game final, and its props graded.
  const gradedProps = new Set(data.props.map(p => p.game_id));
  // A game with no pre-game read (missed capture) has nothing to grade; don't wait on it.
  if (final.length < data.games.length || final.some(g => g.leo && !gradedProps.has(g.game_id))) {
    console.log(`NFL audit ${DATE}: ${final.length}/${data.games.length} games final and graded, waiting.`); return;
  }
  if (!KEY || !FROM || !TO) { console.log("NFL audit: RESEND_API_KEY, EMAIL_FROM or AUDIT_EMAIL not set, skipped."); return; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [TO], subject: email.subject, html: email.html, text: email.text })
  });
  if (!res.ok) { console.warn(`NFL audit send failed: HTTP ${res.status}`); return; }
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(LOG, JSON.stringify({ date: DATE, sent_at: new Date().toISOString(), games: final.length, summary: { props: email.summary.props, beat: email.summary.beat } }, null, 2) + "\n");
  console.log(`NFL audit ${DATE} sent.`);
}
main().catch(e => { console.error("NFL audit error:", e.message); process.exit(0); });
