/**
 * NFL spread calls from the Tuesday read (DEC-20261120-09; Lynold chose "Go live this Tuesday", 2026-11-22).
 * NFL lane, built by the Manager on Lynold's named instruction.
 *
 * From the 2026-11-25 games (Week 12), each game's spread call is made once, from the first read saved on or
 * after the Tuesday of its week that has a posted line, and graded at that read's line. Later reads never make
 * a new spread call. A locked call is removed before kickoff only for a big injury change:
 *   - a team's starting quarterback in Leo's read is not the one in the Tuesday read, or
 *   - the list of non-quarterback regulars Leo counts as out changed AND Leo's latest margin is no longer on
 *     the locked side of Tuesday's line.
 * A removed call stays removed. Moneyline calls are unchanged (game-day, held once made).
 *
 * File: data/nfl/spread-locks/<season>-week-<N>.json
 *   { season, week, games: { <game_id>: { matchup, away, home, date, status: "locked"|"none"|"removed",
 *     side, line (home favoured by), label, margin, gap, away_qb, home_qb, away_out, home_out, read_at,
 *     reason, removed_at } } }
 *
 * apply(dir, picks) runs in generate-nfl-model.js on every read (early reads and game-day gathers) before the
 * picks file is written. It writes the lock file and copies the game's lock onto each row as flat fields
 * (spread_lock_status, spread_lock_side, spread_lock_line, spread_lock_reason, spread_lock_at), which
 * prediction-history.csv keeps and scripts/lib/nfl-calls.js reads.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const FROM = "2026-11-25";
const SEASON = 2026;
const num = v => { const x = typeof v === "number" ? v : parseFloat(v); return Number.isFinite(x) ? x : null; };
const r1 = x => Math.round(x * 10) / 10;
const etDate = ms => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

// The Tuesday on or before a game date (NFL weeks run Wednesday or Thursday to Monday; no Tuesday games).
function weekTuesday(date) {
  const d = new Date(date + "T12:00:00Z");
  const back = (d.getUTCDay() - 2 + 7) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}
const outKey = list => JSON.stringify((list || []).map(p => typeof p === "string" ? p : (p.player || p.name || "")).sort());

function lockFile(dir, week) { return path.join(dir, "spread-locks", `${SEASON}-week-${week}.json`); }
function readLock(dir, week) { try { return JSON.parse(fs.readFileSync(lockFile(dir, week), "utf8")); } catch (e) { return { season: SEASON, week: String(week), games: {} }; } }

function apply(dir, picks, opts = {}) {
  const now = opts.now || Date.now();
  const today = etDate(now);
  const CALLS = require("./nfl-calls");
  const { kickoffUtc } = require("./prediction-history");
  const byWeek = new Map();
  const changed = new Set();
  for (const p of picks) {
    if (!p || !p.date || p.date < FROM || p.week == null) continue;
    const wk = String(p.week);
    if (!byWeek.has(wk)) byWeek.set(wk, readLock(dir, wk));
    const L = byWeek.get(wk);
    const kick = Date.parse(kickoffUtc(p.date, p.kickoff));
    const started = Number.isFinite(kick) && now >= kick;
    let g = L.games[p.game_id];
    if (!g && !started && today >= weekTuesday(p.date) && num(p.spread_line) != null && num(p.exp_margin) != null) {
      // The call the rule makes on this read (calls() with no lock fields and a pre-lock date gives the plain rule).
      const plain = CALLS.calls({ ...p, date: "2026-11-22", spread_lock_status: undefined }).spread;
      g = L.games[p.game_id] = {
        matchup: p.matchup, away: p.away, home: p.home, date: p.date,
        status: plain.call ? "locked" : "none", side: plain.call || null, line: num(p.spread_line),
        label: plain.call ? plain.label : null, margin: num(p.exp_margin), gap: r1(num(p.exp_margin) - num(p.spread_line)),
        reason: plain.call ? "" : (plain.short || plain.pass || "no call"),
        away_qb: p.away_qb || null, home_qb: p.home_qb || null,
        away_out: outKey(p.away_out_beyond_qb), home_out: outKey(p.home_out_beyond_qb),
        read_at: new Date(now).toISOString()
      };
      changed.add(wk);
    } else if (g && g.status === "locked" && !started) {
      let why = "";
      for (const [side, name] of [["away", p.away], ["home", p.home]]) {
        const was = g[side + "_qb"], is = p[side + "_qb"];
        if (was && is && was !== is) why = `${name} starting quarterback changed (${was} to ${is})`;
      }
      if (!why) {
        const outMoved = outKey(p.away_out_beyond_qb) !== g.away_out || outKey(p.home_out_beyond_qb) !== g.home_out;
        const m = num(p.exp_margin);
        const still = m == null ? true : (g.side === p.home ? m > g.line : m < g.line);
        if (outMoved && !still) why = "injury report change moved Leo to the other side of Tuesday's line";
      }
      if (why) { g.status = "removed"; g.reason = why; g.removed_at = new Date(now).toISOString(); changed.add(wk); }
    }
    if (g) {
      p.spread_lock_status = g.status;
      p.spread_lock_side = g.side || "";
      p.spread_lock_line = g.line;
      p.spread_lock_reason = g.reason || "";
      p.spread_lock_at = g.read_at;
    } else {
      p.spread_lock_status = "pending";
      p.spread_lock_side = ""; p.spread_lock_line = ""; p.spread_lock_reason = ""; p.spread_lock_at = "";
    }
  }
  for (const wk of changed) {
    const f = lockFile(dir, wk);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(byWeek.get(wk), null, 1) + "\n");
  }
  const n = [...byWeek.values()].reduce((a, L) => a + Object.values(L.games).filter(g => g.status === "locked").length, 0);
  return { weeks: [...byWeek.keys()], changed: [...changed], locked: n };
}

module.exports = { FROM, apply, weekTuesday, readLock, lockFile };
