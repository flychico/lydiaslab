/**
 * Leo NBA card email: the scoreboard cards, built for inboxes.
 *
 * Same content as /nba/previews/ (Leo win chance for both teams, Leo spread
 * beside DraftKings, the gap, lean or no lean, the why line), laid out with
 * tables and inline styles so it reads the same in Gmail, Apple Mail and
 * Outlook, on a phone or a desktop. Leans are listed first and summarised at
 * the top. Leans are a tracked test, never bets.
 *
 *   build(card, { model, why }) -> { subject, html, text, leans }
 * card is data/nba/picks-<date>.json; why is scripts/lib/nba-why.js.
 */
const SITE = "https://ndhorizon.com";
const C = { ink: "#1A2535", dim: "#6b6457", line: "#e6dfd2", card: "#fffdf8", head: "#f1ebdf", page: "#f6f1e7",
  gold: "#c9a54a", navy: "#1A2535", leanBg: "#dcefe0", leanInk: "#2e7d4f", noBg: "#e9e3d7", noInk: "#6b6457" };
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = p => p == null ? "&mdash;" : Math.round(p * 100) + "%";
const sgn = v => v == null ? "&mdash;" : v === 0 ? "PK" : (v > 0 ? "+" : "") + v;
const tip = iso => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
const logo = t => `https://a.espncdn.com/i/teamlogos/nba/500/${String(t).toLowerCase()}.png`;
const pageUrl = (g, date) => `${SITE}/nba/${g.away.toLowerCase()}-vs-${g.home.toLowerCase()}-prediction-odds-${date}/`;
const FONT = "font-family:Arial,Helvetica,sans-serif";

function teamRow(g, side) {
  const p = side === "home" ? g.leo.p_home : g.leo.p_away;
  return `<tr>
    <td width="40" style="padding:8px 0;vertical-align:middle"><img src="${logo(g[side])}" width="32" height="32" alt="${esc(g[side])}" style="display:block;border:0"></td>
    <td style="padding:8px 8px;vertical-align:middle;${FONT};font-size:16px;color:${C.ink};font-weight:${g.leo.lean && g.leo.lean.side === side ? "bold" : "normal"}">${esc(g[side + "_name"] || g[side])}</td>
    <td align="right" style="padding:8px 0;vertical-align:middle;${FONT}"><div style="font-size:16px;font-weight:bold;color:${C.ink}">${pct(p)}</div><div style="font-size:12px;color:${C.dim}">Leo win chance</div></td>
  </tr>`;
}
function box(label, value, sub) {
  return `<td width="33%" valign="top" style="padding:0 3px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:10px;background:#ffffff">
      <tr><td align="center" style="padding:9px 4px;${FONT}">
        <div style="font-size:10px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;color:${C.dim}">${label}</div>
        <div style="font-size:16px;font-weight:bold;color:${C.ink};margin:3px 0">${value}</div>
        <div style="font-size:11px;color:${C.dim}">${sub}</div>
      </td></tr></table></td>`;
}
function card(g, date, why) {
  const L = g.leo, mk = g.market || {};
  const badge = L.lean ? `Lean ${esc(L.lean.team)} ${sgn(L.lean.line)}` : "No lean";
  const W = why ? why.why(g) : null;
  const pa = Math.round((L.p_away || 0) * 100), ph = 100 - pa;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.line};border-radius:14px;margin:0 0 14px;border-collapse:separate">
  <tr><td style="background:${C.head};border-radius:14px 14px 0 0;padding:12px 16px;border-bottom:1px solid ${C.line}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="${FONT};font-size:15px;font-weight:bold;color:${C.ink}">${esc(tip(g.tip_utc))} &middot; ${esc(g.away)} at ${esc(g.home)}</td>
      <td align="right"><span style="${FONT};display:inline-block;font-size:11px;font-weight:bold;letter-spacing:.06em;text-transform:uppercase;padding:4px 10px;border-radius:999px;background:${L.lean ? C.leanBg : C.noBg};color:${L.lean ? C.leanInk : C.noInk}">${badge}</span></td>
    </tr></table></td></tr>
  <tr><td style="padding:8px 16px 4px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${teamRow(g, "away")}${teamRow(g, "home")}</table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 12px"><tr>
      <td width="${pa}%" style="height:7px;line-height:7px;font-size:0;background:${C.gold};border-radius:999px 0 0 999px">&nbsp;</td>
      <td width="${ph}%" style="height:7px;line-height:7px;font-size:0;background:${C.navy};border-radius:0 999px 999px 0">&nbsp;</td>
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${box("Leo spread", `${esc(g.home)} ${sgn(L.home_spread)}`, "expected margin")}
      ${box("DraftKings", mk.home_spread == null ? "&mdash;" : `${esc(g.home)} ${sgn(mk.home_spread)}`, mk.p_home != null ? `market ${esc(g.home)} ${pct(mk.p_home)}` : "&nbsp;")}
      ${box("Gap", L.edge_pts == null ? "&mdash;" : `${Math.abs(L.edge_pts).toFixed(1)} pts`, L.lean ? "lean" : "under 4, no lean")}
    </tr></table>
    ${W && W.summary ? `<div style="${FONT};font-size:14px;line-height:1.5;color:${C.dim};border-top:1px solid ${C.line};margin-top:12px;padding-top:10px">${esc(W.summary)}</div>` : ""}
    <div style="${FONT};font-size:14px;font-weight:bold;margin:10px 0 12px"><a href="${pageUrl(g, date)}" style="color:${C.ink};text-decoration:none">Full preview: why Leo has this number &rarr;</a></div>
  </td></tr></table>`;
}

function build(doc, { why } = {}) {
  const date = doc.date;
  const nice = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  const games = doc.games.filter(g => g.leo && g.state !== "post");
  const gap = g => g.leo.edge_pts == null ? -1 : Math.abs(g.leo.edge_pts);
  games.sort((a, b) => (!!b.leo.lean - !!a.leo.lean) || a.tip_utc.localeCompare(b.tip_utc) || gap(b) - gap(a));
  const leans = games.filter(g => g.leo.lean);
  const leanList = leans.map(g => `${g.leo.lean.team} ${sgn(g.leo.lean.line)}`);
  const subject = `Leo NBA card, ${nice}: ${games.length} game${games.length === 1 ? "" : "s"}, ${leans.length ? `${leans.length} lean${leans.length === 1 ? "" : "s"} (${leanList.join(", ")})` : "no leans"}`;
  const summary = leans.length
    ? leans.map(g => `<tr><td style="${FONT};font-size:15px;padding:4px 0;color:${C.ink}"><b>${esc(g.leo.lean.team)} ${sgn(g.leo.lean.line)}</b></td><td align="right" style="${FONT};font-size:13px;color:${C.dim}">${esc(g.away)} at ${esc(g.home)} &middot; ${esc(tip(g.tip_utc))} &middot; ${Math.abs(g.leo.edge_pts).toFixed(1)} pts off</td></tr>`).join("")
    : `<tr><td style="${FONT};font-size:14px;color:${C.dim}">No game tonight is 4 or more points off the DraftKings spread, so Leo records no lean.</td></tr>`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.page}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page}"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
  <tr><td style="${FONT};padding:0 4px 14px">
    <div style="font-size:12px;font-weight:bold;letter-spacing:.1em;text-transform:uppercase;color:#a8862f">Leo NBA &middot; ${esc(nice)}</div>
    <div style="font-size:24px;font-weight:bold;color:${C.ink};margin:4px 0 6px">Tonight&rsquo;s card: ${games.length} game${games.length === 1 ? "" : "s"}</div>
    <div style="font-size:14px;line-height:1.5;color:${C.dim}">Leo&rsquo;s win chance and spread for every game, beside DraftKings. A gap of 4 points or more is a lean: a public test, graded every morning, not a bet.</div>
  </td></tr>
  <tr><td style="padding:0 0 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid ${C.line};border-radius:14px"><tr><td style="padding:12px 16px">
      <div style="${FONT};font-size:11px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;color:${C.dim};margin-bottom:4px">Tonight&rsquo;s leans</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${summary}</table>
    </td></tr></table>
  </td></tr>
  <tr><td>${games.map(g => card(g, date, why)).join("")}</td></tr>
  <tr><td style="${FONT};font-size:14px;padding:4px 4px 0"><a href="${SITE}/nba/scoreboard/" style="color:${C.ink};font-weight:bold">Live scores and every card &rarr;</a> &nbsp; <a href="${SITE}/nba/results/" style="color:${C.ink}">Leo&rsquo;s record &rarr;</a></td></tr>
  <tr><td style="${FONT};font-size:12px;line-height:1.5;color:#999;padding:18px 4px 0;border-top:1px solid ${C.line}">Every number is frozen before tip and graded on the site, wins and losses alike. Under 50 graded leans is an early read.<br>Leo provides analysis and education only, not betting advice. 21+. If you or someone you know has a gambling problem, call 1-800-MY-RESET (1-800-697-3738).<br>To unsubscribe, reply with &ldquo;unsubscribe&rdquo;.</td></tr>
</table></td></tr></table></body></html>`;
  const text = [`Leo NBA card, ${nice}`, "",
    leans.length ? `Tonight's leans: ${leanList.join(", ")}` : "No leans tonight.", "",
    ...games.map(g => { const L = g.leo, mk = g.market || {}, W = why ? why.why(g) : null;
      return `${tip(g.tip_utc)}  ${g.away} at ${g.home}  ${L.lean ? `LEAN ${L.lean.team} ${sgn(L.lean.line)}` : "No lean"}\n  Leo win chance: ${g.away} ${Math.round(L.p_away * 100)}%, ${g.home} ${Math.round(L.p_home * 100)}%\n  Leo spread ${g.home} ${sgn(L.home_spread)} | DraftKings ${mk.home_spread == null ? "n/a" : g.home + " " + sgn(mk.home_spread)} | gap ${L.edge_pts == null ? "n/a" : Math.abs(L.edge_pts).toFixed(1)}\n${W && W.summary ? "  " + W.summary + "\n" : ""}  ${pageUrl(g, date)}`; }),
    "", `Every card: ${SITE}/nba/scoreboard/`, "Leans are a public test, not bets. Analysis only, not betting advice. 21+. 1-800-MY-RESET.", 'Reply "unsubscribe" to stop these.'].join("\n").replace(/&mdash;/g, "-");
  return { subject, html, text, leans: leanList };
}

module.exports = { build };
