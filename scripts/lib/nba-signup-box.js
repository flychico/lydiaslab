/**
 * Free card sign-up box near the top of the NBA pages X posts link to
 * (SEO-24, HO-0093 part A): /nba/results/ and /nba/predictions/<date>/.
 * Copy from business/launch/2026-11-16-x-landing-signups.md section 2A.
 * Uses the site's form markup (form.lydia-signup-form data-list="free-preview");
 * js/app.js wires it and adds the 21 or over terms line. Works in Node and the browser.
 */
(function () {
const COPY = {
  results: ["Every call here was made before the game",
    "Get the next card free by email before the games start. Every result graded the next morning, misses included."],
  night: ["Get Leo&rsquo;s card before every slate",
    "Free by email: Leo&rsquo;s calls for every NFL and NBA game before kickoff or tip, graded the next morning."]
};
function box(kind) {
  const c = COPY[kind] || COPY.night;
  return '<section class="nba-signup" aria-label="Free card by email" style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:16px 18px;margin:16px 0;box-shadow:var(--shadow-sm)">' +
    '<h2 style="margin:0;font-size:1.12rem">' + c[0] + '</h2>' +
    '<p style="margin:6px 0 12px;color:var(--text-dim);font-size:.92rem">' + c[1] + '</p>' +
    '<form class="lydia-signup-form" data-list="free-preview" data-thanks="You are on the list. The next card arrives before the next slate." style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<input type="email" name="email" required placeholder="you@email.com" aria-label="Email address" style="flex:1 1 180px;min-width:0">' +
    '<input type="hidden" name="bot-field">' +
    '<button class="btn blue" type="submit">Send me the free card</button></form></section>';
}
const api = { box, COPY };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else if (typeof window !== "undefined") window.NBA_SIGNUP = api;
})();
