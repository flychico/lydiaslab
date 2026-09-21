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
  "cloudflare-worker", "img", "images", "assets", "fonts", "gym"]);

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
  return out.sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
}

function render(pages) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + pages.map(p => `  <url><loc>${ORIGIN}${p}</loc></url>`).join("\n") + `\n</urlset>\n`;
}

function writeSitemap(root) {
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

module.exports = { listPages, writeSitemap, checkSitemap, ORIGIN };
