# Run Line Sanity Check

The run line (total, moneyline, and run line are each projected on their own
model path) must never be published in a way that contradicts the moneyline
pick for the same game. A team's -1.5 and the opposing team's moneyline win
are mutually exclusive outcomes — both cannot be "value" at once.

## The bug this fixes

The run-line cover probability was computed with `Math.abs(homePoint)`,
which silently assumed the home team was always the one laying -1.5. When
the home team was actually the underdog (+1.5), the model still graded them
as if they had to win by 2+, giving out-of-nowhere edges to a spread pick
that ran opposite to the projected winner (e.g., a moneyline lean toward the
home team alongside a "value" run-line pick on the away team's -1.5).

## The rule

Before any run-line pick can be tagged as value:

1. Cover probability uses the **signed** point, not its absolute value. A
   team on +1.5 covers by losing narrowly or winning; a team on -1.5 needs
   to win by 2+.
2. A team can only be picked at a **negative** point (must win by 2+) if
   the model's own moneyline also has that team as the projected winner,
   AND the projected margin actually clears the line (e.g., ≥1.5).
3. A team can be picked at a **positive** point (getting runs) as long as
   the model doesn't project them losing by more than the line.
4. If neither condition holds — i.e., the run-line side would contradict
   the moneyline's projected winner — reject the run-line pick outright.
   It renders as "pass," never as a contradictory value tag.

This is implemented in `scripts/generate-previews.js` (server-side daily
picks + emails) and `picks/index.html` (client-side live picks page), each
in their own run-line block, right after the raw edge computation and
before anything is tagged "Value."

## Brand rule

Two picks for the same game that cannot both be true is a worse failure
than a missed edge. When in doubt, downgrade to a pass and say so plainly.
