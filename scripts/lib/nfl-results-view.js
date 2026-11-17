/**
 * Leo NFL results, rendered (business/RESULTS_DESIGN.md; cleanup DEC-20261110-51).
 *
 * One renderer for the page script on /nfl/results/ (browser) and for
 * scripts/build-nfl-results-pages.js (Node), which writes the same HTML into
 * the page and the permanent week pages /nfl/results/<season>-week-N/. So
 * what Google reads and what a visitor sees are the same.
 *
 *   records(tracker, review)            season tiles: the three calls since
 *                                       RULES.FROM first, then props and
 *                                       touchdowns; older rules collapsed
 *   learning(review, tests)             reason tally plus the open tests
 *   weekList(review, season, current)   links to every week page
 *   weekSection(review, tracker, week, { open, season })   one week, day by day
 *   main(review, tracker, season)       the last two weeks plus the week list
 *
 * Inputs: data/nfl/tracker.json, data/nfl/results-review.json,
 * data/nfl/learning.json. Pure: no network, filesystem or clock reads.
 * Public copy: team nicknames, no dashes, no exclamation marks, no bet language.
 */
(function () {
'use strict';

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt1 = v => String(Math.round(v * 10) / 10);
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = d => { const x = new Date(d + "T12:00:00Z"); return DAYS[x.getUTCDay()] + ", " + MONTHS[x.getUTCMonth()] + " " + x.getUTCDate(); };
const shortDate = d => { const x = new Date(d + "T12:00:00Z"); return MONTHS[x.getUTCMonth()].slice(0, 3) + " " + x.getUTCDate(); };
const rec = (w, l, p) => w + "-" + l + (p ? "-" + p : "");
const u = v => (v > 0 ? "+" : v < 0 ? "-" : "") + Math.abs(v).toFixed(2) + "u";
const cls = r => r === "W" ? "ok" : r === "L" ? "no" : "dim";
const mark = r => r === "W" ? "&#10004;" : r === "L" ? "&#10008;" : "&#8213;";
const weekSlug = (season, w) => `${season}-week-${w}`;

const REASON = { injury_input: "Injury input", market_knew: "The market knew", overtime: "Overtime", blowout: "Blowout", variance: "Variance", model_error: "Leo&rsquo;s error", volume: "Usage", efficiency: "Efficiency" };
const REASON_HELP = { injury_input: "a quarterback Leo&rsquo;s read counted on did not play", market_knew: "the line moved away from Leo&rsquo;s side before kickoff", overtime: "tied after regulation", blowout: "decided by 21 or more, and the line missed about as badly", variance: "the closing line missed by about as much as Leo, or more", model_error: "the closing line was closer than Leo by more than 3 points", volume: "he was used more or less than Leo expected", efficiency: "his yards per attempt, carry or target were off" };
const reasonTag = r => '<span class="reason r-' + esc(r) + '">' + (REASON[r] || esc(r)) + '</span>';

function makeNick(review) {
  const N = {};
  (review.games || []).forEach(g => { N[g.away] = g.away_name; N[g.home] = g.home_name; });
  return a => N[a] || a;
}

/* ---- tiles ------------------------------------------------------------- */
function tallyFor(rows) {
  const s = { w: 0, l: 0, p: 0 }, errs = [];
  for (const r of rows) { if (r.result === "W") s.w++; else if (r.result === "L") s.l++; else if (r.result === "P") s.p++; if (typeof r.err === "number") errs.push(Math.abs(r.err)); }
  const dec = s.w + s.l;
  return { ...s, decided: dec, win_pct: dec ? 100 * s.w / dec : null, mae: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null };
}
function tile(label, big, sub) {
  return '<article class="rec"><span class="lab">' + label + '</span><span class="big">' + big + '</span><span class="beat">' + sub + '</span></article>';
}
function oldTile(label, s, note) {
  if (!s || !s.decided) return "";
  return tile(esc(label), rec(s.w, s.l, s.p), (s.win_pct != null ? s.win_pct.toFixed(0) + "% right" : "") + (s.mae != null ? " &middot; off by <b>" + s.mae.toFixed(1) + "</b> per projection" : "") + (note ? " &middot; " + note : ""));
}
function threeTile(label, t, rule) {
  const n = t.w + t.l + t.p;
  if (!n) return tile(label, "None yet", rule);
  const sample = n < 50 ? "early read, " + n + " of 50 calls" : n + " calls";
  return tile(label, rec(t.w, t.l, t.p), "<b>" + u(t.units) + "</b> &middot; " + sample);
}
function records(tracker, review) {
  const T = review.three || { ml: { w: 0, l: 0, p: 0, units: 0 }, spread: { w: 0, l: 0, p: 0, units: 0 }, total: { w: 0, l: 0, p: 0, units: 0 } };
  const from = shortDate(T.from || "2026-11-02");
  const props = tracker.props || [];
  const P = tallyFor(props), qb = tallyFor(props.filter(r => r.group === "QB")), rb = tallyFor(props.filter(r => r.group === "RB")), wr = tallyFor(props.filter(r => r.group === "WR"));
  const td = tracker.summary && tracker.summary.anytime_td;
  const before = r => r.date < (T.from || "2026-11-02");
  const g = tracker.games || [];
  const now =
    threeTile("Moneyline, since " + from, T.ml, "more than 60%, priced better than -230") +
    threeTile("Spread, since " + from, T.spread, "1 point off the line, both models agree") +
    threeTile("Total, since " + from, T.total, "1.5 to 7 points off the line");
  const extra =
    (P.decided ? tile("Prop calls, season", rec(P.w, P.l), (P.win_pct || 0).toFixed(0) + "% right &middot; quarterbacks " + rec(qb.w, qb.l) + ", running backs " + rec(rb.w, rb.l) + ", receivers " + rec(wr.w, wr.l)) : "") +
    (td && td.n ? tile("Touchdown chances, season", Math.round(td.predicted_pct) + "%", "Leo&rsquo;s average chance &middot; <b>" + Math.round(td.scored_pct) + "%</b> scored &middot; " + td.n.toLocaleString("en-US") + " players") : "");
  const older =
    oldTile("Moneyline picks, Nov 1", tallyFor(g.filter(x => x.model_version !== "leo-nflml-v1" && x.date >= "2026-11-01" && before(x))), "above 60%, no price limit yet") +
    oldTile("Winner picks, Sep 27 to Oct 11", tallyFor(g.filter(x => x.model_version !== "leo-nflml-v1" && x.date < "2026-10-17")), "above 60%") +
    oldTile("Week 2 winners, retired model", tallyFor(g.filter(x => x.model_version === "leo-nflml-v1")), "every game") +
    oldTile("Spread sides, before " + from, tallyFor((tracker.spreads || []).filter(x => x.side && before(x))), "1 point off the line") +
    oldTile("Total sides, before " + from, tallyFor((tracker.totals || []).filter(x => x.side && before(x))), "paused Oct 17 to Nov 4");
  return { now, older, extra };
}

/* ---- What Leo is learning ---------------------------------------------- */
function learning(review, tests) {
  const T = review.tally, weeks = review.weeks.slice().sort((a, b) => Number(a) - Number(b));
  const cur = weeks[weeks.length - 1], prev = weeks[weeks.length - 2];
  const row = (kind, keys) => keys.map(k => {
    const c = (T.weeks[cur] && T.weeks[cur][kind][k]) || 0, p = prev ? ((T.weeks[prev] && T.weeks[prev][kind][k]) || 0) : null, s = T.season[kind][k] || 0;
    if (!s) return "";
    return '<tr><td>' + reasonTag(k) + '<span class="small dim">' + REASON_HELP[k] + '</span></td><td class="n">' + c + '</td><td class="n">' + (p == null ? "" : p) + '</td><td class="n">' + s + '</td></tr>';
  }).join("");
  const gameKeys = ["model_error", "variance", "blowout", "overtime", "injury_input", "market_knew"], propKeys = ["volume", "efficiency"];
  const top = gameKeys.map(k => [k, T.season.games[k] || 0]).sort((a, b) => b[1] - a[1])[0];
  const total = gameKeys.reduce((n, k) => n + (T.season.games[k] || 0), 0);
  const errNow = (T.weeks[cur] && T.weeks[cur].games.model_error) || 0, errPrev = prev ? ((T.weeks[prev] && T.weeks[prev].games.model_error) || 0) : null;
  const trend = errPrev == null ? "" : " Misses that were Leo&rsquo;s own error: <b>" + errNow + "</b> in Week " + esc(cur) + ", <b>" + errPrev + "</b> in Week " + esc(prev) + ".";
  const list = tests && Array.isArray(tests.tests) ? tests.tests : [];
  const testsHtml = list.length
    ? '<h3 class="learn-h3">Changes being tested</h3><ul class="small learn-tests">' +
      list.map(x => '<li><b>' + esc(x.title) + '</b> <span class="test-status s-' + esc(x.status) + '">' + esc(x.status) + '</span>' + (x.result ? ' ' + esc(x.result) : '') + '</li>').join("") + '</ul>'
    : "";
  return '<h2>What Leo is learning</h2>' +
    '<p class="small dim" style="margin:0">Every missed game gets one reason, worked out from the data when the game is graded. Across ' + total + ' missed games this season the most common is <b>' + (REASON[top[0]] || "") + '</b> (' + top[1] + ').' + trend +
    ' Only misses that are Leo&rsquo;s own error point to a model change, and changes are made one at a time, each backed by a backtest.</p>' +
    '<div class="tbl-wrap"><table><thead><tr><th>Why the game was missed</th><th>Week ' + esc(cur) + '</th><th>' + (prev ? 'Week ' + esc(prev) : '') + '</th><th>Season</th></tr></thead><tbody>' + row("games", gameKeys) + '</tbody>' +
    '<thead><tr><th>Why the biggest prop misses happened</th><th>Week ' + esc(cur) + '</th><th>' + (prev ? 'Week ' + esc(prev) : '') + '</th><th>Season</th></tr></thead><tbody>' + row("props", propKeys) + '</tbody></table></div>' + testsHtml;
}

/* ---- one game, in words -------------------------------------------------- */
function sentences(nick) {
  const finalWords = g => {
    const w = g.winner, hi = Math.max(g.score.away, g.score.home), lo = Math.min(g.score.away, g.score.home);
    if (!w) return 'The ' + esc(nick(g.away)) + ' and the ' + esc(nick(g.home)) + ' tied ' + hi + ' to ' + lo;
    const verb = (hi - lo) >= 17 ? 'ran away from' : (hi - lo) <= 3 ? 'edged' : 'beat';
    return 'The ' + esc(nick(w)) + ' ' + verb + ' the ' + esc(nick(g.loser)) + ' ' + hi + ' to ' + lo + (g.overtime ? ' in overtime' : '');
  };
  // Leo's read as his calls. Before the three calls: his win chance only.
  const leoRead = g => {
    if (g.read && g.read.length) return "Leo&rsquo;s calls: " + g.read.map(x => x.market + " " + (x.call ? "<b>" + esc(x.call) + "</b>" : "PASS (" + esc(x.pass) + ")")).join("; ");
    return g.leo.pick && g.leo.prob != null ? 'Leo gave the ' + esc(nick(g.leo.pick)) + ' a ' + Math.round(g.leo.prob) + '% chance' : 'No frozen read';
  };
  return { finalWords, leoRead };
}

function callsFor(tracker, g, nick) {
  const k = x => String(x.week) === String(g.week) && x.matchup === g.matchup;
  const by = (gg, m) => m > 0 ? esc(nick(gg.home)) + ' by ' + fmt1(m) : m < 0 ? esc(nick(gg.away)) + ' by ' + fmt1(-m) : 'level';
  const verdict = r => r ? ' &middot; <span class="' + cls(r) + '">' + (r === "P" ? "PUSH" : r === "W" ? "RIGHT" : "WRONG") + '</span>' : '';
  const off = e => typeof e === "number" ? ' <span class="dim">(off by ' + Math.round(Math.abs(e)) + ')</span>' : '';
  const out = [];
  (tracker.games || []).filter(k).forEach(x => out.push({ o: 0, r: x.result, h: '<b>Moneyline</b> ' + esc(nick(x.pick)) + ' <span class="dim">(' + Math.round(x.leo_prob * 100) + '%)</span> &middot; ' + esc(nick(x.winner)) + ' won' + verdict(x.result) }));
  (tracker.spreads || []).filter(k).forEach(x => {
    if (!x.side) return;
    const h = x.side === x.home ? -x.line : x.line;
    out.push({ o: 1, r: x.result, h: '<b>Spread</b> ' + esc(nick(x.side)) + ' ' + (h > 0 ? '+' + fmt1(h) : h < 0 ? fmt1(h) : 'even') + ' &middot; actual <b>' + by(x, x.actual) + '</b>' + verdict(x.result) });
  });
  (tracker.totals || []).filter(k).forEach(x => {
    if (!x.side) return;
    out.push({ o: 2, r: x.result, h: '<b>Total</b> <span class="side-tag">' + esc(String(x.side).toUpperCase()) + '</span> ' + fmt1(x.line) + ' <span class="dim">&middot; Leo ' + fmt1(x.leo) + '</span> &middot; actual <b>' + fmt1(x.actual) + '</b>' + verdict(x.result) });
  });
  const G = { QB: 3, RB: 4, WR: 5 };
  (tracker.props || []).filter(k).forEach(p => out.push({ o: G[p.group] ?? 9, r: p.result, h: '<b>' + esc(p.group) + '</b> ' + esc(p.player) + ' ' + (p.lean ? '<span class="side-tag">' + esc(String(p.lean).toUpperCase()) + '</span> ' : '') + esc(String(p.line)) +
    ' <span class="dim">&middot; Leo ' + p.leo + '</span> &middot; actual <b>' + p.actual + '</b> ' + esc(p.unit || "") + off(p.err) + verdict(p.result) }));
  return out.sort((a, b) => a.o - b.o).map(c => '<div class="call"><span class="' + cls(c.r) + '">' + mark(c.r) + '</span> ' + c.h + '</div>').join("");
}

/* ---- days and weeks ------------------------------------------------------ */
function sumCalls(calls) {
  const w = calls.filter(c => c.result === "W").length, l = calls.filter(c => c.result === "L").length, p = calls.filter(c => c.result === "P").length;
  return { w, l, p, units: calls.reduce((a, c) => a + (c.units || 0), 0) };
}
// Running three-call record after each day (only days under the three calls).
function runningAfter(review) {
  const days = [...new Set(review.games.filter(g => g.three).map(g => g.date))].sort();
  const run = { w: 0, l: 0, p: 0, units: 0 }, after = {};
  for (const d of days) {
    const s = sumCalls(review.games.filter(g => g.three && g.date === d).flatMap(g => g.calls));
    run.w += s.w; run.l += s.l; run.p += s.p; run.units += s.units; after[d] = { ...run };
  }
  return after;
}

// One game: the final score first, Leo's graded calls beside it (results rebuild, Nov 16).
function gameRow(g, tracker, nick) {
  const N = c => esc(nick(c));
  const t = (c, sc) => '<div class="gr-t' + (g.winner === c ? ' w' : '') + '"><span>' + N(c) + '</span><b>' + sc + '</b></div>';
  const MK = { ml: "Moneyline", moneyline: "Moneyline", spread: "Spread", total: "Total" };
  const word = r => r === "W" ? "Won " : r === "L" ? "Lost " : "Push ";
  const calls = g.calls.map(c => {
    let side = String(c.text || "").split(/, Leo /)[0];
    if (c.market === "ml" || c.market === "moneyline") side = side.replace(/ ([+-]\d+)$/, " ML $1");
    return '<div class="gr-call ' + cls(c.result) + '"><span class="gr-mk">' + mark(c.result) + '</span><span><small>' + (MK[c.market] || esc(c.market)) + '</small><span class="nw">' + esc(side) + '</span>' +
      (c.units != null ? '<em>' + word(c.result) + u(c.units) + '</em>' : '<em>' + word(c.result).trim() + '</em>') + '</span></div>';
  }).join("") || '<div class="gr-call none-call"><span>No call</span></div>';
  const passes = (g.read || []).filter(x => !x.call).map(x => x.market.toLowerCase() + " (" + esc(String(x.pass || "").replace(/^([A-Z]{2,3}) /, (m, c) => nick(c) + " ")) + ")");
  const read = g.leo && g.leo.pick && g.leo.prob != null
    ? 'Leo had the ' + N(g.leo.pick) + ' to win (' + Math.round(g.leo.prob) + '%).' + (g.leo_right_winner == null ? '' : ' <span class="' + (g.leo_right_winner ? 'ok">Right' : 'no">Wrong') + '</span>.')
    : '';
  const props = (tracker.props || []).filter(x => String(x.week) === String(g.week) && x.matchup === g.matchup);
  const tags = [];
  if (g.upset) tags.push('<span class="gr-tag">Upset' + (g.upset.leo_saw_it ? ', Leo saw it' : '') + '</span>');
  if (g.overtime) tags.push('<span class="gr-tag">Overtime</span>');
  return '<article class="gr"><div class="gr-main"><div class="gr-score">' + t(g.away, g.score.away) + t(g.home, g.score.home) + '</div><div class="gr-calls">' + calls + '</div></div>' +
    (read ? '<p class="gr-read">' + read + (passes.length ? ' No call on the ' + passes.join(", ") + '.' : '') + '</p>' : '') +
    (g.miss ? '<p class="gr-why">' + reasonTag(g.miss.reason) + esc(g.miss.evidence) + '</p>' : '') +
    (props.length ? '<details class="gm"><summary>Prop calls on this game (' + props.filter(x => x.result === "W").length + '-' + props.filter(x => x.result === "L").length + ')</summary><div class="calls-in">' +
      callsFor({ props }, g, nick) + '</div></details>' : '') +
    '<div class="gr-foot">' + tags.join("") + (g.url ? '<a href="' + esc(g.url) + '">Game page</a>' : '') + '</div></article>';
}

function dayBlock(review, tracker, date, games, open, after, nick) {
  const three = games.some(g => g.three);
  const s = sumCalls(games.flatMap(g => g.calls));
  const dayProps = (tracker.props || []).filter(x => x.date === date && String(x.week) === String(games[0].week));
  const pw = dayProps.filter(x => x.result === "W").length, pl = dayProps.filter(x => x.result === "L").length;
  const props = (review.prop_misses || []).filter(x => String(x.week) === String(games[0].week) && x.date === date);
  const right = games.filter(g => g.leo_right_winner === true).length, judged = games.filter(g => g.leo_right_winner != null).length;
  const order = games.filter(g => g.calls.length).concat(games.filter(g => !g.calls.length));
  const n = s.w + s.l + s.p;
  const head = (n ? 'Calls ' + rec(s.w, s.l, s.p) + (three ? ', ' + u(s.units) : '') : 'No calls') + ' &middot; winner right in ' + right + ' of ' + judged + (three ? '' : ' &middot; before the three calls');
  const run = after[date];
  const propHtml = props.length ? '<details class="gm"><summary>Biggest prop misses</summary><ul class="small">' + props.map(x => '<li><b>' + esc(x.player) + '</b>, ' + esc(x.team_name) + ': ' + esc(x.lean || "") + ' ' + esc(String(x.line)) + ' ' + esc(x.unit || "") +
      '. Leo ' + x.leo + ', actual <b>' + x.actual + '</b>, off by ' + x.miss + '. ' + reasonTag(x.reason) + esc(x.evidence) + '</li>').join("") + '</ul></details>' : "";
  return '<details class="day"' + (open ? ' open' : '') + '><summary>' + esc(longDate(date)) +
    '<span class="cnt">' + head + '</span></summary><div class="day-body">' + order.map(g => gameRow(g, tracker, nick)).join("") +
    '<p class="day-line">' + (three && run ? 'Calls since ' + shortDate(review.three.from) + ' after this day: <b>' + rec(run.w, run.l, run.p) + ', ' + u(run.units) + '</b>' : '') +
    (dayProps.length ? (three && run ? ' &middot; ' : '') + 'Prop calls this day: ' + rec(pw, pl) : '') + '</p>' + propHtml + '</div></details>';
}

function weekSummary(gs) {
  const s = sumCalls(gs.flatMap(g => g.calls));
  const ups = gs.filter(g => g.upset), seen = ups.filter(g => g.upset.leo_saw_it).length;
  const right = gs.filter(g => g.leo_right_winner === true).length, judged = gs.filter(g => g.leo_right_winner != null).length;
  return gs.length + ' games &middot; calls ' + rec(s.w, s.l, s.p) + (gs.some(g => g.three) ? ' (' + u(s.units) + ')' : '') +
    ' &middot; Leo had the winner in ' + right + ' of ' + judged + ' &middot; ' + ups.length + (ups.length === 1 ? ' upset' : ' upsets') + (ups.length ? ', Leo saw ' + seen : '');
}

function weekSection(review, tracker, w, opts = {}) {
  const nick = makeNick(review), after = runningAfter(review);
  const gs = review.games.filter(g => String(g.week) === String(w));
  if (!gs.length) return "";
  const title = opts.link ? '<a href="/nfl/results/' + weekSlug(opts.season, w) + '/">Week ' + esc(w) + '</a>' : 'Week ' + esc(w);
  let html = '<div class="wk-head"><h2>' + title + '</h2><span class="cnt">' + weekSummary(gs) + '</span></div>';
  const dates = [...new Set(gs.map(g => g.date))].sort((a, b) => b.localeCompare(a));
  dates.forEach((d, i) => {
    html += dayBlock(review, tracker, d, gs.filter(g => g.date === d).sort((a, b) => a.matchup.localeCompare(b.matchup)), opts.open === "all" || (!!opts.open && i === 0), after, nick);
    if (i === 0 && opts.afterFirst) html += opts.afterFirst;
  });
  return html;
}

function weekList(review, season, current) {
  const weeks = review.weeks.slice().sort((a, b) => Number(b) - Number(a));
  return '<nav class="wk-list" aria-label="Every week"><span class="lab">Every week:</span> ' + weeks.map(w =>
    String(w) === String(current) ? '<b>Week ' + esc(w) + '</b>' : '<a href="/nfl/results/' + weekSlug(season, w) + '/">Week ' + esc(w) + '</a>').join(" ") + '</nav>';
}

/** Main page: the two latest weeks in full (latest open), then the week list. */
function main(review, tracker, season, opts = {}) {
  const weeks = review.weeks.slice().sort((a, b) => Number(b) - Number(a));
  const show = weeks.slice(0, 2);
  const older = weeks.slice(2);
  let html = show.map((w, i) => weekSection(review, tracker, w, { open: i === 0, link: true, season, afterFirst: i === 0 ? opts.signup : "" })).join("");
  if (older.length) {
    html += '<div class="card older-weeks"><h2>Earlier weeks</h2><ul>' + older.map(w => {
      const gs = review.games.filter(g => String(g.week) === String(w));
      return '<li><a href="/nfl/results/' + weekSlug(season, w) + '/">Week ' + esc(w) + '</a> <span class="small dim">' + weekSummary(gs) + '</span></li>';
    }).join("") + '</ul></div>';
  }
  return html;
}

// Free card sign up box near the top of the results pages (HO-0093, SEO-24).
// The page script writes it fresh on every load (the prerender saves the form
// already wired, which would leave it dead), then wires it.
function signup() {
  return '<div><b>Get the next card free</b><p>Leo&rsquo;s calls by email before the games start, then graded like the ones above, misses included.</p></div>'
    + '<form class="lydia-signup-form" data-list="free-preview" data-thanks="You are on the list. The next card arrives before the next slate.">'
    + '<input type="email" name="email" required placeholder="you@email.com" aria-label="Email address">'
    + '<input type="hidden" name="bot-field">'
    + '<button class="btn blue" type="submit">Send me the free card</button></form>';
}

const signupBox = () => '<section class="nfl-signup" aria-label="Free card by email">' + signup() + '</section>';
const api = { signupBox, records, learning, weekSection, weekList, main, weekSlug, longDate, signup, REASON, REASON_HELP };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else if (typeof window !== "undefined") window.NFL_RESULTS = api;
})();
