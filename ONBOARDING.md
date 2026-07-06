# Onboarding & retention emails (drafts)

This is what's missing right now: when someone signs up on the homepage or a preview
page, the Netlify form captures their email into your Netlify dashboard — it does
**not** automatically email them anything. Netlify Forms is a submission inbox, not a
sending service. To actually deliver the welcome sequence below, connect one of:

- **An ESP** (Mailchimp, ConvertKit, Buttondown, Beehiiv) — most can pull new rows in
  via a Zapier/Make "when new Netlify form submission" trigger, or you export the CSV
  from Netlify and import it periodically.
- **A no-code automation** (Zapier, Make, n8n) watching the Netlify Forms webhook and
  calling your ESP's API to add the subscriber and fire the welcome sequence.

Until one of those is wired up, new signups only see the on-page thank-you message
(implemented on the homepage and on every daily preview page). The drafts below are
ready to paste into whichever ESP you pick.

## Email 1 — Welcome (send immediately)

**Subject:** You're in — here's how LyDia works

Hey — thanks for signing up.

Starting tomorrow morning, you'll get one email before first pitch with the model's
pick for every MLB game on the slate: the team, the win probability, and the reasoning
(team strength, recent form, the pitching matchup, and whether the market agrees).

A few things worth knowing right away:

- Every pick is public and graded — see the full track record, wins and losses alike,
  on the [Results page](https://mlbedges.com/results.html).
- You can see today's picks right now, without waiting for tomorrow's email, on the
  [Picks page](https://mlbedges.com/picks.html).
- This is analysis and education, not betting advice — no model wins every day.

Talk soon,
LyDia

## Email 2 — How to read a pick (day 3)

**Subject:** How to actually read one of our picks

By now you've gotten a couple of picks — here's the 60-second version of how the
model gets there, so the numbers mean something:

1. **Team strength** blends each team's run differential (Pythagorean win%) with
   their last 10 games, so a hot or cold streak matters, but not too much.
2. **Home field** gets its usual small bump (roughly 54/46 historically).
3. **The starting pitchers** shift the number — a real ERA edge on the mound moves
   the favorite a few points either way.
4. **The market** — when we have live odds, we compare our number to the no-vig
   market probability. A pick only gets flagged "Value" when the model beats the
   market by 3+ points.

Full writeups on each of these are on the [Articles page]
(https://mlbedges.com/articles.html) if you want the long version.

## Email 3 — The track record (day 7)

**Subject:** How are the picks actually doing?

One week in — here's where to check the answer yourself, always: the
[Results page](https://mlbedges.com/results.html) shows every graded pick, broken
down by day, with nothing removed. Good stretches and bad ones both stay up.

A quick note on how to judge it: any real model has losing days and losing weeks —
that's normal variance, not proof it's broken. The number that matters is the
long-run record over hundreds of picks, not any single week. If you want to dig into
one day's picks in detail, click into a date on the Results table to see each game.

If you want the picks delivered with zero effort (no checking the site), that's what
[Membership](https://mlbedges.com/membership.html) is for.

---

*Implementation note: replace the placeholder links above with UTM-tagged versions
once you're sending through a real ESP, so you can see which emails drive clicks back
to the site (e.g. `?utm_source=welcome-email&utm_medium=email`).*
