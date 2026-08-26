"use strict";
/*
  LyDia Coach — correlation engine over the FULL analyzed history.

  2026-08-26, Lynold's explicit instruction: Coach previously only looked at
  22 current-model official picks and 4 pre-chosen splits (probability,
  Lab Rating, pitcher support, bullpen caution) -- see generate-coach.js's
  old buildBuckets()/buildRecommendations(), replaced by this module. His
  words: "look at all the games that we have an analysis for, look at the
  inputs, look at the correlations... what are some patterns that we keep
  noticing that lead to the wrong picks or patterns that have led to the
  correct picks... give real time inputs for today's matchup based on the
  evidence we have collected."

  This module:
    1. Loads EVERY graded game in data/calibration/attribution_model_log.csv
       (all tiers -- official_pick, value_watch, watchlist, pass -- and all
       dates), joined with data/calibration/calibration_model_log.csv by
       (date, gamePk) for market_prob/best_price. ~318 games as of 08-26,
       not 22.
    2. Converts every home/away-relative input into a PICK-relative feature
       (positive = favors the side LyDia actually picked), so "does a bigger
       pitcher edge for our side predict winning" is a straight yes/no
       question instead of something you have to mentally flip per game.
    3. Computes a real point-biserial correlation (equivalent to Pearson
       correlation against the 0/1 win indicator) for every numeric feature,
       plus a quartile win-rate table so a coefficient turns into something
       readable ("bottom quartile: 38-41 (48%) ... top quartile: 54-27
       (67%)"). Also splits a few categorical dimensions (status tier,
       home/away, day of week) the same way.
    4. Ranks findings honestly. Sports correlations are weak by nature --
       this does NOT inflate language to make a 0.05 look like a discovery.
       See CORR_BANDS below for the exact thresholds used in prose.
    5. Given TODAY's own game features, finds where they land in each
       significant historical pattern and returns real evidence sentences
       -- this is what feeds the matchup page, replacing the old fixed
       4-bucket "weaker bucket" check.

  Sign conventions verified against scripts/grade-calibration.js's own ALOG
  builder (the authoritative source of every column read here):
    - home_pitcher_gap  = home pitcher score  - away pitcher score
    - home_woba_gap     = home wOBA (15d)     - away wOBA (15d)
    - home_bullpen_gap  = away bullpen risk   - home bullpen risk
                          (positive = HOME side's pen is safer)
    - home_bullpen_adj  = probability points bullpen moved the PICK's number,
                          already stored pick-relative on the member-brief
                          object, converted home-relative by grade-calibration.js
    - home_model_prob   = model's win probability for the HOME team
  Every one of these is converted to pick-relative here by flipping sign
  when pick_team === "away team" (or 1-p for probabilities). Verified
  2026-08-26 against 5 real rows: pick-relative model_prob derived here
  matches calibration_model_log.csv's own (independently-stored) model_prob
  to within CSV rounding on every row checked.
*/

const fs = require("fs");
const path = require("path");

function splitCsvLine(l) {
  const c = []; let cur = "", q = false;
  for (const ch of l) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { c.push(cur); cur = ""; }
    else cur += ch;
  }
  c.push(cur);
  return c;
}
function loadCsv(p) {
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, "utf8");
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map(l => {
    const cells = splitCsvLine(l);
    const o = {};
    header.forEach((k, i) => { o[k] = cells[i]; });
    return o;
  });
}
function num(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function normDate(d) {
  // calibration_model_log.csv mixes M/D/YYYY and MM/DD/YYYY (see
  // ERR-20260826, the coach-record-fix session) -- normalize both to
  // YYYY-MM-DD so the join key always matches regardless of which format
  // a given row happens to use.
  const m = String(d || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : String(d || "");
}
function dayOfWeek(isoOrSlash) {
  const iso = normDate(isoOrSlash);
  const d = new Date(iso + "T12:00:00Z"); // noon UTC avoids DST edge cases
  if (isNaN(d.getTime())) return null;
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
}

const FEATURES = [
  { key: "pick_model_prob", label: "LyDia's own win probability for this pick" },
  { key: "edge_vs_market", label: "Model edge over the market (model prob minus no-vig market prob)" },
  { key: "pick_pitcher_gap", label: "Starting pitcher score edge (picked side minus opponent)" },
  { key: "pick_era_edge", label: "Starting pitcher ERA edge (opponent's ERA minus the picked pitcher's)" },
  { key: "pick_woba_gap", label: "Offense wOBA edge, last 15 days (picked side minus opponent)" },
  { key: "pick_bullpen_gap", label: "Bullpen risk edge (positive = the picked side's bullpen is the safer one)" },
  { key: "pick_bullpen_adj", label: "Probability points bullpen risk moved this pick's number" },
  { key: "pick_own_bullpen_risk", label: "Picked team's own bullpen fatigue score (regardless of the opponent's)" },
  { key: "pick_lab_score", label: "Lab Rating (LyDia's own analysis-quality score for this pick)" },
  { key: "best_price_abs", label: "Size of the price (how big a favorite or underdog this pick was)" }
];

/*
  Loads every graded game and derives pick-relative features + pickWon.
  Returns an array of row objects: { date, gamePk, matchup, pickTeam, status,
  isHome, pickWon, features: { <FEATURES key>: number|null } }.
*/
function loadHistoricalRows(ROOT) {
  const alog = loadCsv(path.join(ROOT, "data", "calibration", "attribution_model_log.csv"));
  const cal = loadCsv(path.join(ROOT, "data", "calibration", "calibration_model_log.csv"));
  const calByKey = new Map(cal.map(r => [`${normDate(r.date)},${r.gamePk}`, r]));

  const rows = [];
  for (const a of alog) {
    const c = calByKey.get(`${normDate(a.date)},${a.gamePk}`);
    if (!c) continue; // no outcome to grade against -- skip, don't guess

    const pickHome = a.pick_team === "home team";
    const winner = a.winner; // "home" | "away"
    if (winner !== "home" && winner !== "away") continue;
    const pickWon = (pickHome && winner === "home") || (!pickHome && winner === "away") ? 1 : 0;

    const homeModelProb = num(a.home_model_prob);
    const pickModelProb = homeModelProb !== null ? (pickHome ? homeModelProb : 1 - homeModelProb) : null;

    const marketProb = num(c.market_prob); // already pick-relative, same convention as model_probability (see grade-calibration.js's own comment on this)
    const edgeVsMarket = (pickModelProb !== null && marketProb !== null) ? pickModelProb - marketProb : null;

    const homePitcherGap = num(a.home_pitcher_gap);
    const pickPitcherGap = homePitcherGap !== null ? (pickHome ? homePitcherGap : -homePitcherGap) : null;

    const homeEra = num(a.home_era), awayEra = num(a.away_era);
    let pickEraEdge = null;
    if (homeEra !== null && awayEra !== null) {
      const pickEra = pickHome ? homeEra : awayEra;
      const oppEra = pickHome ? awayEra : homeEra;
      pickEraEdge = oppEra - pickEra; // positive = picked pitcher's ERA is lower/better
    }

    const homeWoba = num(a.home_woba), awayWoba = num(a.away_woba);
    let pickWobaGap = null;
    // Both exactly 0 is a missing-data placeholder (wOBA tracking gap,
    // confirmed 2026-08-26: ~24% of historical rows), not a real reading --
    // treated as null rather than a true zero-edge game.
    if (homeWoba !== null && awayWoba !== null && !(homeWoba === 0 && awayWoba === 0)) {
      const g = homeWoba - awayWoba;
      pickWobaGap = pickHome ? g : -g;
    }

    const homeBullpenGap = num(a.home_bullpen_gap);
    const pickBullpenGap = homeBullpenGap !== null ? (pickHome ? homeBullpenGap : -homeBullpenGap) : null;

    const homeBullpenAdj = num(a.home_bullpen_adj);
    const pickBullpenAdj = homeBullpenAdj !== null ? (pickHome ? homeBullpenAdj : -homeBullpenAdj) : null;

    const homeRisk = num(a.home_bullpen_risk), awayRisk = num(a.away_bullpen_risk);
    const pickOwnBullpenRisk = pickHome ? homeRisk : awayRisk;

    const labScore = num(c.lab_score);
    const bestPrice = num(c.best_price);
    const bestPriceAbs = bestPrice !== null ? Math.abs(bestPrice) : null;

    rows.push({
      date: a.date,
      gamePk: a.gamePk,
      matchup: a.matchup,
      pickTeam: pickHome ? a.home_team : a.away_team,
      status: c.status || a.status || "",
      isHome: pickHome,
      pickWon,
      features: {
        pick_model_prob: pickModelProb,
        edge_vs_market: edgeVsMarket,
        pick_pitcher_gap: pickPitcherGap,
        pick_era_edge: pickEraEdge,
        pick_woba_gap: pickWobaGap,
        pick_bullpen_gap: pickBullpenGap,
        pick_bullpen_adj: pickBullpenAdj,
        pick_own_bullpen_risk: pickOwnBullpenRisk,
        pick_lab_score: labScore,
        best_price_abs: bestPriceAbs
      }
    });
  }
  return rows;
}

function pearson(x, y) {
  const n = x.length;
  if (n < 2) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

function quartileTable(pairs) {
  // pairs: [{val, win}], already filtered to non-null val, sorted by val asc
  const n = pairs.length;
  const q = Math.floor(n / 4);
  if (q < 1) return null;
  const buckets = [pairs.slice(0, q), pairs.slice(q, 2 * q), pairs.slice(2 * q, 3 * q), pairs.slice(3 * q)];
  return buckets.map(b => {
    const w = b.filter(r => r.win === 1).length;
    return { n: b.length, w, l: b.length - w, rate: b.length ? w / b.length : null, min: b[0].val, max: b[b.length - 1].val };
  });
}

const MIN_N = 20; // a feature/split needs at least this many non-null rows to be reported at all

/*
  Returns { numeric: [...ranked by |r| desc], categorical: [...] }.
  numeric entries: { key, label, n, r, quartiles }
  categorical entries: { key, label, groups: [{ label, n, w, l, rate }] }
*/
function computeCorrelations(rows) {
  const numeric = [];
  for (const f of FEATURES) {
    const pairs = rows
      .map(r => ({ val: r.features[f.key], win: r.pickWon }))
      .filter(p => p.val !== null && Number.isFinite(p.val));
    if (pairs.length < MIN_N) continue;
    const r = pearson(pairs.map(p => p.val), pairs.map(p => p.win));
    if (r === null) continue;
    const sorted = [...pairs].sort((a, b) => a.val - b.val);
    numeric.push({ key: f.key, label: f.label, n: pairs.length, r, quartiles: quartileTable(sorted) });
  }
  numeric.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

  const categorical = [];

  // Status tier -- does the gate actually work?
  {
    const byStatus = new Map();
    for (const r of rows) {
      if (!byStatus.has(r.status)) byStatus.set(r.status, []);
      byStatus.get(r.status).push(r);
    }
    const groups = [...byStatus.entries()]
      .filter(([, rs]) => rs.length >= Math.min(MIN_N, 5)) // small tiers (value_watch) allowed at a lower floor -- still labeled with n
      .map(([label, rs]) => {
        const w = rs.filter(r => r.pickWon === 1).length;
        return { label, n: rs.length, w, l: rs.length - w, rate: w / rs.length };
      })
      .sort((a, b) => b.rate - a.rate);
    if (groups.length >= 2) categorical.push({ key: "status_tier", label: "Pick tier (official / value watch / watchlist / pass)", groups });
  }

  // Home vs away
  {
    const home = rows.filter(r => r.isHome), away = rows.filter(r => !r.isHome);
    if (home.length >= MIN_N && away.length >= MIN_N) {
      const rec = rs => { const w = rs.filter(r => r.pickWon === 1).length; return { n: rs.length, w, l: rs.length - w, rate: w / rs.length }; };
      categorical.push({
        key: "home_away",
        label: "Picked the home team vs. the road team",
        groups: [{ label: "Home", ...rec(home) }, { label: "Road", ...rec(away) }]
      });
    }
  }

  // Day of week
  {
    const byDow = new Map();
    for (const r of rows) {
      const d = dayOfWeek(r.date);
      if (!d) continue;
      if (!byDow.has(d)) byDow.set(d, []);
      byDow.get(d).push(r);
    }
    const groups = [...byDow.entries()]
      .filter(([, rs]) => rs.length >= Math.min(MIN_N, 10))
      .map(([label, rs]) => {
        const w = rs.filter(r => r.pickWon === 1).length;
        return { label, n: rs.length, w, l: rs.length - w, rate: w / rs.length };
      })
      .sort((a, b) => b.rate - a.rate);
    if (groups.length >= 2) categorical.push({ key: "day_of_week", label: "Day of the week", groups });
  }

  return { numeric, categorical };
}

// Honest banding -- these thresholds are deliberately conservative. Sports
// outcomes are noisy; a single-feature |r| above ~0.15 is already notable,
// and most real signals here sit well below that. Language must not oversell.
const CORR_BANDS = [
  { min: 0.20, word: "a real relationship" },
  { min: 0.10, word: "a modest relationship" },
  { min: 0.00, word: "little to no relationship" }
];
function bandFor(absR) {
  return CORR_BANDS.find(b => absR >= b.min).word;
}
function pct(x) { return x === null || x === undefined ? "—" : (x * 100).toFixed(1) + "%"; }
function fmtNum(x, d = 2) { return Number.isFinite(x) ? x.toFixed(d) : "—"; }

/*
  Human-readable prose, ranked strongest-first -- fills the same
  "recommendations" slot the old fixed-4-bucket version used.
*/
function buildProseRecommendations(correlations, overallRecord) {
  const lines = [];
  lines.push(`Full-history record across every analyzed game (all tiers, all dates): ${overallRecord.w}-${overallRecord.l} (${pct(overallRecord.rate)}), n=${overallRecord.n}. This is what the correlations below are measured against -- not just the 22 current-model official picks.`);

  const top = correlations.numeric.slice(0, 6);
  for (const f of top) {
    const q = f.quartiles;
    const band = bandFor(Math.abs(f.r));
    if (!q) { lines.push(`${f.label}: r=${fmtNum(f.r, 3)} (n=${f.n}) -- ${band}.`); continue; }
    const bottom = q[0], top4 = q[3];
    lines.push(`${f.label}: r=${fmtNum(f.r, 3)} (n=${f.n}) -- ${band}. Bottom quarter (${fmtNum(bottom.min)} to ${fmtNum(bottom.max)}): ${bottom.w}-${bottom.l} (${pct(bottom.rate)}). Top quarter (${fmtNum(top4.min)} to ${fmtNum(top4.max)}): ${top4.w}-${top4.l} (${pct(top4.rate)}).`);
  }

  for (const c of correlations.categorical) {
    const parts = c.groups.map(g => `${g.label} ${g.w}-${g.l} (${pct(g.rate)}, n=${g.n})`);
    lines.push(`${c.label}: ${parts.join(" vs. ")}.`);
  }

  lines.push("These are correlations across LyDia's own analyzed history, not causal proof and not a signal to change any model weight or gate on their own -- human review still required for any actual change.");
  return lines;
}

/*
  Given today's own game features (same shape as a rows[].features object,
  built by the matchup-page generator from that game's live inputs) and the
  correlation findings, returns real evidence notes -- which historical
  quartile this game's numbers fall into, and what that quartile's record
  actually is. Returns [] if correlations aren't ready or nothing rises
  above MIN_R (weak features are omitted rather than forced into a note).
*/
const MIN_R_FOR_EVIDENCE = 0.08; // below this, a note would be evidence-shaped noise, not evidence
function evidenceForGame(gameFeatures, correlations, opts) {
  const topK = (opts && opts.topK) || 3;
  if (!correlations || !Array.isArray(correlations.numeric)) return [];
  const notes = [];
  for (const f of correlations.numeric) {
    if (notes.length >= topK) break;
    if (Math.abs(f.r) < MIN_R_FOR_EVIDENCE) continue;
    const val = gameFeatures[f.key];
    if (val === null || val === undefined || !Number.isFinite(val) || !f.quartiles) continue;
    const q = f.quartiles;
    let bucket = null, bucketIdx = -1;
    for (let i = 0; i < q.length; i++) {
      if (val <= q[i].max || i === q.length - 1) { bucket = q[i]; bucketIdx = i; break; }
    }
    if (!bucket) continue;
    const position = ["bottom quarter", "second quarter", "third quarter", "top quarter"][bucketIdx];
    const direction = f.r > 0
      ? (bucketIdx >= 2 ? "the stronger end" : "the weaker end")
      : (bucketIdx <= 1 ? "the stronger end" : "the weaker end");
    notes.push({
      title: `Evidence check: ${f.label}`,
      detail: `Today's number here (${fmtNum(val)}) falls in the ${position} of LyDia's historical range -- ${direction} of this angle. In that quarter, LyDia's record is ${bucket.w}-${bucket.l} (${pct(bucket.rate)}, n=${bucket.n}). A review note only, from ${f.n} analyzed games -- not a reason to skip or fade this pick.`
    });
  }
  return notes;
}

module.exports = {
  FEATURES,
  loadHistoricalRows,
  computeCorrelations,
  buildProseRecommendations,
  evidenceForGame,
  pearson
};
