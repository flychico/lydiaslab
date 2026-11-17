/**
 * Leo NBA results page: the one renderer for the static page built at grading
 * (scripts/build-nba-results-page.js) and for the page script in the browser
 * (HO-0031, business/RESULTS_DESIGN.md section 1, DEC-20261110-30).
 *
 *   render(doc, { team, date, all, nick, today }) -> HTML for #app
 *
 * doc is data/nba/results-days.json. Team nicknames in all visible text;
 * codes only in URLs, data attributes and filter values. No dashes in copy.
 */
(function () {
'use strict';

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sgn = v => v == null ? "" : v === 0 ? "PK" : (v > 0 ? "+" : "") + v;
const u = v => (v > 0 ? "+" : "") + (+v).toFixed(2);
const unitsTxt = v => u(v) + (Math.abs(v) === 1 ? " unit" : " units");
const pct = p => Math.round(p * 100) + "%";
const dayLong = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const dayShort = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const rec = c => c.w + "-" + c.l + (c.p ? "-" + c.p : "");
const STATIC_DAYS = 21;
const REASON_HELP = {
  injury_input: "Leo had the wrong players in or out.",
  market_knew: "The line moved away from Leo before tip, and was right to.",
  overtime: "Level after regulation, settled in overtime.",
  blowout: "A runaway that the line missed about as badly.",
  variance: "The line missed by about as much as Leo, within 3 points. Shooting and luck.",
  model_error: "The line was closer than Leo by more than 3 points. These drive model changes."
};

function make(nick) {
  const N = c => esc(nick(c));
  const the = c => "the " + N(c);
  const title = g => N(g.away) + " at " + N(g.home);
  const link = g => '<a href="' + esc(g.url) + '">' + title(g) + "</a>";
  /** "The Thunder beat the Grizzlies 128 to 97" */
  function finalWords(g) {
    const hw = g.hs > g.as, w = hw ? g.home : g.away, l = hw ? g.away : g.home;
    return "The " + N(w) + " beat " + the(l) + " " + Math.max(g.hs, g.as) + " to " + Math.min(g.hs, g.as) + (g.ot ? " in overtime" : "");
  }
  /** "Leo had the Raptors to win (66%), by 5.5" */
  function leoRead(g) {
    const fav = g.p_home >= .5 ? g.home : g.away, p = Math.max(g.p_home, 1 - g.p_home), by = Math.abs(g.leo_spread);
    return "Leo had " + the(fav) + " to win (" + (Math.round(p * 100) === 50 ? (p * 100).toFixed(1) + "%" : pct(p)) + ")" + (by ? ", by " + by : ", close to even");
  }
  function dkRead(g) {
    if (g.mkt_spread == null) return "No DraftKings line was saved";
    if (g.mkt_spread === 0) return "DraftKings had it a pick'em";
    return "DraftKings had " + the(g.mkt_spread < 0 ? g.home : g.away) + " by " + Math.abs(g.mkt_spread);
  }
  /** One game as a small final score, Leo's pick and read beside it (results first, Nov 16 rebuild). */
  function gameRow(g) {
    const t = (c, sc, w) => '<div class="gr-t' + (w ? " w" : "") + '"><span>' + N(c) + "</span><b>" + sc + "</b></div>";
    const p = g.pick, mk = r => r === "win" ? "&#10004;" : r === "loss" ? "&#10008;" : "&#8213;";
    const call = p
      ? '<div class="gr-call ' + (p.result === "win" ? "ok" : p.result === "loss" ? "no" : "") + '"><span class="gr-mk">' + mk(p.result) + '</span><span><small>Leo Pick</small><span class="nw">' + N(p.team) + " ML " + sgn(p.price) + '</span><em>' + (p.result === "win" ? "Won " : p.result === "loss" ? "Lost " : "Push ") + u(p.units) + "u</em></span></div>"
      : '<div class="gr-call none-call"><span>No Leo Pick</span></div>';
    const tags = [];
    if (g.upset) tags.push('<span class="gr-tag">Upset' + (g.upset.leo_saw_it ? ", Leo saw it" : "") + "</span>");
    if (g.ot) tags.push('<span class="gr-tag">Overtime</span>');
    return '<article class="gr" data-away="' + esc(g.away) + '" data-home="' + esc(g.home) + '"><div class="gr-main"><div class="gr-score">' +
      t(g.away, g.as, g.as > g.hs) + t(g.home, g.hs, g.hs > g.as) + "</div>" + call + "</div>" +
      '<p class="gr-read">' + leoRead(g) + '. <span class="' + (g.leo_right ? "ok" : "no") + '">' + (g.leo_right ? "Right" : "Wrong") + "</span>.</p>" +
      (g.miss ? '<p class="gr-why"><span class="reason r-' + esc(g.miss.reason) + '">' + esc(g.miss.label) + "</span> " + esc(g.miss.evidence) + "</p>" : "") +
      '<div class="gr-foot">' + tags.join("") + '<a href="' + esc(g.url) + '">Game page</a></div></article>';
  }

  function dayBlock(d, open, team) {
    const games = team ? d.games.filter(g => g.away === team || g.home === team) : d.games;
    if (!games.length) return "";
    const order = games.filter(g => g.pick).concat(games.filter(g => !g.pick));
    const right = games.filter(g => g.leo_right).length;
    const callsTxt = d.calls.n ? "Leo Picks " + rec(d.calls) + ", " + u(d.calls.units) + "u" : "No Leo Pick";
    return '<details class="day" id="d-' + d.date + '" data-date="' + d.date + '"' + (open ? " open" : "") + '><summary><span class="day-date">' + esc(dayLong(d.date)) + '</span><span class="day-sum">' +
      (team ? games.length + (games.length === 1 ? " game" : " games") : callsTxt + " &middot; winner right in " + right + " of " + games.length) + "</span></summary>" +
      '<div class="day-body">' + order.map(gameRow).join("") +
      (team ? "" : '<p class="day-line">Leo Picks this season after this day: <b>' + rec(d.running) + ", " + u(d.running.units) + "u</b></p>") +
      "</div></details>";
  }

  function tiles(items) { return '<section class="rec-row">' + items.map(([l, b, s]) => '<div class="rec"><span class="lab">' + l + '</span><span class="big">' + b + '</span><span class="beat">' + s + "</span></div>").join("") + "</section>"; }

  function learning(doc) {
    const L = doc.learning, T = L.tally;
    const rows = L.order.map(r => "<tr><td><span class=\"reason r-" + r + '">' + esc(L.labels[r]) + '</span><span class="help">' + esc(REASON_HELP[r] || "") + '</span></td><td data-l="This week">' + (T.this_week[r] || 0) + '</td><td data-l="Last week">' + (T.last_week[r] || 0) + '</td><td data-l="Season">' + (T.season[r] || 0) + "</td></tr>").join("");
    const st = { testing: "Testing", measuring: "Measuring", next: "Next test", proposed: "Proposed", adopted: "Adopted", rejected: "Rejected" };
    const tests = (L.tests || []).map(t => '<li><span class="t-status t-' + esc(t.status) + '">' + esc(st[t.status] || t.status) + "</span> <b>" + esc(t.title) + "</b>" + (t.result ? " " + esc(t.result) : "") + "</li>").join("");
    return '<details class="card learn"><summary>Why Leo misses, and what it is testing</summary>' +
      '<p class="sec-p">Every miss gets one reason, worked out from the data: the box score, the injury report Leo read, and how the DraftKings line moved. ' + esc(L.trend) + "</p>" +
      '<section class="card tbl-card"><table class="calls tally"><thead><tr><th>Reason for the miss</th><th>This week</th><th>Last week</th><th>Season</th></tr></thead><tbody>' + rows + "</tbody></table></section>" +
      (tests ? '<h3 class="sub-h">Changes under test</h3><ul class="tests">' + tests + "</ul>" : "") +
      '<p class="sec-p rule">' + esc(L.rule || "Changes are made one at a time, each backed by a backtest.") + "</p></details>";
  }

  /** opts: team (code), date (YYYY-MM-DD), all (show every day) */
  function render(doc, opts) {
    opts = opts || {};
    const S = doc.season, team = opts.team || "", date = opts.date || "";
    let days = doc.days;
    if (date) days = days.filter(d => d.date === date);
    const limited = !opts.all && !team && !date && days.length > STATIC_DAYS;
    const list = limited ? days.slice(0, STATIC_DAYS) : days;
    const opt = (v, t, sel) => '<option value="' + esc(v) + '"' + (sel ? " selected" : "") + ">" + t + "</option>";
    const filters = '<section class="filters" aria-label="Filter by team">' +
      '<div class="field"><label for="f-team">Show one team</label><select id="f-team" onchange="setFilter(\'team\',this.value)">' + opt("", "All teams", !team) +
        doc.teams.map(t => opt(t, N(t), team === t)).join("") + "</select></div>" +
      (date || team ? '<button class="chip-reset" type="button" onclick="clearFilters()">' + (team ? "Show every team" : "Show every day") + "</button>" : "") +
      (team && opts.teamUrl ? '<a class="chip-reset" style="text-decoration:none" href="' + esc(opts.teamUrl(team)) + '">Open the ' + N(team) + " team page</a>" : "") + "</section>";

    const blocks = list.map((d, i) => dayBlock(d, !!date || !!team || i === 0, team)).filter(Boolean);
    const P = S.picks;
    return tiles([
        ["Leo Picks", P.n ? rec(P) : "0-0", P.n ? u(P.units) + " units since " + esc(dayShort(P.from).replace(/^\w+, /, "")) + (P.n < 50 ? ". Early read, " + P.n + " of 50." : ".") : "to win, 60% or more"],
        ["Winner right", S.games ? S.right + " of " + S.games : "0", "DraftKings favorite " + S.mkt_right + " of " + S.mkt_games]
      ]) +
      '<p class="sec-p">A <b>Leo Pick</b> is a team Leo gives 60% or more to win at a price better than -230, one unit each at the price locked when Leo makes the pick. Every game below is graded on Leo&rsquo;s last read before tip.</p>' +
      filters +
      (blocks.length ? blocks[0] + (team || date ? "" : (opts.signup || "")) + blocks.slice(1).join("") : '<div class="score-empty">No graded games for this filter.</div>') +
      (limited ? '<p class="more"><button class="chip-reset" type="button" onclick="showAll()">Show earlier days (' + (days.length - STATIC_DAYS) + " more)</button></p>" : "") +
      learning(doc);
  }
  return { render, finalWords, leoRead, dkRead };
}

const api = { make, STATIC_DAYS };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else if (typeof window !== "undefined") window.NBA_RESULTS_VIEW = api;
})();
