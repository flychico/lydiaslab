# Published Picks

This folder is the official dated record for LyDia picks.

Rules:

1. `scripts/generate-member-lab.js` creates `data/published-picks/YYYY-MM-DD.json`.
2. If a dated file already exists, the engine reuses it instead of overwriting it.
3. `data/published-picks/today.json` is only a convenience mirror for the website's live-results block.
4. `scripts/grade-results.js` grades from this folder first.
5. `data/picks/` remains a backward-compatible mirror, not the source of truth.

Manual override rule:

Do not edit a dated published-picks file after first pitch unless there is a documented data error and the correction is approved by the owner.
