#!/usr/bin/env node
/**
 * Leo NBA player projections for today's games: points, rebounds, assists, PRA. Private test (DEC-20261126-03 step 2;
 * Lynold, 2026-11-28: "So when are we going to build the player projections"). Not on the site, not in posts or
 * emails, not a Leo Pick. The saved sportsbook line is written next to the projection only so the grader can compare
 * them later; it is never an input (scripts/lib/nba-props-model.js never sees it).
 *
 *   node scripts/project-nba-props.js              (today, Eastern; games that have not tipped)
 *   node scripts/project-nba-props.js 2026-11-27   (a past date: every game, rows marked source=backfill)
 *
 * Appends to data/nba/prop-proj/<date>.csv, a row only when the projection (0.1) or the saved line changed since the
 * last row for that player and market, so the file holds the projection at each read and the last one before tip.
 * Players: everyone with a saved line, plus anyone with 5+ games this season and 20+ projected minutes.
 * Absences: Leo's injury list for the game (data/nba/picks-<date>.json, leo.missing): an out player is not projected;
 * new absences in the rotation hand 30% of their minutes (times the status weight) to the players who play.
 * Never fails the run.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const PM = require("./lib/nba-props-model");

const ROOT = path.join(__dirname, "..");
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const DATE = process.argv[2] || TODAY;
const BACKFILL = DATE < TODAY;
const OUTDIR = path.join(ROOT, "data/nba/prop-proj");
const COLS = ["projected_at", "source", "date", "game_id", "tip_utc", "player_id", "player", "team", "opp", "status", "market",
  "projection", "minutes", "games", "line", "line_captured_at"];
const read = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };
const cell = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const r1 = x => Math.round(x * 10) / 10;

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean); if (!lines.length) return [];
  const head = lines.shift().split(",");
  return lines.map(l => { const c = []; let cur = "", q = false;
    for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ",") { c.push(cur); cur = ""; } else cur += ch; }
    c.push(cur); return Object.fromEntries(head.map((h, i) => [h, c[i] ?? ""])); });
}

/** Latest saved line per player and market (data/nba/prop-lines/<date>.csv), and the player names it carries. */
function savedLines(date) {
  const f = path.join(ROOT, "data/nba/prop-lines", `${date}.csv`), m = new Map();
  if (!fs.existsSync(f)) return m;
  for (const r of parseCsv(fs.readFileSync(f, "utf8"))) {
    const k = `${r.athlete_id}|${r.market}`, prev = m.get(k);
    if (!prev || r.captured_at >= prev.captured_at) m.set(k, r);
  }
  return m;
}

async function main() {
  const picks = read(path.join(ROOT, "data/nba", `picks-${DATE}.json`));
  if (!picks || !picks.games || !picks.games.length) { console.log(`prop proj: no games in picks-${DATE}.json`); return; }
  const now = new Date();
  const games = picks.games.filter(g => BACKFILL || !g.tip_utc || new Date(g.tip_utc) > now);
  if (!games.length) { console.log(`prop proj ${DATE}: every game has tipped`); return; }

  // This season through yesterday, last season as the prior. Season year = the year the season ends.
  const d = new Date(DATE + "T12:00:00Z"), sy = d.getUTCMonth() >= 8 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
  const [cur, last] = await Promise.all([PM.seasonRows(sy, ROOT, { current: true }), PM.seasonRows(sy - 1, ROOT)]);
  const { prior, league } = PM.priorFrom(last.rows);
  const T = new PM.Tracker(prior); T.setLeaguePrior(league);
  const byGame = new Map(); for (const r of cur.rows) { const a = byGame.get(r.game_id) || []; a.push(r); byGame.set(r.game_id, a); }
  const names = new Map();
  for (const g of cur.games) if (g.date < DATE) T.addGame(g.date, g.home, g.away, byGame.get(g.game_id) || []);

  const lines = savedLines(DATE);
  for (const r of lines.values()) names.set(String(r.athlete_id), r.player);
  const logF = read(path.join(ROOT, "data/nba/player-log.json"));
  if (logF && Array.isArray(logF.players)) for (const p of logF.players) if (p && p.id && p.name && !names.has(String(p.id))) names.set(String(p.id), p.name);
  const lineIds = new Set([...lines.values()].map(r => String(r.athlete_id)));

  const at = now.toISOString(), out = [];
  for (const g of games) {
    const missing = (g.leo && g.leo.missing) || {};
    for (const side of ["home", "away"]) {
      const team = g[side], opp = side === "home" ? g.away : g.home;
      const miss = new Map((missing[side] || []).map(m => [String(m.id), m]));
      for (const m of miss.values()) if (m.name) names.set(String(m.id), names.get(String(m.id)) || m.name);
      const ds = T.teamDates.get(team) || [], recent = new Set(ds.slice(-3));
      // Candidates: this team's players who played in one of its last three games, or have a line saved.
      const cands = [...T.pl.entries()].filter(([id, p]) => p.team === team && (recent.has(p.games[p.games.length - 1].date) || lineIds.has(id)));
      const outIds = new Set([...miss.values()].filter(m => +m.weight >= 1).map(m => String(m.id)));
      const absent = T.rotation(team).reduce((s, r) => { const m = miss.get(r.id); return s + (m ? r.mpg * Math.min(1, +m.weight || 0) : 0); }, 0);
      const b2b = T.isB2B(team, DATE);
      const playing = cands.filter(([id]) => !outIds.has(id));
      const base = playing.map(([id]) => ({ id, p: T.project(id, team, opp, DATE, { b2b }) })).filter(x => x.p);
      const present = base.reduce((s, x) => s + x.p.min, 0);
      for (const { id } of base) {
        const p = T.project(id, team, opp, DATE, { b2b, absentMinutes: absent, teamMinutesPresent: present });
        if (!p) continue;
        const keep = lineIds.has(id) || (p.games >= 5 && p.min >= 20);
        if (!keep) continue;
        const m = miss.get(id);
        for (const k of ["pts", "reb", "ast", "pra"]) {
          const L = lines.get(`${id}|${k}`);
          out.push({ projected_at: at, source: BACKFILL ? "backfill" : "live", date: DATE, game_id: g.game_id, tip_utc: g.tip_utc, player_id: id,
            player: names.get(id) || "", team, opp, status: m ? m.status : "", market: k, projection: r1(p[k]), minutes: r1(p.min), games: p.games,
            line: L ? L.line : "", line_captured_at: L ? L.captured_at : "" });
        }
      }
    }
  }

  // Append only what changed since the last row for each player and market.
  fs.mkdirSync(OUTDIR, { recursive: true });
  const f = path.join(OUTDIR, `${DATE}.csv`);
  const old = fs.existsSync(f) ? parseCsv(fs.readFileSync(f, "utf8")) : [];
  const lastRow = new Map(); for (const r of old) lastRow.set(`${r.player_id}|${r.market}`, r);
  const add = out.filter(r => { const o = lastRow.get(`${r.player_id}|${r.market}`); return !o || +o.projection !== r.projection || String(o.line) !== String(r.line) || o.status !== r.status; });
  if (!old.length) fs.writeFileSync(f, COLS.join(",") + "\n");
  if (add.length) fs.appendFileSync(f, add.map(r => COLS.map(c => cell(r[c])).join(",")).join("\n") + "\n");
  const players = new Set(out.map(r => r.player_id)).size, lined = out.filter(r => r.line !== "").length;
  console.log(`prop proj ${DATE}: ${games.length} games, ${players} players, ${out.length} projections (${lined} with a saved line), ${add.length} new rows`);
}

main().catch(e => console.error("prop proj: " + (e && e.message)));
