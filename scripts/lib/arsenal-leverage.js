"use strict";
/*
  LyDia — swing-and-miss / arsenal leverage (pitch-type resolved).

  Isolates how much THIS lineup misses THIS pitcher's specific pitch mix,
  relative to a league-average lineup. It is a matchup multiplier only — the
  pitcher's own whiff skill is already in his season K/BF, so we divide it back
  out (baseline) to avoid double-counting.

  For each pitch type pt in the pitcher's arsenal (usage u_pt, pitcher whiff pw_pt):
    ratio_pt = lineupWhiff_pt / leagueWhiff_pt   (how whiffy this lineup is vs pt)
    matchup  = Σ u_pt * pw_pt * ratio_pt
    baseline = Σ u_pt * pw_pt
    factor   = clamp(matchup / baseline, 1-cap, 1+cap)

  Per-batter, per-pitch whiff samples are thin, so each batter's rate is shrunk
  toward the league rate for that pitch (K pitches of regression) before it is
  pitches-weighted into the lineup rate. Whole-lineup thin samples pull the final
  factor toward 1.0.

  Data source: Baseball Savant pitch-arsenal-stats leaderboards (2 calls/day,
  whole league). No key required. Any fetch/parse failure returns a neutral
  factor of 1.0 so the daily run is never blocked.
*/

const SAVANT = "https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats";
// Savant team_name_alt uses a few codes that differ from MLB StatsAPI abbreviations.
const TEAM_ALIAS = { ARI: "AZ", OAK: "ATH", CHW: "CWS", WAS: "WSH", KCR: "KC", SFG: "SF", TBR: "TB", SDP: "SD" };

// minimal CSV parser (handles quoted fields containing commas)
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map(h => h.replace(/^﻿/, "").trim());
  return rows.slice(1).filter(r => r.length === head.length).map(r => {
    const o = {}; head.forEach((h, i) => o[h] = r[i]); return o;
  });
}

const num = x => { const n = Number(x); return Number.isFinite(n) ? n : 0; };

async function fetchText(url) {
  // Savant returns CSV, so fetch text directly (the shared j() parses JSON).
  const r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}

// Returns { ready, pitchers, batters, byTeam, league } or { ready:false } on failure.
async function fetchArsenalData(year, _j) {
  try {
    const q = t => `${SAVANT}?type=${t}&pitchType=&year=${year}&team=&min=10&csv=true`;
    const [pTxt, bTxt] = await Promise.all([fetchText(q("pitcher")), fetchText(q("batter"))]);
    const pRows = parseCsv(pTxt), bRows = parseCsv(bTxt);
    if (!pRows.length || !bRows.length) return { ready: false };

    // league whiff per pitch type: pitches-weighted mean across all pitchers
    const lnum = {}, lden = {};
    for (const r of pRows) {
      const pt = r.pitch_type, w = num(r.pitches), wh = num(r.whiff_percent);
      if (!pt || w <= 0) continue;
      lnum[pt] = (lnum[pt] || 0) + wh * w; lden[pt] = (lden[pt] || 0) + w;
    }
    const league = {};
    for (const pt in lnum) if (lden[pt] > 0) league[pt] = lnum[pt] / lden[pt];

    const pitchers = new Map();
    for (const r of pRows) {
      const id = Number(r.player_id); if (!id) continue;
      const m = pitchers.get(id) || pitchers.set(id, {}).get(id);
      m[r.pitch_type] = { usage: num(r.pitch_usage), whiff: num(r.whiff_percent), pitches: num(r.pitches) };
    }
    const batters = new Map(), teamTot = new Map();
    for (const r of bRows) {
      const id = Number(r.player_id); if (!id) continue;
      const m = batters.get(id) || batters.set(id, { team: r.team_name_alt }).get(id);
      m[r.pitch_type] = { whiff: num(r.whiff_percent), pitches: num(r.pitches) };
      const key = r.team_name_alt + "|" + id;
      teamTot.set(key, (teamTot.get(key) || 0) + num(r.pitches));
    }
    // byTeam: batter ids sorted by total pitches seen (proxy for regulars)
    const byTeam = {};
    for (const [key, tot] of teamTot) {
      const [code, id] = key.split("|");
      (byTeam[code] = byTeam[code] || []).push({ id: Number(id), pitches: tot });
    }
    for (const code in byTeam) byTeam[code].sort((a, b) => b.pitches - a.pitches);

    return { ready: true, pitchers, batters, byTeam, league };
  } catch (e) {
    console.warn("arsenal data fetch skipped:", e.message);
    return { ready: false };
  }
}

// id -> Savant team code, from StatsAPI (one call). {} on failure.
async function fetchTeamCodes(j) {
  try {
    const d = await j("https://statsapi.mlb.com/api/v1/teams?sportId=1");
    const out = {};
    for (const t of d.teams || []) {
      const ab = (t.abbreviation || "").toUpperCase();
      out[t.id] = TEAM_ALIAS[ab] || ab;
    }
    return out;
  } catch (e) { return {}; }
}

// Compute the leverage factor for a pitcher vs a set of batter ids.
// opts: { K=50 (pitches of regression), cap=0.12, minLineup=5,
//         confidence=1 (extra shrink toward 1 for a guessed/projected lineup) }
function leverage(pitcherId, lineupIds, data, opts) {
  const K = (opts && opts.K) || 50;
  const cap = (opts && opts.cap) || 0.12;
  const minLineup = (opts && opts.minLineup) || 5;
  const confidence = (opts && opts.confidence != null) ? opts.confidence : 1;
  const neutral = { factor: 1, applied: false, note: "no data" };
  if (!data || !data.ready) return neutral;
  const arsenal = data.pitchers.get(Number(pitcherId));
  if (!arsenal) return { factor: 1, applied: false, note: "no pitcher arsenal" };
  const ids = (lineupIds || []).map(Number).filter(Boolean);
  const matched = ids.filter(id => data.batters.has(id));
  if (matched.length < minLineup) return { factor: 1, applied: false, note: `thin lineup (${matched.length})` };

  // lineup whiff per pitch type: shrink each batter toward league, weight by pitches
  const lnum = {}, lden = {};
  for (const id of matched) {
    const b = data.batters.get(id);
    for (const pt in data.league) {
      const cell = b[pt]; if (!cell || cell.pitches <= 0) continue;
      const shr = (cell.pitches * cell.whiff + K * data.league[pt]) / (cell.pitches + K);
      lnum[pt] = (lnum[pt] || 0) + shr * cell.pitches;
      lden[pt] = (lden[pt] || 0) + cell.pitches;
    }
  }
  let matchup = 0, baseline = 0;
  const per = [];
  for (const pt in arsenal) {
    const u = arsenal[pt].usage / 100, pw = arsenal[pt].whiff;
    if (u <= 0 || pw <= 0) continue;
    const lg = data.league[pt], ln = lden[pt] > 0 ? lnum[pt] / lden[pt] : null;
    baseline += u * pw;
    if (lg && ln) { const ratio = ln / lg; matchup += u * pw * ratio; per.push({ pt, usage: arsenal[pt].usage, ratio: Number(ratio.toFixed(3)) }); }
    else matchup += u * pw; // no lineup data for this pitch -> neutral on it
  }
  if (baseline <= 0) return { factor: 1, applied: false, note: "no usable arsenal" };
  let factor = matchup / baseline;
  // whole-lineup shrink: fewer than a full 9 pulls toward 1, and a projected
  // (unconfirmed) lineup is shrunk further via the caller's confidence.
  const conf = Math.min(1, matched.length / 9) * Math.max(0, Math.min(1, confidence));
  factor = 1 + (factor - 1) * conf;
  factor = Math.max(1 - cap, Math.min(1 + cap, factor));
  return { factor: Number(factor.toFixed(4)), applied: true, matched: matched.length, per_pitch: per };
}

module.exports = { fetchArsenalData, fetchTeamCodes, leverage, parseCsv };
