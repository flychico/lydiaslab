#!/usr/bin/env node
/*
  LyDia site health cleanup.
  Removes invalid generated artifacts and stale/invalid today mirrors.
  It never edits manual content, historical results, or membership pages.
*/
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SITE = "https://lydiaslab.com";
const FIX = process.argv.includes("--fix");
const issues = [];
const deleted = [];

main();

function main() {
  const badDates = findBadEmptyDates();
  for (const date of badDates) {
    issues.push(`Invalid generated slate detected for ${date}`);
    if (FIX) removeGeneratedDate(date);
  }

  if (FIX) {
    removeStaleTodayMirrors();
    removeInvalidTodayMirrors();
    rebuildPreviewArchive();
    rebuildSitemap();
    writeHealthReport(badDates);
  }

  if (issues.length) {
    console.log("Site health issues:");
    for (const issue of issues) console.log(`- ${issue}`);
    if (FIX) {
      console.log(`Fixed ${deleted.length} generated artifact(s).`);
      for (const d of deleted) console.log(`deleted: ${d}`);
    } else {
      console.log("Run with --fix to remove invalid generated artifacts.");
      process.exit(1);
    }
  } else {
    console.log("Site health cleanup found no invalid empty slates.");
  }
}

function readJsonSafe(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")); } catch (e) { return null; }
}
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }
function unlink(rel) {
  const file = path.join(ROOT, rel);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    deleted.push(rel);
  }
}
function datedJsonFiles(relDir) {
  const dir = path.join(ROOT, relDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.replace(".json", ""));
}
function unique(arr) { return [...new Set(arr)].sort(); }

function hasGames(brief) {
  return brief && Array.isArray(brief.games) && brief.games.length > 0;
}
function hasTeams(bullpen) {
  return bullpen && Array.isArray(bullpen.teams) && bullpen.teams.length > 0;
}
function hasItems(file) {
  return file && Array.isArray(file.items) && file.items.length > 0;
}
function hasPicks(file) {
  return file && Array.isArray(file.picks) && file.picks.length > 0;
}

function findBadEmptyDates() {
  const dates = unique([
    ...datedJsonFiles("data/member-brief"),
    ...datedJsonFiles("data/published-picks"),
    ...datedJsonFiles("data/picks")
  ]);
  const bad = [];
  for (const date of dates) {
    const brief = readJsonSafe(`data/member-brief/${date}.json`);
    const published = readJsonSafe(`data/published-picks/${date}.json`);
    const legacy = readJsonSafe(`data/picks/${date}.json`);
    const preview = exists(`previews/${date}.html`) ? fs.readFileSync(path.join(ROOT, "previews", `${date}.html`), "utf8") : "";

    const briefExistsButEmpty = brief && Array.isArray(brief.games) && brief.games.length === 0;
    const previewEmpty = /GAMES<\/div><div[^>]*>0<\/div>/i.test(preview);

    // Under the stricter official-pick gate, zero official picks can be valid.
    // Only delete dated generated artifacts when the research brief itself is empty or the preview is clearly empty.
    const invalidEmptyLockWithoutBrief = !hasGames(brief) && ((published && Array.isArray(published.picks) && published.picks.length === 0) || (legacy && Array.isArray(legacy.picks) && legacy.picks.length === 0));

    if (briefExistsButEmpty || previewEmpty || invalidEmptyLockWithoutBrief) bad.push(date);
  }
  return bad;
}

function removeGeneratedDate(date) {
  unlink(`data/member-brief/${date}.json`);
  unlink(`data/published-picks/${date}.json`);
  unlink(`data/picks/${date}.json`);
  unlink(`data/market/${date}.json`);
  unlink(`data/bullpen/${date}.json`);
  unlink(`previews/${date}.html`);
}

function etToday() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}
function removeStaleTodayMirrors() {
  const today = etToday();
  const mirrorFiles = [
    "data/member-brief/today.json",
    "data/published-picks/today.json",
    "data/picks/today.json",
    "data/market/today.json",
    "data/bullpen/today.json"
  ];
  for (const rel of mirrorFiles) {
    const data = readJsonSafe(rel);
    if (data && data.date && data.date !== today) {
      issues.push(`Stale today mirror detected: ${rel} has date ${data.date}, expected ${today}`);
      unlink(rel);
    }
  }
}
function removeInvalidTodayMirrors() {
  const today = etToday();
  const brief = readJsonSafe("data/member-brief/today.json");
  const hasValidBrief = brief && brief.date === today && hasGames(brief);

  if (brief && brief.date === today && Array.isArray(brief.games) && brief.games.length === 0) {
    issues.push("Invalid today mirror detected: member brief has zero games");
    unlink("data/member-brief/today.json");
  }

  const published = readJsonSafe("data/published-picks/today.json");
  if (published && published.date === today && Array.isArray(published.picks) && published.picks.length === 0 && !hasValidBrief) {
    issues.push("Invalid today mirror detected: published picks empty without a valid member brief");
    unlink("data/published-picks/today.json");
  }

  const picks = readJsonSafe("data/picks/today.json");
  if (picks && picks.date === today && Array.isArray(picks.picks) && picks.picks.length === 0 && !hasValidBrief) {
    issues.push("Invalid today mirror detected: picks empty without a valid member brief");
    unlink("data/picks/today.json");
  }

  const market = readJsonSafe("data/market/today.json");
  if (market && market.date === today && Array.isArray(market.items) && market.items.length === 0 && !hasValidBrief) {
    issues.push("Invalid today mirror detected: market empty without a valid member brief");
    unlink("data/market/today.json");
  }

  const bullpen = readJsonSafe("data/bullpen/today.json");
  if (bullpen && bullpen.date === today && Array.isArray(bullpen.teams) && bullpen.teams.length === 0) {
    issues.push("Invalid today mirror detected: bullpen has zero teams");
    unlink("data/bullpen/today.json");
  }
}
function niceDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])); }
function rebuildPreviewArchive() {
  const dir = path.join(ROOT, "previews");
  fs.mkdirSync(dir, { recursive: true });
  const posts = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).sort().reverse();
  const links = posts.map(f => {
    const date = f.replace(".html", "");
    return `<a href="/previews/${f}">Game Previews - ${esc(niceDate(date))}</a>`;
  }).join("\n");
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>MLB Game Previews archive | LyDia</title><meta name="description" content="Daily MLB game previews generated after LyDia's Lab Rating, pitcher matchup, bullpen fatigue, and market checks."><link rel="stylesheet" href="/css/style.css"><style>.archive-list a{display:block;padding:8px 0;border-bottom:1px solid var(--border)}</style></head><body><nav id="nav"></nav><main><h1>Game Previews</h1><p class="subtitle">Daily previews rendered from LyDia's daily engine.</p><div class="card archive-list">
${links || '<p class="dim">No preview archive is available yet.</p>'}
</div></main><footer id="footer"></footer><script src="/js/app.js"></script><script>renderNav("/previews/"); renderFooter();</script></body></html>
`;
  fs.writeFileSync(path.join(dir, "index.html"), html, "utf8");
}
function rebuildSitemap() {
  const staticPages = ["", "dashboard/", "picks/", "tools/", "stats/", "recaps/", "articles/", "membership/", "results/", "previews/", "member-brief/",
    "mlb-betting-edge-explained/", "no-vig-odds-calculator-guide/", "how-to-find-value-in-mlb-moneylines/",
    "closing-line-value-mlb-betting/", "mlb-run-line-vs-moneyline/", "mlb-bullpen-fatigue-betting/",
    "mlb-park-factors-betting-guide/", "mlb-pitching-metrics-for-betting/", "how-to-bet-on-mlb/", "tools/offense-matchups/", "tools/pitcher-matchups/", "tools/bullpen-fatigue/", "tools/strikeout-projections/", "tools/totals-projections/"];
  const recapsDir = path.join(ROOT, "recaps");
  const previewsDir = path.join(ROOT, "previews");
  const recapPosts = fs.existsSync(recapsDir) ? fs.readdirSync(recapsDir).filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).map(f => `recaps/${f}`) : [];
  const previewPosts = fs.existsSync(previewsDir) ? fs.readdirSync(previewsDir).filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).map(f => `previews/${f}`) : [];
  // Keep pages owned by other generators alive: the author entity page, the
  // matchup archive, and every indexable matchup page from the manifests.
  // Without this, whichever sitemap writer runs last silently drops them.
  const extraPages = ["writers/lynold/", "mlb/matchups/"];
  const matchupManifestDir = path.join(ROOT, "data", "matchup-pages");
  const matchupUrls = fs.existsSync(matchupManifestDir)
    ? fs.readdirSync(matchupManifestDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .flatMap(f => { try { return (JSON.parse(fs.readFileSync(path.join(matchupManifestDir, f), "utf8")).pages || []); } catch (e) { return []; } })
        .filter(p => p.indexable && p.url).map(p => p.url)
    : [];
  const urls = staticPages.map(p => `${SITE}/${p}`).concat(recapPosts.map(p => `${SITE}/${p}`)).concat(previewPosts.map(p => `${SITE}/${p}`)).concat(extraPages.map(p => `${SITE}/${p}`)).concat(matchupUrls);
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` + urls.map(u => `  <url><loc>${u}</loc></url>`).join("\n") + `\n</urlset>\n`, "utf8");
}
function writeHealthReport(badDates) {
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  const report = {
    checked_at: new Date().toISOString(),
    cleanup_version: "lydia-site-health-v2-strict-gates",
    removed_invalid_dates: badDates,
    deleted_artifacts: deleted
  };
  fs.writeFileSync(path.join(ROOT, "data", "site-health.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
}
