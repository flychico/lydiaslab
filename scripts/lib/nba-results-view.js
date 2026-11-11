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
const STATIC_DAYS = 21, OPEN_DAYS = 7;
const KIND = { pick_lost: "Pick lost", lean_lost: "Lean lost", wrong_winner: "Wrong winner", margin: "Margin" };
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
  const resWord = r => '<span class="' + (r === "win" ? "ok" : r === "loss" ? "no" : "") + '">' + (r === "win" ? "Won" : r === "loss" ? "Lost" : "Push") + "</span>";
  function callLines(g, only) {
    const out = [];
    if (g.pick && (!only || g.pick.result === only))
      out.push('<span class="call-tag">Pick</span> ' + N(g.pick.team) + " to win at " + sgn(g.pick.price) + " (Leo " + pct(g.pick.p) + "). " + resWord(g.pick.result) + ", " + unitsTxt(g.pick.units) + ".");
    if (g.lean && (!only || g.lean.result === only))
      out.push('<span class="call-tag lean">Lean</span> ' + N(g.lean.team) + " " + sgn(g.lean.line) + " on the spread at " + sgn(g.lean.price) + (g.lean.assumed ? " (price assumed)" : "") + ". " + resWord(g.lean.result) + ", " + unitsTxt(g.lean.units) + ".");
    return out;
  }
  function missCard(g) {
    const m = g.miss, kinds = m.kinds.map(k => k === "margin" ? "Margin off by " + g.leo_miss.toFixed(1) : KIND[k]);
    return '<article class="miss" data-reason="' + esc(m.reason) + '"><div class="miss-head"><h4>' + link(g) + '</h4><span class="kinds">' + kinds.map(k => '<span class="kind">' + esc(k) + "</span>").join("") + "</span></div>" +
      "<p>" + finalWords(g) + ". " + leoRead(g) + ". " + dkRead(g) + ".</p>" +
      callLines(g).map(c => '<p class="call-line">' + c + "</p>").join("") +
      '<p class="why"><span class="reason r-' + esc(m.reason) + '">' + esc(m.label) + "</span> " + esc(m.evidence) +
      "" + "</p></article>";
  }
  function upsetLine(g) {
    const x = g.upset;
    return "<li>" + link(g) + ": " + finalWords(g).replace(/^The /, "the ") + ". DraftKings gave " + the(x.fav) + " a " + pct(x.fav_prob_market) + " chance. Leo gave " + the(x.winner) + " " + pct(x.leo_prob_winner) + '. <span class="' + (x.leo_saw_it ? "ok" : "no") + '">' + (x.leo_saw_it ? "Leo saw it" : "Leo missed it") + "</span>.</li>";
  }
  function rightLine(g) {
    return callLines(g, "win").map(c => "<li>" + c + " " + link(g) + ": " + finalWords(g).replace(/^The /, "the ") + ".</li>").join("");
  }
  function otherLine(g) {
    return "<li>" + link(g) + ": " + finalWords(g).replace(/^The /, "the ") + ". " + leoRead(g) + '. <span class="' + (g.leo_right ? "ok" : "no") + '">' + (g.leo_right ? "Right" : "Wrong") + "</span>.</li>";
  }

  function dayBlock(d, open, team) {
    const games = team ? d.games.filter(g => g.away === team || g.home === team) : d.games;
    if (!games.length) return "";
    const ups = games.filter(g => g.upset), wins = games.filter(g => (g.pick && g.pick.result === "win") || (g.lean && g.lean.result === "win"));
    const misses = games.filter(g => g.miss), shown = new Set([...misses, ...wins].map(g => g.id)), others = games.filter(g => !shown.has(g.id));
    const right = games.filter(g => g.leo_right).length;
    const callsTxt = d.calls.n ? "Calls " + rec(d.calls) + ", " + unitsTxt(d.calls.units) : "No calls";
    const sec = (h, body) => '<section class="day-sec"><h3>' + h + "</h3>" + body + "</section>";
    return '<details class="day" id="d-' + d.date + '" data-date="' + d.date + '"' + (open ? " open" : "") + '><summary><span class="day-date">' + esc(dayLong(d.date)) + '</span><span class="day-sum">' +
      games.length + (games.length === 1 ? " game" : " games") + (team ? "" : " &middot; " + callsTxt + " &middot; season after the day " + rec(d.running) + ", " + unitsTxt(d.running.units)) + "</span></summary>" +
      '<div class="day-body"><p class="day-line">Leo had the winner in ' + right + " of " + games.length + (games.length === 1 ? " game" : " games") + "." + (misses.length ? " " + misses.length + (misses.length === 1 ? " miss" : " misses") + " looked at below." : "") + "</p>" +
      sec("Upsets", ups.length ? '<ul class="lines">' + ups.map(upsetLine).join("") + "</ul>" : '<p class="none">No upsets. Every DraftKings favorite won.</p>') +
      sec("What Leo got right", wins.length ? '<ul class="lines">' + wins.map(rightLine).join("") + "</ul>" : '<p class="none">' + (games.some(g => g.pick || g.lean) ? "No winning calls." : "No official calls on " + (team ? "these games" : "this day") + ".") + "</p>") +
      sec("What Leo missed and why", misses.length ? misses.map(missCard).join("") : '<p class="none">Nothing missed: no losing call, no wrong winner and no margin off by 10 or more.</p>') +
      (others.length ? sec("Every other game", '<ul class="lines">' + others.map(otherLine).join("") + "</ul>") : "") +
      "</div></details>";
  }

  function tiles(items) { return '<section class="rec-row">' + items.map(([l, b, s]) => '<div class="rec"><span class="lab">' + l + '</span><span class="big">' + b + '</span><span class="beat">' + s + "</span></div>").join("") + "</section>"; }

  function learning(doc) {
    const L = doc.learning, T = L.tally;
    const rows = L.order.map(r => "<tr><td><span class=\"reason r-" + r + '">' + esc(L.labels[r]) + '</span><span class="help">' + esc(REASON_HELP[r] || "") + '</span></td><td data-l="This week">' + (T.this_week[r] || 0) + '</td><td data-l="Last week">' + (T.last_week[r] || 0) + '</td><td data-l="Season">' + (T.season[r] || 0) + "</td></tr>").join("");
    const st = { testing: "Testing", measuring: "Measuring", next: "Next test", proposed: "Proposed", adopted: "Adopted", rejected: "Rejected" };
    const tests = (L.tests || []).map(t => '<li><span class="t-status t-' + esc(t.status) + '">' + esc(st[t.status] || t.status) + "</span> <b>" + esc(t.title) + "</b>" + (t.result ? " " + esc(t.result) : "") + "</li>").join("");
    return '<section class="learn"><h2 class="sec-h">What Leo is learning</h2>' +
      '<p class="sec-p">Every miss gets one reason, worked out from the data: the box score, the injury report Leo read, and how the DraftKings line moved. ' + esc(L.trend) + "</p>" +
      '<section class="card tbl-card"><table class="calls tally"><thead><tr><th>Reason for the miss</th><th>This week</th><th>Last week</th><th>Season</th></tr></thead><tbody>' + rows + "</tbody></table></section>" +
      (tests ? '<h3 class="sub-h">Changes under test</h3><ul class="tests">' + tests + "</ul>" : "") +
      '<p class="sec-p rule">' + esc(L.rule || "Changes are made one at a time, each backed by a backtest.") + "</p></section>";
  }

  /** opts: team (code), date (YYYY-MM-DD), all (show every day) */
  function render(doc, opts) {
    opts = opts || {};
    const S = doc.season, team = opts.team || "", date = opts.date || "";
    let days = doc.days;
    if (date) days = days.filter(d => d.date === date);
    const limited = !opts.all && !team && !date && days.length > STATIC_DAYS;
    const list = limited ? days.slice(0, STATIC_DAYS) : days;
    const cut = doc.days.length ? new Date(new Date(doc.days[0].date + "T12:00:00Z").getTime() - (OPEN_DAYS - 1) * 864e5).toISOString().slice(0, 10) : "";
    const opt = (v, t, sel) => '<option value="' + esc(v) + '"' + (sel ? " selected" : "") + ">" + t + "</option>";
    const filters = '<section class="filters" aria-label="Filter the record">' +
      '<div class="field"><label for="f-date">Game day</label><select id="f-date" onchange="setFilter(\'date\',this.value)">' + opt("", "All days", !date) +
        doc.days.map(d => opt(d.date, esc(dayShort(d.date)) + " &middot; " + d.games.length + " games" + (d.calls.n ? " &middot; calls " + rec(d.calls) : ""), date === d.date)).join("") + "</select></div>" +
      '<div class="field"><label for="f-team">Team</label><select id="f-team" onchange="setFilter(\'team\',this.value)">' + opt("", "All teams", !team) +
        doc.teams.map(t => opt(t, N(t), team === t)).join("") + "</select></div>" +
      (date || team ? '<button class="chip-reset" type="button" onclick="clearFilters()">Show everything</button>' : "") +
      (team && opts.teamUrl ? '<a class="chip-reset" style="text-decoration:none" href="' + esc(opts.teamUrl(team)) + '">Open the ' + N(team) + " team page</a>" : "") + "</section>";

    const blocks = list.map((d, i) => dayBlock(d, !!date || !!team || i === 0 || d.date >= cut, team)).join("");
    return tiles([
        ["All calls", S.calls.n ? rec(S.calls) : "0-0", S.calls.n ? unitsTxt(S.calls.units) + ". " + (S.calls.n < 50 ? "Under 50 graded calls is an early read." : S.calls.n + " graded calls.") : "none graded yet"],
        ["Leo Picks", S.picks.n ? rec(S.picks) : "0-0", S.picks.n ? unitsTxt(S.picks.units) + " on the moneyline, since " + esc(dayShort(S.picks.from).replace(/^\w+, /, "")) : "to win, 60% or more"],
        ["Leans", S.leans.n ? rec(S.leans) : "0-0", S.leans.n ? unitsTxt(S.leans.units) + " on the spread" : "4 or more points off the spread"],
        ["Winner right", S.games ? S.right + " of " + S.games : "0", "DraftKings favorite " + S.mkt_right + " of " + S.mkt_games],
        ["Average miss", S.miss_leo == null ? "" : S.miss_leo.toFixed(1), "points on the margin. DraftKings spread " + (S.miss_line == null ? "" : S.miss_line.toFixed(1))]
      ]) +
      '<p class="sec-p">A <b>Leo Pick</b> is a team Leo gives 60% or more to win when the DraftKings moneyline on it is better than -230. A <b>lean</b> is Leo 4 or more points off the DraftKings spread. One unit each, at the price saved before tip. A public test, not bets.</p>' +
      learning(doc) +
      '<h2 class="sec-h">Day by day</h2>' +
      '<p class="sec-p">Newest first. Each day: the upsets, what Leo got right, what Leo missed and why, then every other game. Tap a day to open or close it.</p>' +
      filters +
      (blocks || '<div class="score-empty">No graded games for this filter.</div>') +
      (limited ? '<p class="more"><button class="chip-reset" type="button" onclick="showAll()">Show earlier days (' + (days.length - STATIC_DAYS) + " more)</button></p>" : "");
  }
  return { render, finalWords, leoRead, dkRead };
}

const api = { make, STATIC_DAYS };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else if (typeof window !== "undefined") window.NBA_RESULTS_VIEW = api;
})();
