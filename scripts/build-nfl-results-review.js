#!/usr/bin/env node
/*
  Leo NFL results review (business/RESULTS_DESIGN.md, HO-0032; built in the
  Leo Manager chat on Lynold's instruction, 2026-11-09).

  Reads the graded record and writes data/nfl/results-review.json, the feed
  behind the day by day sections of /nfl/results/: for every graded game the
  upset flag, Leo's calls, and for every miss ONE data based reason with a
  one sentence evidence line. Also the reason tally per week and season.

  Display and bookkeeping only: it reads frozen reads and grades, and changes
  no number, pick or grade.

  Inputs (all written by the grading workflow before this runs):
    data/nfl/tracker.json            calls, results, misses (home side margins)
    data/nfl/prediction-history.csv  first read and read of record per game
    data/nfl/matchups/<date>.json    final report (overtime, quarterbacks)
    data/nfl/nfl-props-graded.csv    volume and efficiency effects per prop

  Miss reasons, first match wins (RESULTS_DESIGN.md section 2):
    injury_input  the quarterback Leo's read used did not play
    market_knew   the line moved 1.5+ (spread) or 2+ (total) away from Leo's side
    overtime      the game was tied after regulation
    blowout       decided by 21+ and the line missed about as badly as Leo
    variance      the line missed by about as much as Leo (within 3 points), or more
    model_error   the line was closer than Leo by more than 3 points
  Prop misses: volume or efficiency, plus game script when the margin was 17+.

  Usage: node scripts/build-nfl-results-review.js
*/
"use strict";
const fs = require("fs");
const path = require("path");
const TEAMS = require("./lib/nfl-teams");

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "data", "nfl");
const nick = a => TEAMS.nick(a);
const r1 = v => Math.round(v * 10) / 10;
const num = v => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f.replace(/\r$/, "")); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
const readCsv = f => (fs.existsSync(f) ? parseCsv(fs.readFileSync(f, "utf8")) : []);
const key = r => `${r.week}|${r.matchup}`;
const lastName = s => String(s || "").trim().split(/\s+/).pop().toLowerCase().replace(/[^a-z]/g, "");

// First read and read of record (last capture before kickoff) per game.
function loadReads() {
  const first = new Map(), frozen = new Map();
  for (const r of readCsv(path.join(DIR, "prediction-history.csv"))) {
    const t = Date.parse(r.captured_at), k = Date.parse(r.kickoff_utc);
    if (!Number.isFinite(t) || !Number.isFinite(k) || t >= k) continue;
    const id = key(r);
    if (!first.has(id) || Date.parse(first.get(id).captured_at) > t) first.set(id, r);
    if (!frozen.has(id) || Date.parse(frozen.get(id).captured_at) <= t) frozen.set(id, r);
  }
  return { first, frozen };
}

// The quarterbacks Leo's frozen read used (picks-<date>.json away_qb / home_qb).
function loadPickQbs() {
  const out = new Map();
  for (const f of fs.readdirSync(DIR).filter(f => /^picks-\d{4}-\d{2}-\d{2}\.json$/.test(f))) {
    let d; try { d = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch (e) { continue; }
    for (const g of Array.isArray(d) ? d : (d.games || [])) {
      if (g.matchup && g.week != null && (g.away_qb || g.home_qb)) out.set(`${g.week}|${g.matchup}`, { away: g.away_qb, home: g.home_qb });
    }
  }
  return out;
}

function loadMatchups() {
  const out = new Map();
  const dir = path.join(DIR, "matchups");
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
    let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { continue; }
    for (const g of Array.isArray(d) ? d : (d.games || [])) if (g.matchup && g.week != null) out.set(`${g.week}|${g.matchup}`, g);
  }
  return out;
}

const signed = v => (v > 0 ? "+" : "") + r1(v);
const marginWords = (g, m) => (m > 0 ? `${nick(g.home)} by ${r1(m)}` : m < 0 ? `${nick(g.away)} by ${r1(-m)}` : "a tie");

function spreadCallText(g, s) {
  const h = s.side === g.home ? -s.line : s.line;          // the side's own number
  return `${nick(s.side)} ${h > 0 ? "+" + r1(h) : h < 0 ? r1(h) : "even"}`;
}

/* One reason per missed game. `basis` says which miss the numbers describe. */
function reasonFor(g, ctx) {
  const { sp, tot, fr, m, read0, read1, spreadMiss } = ctx;
  const err = spreadMiss ? sp.err : (tot ? tot.err : null);
  const lerr = spreadMiss ? sp.lerr : (tot ? tot.lerr : null);
  const what = spreadMiss ? "margin" : "total";

  // 1. injury_input: the quarterback in Leo's read did not play.
  if (m && fr && fr.box) {
    for (const side of ["away", "home"]) {
      const used = (ctx.qbs && ctx.qbs[side]) || m[`${side}_qb_name`], played = fr.box[side] && fr.box[side].qb && fr.box[side].qb.name;
      if (used && played && lastName(used) !== lastName(played)) {
        return { reason: "injury_input", evidence: `Leo's read had ${used} at quarterback for the ${nick(g[side])}. ${played} played instead.` };
      }
    }
  }
  // 2. market_knew: the line moved away from the side Leo took.
  if (read0 && read1) {
    if (spreadMiss && sp.leo != null) {
      const s0 = num(read0.spread_line), s1 = num(read1.spread_line);
      if (s0 != null && s1 != null && sp.leo !== s1) {
        const dir = Math.sign(sp.leo - s1);                 // +1 Leo leaned to the home side
        const move = (s1 - s0) * dir;                       // negative: line moved away from Leo
        if (move <= -1.5) return { reason: "market_knew", evidence: `The spread moved ${r1(-move)} points away from Leo's side before kickoff, from ${marginWords(g, s0)} to ${marginWords(g, s1)}.` };
      }
    }
    if (!spreadMiss && tot && tot.side) {
      const t0 = num(read0.total_line), t1 = num(read1.total_line);
      if (t0 != null && t1 != null) {
        const dir = /over/i.test(tot.side) ? 1 : -1;
        const move = (t1 - t0) * dir;                       // negative: the total moved away from Leo's side
        if (move <= -2) return { reason: "market_knew", evidence: `The total moved ${r1(-move)} points away from Leo's ${String(tot.side).toLowerCase()} before kickoff, from ${r1(t0)} to ${r1(t1)}.` };
      }
    }
  }
  // 3. overtime
  if (fr && fr.overtime && spreadMiss) return { reason: "overtime", evidence: "The game was tied after regulation and decided in overtime." };
  // 4. blowout
  if (spreadMiss && sp.actual != null && Math.abs(sp.actual) >= 21 && lerr != null && err != null && lerr >= 0.8 * err) {
    return { reason: "blowout", evidence: `Decided by ${Math.abs(sp.actual)}. Leo missed the margin by ${r1(err)} and the closing line missed by ${r1(lerr)}.` };
  }
  // 5. variance / 6. model_error
  if (err != null && lerr != null) {
    // "About as much": within 3 points. A line that was closer by more than 3 is Leo's error.
    if (lerr >= err - 3) return { reason: "variance", evidence: `Leo missed the ${what} by ${r1(err)}. The closing line missed by ${r1(lerr)}, ${lerr >= err ? "as much or more" : "about as much"}.` };
    return { reason: "model_error", evidence: `Leo missed the ${what} by ${r1(err)}. The closing line missed by only ${r1(lerr)}.`, cost_pts: r1(err - lerr) };
  }
  return { reason: "model_error", evidence: "Leo's read was wrong and there is no closing line to compare." };
}

function build() {
  const t = JSON.parse(fs.readFileSync(path.join(DIR, "tracker.json"), "utf8"));
  const reads = loadReads();
  const matchups = loadMatchups();
  const pickQbs = loadPickQbs();
  const ml = new Map((t.games || []).map(r => [key(r), r]));
  const totals = new Map((t.totals || []).map(r => [key(r), r]));

  const games = [];
  for (const sp of t.spreads || []) {
    const id = key(sp);
    const g = { week: String(sp.week), date: sp.date, matchup: sp.matchup, away: sp.away, home: sp.home };
    const m = matchups.get(id), fr = m && m.final_report, tot = totals.get(id), pick = ml.get(id);
    const read0 = reads.first.get(id), read1 = reads.frozen.get(id);
    const score = sp.score || (t.scores && t.scores[id]) || null;
    if (!score) continue;
    const winner = score.home > score.away ? g.home : score.away > score.home ? g.away : null;
    const loser = winner === g.home ? g.away : g.home;

    // Leo's winner and chance, from the read of record.
    let leoPick = read1 ? read1.pick : null, leoProb = read1 ? num(read1.model_prob) : null;
    if (pick && !leoPick) { leoPick = pick.pick; leoProb = pick.leo_prob; }
    const leoProbWinner = leoProb == null || !winner ? null : (leoPick === winner ? leoProb : 1 - leoProb);
    const wrongWinner = !!(winner && leoPick && leoProb !== 0.5 && leoPick !== winner);

    // Market favorite: the closing spread, else the moneyline price.
    let fav = sp.line > 0 ? g.home : sp.line < 0 ? g.away : null;
    const mktProbPick = read1 ? num(read1.market_prob) : (pick ? pick.market_prob : null);
    if (!fav && mktProbPick != null && leoPick) fav = mktProbPick >= 0.5 ? leoPick : (leoPick === g.home ? g.away : g.home);
    const favProb = fav && mktProbPick != null && leoPick ? r1((leoPick === fav ? mktProbPick : 1 - mktProbPick) * 100) : null;
    const upset = fav && winner && fav !== winner
      ? { fav, fav_prob_market: favProb, leo_prob_winner: leoProbWinner == null ? null : r1(leoProbWinner * 100), leo_saw_it: leoPick === winner }
      : null;

    // Calls: only graded calls (W, L or P).
    const calls = [];
    if (pick && pick.result) calls.push({ market: "ml", text: `${nick(pick.pick)} to win, ${Math.round(pick.leo_prob * 100)}%`, result: pick.result });
    if (sp.side && sp.result) calls.push({ market: "spread", text: `${spreadCallText(g, sp)}, Leo had ${marginWords(g, sp.leo)}`, result: sp.result });
    if (tot && tot.side && tot.result) calls.push({ market: "total", text: `${String(tot.side).charAt(0).toUpperCase() + String(tot.side).slice(1).toLowerCase()} ${r1(tot.line)}, Leo projected ${r1(tot.leo)}`, result: tot.result });

    const lostSpreadish = calls.some(c => c.result === "L" && c.market !== "total");
    const lostTotal = calls.some(c => c.result === "L" && c.market === "total");
    const bigMiss = sp.err != null && sp.err >= 14;
    const why = [];
    for (const c of calls) if (c.result === "L") why.push(c.market === "ml" ? "moneyline call lost" : c.market === "spread" ? "spread call lost" : "total call lost");
    if (wrongWinner) why.push("wrong winner");
    if (bigMiss) why.push(`margin off by ${r1(sp.err)}`);
    let miss = null;
    if (why.length) {
      const spreadMiss = lostSpreadish || wrongWinner || bigMiss;
      miss = { why, ...reasonFor(g, { sp, tot, fr, m, read0, read1, spreadMiss, qbs: pickQbs.get(id) }) };
    }

    games.push({
      ...g, away_name: nick(g.away), home_name: nick(g.home), url: (m && m.url) || null,
      score, winner, loser, overtime: !!(fr && fr.overtime),
      leo: { pick: leoPick, prob: leoProb == null ? null : r1(leoProb * 100), margin: sp.leo, total: tot ? tot.leo : null },
      line: { spread: sp.line, total: tot ? tot.line : null, fav, fav_prob: favProb },
      actual_margin: sp.actual, leo_miss: sp.err, line_miss: sp.lerr,
      leo_right_winner: winner && leoPick ? leoPick === winner : null,
      upset, calls, miss,
    });
  }

  // Prop misses: the three biggest losing calls per game day, volume or efficiency.
  const graded = new Map();
  for (const r of readCsv(path.join(DIR, "nfl-props-graded.csv"))) {
    if (/TD/i.test(r.market) || r.volume_effect === "" || r.rate_effect === "") continue;   // yardage rows only
    graded.set(`${r.week}|${r.matchup}|${r.player}|${r.position}`, r);
  }
  const margins = new Map(games.map(g => [key(g), g.actual_margin]));
  const VOL = { QB: "pass attempts", RB: "carries", WR: "targets" };
  const RATE = { QB: "yards per attempt", RB: "yards per carry", WR: "yards per target" };
  const byDay = new Map();
  for (const p of t.props || []) {
    if (p.result !== "L" || typeof p.err !== "number") continue;
    const k = `${p.week}|${p.date}`;
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(p);
  }
  const prop_misses = [];
  for (const [k, list] of byDay) {
    list.sort((a, b) => Math.abs(b.err) - Math.abs(a.err));
    for (const p of list.slice(0, 3)) {
      const gr = graded.get(`${p.week}|${p.matchup}|${p.player}|${p.group}`) || {};
      const ve = num(gr.volume_effect), re = num(gr.rate_effect);
      const ev = num(gr.expected_volume), av = num(gr.actual_volume), er = num(gr.rate_used), ar = num(gr.actual_rate);
      let reason = "model_error", evidence = `Leo projected ${p.leo} and he finished with ${p.actual}.`;
      if (ve != null && re != null) {
        if (Math.abs(ve) >= Math.abs(re)) {
          reason = "volume";
          evidence = ev != null && av != null ? `Leo expected ${r1(ev)} ${VOL[p.group] || "touches"} and he got ${r1(av)}.` : "The miss came from how much he was used.";
        } else {
          reason = "efficiency";
          evidence = er != null && ar != null ? `Leo expected ${r1(er)} ${RATE[p.group] || "yards per touch"} and he made ${r1(ar)}.` : "The miss came from yards per touch, not usage.";
        }
      }
      const mg = margins.get(`${p.week}|${p.matchup}`);
      const script = mg != null && Math.abs(mg) >= 17;
      if (script) evidence += ` The game was decided by ${Math.abs(mg)}, which changes play calling.`;
      prop_misses.push({
        week: String(p.week), date: p.date, matchup: p.matchup, team: p.team, team_name: nick(p.team), player: p.player, group: p.group,
        unit: p.unit, lean: p.lean, line: p.line, leo: p.leo, actual: p.actual, miss: Math.round(Math.abs(p.err)),
        reason, game_script: script, evidence,
      });
    }
  }

  // Reason tally: per week and season, games and props apart.
  const weeks = [...new Set(games.map(g => g.week))].sort((a, b) => Number(a) - Number(b));
  const tally = { season: { games: {}, props: {} }, weeks: {} };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  for (const w of weeks) tally.weeks[w] = { games: {}, props: {} };
  for (const g of games) if (g.miss) { bump(tally.season.games, g.miss.reason); bump(tally.weeks[g.week].games, g.miss.reason); }
  for (const p of prop_misses) { bump(tally.season.props, p.reason); if (tally.weeks[p.week]) bump(tally.weeks[p.week].props, p.reason); }

  const out = {
    generated_at: new Date().toISOString(), through: t.through, weeks,
    counts: { games: games.length, misses: games.filter(g => g.miss).length, upsets: games.filter(g => g.upset).length, upsets_seen: games.filter(g => g.upset && g.upset.leo_saw_it).length },
    tally, games, prop_misses,
  };
  fs.writeFileSync(path.join(DIR, "results-review.json"), JSON.stringify(out));
  console.log(`NFL results review: ${games.length} games, ${out.counts.misses} misses, ${out.counts.upsets} upsets (${out.counts.upsets_seen} seen), ${prop_misses.length} prop misses -> data/nfl/results-review.json`);
  console.log("  reasons:", JSON.stringify(tally.season.games), JSON.stringify(tally.season.props));
}
if (require.main === module) build();
module.exports = { build, reasonFor };
