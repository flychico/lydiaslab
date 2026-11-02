/*
  Leo: search basics shared by the NFL and NBA game pages (2026-10-31,
  business/SITE_AND_REPO_REVIEW.md section 4). The MLB game pages already
  carry the same structured data; this gives NFL and NBA pages:
    - jsonLd(): Article + SportsEvent + BreadcrumbList as schema.org JSON-LD
    - relatedLinks(): a "Keep reading" block linking the sport's card and
      record, and each team's other Leo game pages, so a visitor who lands
      from search has somewhere to go next
  Display only. Reads no model output and changes no number.
*/
"use strict";
const fs = require("fs");
const path = require("path");

const ORIGIN = "https://ndhorizon.com";
const AUTHOR = { "@type": "Person", "@id": `${ORIGIN}/writers/lynold/#person`, name: "Lynold Rivera", url: `${ORIGIN}/writers/lynold/` };
const PUBLISHER = { "@type": "Organization", "@id": `${ORIGIN}/#organization`, name: "Leo", url: `${ORIGIN}/` };

const escHtml = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// "2026-10-29" + "20:15" Eastern -> ISO string in UTC. Daylight saving is
// worked out for that date, not assumed.
function easternToIso(date, hhmm) {
  if (!date || !/^\d{1,2}:\d{2}$/.test(String(hhmm || ""))) return null;
  const [h, m] = hhmm.split(":").map(Number);
  const guess = new Date(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(guess).reduce((o, p) => (o[p.type] = p.value, o), {});
  const asEastern = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  const offsetMs = asEastern - guess.getTime();
  return new Date(guess.getTime() - offsetMs).toISOString().replace(".000Z", "Z");
}

/*
  o: { sport: "NFL"|"NBA", url: "/nfl/.../", title, description, startIso,
       homeName, awayName, venue, completed, published, modified }
*/
function jsonLd(o) {
  const url = ORIGIN + o.url;
  const hub = o.sport === "NFL" ? "/nfl/scoreboard/" : "/nba/scoreboard/";
  const event = {
    "@type": "SportsEvent", "@id": `${url}#event`,
    name: `${o.awayName} at ${o.homeName}`,
    sport: o.sport === "NFL" ? "American football" : "Basketball",
    url,
    homeTeam: { "@type": "SportsTeam", name: o.homeName },
    awayTeam: { "@type": "SportsTeam", name: o.awayName },
    competitor: [{ "@type": "SportsTeam", name: o.awayName }, { "@type": "SportsTeam", name: o.homeName }],
  };
  if (o.startIso) event.startDate = o.startIso;
  if (o.venue) event.location = { "@type": "Place", name: o.venue };
  if (o.completed) event.eventStatus = "https://schema.org/EventCompleted";
  const article = {
    "@type": "Article", "@id": `${url}#article`,
    headline: String(o.title || "").replace(/\s*\|\s*Leo$/, ""),
    description: o.description, url, mainEntityOfPage: url,
    author: AUTHOR, publisher: PUBLISHER, isAccessibleForFree: true,
    about: { "@id": `${url}#event` },
  };
  if (o.published) article.datePublished = o.published;
  if (o.modified) article.dateModified = o.modified;
  const crumbs = {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Leo", item: `${ORIGIN}/` },
      { "@type": "ListItem", position: 2, name: o.sport, item: ORIGIN + hub },
      { "@type": "ListItem", position: 3, name: `${o.awayName} at ${o.homeName}`, item: url },
    ],
  };
  const graph = { "@context": "https://schema.org", "@graph": [article, event, crumbs] };
  // "<" escaped so no value can close the script tag.
  return `<script type="application/ld+json">${JSON.stringify(graph).replace(/</g, "\\u003c")}</script>`;
}

// Game folders look like <away>-vs-<home>-prediction-odds-<date>.
const GAME_DIR = /^([a-z0-9]+)-vs-([a-z0-9]+)-prediction-odds-(\d{4}-\d{2}-\d{2})$/;
function listGames(sportDir) {
  if (!fs.existsSync(sportDir)) return [];
  return fs.readdirSync(sportDir).map(n => {
    const m = n.match(GAME_DIR);
    return m && fs.existsSync(path.join(sportDir, n, "index.html")) ? { slug: n, away: m[1], home: m[2], date: m[3] } : null;
  }).filter(Boolean).sort((a, b) => b.date.localeCompare(a.date));
}

/*
  o: { sport: "NFL"|"NBA", root, slug, away, home, awayName, homeName,
       hubs: [[href, label], ...], per: games per team (default 4),
       featured: [href, label, sub] optional - shown as a button-like link above the hubs
       (NBA, 2026-11-02, HO-0004: the night's page was easy to miss in the dotted row) }
*/
function relatedLinks(o) {
  const dir = path.join(o.root, o.sport.toLowerCase());
  const games = listGames(dir).filter(g => g.slug !== o.slug);
  const per = o.per || 4;
  const teamBlock = (abbr, name) => {
    const a = String(abbr).toLowerCase();
    const mine = games.filter(g => g.away === a || g.home === a).slice(0, per);
    // o.teamUrl(abbr) -> the team's page (NFL team pages, 2026-11-02), linked first.
    const teamHref = typeof o.teamUrl === "function" ? o.teamUrl(abbr) : null;
    if (!mine.length && !teamHref) return "";
    return `<div><h3 style="margin:0 0 6px;font-size:1rem">More ${escHtml(name)} games</h3><ul style="margin:0;padding-left:18px;line-height:1.7">`
      + (teamHref ? `<li><a href="${teamHref}">All ${escHtml(name)} predictions this season</a></li>` : "")
      + mine.map(g => `<li><a href="/${o.sport.toLowerCase()}/${g.slug}/">${escHtml(linkText(dir, g))}, ${escHtml(niceShort(g.date))}</a></li>`).join("")
      + `</ul></div>`;
  };
  const hubs = (o.hubs || []).map(([href, label]) => `<a href="${href}">${escHtml(label)}</a>`).join(" &middot; ");
  const teams = [teamBlock(o.away, o.awayName), teamBlock(o.home, o.homeName)].filter(Boolean).join("");
  return `<section class="card" style="margin-top:22px">
  <h2 style="margin:0 0 8px;font-size:1.15rem">Keep reading</h2>
  ${o.featured ? `<a href="${o.featured[0]}" style="display:block;margin:0 0 12px;padding:12px 14px;border:1px solid var(--accent,#C9A84C);border-radius:12px;background:var(--bg-elev,#EDE6D9);text-decoration:none;color:inherit"><b style="font-size:1.05rem">${escHtml(o.featured[1])} &rarr;</b>${o.featured[2] ? `<span style="display:block;font-size:.9rem;opacity:.8;margin-top:2px">${escHtml(o.featured[2])}</span>` : ""}</a>` : ""}
  <p style="margin:0 0 10px">${hubs}</p>
  ${teams ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px">${teams}</div>` : ""}
</section>`;
}

// "Panthers vs Packers Prediction" read from the linked page's title, so the
// link carries the words people search; falls back to "CAR at GB".
function linkText(dir, g) {
  try {
    const t = (fs.readFileSync(path.join(dir, g.slug, "index.html"), "utf8").slice(0, 6000).match(/<title>([^<]*?) Prediction/i) || [])[1];
    if (t) return `${t.replace(/&amp;/g, "&").replace(/&#39;/g, "\u2019")} Prediction`;
  } catch (e) { /* fall through */ }
  return `${g.away.toUpperCase()} at ${g.home.toUpperCase()}`;
}

function niceShort(date) {
  const d = new Date(date + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

module.exports = { jsonLd, relatedLinks, easternToIso, listGames };
