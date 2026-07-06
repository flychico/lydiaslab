# Setting up daily member emails (one-time, ~15 minutes)

This turns on the last piece of the $30/month promise: every paid member
automatically gets that day's picks emailed to them before first pitch, with
zero manual work from you. Until you do this, the site and daily agent keep
running exactly as before — this step only adds the email send.

## How it works

    GitHub Actions (6-7am ET, same run as everything else)
      → reads data/picks/<date>.json (today's picks, already generated)
      → looks up who's subscribed, via the "member-email" form on the
        Membership page (Netlify collects these submissions automatically)
      → emails each of them that day's picks via Resend

## Step 1 — Resend account (sends the emails)

1. Create a free account at https://resend.com (3,000 emails/month free).
2. Add your domain: **Domains → Add Domain** → enter `mlbedges.com`.
3. Resend will show you 2-3 DNS records (usually a couple of TXT/CNAME records
   for domain verification + DKIM). Add those at whichever registrar/DNS host
   manages mlbedges.com. This can take a few minutes to a few hours to verify —
   Resend's dashboard will show a green check when it's done.
4. Once verified, go to **API Keys → Create API Key** (full access is fine,
   or restrict to "Sending" if offered). Copy the key — you'll only see it once.

## Step 2 — Netlify access token (reads who's subscribed)

1. In Netlify: **User settings → Applications → Personal access tokens → New
   access token**. Name it anything (e.g. "lydia-github-actions"). Copy it.
2. Find your Site ID: your site's **Site configuration → General → Site
   details** page shows "Site ID" near the top.

## Step 3 — Add everything as GitHub secrets

In the GitHub repo: **Settings → Secrets and variables → Actions → New
repository secret**. Add each of these:

| Secret name          | Value                                                   |
|-----------------------|----------------------------------------------------------|
| `RESEND_API_KEY`     | the API key from Resend (Step 1.4)                      |
| `EMAIL_FROM`         | e.g. `LyDia Picks <picks@mlbedges.com>`                  |
| `EMAIL_REPLY_TO`     | your own email, so member replies reach you (optional)  |
| `NETLIFY_API_TOKEN`  | the personal access token from Netlify (Step 2.1)        |
| `NETLIFY_SITE_ID`    | your site ID from Netlify (Step 2.2)                     |

`ODDS_API_KEY` may already be there from before — leave it as is.

## Step 4 — Test it

1. GitHub → **Actions** tab → "Daily content" → **Run workflow**.
2. Open the run → the new "Email today's picks to paid members" step will log
   either "Emailed N member(s)" or a clear reason nothing was sent (e.g. no
   picks file yet, or no one's subscribed so far).
3. Subscribe yourself once on the Membership page with a real email to confirm
   you actually receive one — that's the real end-to-end test.

## What this does *not* do yet (known limitation)

The member list is whatever the "member-email" Netlify form has collected —
there's no live check against PayPal that a given signup is an active paying
subscriber. For the founding stretch this is a reasonable tradeoff (the
picks aren't secret — they're public on the Previews page either way; this
just controls who gets them delivered). If it ever becomes a real abuse
problem, the fix is a small Netlify Function that verifies the PayPal
subscription ID against PayPal's API before someone's added to the list —
worth doing once there's an actual member base to protect.

If any of the five secrets above is missing, the email step logs why and
exits cleanly — it will never break the daily site build.
