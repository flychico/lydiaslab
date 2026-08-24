/*
  LyDia -- pitcher-score-gap boost coefficient.

  Single source of truth for the coefficient used in every place that prices
  a starting-pitcher score gap into odds: exp(PITCHER_SCORE_K * scoreGap).
  Shared by scripts/generate-member-lab.js (the live moneyline model that
  actually prices picks), scripts/export-pregame-attribution.js, and
  scripts/grade-calibration.js (both ledgers that recompute the same number
  for logging/grading). All three used to carry their own hardcoded local
  copy of this constant -- exactly the "one file changed, the others went
  stale" bug pattern already logged more than once in this project's own
  ERRORS.md (most recently: grade-calibration.js's pitcherBoost was still on
  the OLD era-based formula on 2026-08-21, three days after
  generate-member-lab.js switched to the pitcher-score-based one). A leaf
  module here means there is exactly one place left to go stale.

  2026-08-24, Lynold's explicit instruction: a 6-point pitcher_score gap was
  swinging model_prob by roughly +27 percentage points -- far too much for
  what is really a modest gap between two starters on the shared 20-92
  pitcher_score scale. Root cause: this coefficient used to just BE
  generate-member-lab.js's ERA_K (0.20), reused unchanged when the model
  switched from an ERA-gap input to a pitcher-score-gap input on 2026-08-15.
  Those two inputs are on very different scales -- ERA_K=0.20 was tuned
  against ERA_CLAMP = [2.75, 6.00], a 3.25-point range, where its max clamped
  swing produced a sane ~1.92x pre-bullpen-odds ceiling. Applied unchanged to
  the pitcher-score gap (clamped at +/-20, a ~6x wider range), that same 0.20
  produces up to ~54.6x -- wildly beyond what the coefficient was ever
  calibrated for. Concrete case that surfaced it: Athletics @ Astros,
  2026-08-23 (gamePk 824150) -- a 19-point score gap alone dragged team
  strength from 43.8% up to 97.2% pre-bullpen, functionally overriding the
  team-strength signal entirely.

  New value, chosen 2026-08-24: 0.03, matching that original ERA-based design
  ceiling. At the max clamped gap (20), exp(0.03*20) = 1.82x -- a maxed-out
  pitcher edge now moves team strength from 50% to about 64.6%, not 97%+. At
  the concrete 6-point case Lynold flagged (two starters "in the same
  playing field"), the swing is now about +4.5 percentage points instead of
  +27.

  ERA_K itself (0.20) is UNCHANGED and still lives locally in
  generate-member-lab.js -- it still correctly prices the separate shadow
  model's (modelV3) FIP-lite ERA gap, which is a genuinely different,
  narrower-scale input. Do not point that usage at this constant; they are
  deliberately different numbers for deliberately different scales. Do not
  add unrelated thresholds to this file -- scoped to this one coefficient
  (and its clamp) only, same convention as gate-constants.js.
*/
const PITCHER_SCORE_K = 0.03;
const PITCHER_SCORE_GAP_CLAMP = 20;

module.exports = { PITCHER_SCORE_K, PITCHER_SCORE_GAP_CLAMP };
