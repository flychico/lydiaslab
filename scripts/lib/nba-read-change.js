/**
 * The card email goes out at one read; the game page and night page show the
 * read of record (the last read before tip). When the two differ, the pages
 * say so in one line, with what moved (Lynold, 2026-11-17: the email said
 * Knicks by 2, the page Knicks by 1, "I do not like things being inconsistent";
 * he chose "Show the change").
 *
 *   change(g) -> { text, email: {...}, last: {...} } or null
 *
 * Email read = the last data/nba/prediction-history.csv capture for the game at
 * or before the card email's sent_at (data/email-log/nba-card-<date>.json).
 * Read of record = the last capture before tip. Names of players who came on or
 * off the injury report come from the email log's reads (saved by
 * send-nba-card-emails.js from 2026-11-18, backfilled for earlier dates); when
 * a log has no reads the line says the injury report changed.
 */
const fs = require("fs");
const path = require("path");
const WHY = require("./nba-why");

const ROOT = path.join(__dirname, "..", "..");
const DIR = path.join(ROOT, "data", "nba");
let HIST = null;
const LOGS = {};

function history() {
  if (HIST) return HIST;
  HIST = {};
  const f = path.join(DIR, "prediction-history.csv");
  if (!fs.existsSync(f)) return HIST;
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean);
  const head = lines.shift().split(",");
  for (const l of lines) {
    const c = l.split(","), r = {};
    head.forEach((h, i) => { r[h] = c[i]; });
    (HIST[r.game_id] = HIST[r.game_id] || []).push(r);
  }
  for (const k in HIST) HIST[k].sort((a, b) => a.captured_at.localeCompare(b.captured_at));
  return HIST;
}
function emailLog(date) {
  if (!(date in LOGS)) {
    const f = path.join(ROOT, "data", "email-log", `nba-card-${date}.json`);
    try { LOGS[date] = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { LOGS[date] = null; }
  }
  return LOGS[date];
}
const num = v => (v === "" || v == null || !Number.isFinite(+v)) ? null : +v;
function shown(r) {
  const m = num(r.leo_home_margin), p = num(r.leo_p_home);
  if (m == null || p == null) return null;
  const line = WHY.leoLine({ leo: { home_margin: m }, market: { home_spread: num(r.mkt_home_spread) } });
  return { p_home: p, line, at: r.captured_at, home_lost: num(r.home_lost) || 0, away_lost: num(r.away_lost) || 0 };
}
const etTime = iso => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).replace(" ", "").toLowerCase() + " ET";

function readPair(g) {
  const log = emailLog(g.date);
  if (!log || !log.sent_at) return null;
  const rows = history()[g.game_id] || [];
  const tip = g.tip_utc || (rows[0] && rows[0].kickoff_utc);
  const sent = new Date(log.sent_at).getTime(), tipT = tip ? new Date(tip).getTime() : Infinity;
  if (!(sent < tipT)) return null;   // email after tip: nothing to compare
  let e = null, last = null;
  for (const r of rows) {
    const t = new Date(r.captured_at).getTime();
    if (t <= sent + 60000) e = r;   // the capture written by the run that sent the email
    if (t < tipT) last = r;
  }
  if (!e || !last || e === last) return null;
  return { log, email: shown(e), last: shown(last) };
}

function sideText(s, g, nickOf) {
  const homeFav = s.p_home >= 0.5;
  const team = homeFav ? nickOf(g.home, g.home_name) : nickOf(g.away, g.away_name);
  const p = Math.round((homeFav ? s.p_home : 1 - s.p_home) * 100);
  const by = s.line == null ? "" : s.line === 0 ? ", even on the spread" : `, by ${String(Math.abs(s.line)).replace(/\.0$/, "")}`;
  return { team, p, text: `the ${team} ${p}%${by}` };
}

function playersMoved(g, pair, nickOf) {
  const was = (pair.log.reads || {})[g.game_id];
  const nowM = (g.leo || {}).missing || {};
  if (!was || !was.missing) return null;
  const off = [], on = [], moved = [];
  for (const side of ["home", "away"]) {
    const team = side === "home" ? nickOf(g.home, g.home_name) : nickOf(g.away, g.away_name);
    const before = new Map((was.missing[side] || []).map(p => [p.name, p]));
    const after = new Map((nowM[side] || []).map(p => [p.name, p]));
    const st = s => s === "day-to-day" ? "day to day" : s;
    for (const [n, p] of before) if (!after.has(n)) off.push(`${n} (${team}${p.detail ? ", " + String(p.detail).toLowerCase() : ""})`);
    for (const [n, p] of after) {
      const b = before.get(n);
      if (!b) on.push(`${n} (${team}, listed ${st(p.status)})`);
      else if (b.status !== p.status) moved.push(`${n} (${team}) moved from ${st(b.status)} to ${st(p.status)}`);
    }
  }
  const and = a => a.length < 3 ? a.join(" and ") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
  const out = [];
  if (off.length) out.push(`${and(off)} came off the injury report`);
  if (on.length) out.push(`${and(on)} ${on.length > 1 ? "were" : "was"} added to the injury report`);
  if (moved.length) out.push(and(moved));
  return out;
}

function change(g, opts = {}) {
  const nickOf = opts.nick || ((abbr, name) => String(name || abbr).split(" ").slice(-1)[0].replace("Blazers", "Trail Blazers"));
  const pair = readPair(g);
  if (!pair || !pair.email || !pair.last) return null;
  const a = sideText(pair.email, g, nickOf), b = sideText(pair.last, g, nickOf);
  if (a.text === b.text) return null;   // nothing a reader would see changed
  const moved = playersMoved(g, pair, nickOf);
  let why;
  if (moved && moved.length) why = moved.join("; ") + ",";
  else if (pair.email.home_lost !== pair.last.home_lost || pair.email.away_lost !== pair.last.away_lost) why = "The injury report changed,";
  else why = "The latest data came in,";
  const text = `Leo's read moved after the card email. At ${etTime(pair.email.at)} Leo had ${a.text}. ${why[0].toUpperCase() + why.slice(1)} so the last read before tip has ${b.text}.`;
  return { text, email: pair.email, last: pair.last };
}

/** What the card email saves per game, so a later read can name who moved. */
function snapshot(games) {
  const out = {};
  for (const g of games || []) {
    const L = g.leo || {};
    const m = L.missing || {};
    const pick = p => ({ name: p.name, status: p.status, detail: p.detail || null });
    out[g.game_id] = { p_home: L.p_home ?? null, home_margin: L.home_margin ?? null, missing: { home: (m.home || []).map(pick), away: (m.away || []).map(pick) } };
  }
  return out;
}

module.exports = { change, snapshot };
