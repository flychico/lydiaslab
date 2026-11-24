/**
 * Free card sign-up box near the top of the NBA pages X posts link to
 * (SEO-24, HO-0093 part A): /nba/results/ and /nba/predictions/<date>/.
 * Copy from business/launch/2026-11-16-x-landing-signups.md section 2A.
 * Also near the top of /nba/previews/, /nfl/previews/ and /parlay/, the pages the picks posts link
 * (OD-08, Lynold 2026-11-24): kind "night", or "thanksgiving" on /nfl/previews/ until the first
 * Thanksgiving kickoff (TG_UNTIL; same copy as the Week 12 NFL pages, OD-06).
 * Uses the site's form markup (form.lydia-signup-form data-list="free-preview");
 * js/app.js wires it and adds the 21 or over terms line. Works in Node and the browser.
 */
(function () {
const COPY = {
  results: ["Get the next card free",
    "Leo&rsquo;s calls by email before the games start, then graded like the ones above, misses included."],
  night: ["Get Leo&rsquo;s card before every slate",
    "Free by email: Leo&rsquo;s calls for every NFL and NBA game before kickoff or tip, graded the next morning."],
  thanksgiving: ["Free on Thanksgiving: the full member brief",
    "Join the free list and on Thursday you get the brief Leo members receive: every call on the Thanksgiving games, the reasoning and the inputs behind it. After that, the free card before every slate.",
    "You are on the list. Thursday&rsquo;s brief arrives before the first kickoff."]
};
const TG_UNTIL = Date.parse("2026-11-26T18:00:00Z");   // Bears at Lions, 1:00pm ET (render-nfl-matchup-pages.js)
/** "thanksgiving" before the first Thanksgiving kickoff, else "night". */
const nflKind = (now) => ((now == null ? Date.now() : now) < TG_UNTIL ? "thanksgiving" : "night");
function box(kind, extraStyle) {
  const c = COPY[kind] || COPY.night;
  return '<section class="nba-signup" aria-label="Free card by email" style="' + (extraStyle || "") + 'background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:16px 18px;margin:16px 0;box-shadow:var(--shadow-sm)">' +
    '<h2 style="margin:0;font-size:1.12rem">' + c[0] + '</h2>' +
    '<p style="margin:6px 0 12px;color:var(--text-dim);font-size:.92rem">' + c[1] + '</p>' +
    '<form class="lydia-signup-form" data-list="free-preview" data-thanks="' + (c[2] || "You are on the list. The next card arrives before the next slate.") + '" style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<input type="email" name="email" required placeholder="you@email.com" aria-label="Email address" style="flex:1 1 180px;min-width:0">' +
    '<input type="hidden" name="bot-field">' +
    '<button class="btn blue" type="submit">Send me the free card</button></form></section>';
}
const api = { box, COPY, TG_UNTIL, nflKind };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else if (typeof window !== "undefined") window.NBA_SIGNUP = api;
})();
