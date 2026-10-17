#!/usr/bin/env node
/**
 * Leo's NFL weekly card: one page with every game of a week.
 *
 *   /nfl/week/                      the current week (latest week with data)
 *   /nfl/week/<season>-week-<n>/    a permanent page per week
 *
 *   node scripts/generate-nfl-week-card.js [YYYY-MM-DD]
 *
 * Built only from data/nfl/matchups/<date>.json (the frozen pre-kickoff reads
 * the matchup pages show) and data/nfl/tracker.json (the graded record), so it
 * can never show a number the game pages do not. render-nfl-matchup-pages.js
 * calls build() after every render, which keeps it current through the
 * prepare, publish and grade runs without a workflow change.
 *
 * Per game: kickoff, Leo's win chance (information only; winner picks were
 * retired 2026-10-17), Leo's projected total, the two most likely touchdown
 * scorers, and the final score once it is in.
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const TEAMS = require("./lib/nfl-teams");
const { GA_HEAD } = require("./lib/ga");

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = p => p == null ? "" : `${Math.round(p * 100)}%`;
function clock(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  if (!Number.isFinite(h)) return "";
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, "0")}${h < 12 ? "am" : "pm"} ET`;
}
const dayLabel = d => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

function loadWeek(targetDate) {
  const dir = path.join(ROOT, "data/nfl/matchups");
  const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const read = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { return []; } };
  const target = read(`${targetDate}.json`);
  if (!target.length) return null;
  const week = String(target[0].week), season = targetDate.slice(0, 4);
  // Same season: September to February.
  const sameSeason = f => { const d = f.slice(0, 10); const y = +d.slice(0, 4), mo = +d.slice(5, 7);
    const s = mo >= 3 ? y : y - 1; return String(s) === (+targetDate.slice(5, 7) >= 3 ? season : String(+season - 1)); };
  const games = [];
  let latestWeek = 0;
  for (const f of files.filter(sameSeason)) {
    for (const m of read(f)) {
      latestWeek = Math.max(latestWeek, Number(m.week) || 0);
      if (String(m.week) === week) games.push(m);
    }
  }
  games.sort((a, b) => a.date.localeCompare(b.date) || String(a.kickoff).localeCompare(String(b.kickoff)));
  const seasonYear = +targetDate.slice(5, 7) >= 3 ? season : String(+season - 1);
  return { week, season: seasonYear, games, isLatest: Number(week) >= latestWeek };
}

function record() {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(ROOT, "data/nfl/tracker.json"), "utf8"));
    const s = t.summary || {}, v2 = s.moneyline_v2 || s.moneyline, pr = s.props && s.props.all;
    return { v2, props: pr, through: t.through };
  } catch (e) { return null; }
}

function gameCard(m) {
  const g = m.leo && m.leo.game, F = m.final_report;
  const T = m.td_props || {};
  const top = [...(T[m.away] || []), ...(T[m.home] || [])].filter(x => x.prob != null)
    .sort((a, b) => b.prob - a.prob).slice(0, 2);
  const scored = F && F.td_scored || null;
  const tdTag = x => !scored ? "" : ((scored[x.player] || 0) > 0 ? ' <span class="ok">scored</span>' : ' <span class="no">no TD</span>');
  // Win chance only. Winner picks were retired on 2026-10-17 (DEC-20261017-06).
  const winner = g ? `${esc(TEAMS.nick(g.pick))} ${pct(g.prob)}` : '<span class="dim">No pre-game read</span>';
  const final = F && F.away_score != null
    ? `<div class="wk-final">Final: ${esc(m.away)} ${F.away_score}, ${esc(m.home)} ${F.home_score}</div>` : "";
  return `<article class="wk-game">
    <div class="wk-when">${esc(dayLabel(m.date))} &middot; ${esc(clock(m.kickoff))}${m.stadium ? " &middot; " + esc(m.stadium) : ""}</div>
    <a class="wk-teams" href="${esc(m.url)}">
      <img src="/img/nfl/${encodeURIComponent(m.away)}.png" alt="" loading="lazy"><span>${esc(TEAMS.full(m.away))}</span>
      <span class="at">at</span>
      <img src="/img/nfl/${encodeURIComponent(m.home)}.png" alt="" loading="lazy"><span>${esc(TEAMS.full(m.home))}</span>
    </a>
    <dl class="wk-read">
      <dt>Win chance</dt><dd>${winner}</dd>
      <dt>Leo total</dt><dd>${g && g.proj_total != null ? `${esc(g.proj_total)} points <span class="dim">(line ${esc(m.total_line ?? "n/a")})</span>` : '<span class="dim">n/a</span>'}</dd>
      <dt>Most likely TD</dt><dd>${top.length ? top.map(x => `${esc(x.player)} <span class="dim">${esc(x.team)} ${pct(x.prob)}</span>${tdTag(x)}`).join("<br>") : '<span class="dim">n/a</span>'}</dd>
    </dl>
    ${final}
    <a class="wk-more" href="${esc(m.url)}">Full matchup, injuries and props &rarr;</a>
  </article>`;
}

function page({ week, season, games }, rec, canonical) {
  const title = `NFL Week ${week} Predictions ${season}: Every Game, Win Chances and Touchdown Scorers | Leo`;
  const desc = `Leo's NFL Week ${week} ${season} card: a win chance and projected total for all ${games.length} games, plus the two most likely touchdown scorers in each, frozen before kickoff and graded after.`;
  const recLine = rec && rec.props && rec.props.decided
    ? `Prop calls this season: <b>${rec.props.w}-${rec.props.l}</b> &middot; <a href="/nfl/results/">full record</a>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
${GA_HEAD}
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="https://ndhorizon.com${canonical}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Leo">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="https://ndhorizon.com${canonical}">
<meta property="og:image" content="https://ndhorizon.com/img/og-card.png">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>&#127944;</text></svg>">
<link rel="stylesheet" href="/css/style.css">
<link rel="stylesheet" href="/css/scoreboard.css">
<style>
.wk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin-top:16px}
.wk-game{background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:14px 16px;box-shadow:var(--shadow-sm);display:flex;flex-direction:column;gap:8px}
.wk-when{color:var(--text-dim);font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.wk-teams{display:grid;grid-template-columns:28px 1fr;gap:4px 8px;align-items:center;font-weight:800;color:var(--text)}
.wk-teams img{width:28px;height:28px;object-fit:contain}
.wk-teams .at{grid-column:2;color:var(--text-dim);font-size:.72rem;font-weight:700;text-transform:uppercase}
.wk-read{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;margin:0;font-size:.9rem}
.wk-read dt{color:var(--text-dim);font-weight:700;font-size:.76rem;text-transform:uppercase;letter-spacing:.04em;padding-top:2px}
.wk-read dd{margin:0}
.wk-final{font-weight:800}
.wk-more{font-size:.86rem;font-weight:700;margin-top:auto}
.ok{color:var(--good);font-weight:800}.no{color:var(--danger);font-weight:800}.dim{color:var(--text-dim)}
.wk-rec{margin:8px 0 0}
.nfl-signup{display:grid;grid-template-columns:1.2fr 1fr;gap:14px;align-items:center;background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:16px 18px;margin:22px 0 4px;box-shadow:var(--shadow-sm)}
.nfl-signup p{margin:4px 0 0;color:var(--text-dim);font-size:.86rem}
.nfl-signup form{display:flex;gap:8px}.nfl-signup input[type=email]{flex:1;min-width:0}
@media (max-width:640px){.nfl-signup{grid-template-columns:1fr}.wk-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<nav id="nav"></nav>
<main class="scoreboard-shell">
  <section class="score-hero">
    <p class="eyebrow">NFL ${esc(season)} &middot; Week ${esc(week)}</p>
    <h1>Leo&rsquo;s Week ${esc(week)} card</h1>
    <p class="subtitle">Every game this week: each team&rsquo;s chance to win, Leo&rsquo;s projected total, and the two players most likely to score a touchdown. Every number is frozen before kickoff and graded after the game.</p>
    ${recLine ? `<p class="wk-rec small">${recLine}</p>` : ""}
  </section>

  <div class="notice note">How to read it: the <b>win chance</b> is how often Leo expects that team to win. It is information, not a pick. Leo&rsquo;s top touchdown pick in a game scored 47% of the time in 2023 to 2025, so treat these as chances, not promises. Leo&rsquo;s total is a projection with no over or under call. Nothing here is betting advice.</div>

  <div class="nfl-signup">
    <div><b>Get this card by email</b><p>Free, before kickoff on game days. Unsubscribe anytime.</p></div>
    <form class="lydia-signup-form" data-list="free-preview" data-thanks="You&rsquo;re on the list. The next NFL card goes to that inbox.">
      <input type="email" name="email" required placeholder="you@email.com" aria-label="Email address">
      <input type="hidden" name="bot-field">
      <button class="btn blue" type="submit">Send me the card</button>
    </form>
  </div>

  <section class="wk-grid">
${games.map(gameCard).join("\n")}
  </section>

  <p class="data-note">Player and team statistics from the open nflverse dataset. For entertainment and information only. 21+. If you or someone you know has a gambling problem, call 1-800-MY-RESET.</p>
</main>
<footer id="footer"></footer><script src="/js/app.js"></script>
<script>renderNav("/nfl/scoreboard/"); renderFooter();</script>
</body>
</html>`;
}

function build(targetDate) {
  const wk = loadWeek(targetDate);
  if (!wk || !wk.games.length) { console.log(`  week card: no matchup data for ${targetDate}`); return null; }
  const rec = record();
  const slug = `${wk.season}-week-${wk.week}`;
  const dir = path.join(ROOT, "nfl/week", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), page(wk, rec, `/nfl/week/${slug}/`));
  if (wk.isLatest) fs.writeFileSync(path.join(ROOT, "nfl/week/index.html"), page(wk, rec, "/nfl/week/"));
  console.log(`  week card: Week ${wk.week} (${wk.games.length} games) -> /nfl/week/${slug}/${wk.isLatest ? " and /nfl/week/" : ""}`);
  return slug;
}

if (require.main === module) {
  build(process.argv[2] || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }));
}
module.exports = { build };
