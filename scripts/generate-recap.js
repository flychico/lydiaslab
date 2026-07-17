#!/usr/bin/env node
/*
  LyDia true-game daily recap generator.
  Uses official MLB schedule, linescore, boxscore and play-by-play data.
  Usage: node scripts/generate-recap.js [YYYY-MM-DD]
*/
const fs = require("fs");
const path = require("path");

const SITE = "https://lydiaslab.com";
const ROOT = path.join(__dirname, "..");
const RECAP_DIR = path.join(ROOT, "recaps");

function etYesterday() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  et.setDate(et.getDate() - 1);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}

const DATE = process.argv[2] || etYesterday();
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) { console.error("Bad date arg:", DATE); process.exit(1); }

function niceDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" });
}
function esc(s) {
  const map = { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" };
  return String(s ?? "").replace(/[&<>"']/g, c => map[c]);
}
function teamShort(name) {
  const two = ["Red Sox", "White Sox", "Blue Jays"].find(x => String(name).endsWith(x));
  if (two) return two;
  const parts = String(name || "").split(" ");
  return parts[parts.length - 1] || name;
}
function ordinal(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;
}
function ipNum(ip) {
  if (ip === undefined || ip === null || ip === "-.--") return 0;
  const [whole, frac] = String(ip).split(".");
  return Number(whole || 0) + Number(frac || 0) / 3;
}
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
function gameFacts(g) {
  const a = g.teams.away, h = g.teams.home;
  const winner = a.score > h.score ? a : h;
  const loser = winner === a ? h : a;
  const winnerSide = winner === a ? "away" : "home";
  const loserSide = winnerSide === "away" ? "home" : "away";
  const margin = winner.score - loser.score;
  const ls = g.linescore || {};
  const innings = ls.currentInning || 9;
  const bigInnings = [];
  for (const inn of ls.innings || []) {
    const runs = inn[winnerSide] && inn[winnerSide].runs;
    if (typeof runs === "number" && runs >= 3) bigInnings.push({ runs, inning: inn.num || Number(String(inn.ordinalNum || "").replace(/\D/g, "")) || 0, ord: inn.ordinalNum || "" });
  }
  bigInnings.sort((x, y) => y.runs - x.runs || y.inning - x.inning);
  return { a, h, winner, loser, winnerSide, loserSide, margin, innings, bigInning: bigInnings[0] || null };
}
function playerList(boxSide) {
  return Object.values((boxSide && boxSide.players) || {}).filter(Boolean);
}
function pitchingLine(player) {
  const st = player && player.stats && player.stats.pitching;
  if (!st) return null;
  return {
    name: player.person && player.person.fullName ? player.person.fullName : "Unknown pitcher",
    ip: ipNum(st.inningsPitched),
    ipText: st.inningsPitched || "0.0",
    hits: Number(st.hits || 0),
    er: Number(st.earnedRuns || 0),
    so: Number(st.strikeOuts || 0),
    pitches: Number(st.numberOfPitches || 0)
  };
}
function battingLine(player) {
  const st = player && player.stats && player.stats.batting;
  if (!st) return null;
  return {
    name: player.person && player.person.fullName ? player.person.fullName : "Unknown hitter",
    hits: Number(st.hits || 0),
    hr: Number(st.homeRuns || 0),
    rbi: Number(st.rbi || 0),
    runs: Number(st.runs || 0),
    totalBases: Number(st.totalBases || 0)
  };
}
function bestStarter(boxSide) {
  const ids = (boxSide && boxSide.pitchers) || [];
  const players = (boxSide && boxSide.players) || {};
  const lines = ids.map(id => pitchingLine(players[`ID${id}`])).filter(Boolean).filter(p => p.ip >= 4);
  lines.sort((a, b) => (b.ip * 6 + b.so - b.er * 5 - b.hits) - (a.ip * 6 + a.so - a.er * 5 - a.hits));
  return lines[0] || null;
}
function topHitter(boxSide) {
  const lines = playerList(boxSide).map(battingLine).filter(Boolean);
  lines.sort((a, b) => (b.hr * 8 + b.rbi * 3 + b.hits + b.totalBases) - (a.hr * 8 + a.rbi * 3 + a.hits + a.totalBases));
  const top = lines[0];
  if (!top || (top.hr === 0 && top.rbi < 3 && top.hits < 3)) return null;
  return top;
}
function scoringPlays(feed) {
  const all = (((feed || {}).liveData || {}).plays || {}).allPlays || [];
  return all.filter(p => p.about && p.about.isScoringPlay);
}
function grandSlamForWinner(feed, winnerName) {
  for (const p of scoringPlays(feed)) {
    const result = p.result || {};
    const batter = p.matchup && p.matchup.batter && p.matchup.batter.fullName;
    const desc = String(result.description || "");
    const rbi = Number(result.rbi || 0);
    const homeScore = Number(result.homeScore || 0);
    const awayScore = Number(result.awayScore || 0);
    const winningTeamIsHome = (((feed || {}).gameData || {}).teams || {}).home && feed.gameData.teams.home.name === winnerName;
    const winnerScoredThisPlay = winningTeamIsHome ? p.about.halfInning === "bottom" : p.about.halfInning === "top";
    const winnerWasAheadOrTiedAfterPlay = winningTeamIsHome ? homeScore >= awayScore : awayScore >= homeScore;
    if ((result.eventType === "home_run" || /home run/i.test(desc)) && rbi >= 4 && winnerScoredThisPlay && winnerWasAheadOrTiedAfterPlay) {
      return { batter: batter || "A hitter", inning: p.about.inning || null, description: desc };
    }
  }
  return null;
}
function walkoffInfo(feed, winnerSide) {
  if (winnerSide !== "home") return null;
  const plays = scoringPlays(feed);
  for (let i = plays.length - 1; i >= 0; i--) {
    const p = plays[i];
    const result = p.result || {};
    if (p.about && p.about.halfInning === "bottom" && Number(p.about.inning || 0) >= 9 && Number(result.homeScore || 0) > Number(result.awayScore || 0)) {
      return { inning: Number(p.about.inning), description: result.description || "" };
    }
  }
  return null;
}
function describeStarter(p) {
  if (!p) return "";
  if (p.ip >= 7 && p.hits === 0 && p.er === 0) return `${p.name} was dominant, working ${p.ipText} scoreless innings without allowing a hit and striking out ${p.so}.`;
  if (p.ip >= 7 && p.er === 0) return `${p.name} controlled the game with ${p.ipText} scoreless innings, ${p.hits} hit${p.hits === 1 ? "" : "s"} allowed and ${p.so} strikeout${p.so === 1 ? "" : "s"}.`;
  if (p.ip >= 6 && p.er <= 1) return `${p.name} delivered ${p.ipText} strong innings, allowing ${p.er} earned run${p.er === 1 ? "" : "s"} with ${p.so} strikeout${p.so === 1 ? "" : "s"}.`;
  if (p.so >= 10) return `${p.name} overpowered the lineup with ${p.so} strikeouts across ${p.ipText} innings.`;
  return "";
}
function describeHitter(h) {
  if (!h) return "";
  if (h.hr >= 2) return `${h.name} powered the offense with ${h.hr} home runs and ${h.rbi} RBI.`;
  if (h.rbi >= 4) return `${h.name} drove in ${h.rbi} runs to lead the offense.`;
  if (h.hr >= 1 && h.rbi >= 3) return `${h.name} homered and drove in ${h.rbi} runs.`;
  if (h.hits >= 3) return `${h.name} collected ${h.hits} hits in the win.`;
  return "";
}
function buildGameStory(g, feed) {
  const facts = gameFacts(g);
  const box = (((feed || {}).liveData || {}).boxscore || {}).teams || {};
  const winnerBox = box[facts.winnerSide] || {};
  const starter = bestStarter(winnerBox);
  const hitter = topHitter(winnerBox);
  const grandSlam = grandSlamForWinner(feed, facts.winner.team.name);
  const walkoff = walkoffInfo(feed, facts.winnerSide);
  const big = facts.bigInning;
  const lateRally = big && big.inning >= 7 && big.runs >= 3 ? big : null;
  const winnerShort = teamShort(facts.winner.team.name);
  const loserShort = teamShort(facts.loser.team.name);

  let headline = `${winnerShort} beat ${loserShort} ${facts.winner.score}-${facts.loser.score}`;
  if (starter && starter.ip >= 7 && starter.hits === 0 && starter.er === 0) headline = `${starter.name} dominates as ${winnerShort} shut down ${loserShort}`;
  else if (grandSlam) headline = `${grandSlam.batter} grand slam powers ${winnerShort} past ${loserShort}`;
  else if (walkoff) headline = `${winnerShort} walk off ${loserShort} in the ${ordinal(walkoff.inning)}`;
  else if (lateRally) headline = `${winnerShort} erupt for ${lateRally.runs} runs in the ${ordinal(lateRally.inning)} to beat ${loserShort}`;
  else if (starter && (starter.ip >= 7 || starter.so >= 10 || (starter.ip >= 6 && starter.er <= 1))) headline = `${starter.name} leads ${winnerShort} past ${loserShort}`;
  else if (hitter && (hitter.hr >= 2 || hitter.rbi >= 4)) headline = `${hitter.name} powers ${winnerShort} past ${loserShort}`;

  const sentences = [];
  sentences.push(`The ${winnerShort} defeated the ${loserShort} ${facts.winner.score}-${facts.loser.score}${facts.winnerSide === "away" ? " on the road" : " at home"}${facts.innings > 9 ? ` in ${facts.innings} innings` : ""}.`);
  if (grandSlam) sentences.push(`${grandSlam.batter} delivered the biggest swing with a grand slam${grandSlam.inning ? ` in the ${ordinal(grandSlam.inning)}` : ""}.`);
  else if (walkoff && walkoff.description) sentences.push(walkoff.description.replace(/\s+/g, " ").trim());
  else if (lateRally) sentences.push(`A ${lateRally.runs}-run ${ordinal(lateRally.inning)} inning turned the game and created the decisive separation.`);

  const starterText = describeStarter(starter);
  if (starterText) sentences.push(starterText);
  const hitterText = describeHitter(hitter);
  if (hitterText && !grandSlam) sentences.push(hitterText);
  if (!starterText && !hitterText && big && !lateRally) sentences.push(`A ${big.runs}-run ${ordinal(big.inning)} inning provided the biggest offensive burst of the game.`);

  const wr = facts.winner.leagueRecord, lr = facts.loser.leagueRecord;
  if (wr && lr) sentences.push(`The win moves the ${winnerShort} to ${wr.wins}-${wr.losses}, while the ${loserShort} fall to ${lr.wins}-${lr.losses}.`);

  return { ...facts, headline, paragraph: sentences.join(" "), starter, hitter };
}
function pageShell(title, desc, body, canonical = `${SITE}/recaps/${DATE}.html`) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
<link rel="stylesheet" href="/css/style.css">
<style>
.recap-game{border-left:3px solid var(--accent2);padding-left:14px;margin:24px 0}.recap-game h2{margin:0 0 6px;font-size:1.18rem}.recap-game .score{font-weight:800;margin-bottom:6px}.recap-game p{color:var(--text);font-size:.96rem;margin-top:4px;line-height:1.6}.roundup{font-size:1.02rem;margin-bottom:10px}.archive-list a{display:block;padding:10px 0;border-bottom:1px solid var(--border)}.highlights{margin:18px 0}.highlights li{margin:6px 0}
</style>
</head>
<body>
<nav id="nav"></nav>
<main>${body}</main>
<footer id="footer"></footer>
<script src="/js/app.js"></script><script>renderNav("/recaps/"); renderFooter();</script>
</body>
</html>`;
}

async function main() {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}&hydrate=linescore`;
  const sched = await fetchJson(url);
  const games = (((sched.dates || [])[0]) || {}).games || [];
  const finals = games.filter(g => g.status && g.status.abstractGameState === "Final" && g.teams.away.score !== undefined);
  if (!finals.length) { console.log(`No completed games for ${DATE}. Nothing to publish.`); return; }

  const stories = [];
  for (const game of finals) {
    let feed = null;
    try { feed = await fetchJson(`https://statsapi.mlb.com/api/v1.1/game/${game.gamePk}/feed/live`); }
    catch (err) { console.warn(`Could not load detailed feed for ${game.gamePk}: ${err.message}`); }
    stories.push(buildGameStory(game, feed));
  }

  const nice = niceDate(DATE);
  const totalRuns = stories.reduce((s, f) => s + f.winner.score + f.loser.score, 0);
  const close = stories.filter(f => f.margin === 1).length;
  const extras = stories.filter(f => f.innings > 9).length;
  const intro = `${finals.length} MLB games went final on ${nice}, producing ${totalRuns} total runs. ${close ? `${close} game${close === 1 ? " was" : "s were"} decided by one run.` : "No games were decided by one run."}${extras ? ` ${extras} game${extras === 1 ? " went" : "s went"} to extra innings.` : ""}`;
  const topHighlights = stories.slice().sort((a, b) => {
    const score = s => (s.starter && s.starter.ip >= 7 ? 4 : 0) + (s.hitter && (s.hitter.hr >= 2 || s.hitter.rbi >= 4) ? 3 : 0) + (s.bigInning && s.bigInning.inning >= 7 ? 2 : 0) + s.margin / 20;
    return score(b) - score(a);
  }).slice(0, 3);

  let body = `<h1>MLB Recap | ${esc(nice)}</h1>\n<p class="roundup">${esc(intro)}</p>\n`;
  if (topHighlights.length) {
    body += `<div class="card highlights"><h2 style="margin-top:0">Top stories from the day</h2><ul>${topHighlights.map(s => `<li><strong>${esc(s.headline)}</strong></li>`).join("")}</ul></div>`;
  }
  for (const story of stories) {
    const score = `${teamShort(story.a.team.name)} ${story.a.score}, ${teamShort(story.h.team.name)} ${story.h.score}`;
    body += `<article class="recap-game"><h2>${esc(story.headline)}</h2><div class="score">${esc(score)}</div><p>${esc(story.paragraph)}</p></article>\n`;
  }
  body += `<p class="dim small">Generated from official MLB game data. <a href="/recaps/">All recaps</a> · <a href="/picks/">Today's model picks</a></p>`;

  fs.mkdirSync(RECAP_DIR, { recursive: true });
  const outFile = path.join(RECAP_DIR, `${DATE}.html`);
  const desc = `${stories[0].headline}. ${stories[1] ? stories[1].headline + ". " : ""}${finals.length} MLB games recapped for ${nice}.`;
  fs.writeFileSync(outFile, pageShell(`MLB Recap ${nice}: key performances, rallies and final scores | LyDia`, desc, body));
  console.log("wrote", path.relative(ROOT, outFile));

  const posts = fs.readdirSync(RECAP_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).sort().reverse();
  const list = posts.map(f => {
    const d = f.replace(".html", "");
    return `<a href="/recaps/${f}">MLB Recap | ${esc(niceDate(d))}</a>`;
  }).join("\n");
  fs.writeFileSync(path.join(RECAP_DIR, "index.html"), pageShell(
    "Daily MLB Recaps: game stories, key performers and late rallies | LyDia",
    "Daily MLB recaps covering the performances, rallies, pitching gems, home runs and moments that actually decided each game.",
    `<h1>Daily MLB Recaps</h1>\n<p class="subtitle">Not just final scores. The performances, rallies, pitching gems, home runs, and moments that decided each game.</p>\n<div class="card archive-list">\n${list}\n</div>`,
    `${SITE}/recaps/`));

  const staticPages = ["", "dashboard/", "picks/", "previews/", "results/", "tools/", "stats/", "recaps/", "articles/", "membership/", "member-brief/", "how-to-bet-on-mlb/", "mlb-betting-edge-explained/", "no-vig-odds-calculator-guide/", "how-to-find-value-in-mlb-moneylines/", "closing-line-value-mlb-betting/", "mlb-run-line-vs-moneyline/", "mlb-bullpen-fatigue-betting/", "mlb-park-factors-betting-guide/", "mlb-pitching-metrics-for-betting/", "tools/offense-matchups/", "tools/pitcher-matchups/", "tools/bullpen-fatigue/", "tools/strikeout-projections/"];
  const previewDir = path.join(ROOT, "previews");
  const previewPosts = fs.existsSync(previewDir) ? fs.readdirSync(previewDir).filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).sort().reverse().map(f => `previews/${f}`) : [];
  const urls = staticPages.map(p => `${SITE}/${p}`).concat(posts.map(f => `${SITE}/recaps/${f}`)).concat(previewPosts.map(p => `${SITE}/${p}`));
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` + [...new Set(urls)].map(u => `  <url><loc>${u}</loc></url>`).join("\n") + `\n</urlset>\n`;
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), sitemap);
  console.log("wrote recaps/index.html and sitemap.xml");
}

main().catch(e => { console.error(e); process.exit(1); });
