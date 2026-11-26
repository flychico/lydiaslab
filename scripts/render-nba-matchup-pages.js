#!/usr/bin/env node
/**
 * One permanent page per NBA game: /nba/<away>-vs-<home>-prediction-odds-<date>/ (team nicknames from
 * 2026-11-07, abbreviations before; scripts/lib/nba-urls.js)
 *
 *   node scripts/render-nba-matchup-pages.js [YYYY-MM-DD ...]   default: today, New York
 *
 * Reads data/nba/picks-<date>.json (Leo's read, the DraftKings line, what
 * moved Leo's number, form, key players, the injury list as of the read) and
 * data/nba/results.json (the final and how Leo was graded, once graded).
 * Re-run after grading to add the final.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "data", "nba");
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const DATES = process.argv.slice(2).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (!DATES.length) DATES.push(today());

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sgn = v => v == null ? "&mdash;" : v === 0 ? "PK" : (v > 0 ? "+" : "") + v;
const pct = p => p == null ? "&mdash;" : Math.round(p * 100) + "%";
const am = v => v == null ? "&mdash;" : (v > 0 ? "+" : "") + v;
const nick = name => String(name || "").split(" ").slice(-1)[0].replace("Blazers", "Trail Blazers");
const logo = t => "https://a.espncdn.com/i/teamlogos/nba/500/" + String(t).toLowerCase() + ".png";
const URLS = require("./lib/nba-urls");
const COPY = require("./lib/nba-game-copy");
const RC = require("./lib/nba-read-change");   // the read moved after the card email (Lynold, 2026-11-17)   // unique opening and What happened (HO-0069 part B)
const SCHED = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "nba", "schedule.json"), "utf8")); } catch (e) { return null; } })();
const HOW = "/nba/how-leo-works/";   // the explainers every page used to repeat   // one address helper for page, nightly page, email, picks data (SEO-09, DEC-20261107-30)
const slug = g => URLS.gameSlug(g);
const longDate = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const tip = iso => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
const statusTxt = s => s === "day-to-day" ? "Day to day" : s ? s[0].toUpperCase() + s.slice(1) : "";

/** Published read rule (Lynold, 2026-11-24): the card keeps the read that went out; a later read is shown, not graded. */
function latestNote(g) {
  const L = g.latest; if (!L || !g.leo || L.p_home == null || g.leo.p_home == null) return "";
  const nm = ab => URLS.nick(ab, ab === g.home ? g.home_name : g.away_name);
  const side = p => p >= 0.5 ? g.home : g.away, pct = p => Math.round(Math.max(p, 1 - p) * 100);
  const flip = side(L.p_home) !== side(g.leo.p_home);
  if (!flip && Math.abs(L.p_home - g.leo.p_home) < 0.03) return "";
  const t = iso => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
  return `<p class="moved">Leo&rsquo;s later read (${esc(t(L.captured_at))}) has the ${esc(nm(side(L.p_home)))} at ${pct(L.p_home)}%. Leo is graded on the read it published${g.public_at ? ` (${esc(t(g.public_at))})` : ""}: the ${esc(nm(side(g.leo.p_home)))} at ${pct(g.leo.p_home)}%.</p>`;
}

function results() {
  const f = path.join(DIR, "results.json");
  const out = {};
  if (fs.existsSync(f)) for (const g of JSON.parse(fs.readFileSync(f, "utf8")).games || []) out[g.game_id] = g;
  return out;
}

// Leo's read in plain words (DEC-20261031-10). Same text as the nightly card.
const WHY = require("./lib/nba-why");
const PKS = require("./lib/nba-picks");   // Leo Pick rule (DEC-20261102-30)
const SW = require("./lib/nba-swing");
const EX = require("./lib/nba-page-extras");
const SEO = require("./lib/game-page-seo");
const SEASON_PICKS = (() => { try { return JSON.parse(fs.readFileSync(path.join(DIR, "results-days.json"), "utf8")).season.picks; } catch (e) { return null; } })();   // stat table, head to head, rest, FAQ (Lynold, 2026-11-24)   // "Depends on <player>" line (HO-0097)
// Player lines for finished games: ESPN's game summary saved at grading
// (data/nba/boxscores/<date>.json, full line), else the season player log
// (data/nba/player-log.json: minutes, points, rebounds, assists).
const PLOG = (() => { try { return JSON.parse(fs.readFileSync(path.join(DIR, "player-log.json"), "utf8")).players; } catch (e) { return []; } })();
const BOXES = {};
function espnBox(date, id) {
  if (!(date in BOXES)) { const f = path.join(DIR, "boxscores", `${date}.json`); BOXES[date] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).games : []; }
  return BOXES[date].find(x => x.game_id === String(id)) || null;
}
function lastN(team, name, date, k = 5) {
  const p = PLOG.find(x => x.team === team && x.name === name); if (!p) return null;
  const g = p.log.filter(l => l[0] < date && l[3] != null).slice(-k);
  return g.length ? Math.round(g.reduce((s, l) => s + l[3], 0) / g.length * 10) / 10 : null;
}
function boxBlock(g, res) {
  if (!res) return "";
  const eb = espnBox(g.date, g.game_id), counted = {};
  for (const side of ["home", "away"]) for (const p of ((g.leo.missing || {})[side]) || []) counted[g[side] + "|" + p.name] = p;
  const n = v => { const x = parseFloat(String(v ?? "").replace(/^\+/, "")); return Number.isFinite(x) ? x : null; };
  const side = sd => {
    const team = g[sd];
    let rows = eb ? eb.players.filter(p => p.team === team).map(p => ({ name: p.name, starter: p.starter, min: p.dnp ? 0 : Math.round(p.minutes || 0), dnp: p.dnp || !(p.minutes > 0), reason: p.reason,
        pts: n(p.stats.points), reb: n(p.stats.rebounds), ast: n(p.stats.assists), fg: p.stats["fieldGoalsMade-fieldGoalsAttempted"], tp: p.stats["threePointFieldGoalsMade-threePointFieldGoalsAttempted"],
        ft: p.stats["freeThrowsMade-freeThrowsAttempted"], pm: p.stats.plusMinus }))
      : PLOG.filter(p => p.team === team).map(p => { const l = p.log.find(x => x[0] === g.date); return l ? { name: p.name, min: l[2], dnp: !l[2], pts: l[3], reb: l[4], ast: l[5] } : null; }).filter(Boolean);
    if (!rows.length) return `<p class="dim">${esc(team)} box score not in yet.</p>`;
    rows.sort((a, b) => (a.dnp - b.dnp) || (b.min - a.min));
    const full = !!eb, tot = rows.reduce((s, r) => s + (r.pts || 0), 0);
    const leoTag = r => { const c = counted[team + "|" + r.name]; if (!c) return "";
      const was = c.status === "out" ? "out" : c.status === "day-to-day" ? "day to day" : c.status;
      return ` <span class="tag">Leo counted ${esc(was)}: ${r.dnp ? "sat" : "played"}</span>`; };
    return `<div class="card tbl"><table><thead><tr><th>${esc(g[sd + "_name"] || team)}</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th>${full ? "<th>FG</th><th>3PT</th><th>FT</th><th>+/-</th>" : ""}</tr></thead><tbody>
    ${rows.map(r => r.dnp
      ? `<tr class="dnp"><td>${esc(r.name)}${leoTag(r)}</td><td colspan="${full ? 8 : 4}" class="dim">Did not play${r.reason && !/coach/i.test(r.reason) ? ": " + esc(r.reason.toLowerCase()) : ""}</td></tr>`
      : `<tr><td>${esc(r.name)}${r.starter ? ' <span class="st5">S</span>' : ""}${leoTag(r)}</td><td>${r.min}</td><td><b>${r.pts ?? "&mdash;"}</b></td><td>${r.reb ?? "&mdash;"}</td><td>${r.ast ?? "&mdash;"}</td>${full ? `<td>${esc(r.fg || "")}</td><td>${esc(r.tp || "")}</td><td>${esc(r.ft || "")}</td><td>${esc(r.pm || "")}</td>` : ""}</tr>`).join("")}
    <tr class="tot"><td>Team</td><td></td><td><b>${tot}</b></td><td colspan="${full ? 6 : 2}"></td></tr>
    </tbody></table></div>`;
  };
  return `<h2 id="box">${esc(URLS.nick(g.away, g.away_name))} vs ${esc(URLS.nick(g.home, g.home_name))} box score</h2><p class="dim">${eb ? "ESPN box score." : "From ESPN box score files."} <a href="${HOW}#players">Tags show who Leo counted.</a></p>${side("away")}${side("home")}`;
}

const MODEL = (() => { try { return JSON.parse(fs.readFileSync(path.join(DIR, "model.json"), "utf8")); } catch (e) { return {}; } })();
function whyBlock(g) {
  const w = WHY.why(g, { lostCoef: MODEL.coef && MODEL.coef.lost_d, leanPts: MODEL.lean_edge_pts });
  if (!w.leo) return "";
  const nm = COPY.names(g);
  return `<h2 id="why">Why Leo has ${esc(nm(w.leo))}</h2>
  <div class="card why">
  ${w.drivers.length ? `<ol>${w.drivers.map(d => `<li>${esc(nm(d.text))}.</li>`).join("")}</ol>` : ""}
  ${w.swing.length ? `<p class="dim"><b>What could still move it.</b> ${w.swing.map(x => esc(nm(x))).join(" ")}</p>` : ""}
  <p class="dim"><a href="${HOW}#knows">What Leo knows and does not</a></p></div>`;
}

function partsTable(g) {
  const p = g.leo.parts; if (!p) return "";
  const H = esc(URLS.nick(g.home, g.home_name)), AW = esc(URLS.nick(g.away, g.away_name)), row = (label, v, note) => `<tr><td>${label}</td><td class="num"><b>${v == null ? "&mdash;" : (v > 0 ? "+" : "") + v.toFixed(1)}</b></td><td class="dim">${note}</td></tr>`;
  const L = g.leo;
  return `<h2>What moves Leo&rsquo;s number</h2>
  <p class="dim">Points added to ${H}&rsquo;s expected margin. Positive helps the ${H}, negative helps the ${AW}.</p>
  <div class="card tbl"><table>
    ${row("Home court", p.home_court, `Average home edge`)}
    ${row("Team ratings", p.ratings, `${H} ${sgn(L.rating && L.rating.home)}, ${AW} ${sgn(L.rating && L.rating.away)} against an average team`)}
    ${row("Back to back", p.back_to_back, L.back_to_back ? [L.back_to_back.home ? H + " played last night" : "", L.back_to_back.away ? AW + " played last night" : ""].filter(Boolean).join(", ") || "Neither team played last night" : "")}
    ${row("Rest", p.rest, L.rest ? `${H} ${L.rest.home}, ${AW} ${L.rest.away} ${L.rest.away === 1 ? "day" : "days"}` : "")}
    ${row("Missing players", p.missing_players, `Value out: ${H} ${L.lost.home}, ${AW} ${L.lost.away}`)}
    <tr class="total"><td>Leo&rsquo;s margin</td><td class="num"><b>${(L.home_margin > 0 ? "+" : "") + L.home_margin}</b></td><td class="dim">${L.home_margin < 0 ? AW : H} by ${Math.abs(L.home_margin)}</td></tr>
  </table></div>`;
}

function injuries(g, side) {
  const c = g.context && g.context[side];
  const counted = new Map(((g.leo.missing || {})[side] || []).map(p => [p.name, p]));
  const list = c ? c.injuries : [...counted.values()].map(p => ({ name: p.name, status: p.status, detail: p.detail }));
  if (!list.length) return `<p class="dim">Nobody listed.</p>`;
  return `<ul class="inj">${list.map(p => {
    const k = counted.get(p.name);
    return `<li><b>${esc(p.name)}</b> <span class="tag">${esc(statusTxt(p.status))}</span>${p.detail ? ` <span class="dim">${esc(p.detail)}</span>` : ""}${k ? ` <span class="dim">&middot; counted${(k.weight ?? 1) < 1 ? ` ${Math.round(k.weight * 100)}%` : ""}, ${k.mpg} min</span>` : ""}</li>`;
  }).join("")}</ul>`;
}

function formBlock(g, side) {
  const c = g.context && g.context[side]; if (!c) return `<p class="dim">Not available for this read.</p>`;
  const f = c.form;
  const last = f.last5.map(x => `<li><span class="${x.won ? "ok" : "no"}">${x.won ? "W" : "L"}</span> ${x.pts}-${x.opp_pts} ${x.home ? "vs" : "at"} ${esc(URLS.nick(x.opp))} <span class="dim">${esc(x.date.slice(5))}</span></li>`).join("");
  return `<p><b>${f.wins}-${f.losses}</b> &middot; ${f.ppg ?? "&mdash;"} scored, ${f.opp_ppg ?? "&mdash;"} allowed</p>${last ? `<ul class="last5">${last}</ul>` : ""}`;
}

function playersBlock(g, side) {
  const c = g.context && g.context[side]; if (!c || !c.players.length) return "";
  return `<div class="card tbl"><table><thead><tr><th>Player</th><th>GP</th><th>MIN</th><th>PTS</th><th>Last 5</th><th>REB</th><th>AST</th></tr></thead><tbody>
  ${c.players.map(p => { const l5 = lastN(g[side], p.name, g.date); return `<tr><td>${esc(p.name)}${p.status ? ` <span class="tag">${esc(statusTxt(p.status))}</span>` : ""}</td><td>${p.gp}</td><td>${p.mpg}</td><td><b>${p.ppg}</b></td><td>${l5 ?? "&mdash;"}</td><td>${p.rpg}</td><td>${p.apg}</td></tr>`; }).join("")}
  </tbody></table></div>`;
}

const MISSES = {};
function missOf(g) {
  if (!(g.date in MISSES)) { const f = path.join(DIR, "misses", `${g.date}.json`); MISSES[g.date] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).games : null; }
  return MISSES[g.date] ? MISSES[g.date].find(x => String(x.game_id) === String(g.game_id)) || {} : null;
}
function finalBlock(g, res) {
  if (!res) return "";
  const H = URLS.nick(g.home, g.home_name), A = URLS.nick(g.away, g.away_name), margin = res.home_score - res.away_score;
  return `<h2 id="final">${esc(A)} vs ${esc(H)} final score</h2><div class="card final">
    <p class="score">${esc(g.away_name)} ${res.away_score}, ${esc(g.home_name)} ${res.home_score}</p>
    <p>${COPY.whatHappened(g, res, missOf(g)).map(esc).join(" ")}</p>
    <ul>
      <li>Leo&rsquo;s margin for the ${esc(H)} was ${(res.leo_home_margin > 0 ? "+" : "") + res.leo_home_margin.toFixed(1)} and they finished ${(margin > 0 ? "+" : "") + margin}, so Leo missed by ${Math.abs(res.leo_home_margin - margin).toFixed(1)}${res.mkt_home_spread != null ? ` and the DraftKings spread by ${Math.abs(-res.mkt_home_spread - margin).toFixed(1)}` : ""}.</li>
      ${res.pick_result && !res.pick_replay ? `<li>Leo Pick ${esc(URLS.nick(res.pick_team))} ${PKS.fmtPrice(res.pick_price)}: <b class="${res.pick_result === "win" ? "ok" : "no"}">${res.pick_result === "win" ? "won" : "lost"}</b>, ${res.pick_units > 0 ? "+" : ""}${(+res.pick_units).toFixed(2)} units${res.pick_close_price != null ? `. Price at tip ${PKS.fmtPrice(res.pick_close_price)}` : ""}.</li>` : ""}
    </ul></div>`;
}

function page(g, res) {
  const L = g.leo, mk = g.market || {}, H = g.home, A = g.away;
  const OCC = SEO.occasion("NBA", g.date);   // "Christmas Day" (competitor review, 2026-11-25)
  const title = `${nick(g.away_name)} vs ${nick(g.home_name)} Prediction, Spread and Odds${OCC ? ": " + OCC + "," : ","} ${new Date(g.date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} | Leo by ND Horizon`;
  const desc = `Leo gives the ${g.home_name} a ${pct(L.p_home)} chance against the ${g.away_name}. Leo's spread ${H} ${WHY.leoLine(g) === 0 ? "PK" : sgn(WHY.leoLine(g))}, injury report, form and key players.`;
  const url = `https://ndhorizon.com/nba/${slug(g)}/`;
  // Same winner or not, by how much, and Leo's side (shared with the card and email).
  const LS = WHY.leoLine(g), GS = WHY.gapShown(g);
  const NM = COPY.names(g), NA = URLS.nick(A, g.away_name), NH = URLS.nick(H, g.home_name), lbl = c => URLS.nick(c, c === H ? g.home_name : g.away_name);
  const gapTxt = esc(NM(WHY.compare(g, MODEL.lean_edge_pts || 4)));
  const PT = PKS.pickText(g);
  const leanTxt = (PT ? (PT.ok ? `<div class="lean">${esc(NM(PT.line))}</div>` : `<p class="gapread">${esc(NM(PT.line))}</p>`) : "")
    + (!g.completed && SW.line(g) ? `<p class="gapread"><b>${esc(SW.line(g))}</b></p>` : "");   // HO-0097
  const FAQ = EX.faqItems(g, res);
  const lede = COPY.opening(g, { sched: SCHED, lostCoef: MODEL.coef && MODEL.coef.lost_d });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XVWTMDNBJK"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-XVWTMDNBJK');</script>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="article"><meta property="og:site_name" content="Leo">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}"><meta property="og:image" content="https://ndhorizon.com/img/leo-card.png">
<link rel="canonical" href="${url}">
<link rel="stylesheet" href="/css/style.css">
<style>
.mx{max-width:900px;margin:0 auto;padding:26px 16px 40px}
.mx h1{font-size:clamp(1.5rem,4vw,2.2rem);margin:6px 0 4px}
.mx h2{font-size:1.1rem;margin:26px 0 8px;padding-bottom:6px;border-bottom:1.5px solid var(--border)}
.dim{color:var(--text-dim);font-size:.86rem}
.eyebrow{font-size:.7rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--gold-deep)}
.hdr{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:16px;margin:14px 0}
.tm{display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center;flex:1}
.tm img{width:58px;height:58px;object-fit:contain}
.tm b{font-size:.95rem}.tm .p{font-size:1.5rem;font-weight:800}
.mid{text-align:center;font-size:.8rem;color:var(--text-dim)}
.boxes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.box{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:11px 12px}
.box .l{font-size:.64rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--text-dim)}
.box .v{font-size:1.15rem;font-weight:800;margin-top:3px}.box .s{font-size:.76rem;color:var(--text-dim)}
.lean{margin-top:10px;background:rgba(47,110,74,.1);border:1px solid rgba(47,110,74,.35);border-radius:10px;padding:9px 12px;font-size:.88rem}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.tbl{overflow-x:auto}.tbl tr.dnp td{color:var(--text-dim)}.tbl tr.tot td{border-top:2px solid var(--border);font-weight:700}.st5{font-size:.62rem;font-weight:800;color:var(--text-dim)}
.card.tbl{padding:0;overflow-x:auto}
.card table{width:100%;border-collapse:collapse;font-size:.86rem}
.card th,.card td{padding:8px 10px;border-bottom:1px solid var(--border);text-align:left}
.card th{font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim)}
.card td.num{text-align:right;white-space:nowrap}
.card tr.total td{border-bottom:0;background:var(--bg-elev)}
.tag{display:inline-block;padding:0 6px;border-radius:999px;font-size:.66rem;font-weight:800;background:var(--bg-elev);border:1px solid var(--border);color:var(--danger)}
ul.inj,ul.last5{margin:6px 0 0;padding-left:18px;font-size:.86rem;line-height:1.6}
.ok{color:var(--good);font-weight:800}.no{color:var(--danger);font-weight:800}
.why{padding:12px 16px}.why ol{margin:6px 0 8px;padding-left:20px;line-height:1.6;font-size:.9rem}.why p{margin:6px 0}
.final{padding:14px 16px}.final .score{font-size:1.25rem;font-weight:800;margin:0 0 6px}
.lede{font-size:1rem;line-height:1.6;margin:10px 0 4px}
.stk{background:var(--bg-elev);border:1px solid var(--border);border-left:3px solid var(--gold,#C9A84C);border-radius:10px;padding:10px 13px;margin:12px 0 0;font-size:.92rem;line-height:1.5}
.moved{margin:10px 0 0;padding:8px 12px;border-left:3px solid var(--gold,#C9A84C);font-size:.92rem;line-height:1.5}
.lede2{font-size:.9rem;line-height:1.55;margin:6px 0 4px;color:var(--text-dim)}
.final p{margin:0 0 8px;line-height:1.55}
.final ul{margin:0;padding-left:18px;line-height:1.6;font-size:.9rem}
.cmp td{text-align:center;width:28%;white-space:nowrap}.cmp th{text-align:center}.cmp tbody th{font-size:.78rem;text-transform:none;letter-spacing:0;color:var(--text)}.cmp tbody th span{display:block;font-weight:400;font-size:.68rem;color:var(--text-dim)}.cmp td.lead{font-weight:800}
.nfl-signup{display:grid;grid-template-columns:1.2fr 1fr;gap:14px;align-items:center;background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:16px 18px;margin:26px 0 6px;box-shadow:var(--shadow-sm)}
.nfl-signup p{margin:4px 0 0;color:var(--text-dim);font-size:.86rem}
.nfl-signup form{display:flex;gap:8px}.nfl-signup input[type=email]{flex:1;min-width:0;padding:10px 12px;border:1px solid var(--border);border-radius:10px}
@media(max-width:700px){.two,.nfl-signup{grid-template-columns:1fr}.boxes{grid-template-columns:1fr 1fr}.box:last-child{grid-column:1/-1}}
</style>
${require("./lib/game-page-seo").jsonLd({sport:"NBA",url:`/nba/${slug(g)}/`,title,description:desc,startIso:g.tip_utc?new Date(g.tip_utc).toISOString().replace(".000Z","Z"):null,homeName:g.home_name,awayName:g.away_name,venue:g.venue,completed:!!(g.completed||res),modified:g.public_at||GEN||undefined,faq:FAQ})}
</head>
<body>
<nav id="nav"></nav>
<main class="mx">
  <p class="eyebrow"><a href="/nba/scoreboard/">NBA</a> &middot; ${esc(longDate(g.date))} &middot; ${esc(tip(g.tip_utc))}${g.venue ? " &middot; " + esc(g.venue) : ""}${g.early ? " &middot; <b>Early read</b>" : ""}</p>
  <h1>${esc(g.away_name)} vs ${esc(g.home_name)}: ${OCC ? esc(OCC) + " " : ""}Prediction and Odds</h1>
  ${SEO.byline(g.public_at || GEN, HOW)}
  ${(c => c && !g.public_at ? `<p class="moved">${esc(c.text)}</p>` : "")(RC.change(g, { nick: (a, n) => URLS.nick(a, n) }))}
  ${latestNote(g)}

  ${finalBlock(g, res)}
  <h2 id="pick">${esc(NA)} vs ${esc(NH)} pick</h2>
  <div class="hdr">
    <div class="tm"><img src="${logo(A)}" alt="" onerror="this.style.visibility='hidden'"><b>${esc(g.away_name)}</b><span class="p">${pct(L.p_away)}</span><span class="dim">Leo win chance</span></div>
    <div class="mid">at</div>
    <div class="tm"><img src="${logo(H)}" alt="" onerror="this.style.visibility='hidden'"><b>${esc(g.home_name)}</b><span class="p">${pct(L.p_home)}</span><span class="dim">Leo win chance</span></div>
  </div>
  <div class="boxes">
    <div class="box"><div class="l">Leo spread</div><div class="v">${esc(require("./lib/nba-why").favLine(g, LS, lbl))}</div><div class="s">Leo&rsquo;s favorite, by</div></div>
    <div class="box"><div class="l">DraftKings</div><div class="v">${mk.home_spread == null ? "&mdash;" : esc(require("./lib/nba-why").favLine(g, mk.home_spread, lbl))}</div><div class="s">Moneyline ${esc(NA)} ${am(mk.away_ml)}, ${esc(NH)} ${am(mk.home_ml)}</div></div>
    <div class="box"><div class="l">Call</div><div class="v">${esc(NM(PKS.callBox(g).value))}</div><div class="s">${esc(NM(PKS.callBox(g).sub))}</div></div>
  </div>
  ${gapTxt ? `<p class="gapread">${gapTxt}</p>` : ""}
  ${WHY.projScore(g) ? `<p class="gapread">Projected score: ${esc(NA)} ${WHY.projScore(g).away}, ${esc(NH)} ${WHY.projScore(g).home}, total ${WHY.projScore(g).total} (<a href="${HOW}#total">information only</a>).</p>` : ""}
  ${leanTxt}
  ${(() => { const P = SEASON_PICKS, k = P ? P.w + P.l : 0; return P && k ? `<p class="gapread dim">Leo Picks since Nov 2: ${P.w}-${P.l}${P.p ? "-" + P.p : ""} (${P.units > 0 ? "+" : ""}${(+P.units).toFixed(2)}u)${k < 50 ? `, an early read (${k} of 50)` : ""}. Every pick is graded in public. <a href="/nba/results/">The record</a></p>` : ""; })()}
  ${(st => st ? `<p class="stk"><b>Stat to know:</b> ${esc(st)}</p>` : "")(EX.statToKnow(g))}
  ${lede.length ? `<p class="lede">${lede.slice(0, lede.indexOf(null)).map(esc).join(" ")}</p><p class="lede2">${lede.slice(lede.indexOf(null) + 1).map(esc).join(" ")}</p>` : ""}
  <p style="margin:6px 0 0;font-size:.92rem">Every game this season: <a href="/nba/teams/${URLS.slugify(URLS.nick(g.away))}/">${esc(URLS.nick(g.away, g.away_name))} team page</a> &middot; <a href="/nba/teams/${URLS.slugify(URLS.nick(g.home))}/">${esc(URLS.nick(g.home, g.home_name))} team page</a></p>
  ${SEO.jumpBar([["pick", "Pick"], res ? ["box", "Box score"] : null, ["why", "Why"], ["injuries", "Injuries"], ["stats", "Stats"], ["form", "Form"], ["players", "Players"], ["h2h", "Head to head"], ["faq", "FAQ"]])}
  ${boxBlock(g, res)}
  ${whyBlock(g)}
  ${partsTable(g)}

  <h2 id="injuries">${esc(NA)} vs ${esc(NH)} injury report</h2>
  <p class="dim">As of Leo&rsquo;s read. <a href="${HOW}#injuries">How Leo counts injuries</a></p>
  <div class="two"><div><b>${esc(g.away_name)}</b>${injuries(g, "away")}</div><div><b>${esc(g.home_name)}</b>${injuries(g, "home")}</div></div>

  ${EX.statTable(g)}

  <h2 id="form">${esc(NA)} and ${esc(NH)} form</h2>
  <div class="two"><div><b>${esc(g.away_name)}</b>${formBlock(g, "away")}</div><div><b>${esc(g.home_name)}</b>${formBlock(g, "home")}</div></div>

  <h2 id="players">${esc(NA)} and ${esc(NH)} key players this season</h2>
  <p class="dim">Last 5: the prior five games. <a href="/nba/players/">Player Scoring</a></p>
  <div class="two"><div><b>${esc(g.away_name)}</b>${playersBlock(g, "away")}</div><div><b>${esc(g.home_name)}</b>${playersBlock(g, "home")}</div></div>

  ${EX.h2hRest(g)}

  ${require("./lib/game-page-seo").faqHtml(FAQ)}

  <div class="nfl-signup">
    <div><b>Get Leo&rsquo;s card by email</b><p>Free, before every game day.</p></div>
    <form class="lydia-signup-form" data-list="free-preview" data-thanks="You&rsquo;re on the list.">
      <input type="email" name="email" required placeholder="you@email.com" aria-label="Email address">
      <input type="hidden" name="bot-field">
      <button class="btn blue" type="submit">Send me the card</button>
    </form>
  </div>
  <p class="dim" style="margin-top:18px">Not betting advice. <a href="${HOW}">How Leo works</a> &middot; <a href="/nba/results/">Results</a></p>
${require("./lib/game-page-seo").relatedLinks({sport:"NBA",root:ROOT,slug:slug(g),away:g.away,home:g.home,teamSlug:a=>URLS.slugify(URLS.nick(a)),teamUrl:a=>"/nba/teams/"+URLS.slugify(URLS.nick(a))+"/",awayName:g.away_name,homeName:g.home_name,featured:[`/nba/predictions/${g.date}/`,`NBA predictions, ${new Date(g.date+"T12:00:00Z").toLocaleDateString("en-US",{month:"long",day:"numeric",timeZone:"UTC"})}`,"Win chance, spread and picks"],hubs:[["/nba/scoreboard/","Tonight\u2019s NBA predictions"],["/nba/games/","Every NBA game"],["/nba/teams/","NBA team predictions"],["/nba/results/","Leo\u2019s NBA record"],["/nba/tools/injury-tracker/","NBA injury tracker"],["/nba/stats/","NBA team stats"],["/membership/#free","Free card by email"]]})}
</main>
<footer id="footer"></footer><script src="/js/app.js"></script><script>renderNav("/nba/scoreboard/"); renderFooter();</script>
</body>
</html>
`;
}

const RES = results();
let GEN = null;   // the card file's generated_at, for the byline when a game has no public read time
let n = 0;
for (const date of DATES) {
  const f = path.join(DIR, `picks-${date}.json`);
  if (!fs.existsSync(f)) { console.log(`No NBA card for ${date}.`); continue; }
  const CARD = JSON.parse(fs.readFileSync(f, "utf8")); GEN = CARD.generated_at || null;
  for (const g of CARD.games) {
    if (!g.leo) continue;
    const dir = path.join(ROOT, "nba", slug(g));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), SEO.withReadTime(page(g, RES[g.game_id])));
    n++;
  }
}
console.log(`NBA matchup pages: ${n} written for ${DATES.join(", ")}.`);
// Every page writer rebuilds sitemap.xml from the pages that exist (scripts/lib/sitemap.js).
console.log(`sitemap.xml: ${require("./lib/sitemap").writeSitemap(ROOT)} pages`);
