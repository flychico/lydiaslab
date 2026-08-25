/*
  LyDia -- pitcher-score-gap boost coefficient (ERA_K).

  Single source of truth for the coefficient used in every place that prices
  a starting-pitcher score gap into odds: exp(ERA_K * scoreGap), scoreGap
  clamped to +/-PITCHER_SCORE_GAP_CLAMP before the exponential. Shared by:
    - scripts/generate-member-lab.js -- the live moneyline model that
      actually prices picks (the scoreGap-based pitcher boost only; modelV3,
      the dormant shadow A/B model in the same file, uses this same shared
      constant for its own ERA-gap term too -- that was already true before
      this file existed, since both call sites read the same top-level
      variable; not a new coupling introduced by this centralization).
    - scripts/export-pregame-attribution.js and scripts/grade-calibration.js
      -- both ledgers that recompute the same number for logging/grading,
      feeding the home_pitcher_boost / home_pre_bullpen_odds columns.

  2026-08-25, Lynold's explicit instruction: fix a real drift this file's
  own history had already warned about. All three consumers above used to
  carry their own hardcoded local copy of this coefficient. At some point
  after the 2026-08-24 rebalance below, generate-member-lab.js's live copy
  was retuned to 0.15 -- but export-pregame-attribution.js and
  grade-calibration.js were never updated to match and stayed hardcoded at
  the older 0.20, so the attribution log's home_pitcher_boost/
  home_pre_bullpen_odds columns silently stopped matching what the live
  model actually priced. Caught 2026-08-25 while building an Excel replica
  of home_pre_bullpen_odds and finding the two numbers didn't agree.
  Centralizing here for real this time (a same-day attempt to do exactly
  this on 2026-08-24, then named PITCHER_SCORE_K=0.03, was reverted back to
  local copies per Lynold's call that day -- this file was left orphaned,
  imported by nothing, after that revert) at the current correct value: 0.15.

  2026-08-24 background (why this coefficient is NOT just the old ERA-gap
  ERA_K=0.20 reused unchanged): a 6-point pitcher_score gap was swinging
  model_prob by roughly +27 percentage points -- far too much for a modest
  gap on the shared 20-92 pitcher_score scale. ERA_K=0.20 was tuned against
  ERA_CLAMP=[2.75,6.00], a 3.25-point range; applied unchanged to a
  pitcher-score gap (clamped +/-20, a ~6x wider range) it produced up to
  ~54.6x -- wildly beyond calibration. Concrete case: Athletics @ Astros,
  2026-08-23 (gamePk 824150), a 19-point score gap alone dragged team
  strength from 43.8% to 97.2% pre-bullpen. 0.15 is the current live-tuned
  replacement -- at the max clamped gap (20), exp(0.15*20) = 20.1x.

  Do not add unrelated thresholds here -- scoped to this one coefficient
  (and its clamp) only, same convention as gate-constants.js.
*/
const ERA_K = 0.15;
const PITCHER_SCORE_GAP_CLAMP = 20;

module.exports = { ERA_K, PITCHER_SCORE_GAP_CLAMP };
