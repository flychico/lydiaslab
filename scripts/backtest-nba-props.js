#!/usr/bin/env node
/**
 * Walk-forward test of the NBA player projection (scripts/lib/nba-props-model.js) against each player's season
 * average to date. 2025-26 (prior: 2024-25) and 2026-27 to date (prior: 2025-26; release file plus the ESPN box
 * scores saved in data/nba/boxscores). Each game is projected from games before its date only.
 * Absences use who actually sat (an upper bound for the live model, which only knows the injury report).
 * Players scored: 5+ games played this season, 20+ projected minutes (about the players books post lines for),
 * and who played (a player who sits is a void at the book).
 *
 *   node scripts/backtest-nba-props.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const PM = require("./lib/nba-props-model");
const ROOT = path.join(__dirname, "..");

const season = s => PM.seasonRows(s, ROOT, { current: s === 2027 });

function run(test, priorRows, params) {
  const { prior, league } = PM.priorFrom(priorRows);
  const T = new PM.Tracker(prior, params); T.setLeaguePrior(league);
  const byGame = new Map(); for (const r of test.rows) { const a = byGame.get(r.game_id) || []; a.push(r); byGame.set(r.game_id, a); }
  const err = { model: {}, avg: {} }, n = { c: 0 };
  for (const k of ["pts", "reb", "ast", "pra"]) { err.model[k] = 0; err.avg[k] = 0; }
  const dates = [...new Set(test.games.map(g => g.date))].sort();
  for (const d of dates) {
    const todays = test.games.filter(g => g.date === d);
    const projs = [];
    for (const g of todays) {
      const rows = byGame.get(g.game_id) || [];
      for (const team of [g.home, g.away]) {
        const opp = team === g.home ? g.away : g.home;
        const played = rows.filter(r => r.team === team && r.played);
        const playedIds = new Set(played.map(r => r.id));
        const absent = T.rotation(team).filter(r => !playedIds.has(r.id)).reduce((s, r) => s + r.mpg, 0);
        const b2b = T.isB2B(team, d);
        // first pass: minutes without the absence boost, to share it out
        const base = played.map(r => ({ r, p: T.project(r.id, team, opp, d, { b2b }) })).filter(x => x.p);
        const present = base.reduce((s, x) => s + x.p.min, 0);
        for (const { r, p: p0 } of base) {
          const p = T.project(r.id, team, opp, d, { b2b, absentMinutes: absent, teamMinutesPresent: present });
          const sa = T.seasonAvg(r.id);
          // The scored set is chosen from minutes before any adjustment, so every variant scores the same games.
          const plain = T.project(r.id, team, opp, d, {});
          if (!p || !sa || sa.games < 5 || plain.min < 20) continue;
          projs.push({ r, p, sa });
        }
      }
    }
    for (const { r, p, sa } of projs) {
      n.c++;
      const act = { pts: r.pts, reb: r.reb, ast: r.ast, pra: r.pts + r.reb + r.ast };
      for (const k of ["pts", "reb", "ast", "pra"]) { err.model[k] += Math.abs(p[k] - act[k]); err.avg[k] += Math.abs(sa[k] - act[k]); }
    }
    for (const g of todays) T.addGame(d, g.home, g.away, byGame.get(g.game_id) || []);
  }
  const out = { n: n.c };
  for (const k of ["pts", "reb", "ast", "pra"]) out[k] = { model: +(err.model[k] / n.c).toFixed(3), avg: +(err.avg[k] / n.c).toFixed(3) };
  return out;
}

(async () => {
  const s25 = await season(2025), s26 = await season(2026), s27 = await season(2027);
  // base = the settings now in P; every other variant changes one thing from them (or from the older defaults).
  const variants = {
    base: {},
    "old defaults (prior 250, no opp, no teammates)": { RATE_PRIOR_MIN: 250, OPP_EXP: 0, TEAMMATE_SHARE: 0 },
    "rate prior 60": { RATE_PRIOR_MIN: 60 }, "rate prior 250": { RATE_PRIOR_MIN: 250 },
    "no opponent": { OPP_EXP: 0 }, "no teammates": { TEAMMATE_SHARE: 0 }, "teammates 0.6": { TEAMMATE_SHARE: 0.6 },
    "min half-life 4": { MIN_HALF_LIFE: 4 }, "min half-life 10": { MIN_HALF_LIFE: 10 },
    "rate half-life 10": { RATE_HALF_LIFE: 10 }, "rate half-life 40": { RATE_HALF_LIFE: 40 },
    "rate prior 500": { RATE_PRIOR_MIN: 500 },
    "b2b cut 4%": { B2B_MIN_CUT: 0.04 },
    "teammates 1.0": { TEAMMATE_SHARE: 1.0 }, "teammates 0.6 + rate 0.03": { TEAMMATE_SHARE: 0.6, TEAMMATE_RATE: 0.03 },
    "opponent 1.0": { OPP_EXP: 1.0 }, "min prior 8 games": { MIN_PRIOR_GAMES: 8 },
  };
  const only = process.argv[2] ? JSON.parse(process.argv[2]) : null;
  const res = {};
  for (const [name, par] of Object.entries(only || variants)) {
    res[name] = { "2025-26": run(s26, s25.rows, par), "2026-27": run(s27, s26.rows, par) };
    const f = (r) => ["pts", "reb", "ast", "pra"].map(k => `${k} ${r[k].model.toFixed(3)} (avg ${r[k].avg.toFixed(3)})`).join("  ");
    console.log(`${name.padEnd(28)} 25-26 n=${res[name]["2025-26"].n}: ${f(res[name]["2025-26"])}\n${"".padEnd(28)} 26-27 n=${res[name]["2026-27"].n}: ${f(res[name]["2026-27"])}`);
  }
  fs.writeFileSync(process.env.OUT || "/home/claude/mgr/nba-props/backtest.json", JSON.stringify(res, null, 1));
})();
