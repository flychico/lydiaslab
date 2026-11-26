#!/usr/bin/env node
/**
 * NBA player prop lines, saved for a private test (Lynold, 2026-11-26: "we need
 * to expand nba picks to include player props ... we do not need props for every
 * single player"). Nothing here is shown on the site or used by Leo's numbers.
 *
 * Source: ESPN's free odds feed (DraftKings, provider 100), the same feed the NBA
 * game lines come from. No odds credits.
 *
 * Kept small on purpose (the repo is GitHub Pages):
 *   - today's games (Eastern date) that have not tipped
 *   - each team's top 8 players by minutes (data/nba/player-log.json, 3+ games)
 *   - four markets: points, rebounds, assists, points + rebounds + assists
 *     (no threes: shooting variance, Gemini's review 2026-11-26)
 *   - the main line only (milestone and alternate lines are left out)
 *   - a row only when the line or a price changed since the last saved row
 * Every NBA read saves a snapshot, so the file holds the line at 12:47pm, at the
 * 5:47pm graded card and the last read before tip (the closing line we test against).
 *
 *   node scripts/capture-nba-prop-lines.js [YYYY-MM-DD]
 * writes data/nba/prop-lines/<date>.csv
 *
 * Columns: captured_at, game_id, tip_utc, athlete_id, player, team, market, line,
 *   price_1, price_2, open_line, open_1, open_2, book_updated
 * price_1 and price_2 are the two sides in the feed's order (ESPN does not label
 * them); which one is the over is confirmed against the book before any grading.
 * Never fails the run.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATE = process.argv[2] || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const MARKETS = { "Total Points": "pts", "Total Rebounds": "reb", "Total Assists": "ast", "Total Points, Rebounds, and Assists": "pra" };
const TOP = 8;
const COLS = ["captured_at", "game_id", "tip_utc", "athlete_id", "player", "team", "market", "line", "price_1", "price_2", "open_line", "open_1", "open_2", "book_updated"];
const read = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };
const cell = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function getJson(url) {
  for (let i = 0; i < 2; i++) {
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(t));
      if (r.ok) return await r.json();
    } catch (e) { /* retry once */ }
    await new Promise(r => setTimeout(r, 1500));
  }
  return null;
}

function rotation() {
  const L = read(path.join(ROOT, "data/nba/player-log.json")) || {};
  const byTeam = {};
  for (const p of L.players || []) if (p.gp >= 3 && p.id) (byTeam[p.team] = byTeam[p.team] || []).push(p);
  const keep = new Map();
  for (const [team, ps] of Object.entries(byTeam)) for (const p of ps.sort((a, b) => b.mpg - a.mpg).slice(0, TOP)) keep.set(String(p.id), { name: p.name, team });
  return keep;
}

function lastRows(file) {
  const last = new Map();
  if (!fs.existsSync(file)) return last;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").slice(1);
  for (const l of lines) { const c = l.split(","); last.set(`${c[1]}|${c[3]}|${c[6]}`, `${c[7]}|${c[8]}|${c[9]}`); }
  return last;
}

(async () => {
  try {
    const card = read(path.join(ROOT, `data/nba/picks-${DATE}.json`));
    const games = (card && card.games || []).filter(g => g.game_id && !(g.tip_utc && Date.parse(g.tip_utc) <= Date.now()));
    if (!games.length) { console.log(`Prop lines ${DATE}: no games left to capture.`); return; }
    const keep = rotation();
    const file = path.join(ROOT, "data/nba/prop-lines", `${DATE}.csv`);
    const last = lastRows(file), now = new Date().toISOString(), rows = [];
    for (const g of games) {
      const id = g.game_id;
      const j = await getJson(`https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/${id}/competitions/${id}/odds/100/propBets?limit=1000`);
      if (!j || !Array.isArray(j.items)) { console.log(`  ${g.away} at ${g.home}: no prop feed`); continue; }
      const pairs = new Map();
      for (const p of j.items) {
        const m = MARKETS[p.type && p.type.name]; if (!m) continue;
        const aid = ((p.athlete && p.athlete.$ref || "").match(/athletes\/(\d+)/) || [])[1];
        if (!aid || !keep.has(aid)) continue;
        const k = `${aid}|${m}`; (pairs.get(k) || pairs.set(k, []).get(k)).push(p);
      }
      let n = 0;
      for (const [k, ps] of pairs) {
        if (ps.length !== 2) continue;   // main line only: exactly the two sides of one line
        const [a, b] = ps, [aid, m] = k.split("|"), who = keep.get(aid);
        const line = a.current && a.current.target ? a.current.target.value : null;
        if (line == null || (b.current && b.current.target && b.current.target.value !== line)) continue;
        const row = { captured_at: now, game_id: id, tip_utc: g.tip_utc || "", athlete_id: aid, player: who.name, team: who.team, market: m, line,
          price_1: a.odds.american.value, price_2: b.odds.american.value,
          open_line: a.open && a.open.target ? a.open.target.value : "", open_1: a.odds.american.open || "", open_2: b.odds.american.open || "",
          book_updated: a.lastUpdated || "" };
        const key = `${id}|${aid}|${m}`, sig = `${row.line}|${row.price_1}|${row.price_2}`;
        if (last.get(key) === sig) continue;
        rows.push(row); n++;
      }
      console.log(`  ${g.away} at ${g.home}: ${n} new or changed lines`);
    }
    if (!rows.length) { console.log(`Prop lines ${DATE}: nothing changed.`); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = rows.map(r => COLS.map(c => cell(r[c])).join(",")).join("\n") + "\n";
    if (!fs.existsSync(file)) fs.writeFileSync(file, COLS.join(",") + "\n" + body); else fs.appendFileSync(file, body);
    console.log(`Prop lines ${DATE}: ${rows.length} rows -> data/nba/prop-lines/${DATE}.csv (${Math.round(fs.statSync(file).size / 1024)} KB)`);
  } catch (e) { console.log("Prop lines: skipped,", e.message); }
})();
