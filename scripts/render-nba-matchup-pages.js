#!/usr/bin/env node
/**
 * One permanent page per NBA game: /nba/<away>-vs-<home>-prediction-odds-<date>/
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
const slug = g => `${g.away.toLowerCase()}-vs-${g.home.toLowerCase()}-prediction-odds-${g.date}`;
const longDate = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const tip = iso => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
const statusTxt = s => s === "day-to-day" ? "Day to day" : s ? s[0].toUpperCase() + s.slice(1) : "";

function results() {
  const f = path.join(DIR, "results.json");
  const out = {};
  if (fs.existsSync(f)) for (const g of JSON.parse(fs.readFileSync(f, "utf8")).games || []) out[g.game_id] = g;
  return out;
}

function partsTable(g) {
  const p = g.leo.parts; if (!p) return "";
  const H = esc(g.home), row = (label, v, note) => `<tr><td>${label}</td><td class="num"><b>${v == null ? "&mdash;" : (v > 0 ? "+" : "") + v.toFixed(1)}</b></td><td class="dim">${note}</td></tr>`;
  const L = g.leo;
  return `<h2>What moves Leo&rsquo;s number</h2>
  <p class="dim">Points added to ${H}&rsquo;s expected margin. Positive helps ${H}, negative helps ${esc(g.away)}.</p>
  <div class="card tbl"><table>
    ${row("Home court", p.home_court, `Average home edge, fitted on the last three seasons`)}
    ${row("Team ratings", p.ratings, `${H} rated ${sgn(L.rating && L.rating.home)}, ${esc(g.away)} ${sgn(L.rating && L.rating.away)} points against an average team`)}
    ${row("Back to back", p.back_to_back, L.back_to_back ? [L.back_to_back.home ? H + " played last night" : "", L.back_to_back.away ? esc(g.away) + " played last night" : ""].filter(Boolean).join(", ") || "Neither team played last night" : "")}
    ${row("Rest", p.rest, L.rest ? `${H} ${L.rest.home} ${L.rest.home === 1 ? "day" : "days"}, ${esc(g.away)} ${L.rest.away} ${L.rest.away === 1 ? "day" : "days"} (capped at 4)` : "")}
    ${row("Missing players", p.missing_players, `Value of regulars on the injury report: ${H} ${L.lost.home}, ${esc(g.away)} ${L.lost.away}`)}
    <tr class="total"><td>Leo&rsquo;s margin</td><td class="num"><b>${(L.home_margin > 0 ? "+" : "") + L.home_margin}</b></td><td class="dim">${L.home_margin < 0 ? esc(g.away) : H} by ${Math.abs(L.home_margin)} expected</td></tr>
  </table></div>`;
}

function injuries(g, side) {
  const c = g.context && g.context[side];
  const counted = new Map(((g.leo.missing || {})[side] || []).map(p => [p.name, p]));
  const list = c ? c.injuries : [...counted.values()].map(p => ({ name: p.name, status: p.status, detail: p.detail }));
  if (!list.length) return `<p class="dim">Nobody listed.</p>`;
  return `<ul class="inj">${list.map(p => {
    const k = counted.get(p.name);
    return `<li><b>${esc(p.name)}</b> <span class="tag">${esc(statusTxt(p.status))}</span>${p.detail ? ` <span class="dim">${esc(p.detail)}</span>` : ""}${k ? ` <span class="dim">&middot; counted, ${k.mpg} min a game</span>` : ""}</li>`;
  }).join("")}</ul>`;
}

function formBlock(g, side) {
  const c = g.context && g.context[side]; if (!c) return `<p class="dim">Not available for this read.</p>`;
  const f = c.form;
  const last = f.last5.map(x => `<li><span class="${x.won ? "ok" : "no"}">${x.won ? "W" : "L"}</span> ${x.pts}-${x.opp_pts} ${x.home ? "vs" : "at"} ${esc(x.opp)} <span class="dim">${esc(x.date.slice(5))}</span></li>`).join("");
  return `<p><b>${f.wins}-${f.losses}</b> this season &middot; ${f.ppg ?? "&mdash;"} scored, ${f.opp_ppg ?? "&mdash;"} allowed a game</p>${last ? `<ul class="last5">${last}</ul>` : ""}`;
}

function playersBlock(g, side) {
  const c = g.context && g.context[side]; if (!c || !c.players.length) return "";
  return `<div class="card tbl"><table><thead><tr><th>Player</th><th>GP</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th></tr></thead><tbody>
  ${c.players.map(p => `<tr><td>${esc(p.name)}${p.status ? ` <span class="tag">${esc(statusTxt(p.status))}</span>` : ""}</td><td>${p.gp}</td><td>${p.mpg}</td><td><b>${p.ppg}</b></td><td>${p.rpg}</td><td>${p.apg}</td></tr>`).join("")}
  </tbody></table></div>`;
}

function finalBlock(g, res) {
  if (!res) return "";
  const H = g.home, A = g.away, margin = res.home_score - res.away_score;
  const lean = res.lean_result ? `<li>Lean ${esc(res.lean_side === "home" ? H : A)} ${sgn(res.lean_line)}: <b class="${res.lean_result === "win" ? "ok" : res.lean_result === "loss" ? "no" : ""}">${esc(res.lean_result)}</b></li>` : "";
  return `<h2>Final</h2><div class="card final">
    <p class="score">${esc(A)} ${res.away_score}, ${esc(H)} ${res.home_score}</p>
    <ul>
      <li>Leo had ${esc(res.leo_p_home >= .5 ? H : A)} to win: <b class="${res.leo_winner_correct ? "ok" : "no"}">${res.leo_winner_correct ? "right" : "wrong"}</b></li>
      <li>Leo expected ${esc(H)} ${(res.leo_home_margin > 0 ? "+" : "") + res.leo_home_margin.toFixed(1)}; it finished ${(margin > 0 ? "+" : "") + margin}. Leo missed by ${Math.abs(res.leo_home_margin - margin).toFixed(1)}${res.mkt_home_spread != null ? `, the DraftKings spread by ${Math.abs(-res.mkt_home_spread - margin).toFixed(1)}` : ""}.</li>
      ${lean}
    </ul></div>`;
}

function page(g, res) {
  const L = g.leo, mk = g.market || {}, H = g.home, A = g.away;
  const title = `${nick(g.away_name)} vs ${nick(g.home_name)} Prediction and Odds, ${new Date(g.date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} | Leo`;
  const desc = `Leo gives the ${g.home_name} a ${pct(L.p_home)} chance against the ${g.away_name}. Leo's spread ${H} ${L.home_spread === 0 ? "PK" : sgn(L.home_spread)}, injury report, form and key players.`;
  const url = `https://ndhorizon.com/nba/${slug(g)}/`;
  // Plain-English read of the gap, so a winner pick and a spread lean on the
  // other team do not look like a contradiction.
  const gapTxt = (() => {
    if (mk.home_spread == null || L.home_margin == null) return "";
    const m = +L.home_margin, mm = -mk.home_spread, r = v => Math.abs(Math.round(v * 2) / 2);
    const who = v => v > 0 ? H : A, by = v => v === 0 ? "a pick'em" : `${who(v)} by ${r(v)}`;
    if (r(m) === 0 || mm === 0) return `Leo has ${by(m)}; DraftKings has ${by(mm)}.`;
    if (Math.sign(m) === Math.sign(mm)) {
      if (r(m) === r(mm)) return `Leo and DraftKings agree: ${by(m)}.`;
      return `Both expect ${esc(who(m))} to win. Leo expects ${r(m) < r(mm) ? "a closer game" : "a bigger win"} (${esc(by(m))}) than DraftKings (${esc(by(mm))}).`;
    }
    return `Leo expects ${esc(who(m))} to win (${esc(by(m))}); DraftKings has ${esc(by(mm))}.`;
  })();
  const leanTxt = L.lean ? `<div class="lean">Lean: <b>${esc(L.lean.team)} ${sgn(L.lean.line)}</b>. Leo is ${L.lean.edge_pts} points off the DraftKings spread. A tracked test, not a bet.</div>` : "";
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
<meta property="og:url" content="${url}"><meta property="og:image" content="https://ndhorizon.com/img/og-card.png">
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
.card.tbl{padding:0;overflow-x:auto}
.card table{width:100%;border-collapse:collapse;font-size:.86rem}
.card th,.card td{padding:8px 10px;border-bottom:1px solid var(--border);text-align:left}
.card th{font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim)}
.card td.num{text-align:right;white-space:nowrap}
.card tr.total td{border-bottom:0;background:var(--bg-elev)}
.tag{display:inline-block;padding:0 6px;border-radius:999px;font-size:.66rem;font-weight:800;background:var(--bg-elev);border:1px solid var(--border);color:var(--danger)}
ul.inj,ul.last5{margin:6px 0 0;padding-left:18px;font-size:.86rem;line-height:1.6}
.ok{color:var(--good);font-weight:800}.no{color:var(--danger);font-weight:800}
.final{padding:14px 16px}.final .score{font-size:1.25rem;font-weight:800;margin:0 0 6px}
.final ul{margin:0;padding-left:18px;line-height:1.6;font-size:.9rem}
.nfl-signup{display:grid;grid-template-columns:1.2fr 1fr;gap:14px;align-items:center;background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:16px 18px;margin:26px 0 6px;box-shadow:var(--shadow-sm)}
.nfl-signup p{margin:4px 0 0;color:var(--text-dim);font-size:.86rem}
.nfl-signup form{display:flex;gap:8px}.nfl-signup input[type=email]{flex:1;min-width:0;padding:10px 12px;border:1px solid var(--border);border-radius:10px}
@media(max-width:700px){.two,.nfl-signup{grid-template-columns:1fr}.boxes{grid-template-columns:1fr 1fr}.box:last-child{grid-column:1/-1}}
</style>
</head>
<body>
<nav id="nav"></nav>
<main class="mx">
  <p class="eyebrow"><a href="/nba/scoreboard/">NBA</a> &middot; ${esc(longDate(g.date))} &middot; ${esc(tip(g.tip_utc))}${g.venue ? " &middot; " + esc(g.venue) : ""}</p>
  <h1>${esc(g.away_name)} vs ${esc(g.home_name)}: Prediction and Odds</h1>
  <p class="dim">Leo&rsquo;s read, frozen before tip. ${esc(A)} at ${esc(H)}.</p>

  <div class="hdr">
    <div class="tm"><img src="${logo(A)}" alt="" onerror="this.style.visibility='hidden'"><b>${esc(g.away_name)}</b><span class="p">${pct(L.p_away)}</span><span class="dim">Leo win chance</span></div>
    <div class="mid">at</div>
    <div class="tm"><img src="${logo(H)}" alt="" onerror="this.style.visibility='hidden'"><b>${esc(g.home_name)}</b><span class="p">${pct(L.p_home)}</span><span class="dim">Leo win chance</span></div>
  </div>
  <div class="boxes">
    <div class="box"><div class="l">Leo spread</div><div class="v">${esc(H)} ${L.home_spread === 0 ? "PK" : sgn(L.home_spread)}</div><div class="s">Expected margin</div></div>
    <div class="box"><div class="l">DraftKings</div><div class="v">${mk.home_spread == null ? "&mdash;" : esc(H) + " " + sgn(mk.home_spread)}</div><div class="s">Moneyline ${esc(A)} ${am(mk.away_ml)}, ${esc(H)} ${am(mk.home_ml)}</div></div>
    <div class="box"><div class="l">Gap</div><div class="v">${L.edge_pts == null ? "&mdash;" : Math.abs(L.edge_pts).toFixed(1) + " pts"}</div><div class="s">${L.edge_pts == null ? "No line yet" : "Between Leo and DraftKings"}</div></div>
  </div>
  ${gapTxt ? `<p class="gapread">${gapTxt}</p>` : ""}
  ${leanTxt}
  ${finalBlock(g, res)}
  ${partsTable(g)}

  <h2>Injury report</h2>
  <p class="dim">As of Leo&rsquo;s read. &ldquo;Counted&rdquo; means Leo lowered the team&rsquo;s number for that player: fully when out, 40% when day to day.</p>
  <div class="two"><div><b>${esc(g.away_name)}</b>${injuries(g, "away")}</div><div><b>${esc(g.home_name)}</b>${injuries(g, "home")}</div></div>

  <h2>Form</h2>
  <div class="two"><div><b>${esc(g.away_name)}</b>${formBlock(g, "away")}</div><div><b>${esc(g.home_name)}</b>${formBlock(g, "home")}</div></div>

  <h2>Key players this season</h2>
  <div class="two"><div><b>${esc(g.away_name)}</b>${playersBlock(g, "away")}</div><div><b>${esc(g.home_name)}</b>${playersBlock(g, "home")}</div></div>

  <div class="nfl-signup">
    <div><b>Get Leo&rsquo;s card by email</b><p>Leo&rsquo;s reads before every game day. Free. Unsubscribe anytime.</p></div>
    <form class="lydia-signup-form" data-list="free-preview" data-thanks="You&rsquo;re on the list.">
      <input type="email" name="email" required placeholder="you@email.com" aria-label="Email address">
      <input type="hidden" name="bot-field">
      <button class="btn blue" type="submit">Send me the card</button>
    </form>
  </div>
  <p class="dim" style="margin-top:18px">Leo&rsquo;s win chance and spread come from team results, rest and the injury report. The DraftKings line is shown for comparison and is never an input. Every read is graded on the <a href="/nba/results/">results page</a>. Analysis only, not betting advice. 21+.</p>
</main>
<footer id="footer"></footer><script src="/js/app.js"></script><script>renderNav("/nba/scoreboard/"); renderFooter();</script>
</body>
</html>
`;
}

const RES = results();
let n = 0;
for (const date of DATES) {
  const f = path.join(DIR, `picks-${date}.json`);
  if (!fs.existsSync(f)) { console.log(`No NBA card for ${date}.`); continue; }
  for (const g of JSON.parse(fs.readFileSync(f, "utf8")).games) {
    if (!g.leo) continue;
    const dir = path.join(ROOT, "nba", slug(g));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), page(g, RES[g.game_id]));
    n++;
  }
}
console.log(`NBA matchup pages: ${n} written for ${DATES.join(", ")}.`);
