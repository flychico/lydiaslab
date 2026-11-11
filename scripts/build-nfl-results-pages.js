#!/usr/bin/env node
/**
 * Leo NFL results pages (business/RESULTS_DESIGN.md; cleanup DEC-20261110-51).
 *
 * Writes, with scripts/lib/nfl-results-view.js (the same renderer the page
 * script uses):
 *   /nfl/results/index.html                 tiles, earlier rules, what Leo is
 *                                           learning, the two latest weeks
 *   /nfl/results/<season>-week-N/index.html one permanent page per week
 *
 * Runs at grading after build-nfl-results-review.js. Display only: reads
 * data/nfl/tracker.json, results-review.json and learning.json.
 *
 * Usage: node scripts/build-nfl-results-pages.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const V = require("./lib/nfl-results-view");

const ROOT = path.resolve(__dirname, "..");
const read = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
const tryRead = f => { try { return read(f); } catch (e) { return null; } };
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fill(html, id, inner) {
  const re = new RegExp(`(<section[^>]*\\bid="${id}"[^>]*>)([\\s\\S]*?)(</section>)`);
  if (!re.test(html)) throw new Error(`section #${id} not found`);
  return html.replace(re, (m, a, b, c) => a + inner + c);
}

function build() {
  const tracker = read("data/nfl/tracker.json");
  const review = read("data/nfl/results-review.json");
  const tests = tryRead("data/nfl/learning.json");
  const d = String(review.through || review.generated_at || "").slice(0, 10);
  const season = +d.slice(5, 7) >= 3 ? d.slice(0, 4) : String(+d.slice(0, 4) - 1);
  const file = path.join(ROOT, "nfl/results/index.html");
  let page = fs.readFileSync(file, "utf8");

  // Main page.
  const R = V.records(tracker, review);
  page = fill(page, "records", R.now);
  page = fill(page, "older", R.older);
  page = fill(page, "learning", V.learning(review, tests));
  page = fill(page, "weekList", V.weekList(review, season, null));
  page = fill(page, "body", V.main(review, tracker, season));
  page = page.replace(/<!-- prerendered [^>]*-->\n?/, "");
  fs.writeFileSync(file, page);

  // One page per week, static (no data fetch).
  const head = page.slice(0, page.indexOf("<body"));
  const nav = (page.match(/<body>[\s\S]*?<\/nav>/) || ["<body>"])[0];
  let wrote = 0;
  for (const w of review.weeks) {
    const slug = V.weekSlug(season, w);
    const url = `/nfl/results/${slug}/`;
    const gs = review.games.filter(g => String(g.week) === String(w));
    const dates = [...new Set(gs.map(g => g.date))].sort();
    const span = dates.length ? `${V.longDate(dates[0])} to ${V.longDate(dates[dates.length - 1])}` : "";
    const title = `NFL Week ${w} ${season} Results: Every Leo Call Graded | Leo`;
    const desc = `Leo's NFL Week ${w} ${season} results, day by day: ${gs.length} games, the upsets, what Leo got right, and what Leo missed and why.`;
    let h = head
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
      .replace(/(<meta name="description" content=")[^"]*"/, `$1${esc(desc)}"`)
      .replace(/(<meta property="og:title" content=")[^"]*"/, `$1${esc(title)}"`)
      .replace(/(<meta property="og:description" content=")[^"]*"/, `$1${esc(desc)}"`)
      .replace(/(<meta property="og:url" content=")[^"]*"/, `$1https://ndhorizon.com${url}"`)
      .replace(/(<link rel="canonical" href=")[^"]*"/, `$1https://ndhorizon.com${url}"`)
      .replace(/(<meta name="twitter:title" content=")[^"]*"/, `$1${esc(title)}"`)
      .replace(/(<meta name="twitter:description" content=")[^"]*"/, `$1${esc(desc)}"`);
    const body = `${nav}
<main class="scoreboard-shell">
  <section class="score-hero">
    <p class="eyebrow"><a href="/nfl/results/">Leo&rsquo;s NFL record</a></p>
    <h1>NFL Week ${esc(w)} results</h1>
    <p class="subtitle">${esc(span)}. Every game Leo read in Week ${esc(w)}, day by day: the upsets, what Leo got right, and what Leo missed and why. Every read was frozen before kickoff and nothing is changed after the fact. Nothing here is a wager.</p>
  </section>
  <section id="weekList" aria-label="Every week">${V.weekList(review, season, w)}</section>
  <section id="body">${V.weekSection(review, tracker, w, { open: true, season })}</section>
  <p class="small dim" style="margin:18px 0">The season record, the reasons behind every miss and how Leo is graded are on <a href="/nfl/results/">Leo&rsquo;s NFL record</a>.</p>
</main>
<footer id="footer"></footer><script src="/js/app.js"></script>
<script>renderNav("/articles/"); renderFooter();</script>
</body>
</html>
`;
    fs.mkdirSync(path.join(ROOT, "nfl/results", slug), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "nfl/results", slug, "index.html"), h + body);
    wrote++;
  }
  console.log(`NFL results pages: /nfl/results/ (${Math.round(page.length / 1024)} KB) and ${wrote} week pages`);
}

if (require.main === module) build();
module.exports = { build };
