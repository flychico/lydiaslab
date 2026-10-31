/**
 * Leo NFL: the named starting quarterback for a game (DEC-20261031-08).
 *
 * Source: nflverse's daily depth charts (depth_charts_<season>.csv, ESPN),
 * the latest snapshot taken strictly before the cut-off, QB rank 1. A QB
 * listed Out or Doubtful on that week's injury report is skipped and the next
 * rank takes his place.
 *
 * Why not the other two sources:
 *   - games.csv names a QB for upcoming games, but it named Jalen Hurts for
 *     PHI @ WAS on 2026-11-01 after he went on injured reserve for the season
 *     (IR players are not on the weekly injury report either).
 *   - "Most attempts per game so far" (the old props rule) projects the
 *     backup whenever a starter returns from injury: Huntley for Jackson,
 *     Kaliakmanis for Daniels on the same slate.
 * Walk-forward on 2026 weeks 1-8 (216 team-games, snapshot before kickoff,
 * Out/Doubtful skipped): depth chart named the QB who actually threw the
 * most passes 210 times (97.2%), games.csv 204 (94.4%), usage 169 (78.2%).
 *
 * NO LOOKAHEAD: the cut-off is the earlier of now and kickoff, so a rerun
 * after kickoff cannot read a depth chart updated after the game.
 *
 * Pure: no network, filesystem or clock reads.
 */
(function () {
'use strict';

/**
 * rows:      depth chart rows ({dt, team, player_name, gsis_id, pos_abb, pos_rank})
 * team:      team abbreviation as in games.csv
 * cutoffMs:  epoch ms; only snapshots taken strictly before it are used
 * sidelined: Set of gsis_ids listed Out or Doubtful for the week
 * returns    {name, gsis_id, rank, dt} or null when no usable snapshot exists
 */
function depthChartQb(rows, team, cutoffMs, sidelined) {
  let last = "";
  const snaps = [];
  for (const r of rows) {
    if (r.team !== team || r.pos_abb !== "QB") continue;
    const t = Date.parse(r.dt);
    if (!Number.isFinite(t) || t >= cutoffMs) continue;
    snaps.push(r);
    if (r.dt > last) last = r.dt;
  }
  if (!last) return null;
  const qs = snaps.filter(r => r.dt === last)
    .sort((a, b) => Number(a.pos_rank) - Number(b.pos_rank));
  const skip = sidelined || new Set();
  const pick = qs.find(r => !skip.has(r.gsis_id));
  return pick ? { name: pick.player_name, gsis_id: pick.gsis_id, rank: Number(pick.pos_rank), dt: last } : null;
}

/** Keep only QB rows so a 70 MB file does not sit in memory twice. */
const qbRowsOnly = rows => rows.filter(r => r.pos_abb === "QB");

const api = { depthChartQb, qbRowsOnly };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else if (typeof window !== "undefined") window.NFL_STARTERS = api;
})();
