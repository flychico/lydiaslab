// Single source for sitemap.xml: built from the pages that actually exist.
// 2026-09-21: four scripts each rebuilt sitemap.xml from their own manifests;
// it had drifted to 722 dead URLs out of 953 and was missing 47 live pages,
// including every NFL page. Now every writer calls writeSitemap(), which walks
// the site and lists each index.html that is indexable: not noindex, not a
// meta-refresh redirect stub.
const fs = require("fs");
const path = require("path");

const ORIGIN = "https://ndhorizon.com";
const SKIP = new Set([".git", ".github", "node_modules", "data", "scripts", "css", "js",
  "cloudflare-worker", "img", "images", "assets", "fonts",
  // Market Desk (/research/) stays out of the sitemap while nothing on the site links it, so Google
  // spends its visits on game pages (Lynold, Nov 19, DEC-20261119-12). Add it back when it is linked.
  "research"]);

// Pages that stay on the site but are left out of the sitemap, so Google
// spends its visits on pages people search for now. 2026-11-14 (Lynold, "Trim
// the sitemap"): Google had found 533 Leo pages and not visited them; 317 of
// the sitemap's URLs were MLB game pages from the finished 2026 season. MLB
// game pages are left out while the offseason flag exists (data/mlb-offseason.json,
// HO-0037) and, in season, when their game is from an earlier year. The pages
// themselves are unchanged and still linked from the MLB team pages.
const MLB_GAME = /^\/mlb\/[a-z0-9-]+-prediction-odds-(\d{4})-\d{2}-\d{2}(-game-\d)?\/$/;
function leftOut(root, page) {
  const m = MLB_GAME.exec(page);
  if (!m) return false;
  if (fs.existsSync(path.join(root, "data", "mlb-offseason.json"))) return true;
  return Number(m[1]) < new Date().getUTCFullYear();
}

function isIndexable(file) {
  const head = fs.readFileSync(file, "utf8").slice(0, 6000).toLowerCase();
  if (/<meta[^>]+name=["']robots["'][^>]*noindex/.test(head)) return false;
  if (/<meta[^>]+http-equiv=["']refresh["']/.test(head)) return false;
  return true;
}

function listPages(root) {
  const out = [];
  (function walk(dir, rel) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".html") || e.name === "404.html") continue;
      const file = path.join(dir, e.name);
      if (!isIndexable(file)) continue;
      if (e.name === "index.html") out.push(rel ? `/${rel}/` : "/");
      else out.push(`/${rel ? rel + "/" : ""}${e.name}`);   // dated cards: /previews/2026-08-01.html
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || (rel === "" && SKIP.has(e.name))) continue;
      walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
    }
  })(root, "");
  return out.filter(p => !leftOut(root, p)).sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
}

function render(pages) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + pages.map(p => `  <url><loc>${ORIGIN}${p}</loc></url>`).join("\n") + `\n</urlset>\n`;
}

// NFL and NBA game pages older than 7 days get <meta name="robots" content="noindex, follow"> and so leave the
// sitemap (Lynold, 2026-11-22, chose the outside review's advice: Google had 585 pages "Discovered, currently not
// indexed", most of them dated game pages nobody searches after the game). Upcoming and recent games stay indexable;
// old pages stay on the site and keep passing links. Runs before every sitemap write, so a page re-rendered later
// gets the tag back on the next run.
const STALE_DAYS = 7;
const GAME_DIR = /-prediction-odds-(\d{4}-\d{2}-\d{2})(-game-\d)?$/;
const ROBOTS_STALE = '<meta name="robots" content="noindex, follow">';
function etToday() { return new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10); }
function markStaleGames(root, today = etToday()) {
  const cutoff = new Date(Date.parse(today + "T00:00:00Z") - STALE_DAYS * 864e5).toISOString().slice(0, 10);
  let n = 0;
  for (const sport of ["nfl", "nba"]) {
    const dir = path.join(root, sport);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const m = GAME_DIR.exec(name);
      if (!m || m[1] >= cutoff) continue;
      const f = path.join(dir, name, "index.html");
      if (!fs.existsSync(f)) continue;
      const html = fs.readFileSync(f, "utf8");
      const head = html.slice(0, 6000);
      if (/<meta[^>]+http-equiv=["']refresh["']/i.test(head) || /<meta[^>]+name=["']robots["'][^>]*noindex/i.test(head)) continue;
      let out;
      if (/<meta[^>]+name=["']robots["'][^>]*>/i.test(head)) out = html.replace(/<meta[^>]+name=["']robots["'][^>]*>/i, ROBOTS_STALE);
      else if (/<head[^>]*>/i.test(html)) out = html.replace(/<head[^>]*>/i, h => h + "\n" + ROBOTS_STALE);
      else continue;
      fs.writeFileSync(f, out, "utf8"); n++;
    }
  }
  return n;
}

function writeSitemap(root) {
  markStaleGames(root);
  const pages = listPages(root);
  fs.writeFileSync(path.join(root, "sitemap.xml"), render(pages), "utf8");
  return pages.length;
}

// Returns problems: dead URLs in sitemap.xml and indexable pages missing from it.
function checkSitemap(root) {
  const want = new Set(listPages(root).map(p => ORIGIN + p));
  const file = path.join(root, "sitemap.xml");
  const have = new Set(fs.existsSync(file)
    ? [...fs.readFileSync(file, "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]) : []);
  return {
    dead: [...have].filter(u => !want.has(u)),
    missing: [...want].filter(u => !have.has(u)),
  };
}

module.exports = { markStaleGames, listPages, writeSitemap, checkSitemap, leftOut, ORIGIN };
