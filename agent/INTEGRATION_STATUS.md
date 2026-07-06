# LyDia Agent v2 — integration status (live site)

This folder is the LyDia Agent v2 methodology package as designed: prompts, templates,
trackers, and rules for a disciplined, verifier-checked daily pick process. It's kept
here for reference and for running the full manual/LLM workflow when you want the
deeper competitor-reasoning and verifier pass described in `AGENT.md` and `README.md`.

**What's already wired into the live, automated site (`scripts/generate-previews.js`,
`scripts/grade-results.js`, running daily via `.github/workflows/daily-recap.yml`):**

- Edge-based no-play logic (`01-agent-core/NO_PLAY_ENGINE.md`) — the live model already
  passes on any market where the raw edge is inside a no-play band, and now says so
  explicitly on the page ("PASS — no edge") instead of staying silent.
- Price discipline (`01-agent-core/PRICE_DISCIPLINE.md`) — every published value pick
  now ships with a current price, a playable-to range, and a re-check note, generated
  automatically from the model's confidence.
- Closing-line value tracking (`POSTMORTEM_LOOP.md` / `06-trackers/clv_tracker.csv`
  concept) — `grade-results.js` now appends every graded pick (moneyline, total, run
  line) to `data/clv/clv_log.csv` in the same spirit as the manual tracker here.
- Total and run-line markets (flagged as a V3 candidate in `NEXT_STEPS.md`) — live in
  the automated model as of this update, using a normal-approximation projection
  layered on the same team/pitcher inputs as the moneyline.
- "Never suppress a pick, never hide a pick behind a paywall" — the live Results and
  Previews pages hold to this; membership is sold on delivery and price-discipline
  alerts, not on access.
- Actual delivery — `scripts/send-member-emails.js` now runs as the last step of the
  daily workflow: it reads that day's `data/picks/<date>.json`, pulls the list of
  people who've submitted the "member-email" form on the Membership page (via the
  Netlify API), and emails each of them the day's picks through Resend. Before this,
  the membership page *promised* delivery but nothing actually sent an email — see
  `EMAIL_SETUP.md` in the repo root for the one-time setup (Resend account + a
  handful of GitHub secrets) needed to switch it on. Until that setup is done, this
  step logs why it's skipping and the rest of the daily run is unaffected.

**What's still manual, on purpose, per this package's own `NEXT_STEPS.md`
("do not automate paid pick publishing until the manual workflow has proven
reliable"):**

- The full seven-stage LLM chain (Data Collector → Edge Engine → Competitor Reasoning
  → Verifier → Publishing → Results Grader → Lessons Learned) is not wired into GitHub
  Actions. Running it would mean calling an LLM from the workflow (a new API key and
  cost to set up) — worth doing once the lighter automated model has a real track
  record, not before.
- Competitor reasoning is still the lightweight best-effort fetch + manual CSV
  (`data/config/manual-competitor-signals.csv`) in the live site, not the full
  `COMPETITOR_REASONING_FRAMEWORK.md` process.
- The trackers in `06-trackers/` are still meant to be filled by hand if you run the
  full manual workflow for a slate — they are separate from `data/clv/clv_log.csv`,
  which is the live, automatic version of the same idea.

Nothing here was deleted or replaced — this is additive. Use the prompts in
`02-prompts/` any time you want a deeper, hand-run pass on a specific slate.
