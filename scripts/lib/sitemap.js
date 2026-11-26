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
  "research",
  // MichelAngelo (/gym/) is New Dawn Horizon's workout app, not a sports page: kept on the site and linked from
  // the home page's "Other tools" strip, but out of the sports sitemap (Lynold, 2026-11-23).
  "gym"]);

// Pages that stay on the site but are left out of the sitemap, so Google
// spends its visits on pages people search for now. 2026-11-14 (Lynold, "Trim
// the sitemap"): Google had found 533 Leo pages and not visited them; 317 of
// the sitemap's URLs were MLB game pages from the finished 2026 season. MLB
// game pages are left out while the offseason flag exists (data/mlb-offseason.json,
// HO-0037) and, in season, when their game is from an earlier year. The pages
// themselves are unchanged and still linked from the MLB team pages.
const MLB_GAME = /^\/mlb\/[a-z0-9-]+-prediction-odds-(\d{4})-\d{2}-\d{2}(-game-\d)?\/$/;
// MLB team pages too while the offseason flag exists (Lynold, 2026-11-25: "MLB team pages out until March").
const MLB_TEAMS = /^\/mlb\/teams\/([a-z0-9-]+\/)?$/;
function leftOut(root, page) {
  if (MLB_TEAMS.test(page) && fs.existsSync(path.join(root, "data", "mlb-offseason.json"))) return true;
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

function render(pages, mods = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + pages.map(p => `  <url><loc>${ORIGIN}${p}</loc>${mods[p] ? `<lastmod>${mods[p]}</lastmod>` : ""}</url>`).join("\n") + `\n</urlset>\n`;
}

/*
  <lastmod> = the date the page last really changed (Lynold, 2026-11-25, from the SEO spec: "never a hardcoded
  build timestamp on unchanged pages"). No state file: a page this run changed or added (git status: modified or
  new, against the last commit) gets today; every other page keeps the date already in sitemap.xml. A page with no
  date yet gets the date of its last commit when git history has it, else today.
*/
const pageFile = p => p.endsWith("/") ? p.slice(1) + "index.html" : p.slice(1);
function changedFiles(root) {
  try {
    const out = require("child_process").execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "."], { cwd: root, maxBuffer: 64 << 20 }).toString();
    return new Set(out.split("\n").filter(Boolean).map(l => l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop()));
  } catch (e) { return null; }
}
function lastCommitDates(root, files) {
  const out = {};
  if (!files.length) return out;
  try {
    const log = require("child_process").execFileSync("git", ["log", "--format=@%cI", "--name-only", "--", ...files], { cwd: root, maxBuffer: 256 << 20 }).toString();
    let d = null;
    for (const line of log.split("\n")) {
      if (line.startsWith("@")) d = new Date(Date.parse(line.slice(1)) - 5 * 3600e3).toISOString().slice(0, 10);   // New York date
      else if (line && d && !out[line]) out[line] = d;
    }
  } catch (e) {}
  return out;
}
function lastmods(root, pages) {
  const today = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);   // New York date (EST)
  const prev = {};
  const file = path.join(root, "sitemap.xml");
  if (fs.existsSync(file)) for (const m of fs.readFileSync(file, "utf8").matchAll(/<loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?/g))
    if (m[2]) prev[m[1].slice(ORIGIN.length)] = m[2];
  const changed = changedFiles(root);
  const need = pages.filter(p => !prev[p] && !(changed && changed.has(pageFile(p))));
  const hist = lastCommitDates(root, need.map(pageFile));
  const mods = {};
  for (const p of pages) {
    if (changed && changed.has(pageFile(p))) mods[p] = today;
    else mods[p] = prev[p] || hist[pageFile(p)] || today;
  }
  return mods;
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

/*
  Dated hub pages follow the same 7 day rule (Lynold, 2026-11-25, from the SEO spec): an NFL week page
  /nfl/week/<season>-week-N/ once its last game is more than 7 days ago (dates from data/nfl/games-lite.json),
  and an NBA night page /nba/predictions/<date>/ once its date is. The weekly results pages stay indexed.
*/
function addNoindex(f) {
  if (!fs.existsSync(f)) return false;
  const html = fs.readFileSync(f, "utf8"), head = html.slice(0, 6000);
  if (/<meta[^>]+http-equiv=["']refresh["']/i.test(head) || /<meta[^>]+name=["']robots["'][^>]*noindex/i.test(head)) return false;
  let out;
  if (/<meta[^>]+name=["']robots["'][^>]*>/i.test(head)) out = html.replace(/<meta[^>]+name=["']robots["'][^>]*>/i, ROBOTS_STALE);
  else if (/<head[^>]*>/i.test(html)) out = html.replace(/<head[^>]*>/i, h => h + "\n" + ROBOTS_STALE);
  else return false;
  fs.writeFileSync(f, out, "utf8");
  return true;
}
function markStaleHubs(root, today = etToday()) {
  const cutoff = new Date(Date.parse(today + "T00:00:00Z") - STALE_DAYS * 864e5).toISOString().slice(0, 10);
  let n = 0;
  let last = {};
  try {
    for (const g of JSON.parse(fs.readFileSync(path.join(root, "data", "nfl", "games-lite.json"), "utf8")).games)
      if (g.type === "REG") { const k = `${g.season}-week-${g.week}`; if (!last[k] || g.date > last[k]) last[k] = g.date; }
  } catch (e) { last = {}; }
  const wdir = path.join(root, "nfl", "week");
  if (fs.existsSync(wdir)) for (const name of fs.readdirSync(wdir)) {
    const m = /^(\d{4})-week-(\d+)$/.exec(name);
    if (!m || !last[name] || last[name] >= cutoff) continue;
    if (addNoindex(path.join(wdir, name, "index.html"))) n++;
  }
  const ndir = path.join(root, "nba", "predictions");
  if (fs.existsSync(ndir)) for (const name of fs.readdirSync(ndir)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name) || name >= cutoff) continue;
    if (addNoindex(path.join(ndir, name, "index.html"))) n++;
  }
  return n;
}

function writeSitemap(root) {
  markStaleGames(root);
  markStaleHubs(root);
  const pages = listPages(root);
  fs.writeFileSync(path.join(root, "sitemap.xml"), render(pages, lastmods(root, pages)), "utf8");
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

module.exports = { markStaleGames, markStaleHubs, listPages, writeSitemap, checkSitemap, leftOut, ORIGIN };
