/**
 * Short links for X posts (Lynold, 2026-11-18: "I really hate how the links
 * looks", about ndhorizon.com/nba/results/?u..., then chose "Short link per post").
 *
 *   short(sport, date, postId, dest) -> "https://ndhorizon.com/x/nba-1117-day"
 *
 * Writes x/<slug>/index.html: a page that forwards at once to dest with the X
 * campaign tag (utm_source=x, utm_medium=social, utm_campaign=<sport>-<post id>,
 * HO-0093), so js/app.js still records which post brought a sign-up. noindex,
 * canonical to dest, so the forwarding pages never enter the sitemap or Google.
 * The slug fits the ~28 characters X shows before it cuts a link with "…".
 * Shared (Manager's file); the NBA and NFL post builders call it.
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const SITE = "https://ndhorizon.com";

const code = id => id === "picks" || id === "day" ? id : String(id).replace(/^wave-/, "w");
const slugFor = (sport, date, id) => `${sport}-${date.slice(5, 7)}${date.slice(8, 10)}-${code(id)}`;
const esc = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function short(sport, date, id, dest) {
  const slug = slugFor(sport, date, id);
  const target = `${dest}${dest.includes("?") ? "&" : "?"}utm_source=x&utm_medium=social&utm_campaign=${sport}-${id}`;
  const dir = path.join(ROOT, "x", slug);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="robots" content="noindex,follow">
<link rel="canonical" href="${esc(dest)}">
<meta http-equiv="refresh" content="0; url=${esc(target)}">
<title>Leo</title>
<script>location.replace(${JSON.stringify(target)});</script>
</head><body><p><a href="${esc(target)}">Open the page on ndhorizon.com</a></p></body></html>
`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "index.html");
    if (!fs.existsSync(f) || fs.readFileSync(f, "utf8") !== html) fs.writeFileSync(f, html);
  } catch (e) { return target; }   // cannot write the page: fall back to the tagged link
  return `${SITE}/x/${slug}`;
}

module.exports = { short, slugFor };
