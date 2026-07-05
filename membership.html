# Automating the daily recap (one-time setup, ~20 minutes)

Once set up, every morning at ~6am ET a robot fetches yesterday's finals, writes a
new recap page at `mlbedges.com/recaps/<date>.html`, updates the archive and sitemap,
and publishes — with your computer off. Each day adds an indexable page, which is the
SEO engine for the site.

## How it works

GitHub stores your site and runs the daily script (GitHub Actions, free).
Netlify redeploys automatically every time the repository changes.

    GitHub Actions (6am ET) → generate-recap.js → commit → Netlify auto-deploy

## Step 1 — Put the site in a GitHub repository

1. Create a free account at https://github.com if you don't have one.
2. Click **New repository**, name it `mlbedges`, keep it **Public** (or Private — both work), create.
3. On the empty repo page choose **uploading an existing file** and drag in ALL the
   contents of the `mlb-edge` folder — including the hidden `.github` folder and the
   `scripts` folder. (If your file explorer hides `.github`, upload the zip contents
   via GitHub Desktop instead, or enable hidden files.)
4. Commit the upload.

## Step 2 — Switch Netlify from drag-and-drop to GitHub

1. In Netlify open your site → **Site configuration → Build & deploy → Link repository**
   (on newer UI: Add new site → Import an existing project, then move the custom domain
   to the new site).
2. Choose GitHub → authorize → pick the `mlbedges` repo.
3. Build settings: leave **Build command empty**, **Publish directory** = `/` (repo root). Deploy.
4. Confirm mlbedges.com still loads. From now on every commit deploys automatically.

## Step 3 — Confirm the robot works

1. In GitHub open the repo → **Actions** tab → "Daily recap" → **Run workflow** (manual test).
2. Watch it finish green, then check `mlbedges.com/recaps/` — yesterday's recap should be there.
3. That's it. It now runs itself every morning.

## Notes

- The schedule (6am ET) is in `.github/workflows/daily-recap.yml` — edit the cron line to change it.
- If there were no games (off-day), the script publishes nothing and the run just ends.
- To update site pages in the future, edit files in the GitHub repo (or ask Claude for a new
  version and upload) — Netlify redeploys on every commit.
- Submit `https://mlbedges.com/sitemap.xml` in Google Search Console once — the daily script
  keeps it updated with every new recap page automatically.
