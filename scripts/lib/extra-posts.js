/**
 * Extra X posts for NBA and NFL (Lynold, 2026-11-20: "how many nba games did we have
 * tonight ? how many tweets did you provide for me to tweet ? how is this helping us
 * grow faster?", then chose all four). DEC-20261120-04. Shared (Manager's file);
 * scripts/build-nba-social.js and scripts/build-nfl-social.js call it.
 *
 *   reads      every game: Leo's winner and chance ("Thunder over Pelicans (84%)")
 *   upset      Leo's winner is the market's underdog, or a coin flip (under 53%)
 *   g1..g3     spotlight: one game each, Leo's chance and the biggest reason, with that game page
 *   rday       after every game is graded: Leo's winner in every game, right or wrong
 *
 * These are READS, never picks: no price, no record beyond "Leo had X of Y winners",
 * and the graphic says "Leo's reads", never "picks". The Leo Pick and the NFL calls
 * stay the only graded calls. Numbers only from the files; no dashes, no exclamation
 * marks, no "bet", "lock" or sportsbook name. kind "reads" (sent once, see
 * scripts/send-x-posts.js); the results post is kind "results".
 *
 * game: {id, away, home (nicknames), awayCode, homeCode, tip (ISO), p_home,
 *        mlHome, mlAway (market moneylines, only to say "underdog"), url, why, strength}
 */
"use strict";
const pct = p => `${Math.round(p * 100)}%`;
const side = g => g.p_home >= 0.5 ? "home" : "away";
const fav = g => side(g) === "home" ? { team: g.home, opp: g.away, code: g.homeCode, p: g.p_home, at: "vs" } : { team: g.away, opp: g.home, code: g.awayCode, p: 1 - g.p_home, at: "at" };
const bare = u => String(u).replace(/^https?:\/\//, "");
function isDog(g) {
  const s = side(g), mine = s === "home" ? g.mlHome : g.mlAway, other = s === "home" ? g.mlAway : g.mlHome;
  return Number.isFinite(+mine) && Number.isFinite(+other) && mine !== "" && other !== "" && +mine > 0 && +other < 0;
}
const compose = (title, sub, lines, link, tags) => tail([title, sub, "", ...lines.map(l => `• ${l}`)], link, tags);

function readsPost({ sport, emoji, dayTitle, games, link, tags, now }) {
  if (!games.length) return null;
  const rows = games.map(g => ({ g, f: fav(g) })).sort((a, b) => b.f.p - a.f.p);
  const lines = rows.map(({ f }) => `${f.team} over ${f.opp} (${pct(f.p)})`);
  const title = `${dayTitle}: LEO'S READS ${emoji}`;
  return { id: "reads", kind: "reads", hero: "Leo's reads", created_at: now, tip_utc: games.map(g => g.tip).sort()[0],
    header: title, lines, record: "", facts: [], hashtags: tags(rows.slice(0, 3).map(r => r.f.code)),
    text: compose(title, sport === "nfl" ? "Who Leo has winning every game" : "Who Leo has winning every game tonight", lines, link, tags(rows.slice(0, 3).map(r => r.f.code))), link };
}

function upsetPost({ emoji, dayTitle, games, link, tags, now }) {
  const dogs = games.filter(isDog), flips = games.filter(g => !isDog(g) && fav(g).p < 0.53);
  if (!dogs.length && !flips.length) return null;
  const lines = [...dogs, ...flips].map(g => { const f = fav(g); return `${f.team} ${f.at} ${f.opp} (${pct(f.p)})`; });
  const sub = dogs.length && flips.length ? "Leo likes the underdog, or calls it a coin flip"
    : dogs.length ? (dogs.length === 1 ? "Leo has the underdog winning" : "Leo has the underdogs winning") : "Too close to call";
  const title = `${dayTitle}: UPSET WATCH ${emoji}`;
  const codes = [...dogs, ...flips].map(g => fav(g).code);
  return { id: "upset", kind: "reads", hero: "Upset watch", note: sub, created_at: now, tip_utc: [...dogs, ...flips].map(g => g.tip).sort()[0],
    header: title, lines, record: "", facts: [], hashtags: tags(codes), text: compose(title, sub, lines, link, tags(codes)), link };
}

/** Up to n spotlight posts: the strongest matchup, then the closest games, skipping upset-watch games. */
function spotlightPosts({ emoji, games, n = 3, tags, linkFor, now }) {
  if (games.length < 2) return [];
  const upset = new Set(games.filter(g => isDog(g) || fav(g).p < 0.53).map(g => g.id));
  const pool = games.filter(g => !upset.has(g.id) && g.why);
  const chosen = [];
  const best = pool.slice().sort((a, b) => (b.strength || 0) - (a.strength || 0))[0];
  if (best) chosen.push(best);
  const want = Math.min(n, games.length >= 7 ? 3 : games.length >= 4 ? 2 : 1);
  for (const g of pool.slice().sort((a, b) => fav(a).p - fav(b).p)) { if (chosen.length >= want) break; if (!chosen.includes(g)) chosen.push(g); }
  return chosen.map((g, i) => {
    const f = fav(g), id = `g${i + 1}`, link = linkFor(g, id);
    const title = `${g.away} at ${g.home} ${emoji}`;
    const line = `${f.team} to win (${pct(f.p)})`;
    return { id, kind: "reads", hero: "Leo's read", created_at: now, tip_utc: g.tip, game_id: g.id,
      header: title, lines: [line], record: "", facts: [g.why], hashtags: tags([g.awayCode, g.homeCode]),
      text: tail([title, `Leo has the ${f.team} at ${pct(f.p)}.`, g.why], link, tags([g.awayCode, g.homeCode])), link };
  });
}

/** results: [{leo, opp, code, right, my, their, beatMarket}] in start order. Leo's team is written first with the
 * final score, so a miss reads plainly ("❌ Pistons 102, Raptors 105"), not as if Leo's team won (Lynold, Nov 21). */
function readsResultsPost({ emoji, dayTitle, results, link, tags, now }) {
  if (!results.length) return null;
  const right = results.filter(r => r.right).length;
  const sorted = [...results.filter(r => r.right), ...results.filter(r => !r.right)];
  const line = r => Number.isFinite(r.my) && Number.isFinite(r.their) ? `${r.right ? "✅" : "❌"} ${r.leo} ${r.my}, ${r.opp} ${r.their}` : `${r.right ? "✅" : "❌"} ${r.leo} over ${r.opp}`;
  const lines = sorted.map(line);
  const upsets = sorted.filter(r => r.right && r.beatMarket).map(r => r.leo);
  const title = `${dayTitle}: LEO'S READS ${emoji}`;
  const rec = `Leo had ${right} of ${results.length} winners`;
  const call = upsets.length ? `Called the ${upsets.join(" and ")} as underdogs` : null;
  const tg = tags(upsets.length ? results.filter(r => upsets.includes(r.leo)).map(r => r.code) : []);
  return { id: "rday", kind: "results", created_at: now, header: title, lines, record: `${right} of ${results.length}`, facts: call ? [call] : [], hashtags: tg,
    text: tail([title, "", ...lines, "", rec, call], link, tg), link };
}
/** Hashtags, then the link alone on the last line, so nothing can run into the link when it is pasted into X. */
function tail(head, link, tags) {
  return [...head.filter(x => x != null), "", tags.join(" "), "", bare(link)].join("\n").replace(/\n{3,}/g, "\n\n");
}

// ---------- hype voice (Lynold, Nov 20, DEC-20261120-05: "example of what i want our voice to sound like") ----------
// Results opener on picks: a perfect night "TOO EASY.", more wins "WINNING NIGHT.", even "SPLIT.", more losses "NOT TONIGHT."
function opener(w, l, unit = "NIGHT") {
  if (w > 0 && l === 0) return "TOO EASY.";
  if (w > l) return `WINNING ${unit}.`;
  if (w === l) return "SPLIT.";
  return "NOT TONIGHT.";
}
const WITH_LEO = "🔥 if you're with Leo";
/** The night's strongest pick as its own post. Label only: graded at 1 unit like every pick. */
function nukePost({ title, line, link, tags, now, tip }) {
  return { id: "nuke", kind: "picks", hero: "Leo's nuke", created_at: now, tip_utc: tip || null, header: title, lines: [line], record: "", facts: [], hashtags: tags,
    text: tail([title, "", line, "", WITH_LEO], link, tags), link };
}
/** Bleacher Report style stat line: headline, one stat per line, the result, the game page. */
function statPost({ headline, stats, result, link, tags, now, player, team }) {
  return { id: "stat", kind: "stat", hero: headline.replace(/\s*\S+$/u, ""), created_at: now, header: headline, lines: stats, record: "", facts: result ? [result] : [],
    hashtags: tags, player, team, text: tail([headline, "", ...stats, "", result || null], link, tags), link };
}

module.exports = { tail, readsPost, upsetPost, spotlightPosts, readsResultsPost, isDog, fav, opener, nukePost, statPost, WITH_LEO };
