"use strict";

/*
  LyDia -- single source of truth for the official-pick gate thresholds.

  Both generate-member-lab.js (which enforces the live gate) and
  generate-learning-summary.js (which reports historically against that same
  gate) import from here. Before 2026-08-22 they didn't: generate-learning-summary.js
  carried its own hardcoded copy (0.72 model probability / 80 lab score) in
  eight separate places (the strongOfficial/protectedByGate filters,
  fallbackLessonTag's strict_gate_win/loss labels, the multi-day
  strict_gate_candidates count, and the gates{} block returned in the JSON
  summary itself). That copy traced back to before the 2026-08-05 calibration
  remap (0.72 raw == 0.61 calibrated, same games -- see the comment at
  OFFICIAL_MODEL_PROB's old declaration site in generate-member-lab.js) and
  was never updated for it, then drifted further out of sync again on
  2026-08-22 when OFFICIAL_LAB_SCORE moved 80 -> 72. Lynold's explicit
  instruction: "everything needs to be traced to the live gate" -- so both
  scripts now read the same two constants instead of each keeping its own
  copy that can go stale independently.

  Do not add unrelated thresholds here (VALUE_EDGE, VALUE_WATCH_LAB_SCORE,
  WATCHLIST_LAB_SCORE, etc. stay local to generate-member-lab.js) -- this file
  is scoped to exactly the two numbers a second script needs to describe the
  real official-pick gate, not a general settings dump.
*/

// 2026-08-05: calibration remap, 0.72 raw -> 0.61 calibrated, same games.
const OFFICIAL_MODEL_PROB = 0.61;
// 2026-08-22, Lynold's explicit instruction: 80 -> 72 (8.0/10 -> 7.2/10),
// same day as the lab rating v3.2 reweight (see lib/lab-rating-core.js).
const OFFICIAL_LAB_SCORE = 72;

module.exports = { OFFICIAL_MODEL_PROB, OFFICIAL_LAB_SCORE };
