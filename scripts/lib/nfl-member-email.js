/**
 * Leo NFL member emails (HO-0060, launch plan day 5, DEC-20261113-50).
 *
 *   brief(games, opts)   the member brief before a slate: Leo's three calls
 *                        for every game, the reasoning in plain words, and
 *                        the inputs Leo read (quarterbacks, who is out, the
 *                        ratings, Leo's number beside the line and the gap).
 *                        No prop reads and no touchdown chances (Lynold,
 *                        2026-11-13: "Drop them"); those stay on the free site.
 *   review(rv, date)     the morning after review of one graded game day:
 *                        the calls with units, every miss with its reason and
 *                        one sentence of evidence, the upsets, what Leo got
 *                        right. From data/nfl/results-review.json, so the
 *                        labels match /nfl/results/.
 *   upsell()             the one line the free card carries about members.
 *
 * Numbers come only from the files: data/nfl/matchups/<date>.json (the same
 * read the card and the game pages show), data/nfl/picks-<date>.json (the
 * quarterback source), data/nfl/ml-inputs-history.csv through
 * nfl-page-copy.js drivers(), and data/nfl/results-review.json.
 * Copy rules: no dashes, no exclamation marks, never a promise of a winning
 * record, never a wager. The footer (email-theme.js) carries 21+ and the
 * problem gambling line.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const E = require("./email-cards");
const TEAMS = require("./nfl-teams");
const CALLS = require("./nfl-calls");
const COPY = require("./nfl-page-copy");
const VIEW = require("./nfl-results-view");

const ROOT = path.join(__dirname, "..", "..");
const { T, SANS, esc } = E;
const F = `font-family:${SANS}`;
const MEMBERSHIP = `${E.SITE}/membership/`;
const r1 = x => Math.round(x * 10) / 10;
const pct = p => `${Math.round(p * 100)}%`;
const nick = a => TEAMS.nick(a);
const am = v => v == null || v === "" ? "" : (+v > 0 ? "+" : "") + v;
const u = v => (v > 0 ? "+" : v < 0 ? "-" : "") + Math.abs(v).toFixed(2) + "u";
const rec = (w, l, p) => `${w}-${l}${p ? `-${p}` : ""}`;
const longDate = d => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const shortDate = d => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
function clock(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  return Number.isFinite(h) ? `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, "0")}${h < 12 ? "am" : "pm"} ET` : "";
}
const strip = s => String(s).replace(/<[^>]+>/g, "").replace(/&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/&middot;/g, "·").replace(/&rarr;/g, "->").replace(/&nbsp;/g, " ");
const by = (m, x) => x == null ? "n/a" : x === 0 ? "an even game" : `${nick(x > 0 ? m.home : m.away)} by ${r1(Math.abs(x))}`;
// Team codes in the call labels and pass reasons ("NYG -1.5", "NYG 51%")
// read as nicknames in sentences.
const nickify = (m, t) => String(t == null ? "" : t).replace(new RegExp(`\\b(${m.away}|${m.home})\\b`, "g"), a => nick(a));
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
const lineTxt = (m, l) => l == null ? "n/a" : +l === 0 ? "pick'em" : `${nick(+l > 0 ? m.home : m.away)} -${Math.abs(+l)}`;

// Small building blocks in the email look.
const h4 = t => `<div style="${F};font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${T.text};margin:0 0 6px">${t}</div>`;
function grid(rows, head) {
  const cell = (c, i, hd) => `<td${i ? ' align="right"' : ""} style="${F};font-size:${hd ? 10 : 13}px;${hd ? `font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${T.dim};padding:0 4px 5px` : `color:${T.text};padding:6px 4px;border-top:1px solid ${E.X.line}`};vertical-align:top">${c}</td>`;
  return E.tbl((head ? `<tr>${head.map((c, i) => cell(c, i, true)).join("")}</tr>` : "") + rows.map(r => `<tr>${r.map((c, i) => cell(c, i, false)).join("")}</tr>`).join(""));
}
const result = r => r === "W" ? E.pill("Won", "good") : r === "L" ? E.pill("Lost", "live") : E.pill("Push", "muted");

/* ------------------------------------------------------------ record */

// The three calls since Nov 2, from results-review.json (the same numbers as
// the tiles on /nfl/results/), "early read, N of 50 calls" while under 50.
function recordTiles(rv) {
  const T3 = rv && rv.three;
  if (!T3) return { html: "", text: "" };
  const one = (label, t) => {
    const n = t.w + t.l + t.p;
    return { label, value: rec(t.w, t.l, t.p), sub: `${u(t.units)} &middot; ${n < 50 ? `early read, ${n} of 50 calls` : `${n} calls`}` };
  };
  const items = [one("Moneyline", T3.ml), one("Spread", T3.spread), one("Total", T3.total)];
  const all = ["ml", "spread", "total"].reduce((a, k) => a + T3[k].units, 0);
  return {
    html: E.panel(`Leo&rsquo;s three calls since ${esc(shortDate(T3.from))}, through ${esc(shortDate(rv.through))}`, E.tiles(items) +
      `<div style="${F};font-size:12px;color:${T.dim};margin-top:2px">All three together: <b style="color:${T.text}">${u(all)}</b>. Moneyline graded at the price when Leo made the call, spread and total at -110. Under 50 calls a record says little either way.</div>`),
    text: `Leo's three calls since ${shortDate(T3.from)} (through ${shortDate(rv.through)}): ` + items.map(i => `${i.label} ${i.value}, ${strip(i.sub)}`).join("; ") + `. All three together ${u(all)}.`
  };
}

/* ------------------------------------------------------------ brief */

function callsOf(m) {
  const g = m.leo && m.leo.game;
  if (!g) return null;
  return g.calls || CALLS.calls({ ...g, away: m.away, home: m.home, model_prob: g.prob });
}

// "Why Leo has X at N%": the moneyline model's own split (nfl-page-copy.js
// drivers(): home field, quarterback, offense, defense in points of win
// chance), or words only when the saved inputs do not reproduce the number.
function whyLines(m, P) {
  const g = m.leo.game;
  const D = COPY.drivers(m) || (P && P.ml_inputs ? COPY.drivers(m, { ...P.ml_inputs, home_qb_name: P.home_qb, away_qb_name: P.away_qb }) : null);
  const out = [];
  if (D) {
    const pts = (k, label, words) => {
      const p = D.pts[k]; if (p == null) return;
      const n = Math.round(Math.abs(p));
      out.push(`${label}: ${words} ${n < 1 ? "Barely moves Leo's number." : `Moves Leo about ${n} point${n === 1 ? "" : "s"} toward the ${nick(p > 0 ? m.home : m.away)}.`}`);
    };
    const hq = D.row.home_qb_name || m.home_qb_name, aq = D.row.away_qb_name || m.away_qb_name;
    const ahead = (x, h, a) => cap(Math.abs(x) < 0.15 ? `${h} and ${a} rate about the same` : `${x > 0 ? h : a} rates ahead of ${x > 0 ? a : h}`).replace(/\.$/, "") + ".";
    pts("home", "Home field", `${nick(m.home)} at home${m.div_game ? " in a division game" : ""}.`);
    pts("qb_diff", "Quarterback", hq && aq ? ahead(Number(D.row.qb_diff), hq, aq) : "Starting quarterbacks compared.");
    pts("off_diff", "Offense", ahead(Number(D.row.off_diff), `the ${nick(m.home)} offense`, `the ${nick(m.away)} offense`));
    pts("def_diff", "Defense", ahead(Number(D.row.def_diff), `the ${nick(m.home)} defense`, `the ${nick(m.away)} defense`));
  } else {
    out.push("Leo's win chance comes from four things: home field, the starting quarterbacks, each offense and each defense, all measured from games before this one.");
  }
  // Two separate models: say so when they point different ways.
  const mt = g.proj_spread > 0 ? m.home : g.proj_spread < 0 ? m.away : null;
  if (g.proj_spread != null && (mt !== g.pick || Math.abs(g.proj_spread) < 1.5)) {
    out.push(`Two models: the win chance favors the ${nick(g.pick)} at ${pct(g.prob)}, while Leo's margin model has ${by(m, g.proj_spread)}. Read it as a closer game than ${pct(g.prob)} suggests.`);
  }
  return out;
}

// Leo's number beside the line at read time, the gap, and the verdict.
function numbers(m, C, P) {
  const g = m.leo.game;
  const mlTeam = g.pick, mkt = g.market_prob;
  const rows = [];
  const verdict = (c, passTxt) => c && c.call ? `<b style="color:${T.good}">Call: ${esc(nickify(m, c.label))}</b>` : `<span style="color:${T.dim}">No call: ${esc(nickify(m, passTxt))}</span>`;
  const priceOf = mlTeam === m.home ? m.home_moneyline : m.away_moneyline;
  rows.push(["Moneyline", `${esc(nick(mlTeam))} ${pct(g.prob)}`, mkt != null ? `${pct(mkt)}${priceOf != null ? ` (${esc(am(priceOf))})` : ""}` : "n/a",
    mkt != null ? `${Math.round((g.prob - mkt) * 100) > 0 ? "+" : ""}${Math.round((g.prob - mkt) * 100)} pts` : "", verdict(C.ml, C.ml && C.ml.pass)]);
  const sGap = g.spread_line != null && g.proj_spread != null ? r1(Math.abs(g.proj_spread - g.spread_line)) : null;
  rows.push(["Spread", esc(by(m, g.proj_spread)), esc(lineTxt(m, g.spread_line)), sGap != null ? `${sGap} pt${sGap === 1 ? "" : "s"}` : "", verdict(C.spread, C.spread && C.spread.pass)]);
  const tGap = g.total_line != null && g.proj_total != null ? r1(Math.abs(g.proj_total - g.total_line)) : null;
  rows.push(["Total", esc(g.proj_total ?? "n/a"), esc(g.total_line ?? "n/a"), tGap != null ? `${tGap} pt${tGap === 1 ? "" : "s"}` : "", verdict(C.total, C.total && C.total.pass)]);
  return {
    html: grid(rows.map(r => [`<b>${r[0]}</b>`, r[1], r[2], r[3]]).concat([]), ["", "Leo", "Line", "Gap"]) +
      `<div style="${F};font-size:12px;color:${T.dim};margin-top:6px;line-height:1.6">${rows.map(r => `<b style="color:${T.text}">${r[0]}:</b> ${r[4]}`).join("<br>")}</div>`,
    text: rows.map(r => `${r[0]}: Leo ${strip(r[1])}, line ${strip(r[2])}${r[3] ? `, gap ${r[3]}` : ""}. ${strip(r[4])}`)
  };
}

function inputs(m, P) {
  const SKILL = /^(QB|RB|WR|TE)$/;
  const lines = [], text = [];
  const src = s => s === "depth_chart" ? "depth chart before kickoff" : s ? String(s).replace(/_/g, " ") : "";
  const aq = P.away_qb || m.away_qb_name, hq = P.home_qb || m.home_qb_name;
  if (aq || hq) {
    const s = `${esc(aq || "n/a")} for the ${esc(nick(m.away))}, ${esc(hq || "n/a")} for the ${esc(nick(m.home))}${P.home_qb_source ? ` (from the ${esc(src(P.home_qb_source))})` : ""}.`;
    lines.push(`<b style="color:${T.text}">Starting quarterbacks:</b> ${s}`); text.push(`Starting quarterbacks: ${strip(s)}`);
  }
  const outs = side => ((m.injuries && m.injuries[side] && m.injuries[side].listed) || []).filter(p => SKILL.test(p.pos) && /^(Out|Doubtful)$/i.test(p.status));
  const miss = ["away", "home"].map(side => { const o = outs(side); return o.length ? `${nick(m[side])}: ${o.map(p => `${p.pos} ${p.player}${/doubtful/i.test(p.status) ? " (doubtful)" : ""}`).join(", ")}` : null; }).filter(Boolean);
  const inj = miss.length ? `${esc(miss.join("; "))}. The win chance counts the starting quarterback; the other absences are listed for context.` : "No quarterback, running back, receiver or tight end listed out or doubtful on either side.";
  lines.push(`<b style="color:${T.text}">Who is out:</b> ${inj}`); text.push(`Who is out: ${strip(inj)}`);
  const R = m.ratings && m.ratings.this_season;
  let ratings = "";
  if (R && R.away && R.home) {
    const f = v => v == null ? "n/a" : Math.round(v);
    ratings = grid([["Quarterback", "qb_rating"], ["Offense", "off_rating"], ["Defense", "def_rating"], ["Overall", "overall"]].map(([l, k]) => [l, f(R.away[k]), f(R.home[k])]),
      ["Ratings this season", esc(nick(m.away)), esc(nick(m.home))]) +
      `<div style="${F};font-size:11px;color:${T.dim};margin-top:4px">0 to 100 against the league, built from efficiency rather than record: 50 is average, every 15 points is one standard deviation.</div>`;
    text.push(`Ratings this season (50 is average): ${["qb_rating", "off_rating", "def_rating"].map((k, i) => `${["QB", "offense", "defense"][i]} ${nick(m.away)} ${f(R.away[k])}, ${nick(m.home)} ${f(R.home[k])}`).join("; ")}`);
  }
  return { html: lines.map(l => `<div style="margin:0 0 6px">${l}</div>`).join("") + ratings, text };
}

function readTime(m) {
  if (!m.leo || !m.leo.captured_at) return "";
  const t = new Date(m.leo.captured_at).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
  return `Leo's read: ${t} ET${m.leo.minutes_before_kickoff != null ? `, ${Math.round(m.leo.minutes_before_kickoff / 60 * 10) / 10} hours before kickoff` : ""}. The calls are graded on the last read before kickoff, which can differ if the news or the line changes.`;
}

function memberGame(m, P) {
  const g = m.leo && m.leo.game;
  const [ac, hc] = E.pairColors(E.NFL_COLORS, m.away, m.home);
  const team = side => ({ abbr: m[side], logo: `${E.SITE}/img/nfl/${encodeURIComponent(m[side])}.png`, name: TEAMS.full(m[side]),
    sub: (P[side + "_qb"] || m[side + "_qb_name"]) ? `QB ${esc(P[side + "_qb"] || m[side + "_qb_name"])}` : "",
    right: esc(am(m[side + "_moneyline"])) || "&nbsp;", rightSub: "" });
  if (!g) {
    return { html: E.gameCard({ href: `${E.SITE}${m.url}`, awayColor: ac, homeColor: hc, time: esc(clock(m.kickoff)), venue: esc(m.stadium || ""),
      badges: [E.pill("Read pending", "muted")], away: team("away"), home: team("home"), notes: ["Leo has no read for this game yet."], cta: "Game page" }),
      text: `${TEAMS.full(m.away)} at ${TEAMS.full(m.home)} (${clock(m.kickoff)}): no read yet.` };
  }
  const C = callsOf(m);
  const leoHome = g.pick === m.home ? g.prob : 1 - g.prob;
  const why = whyLines(m, P), N = numbers(m, C, P), I = inputs(m, P), when = readTime(m);
  const html = E.gameCard({
    href: `${E.SITE}${m.url}`, awayColor: ac, homeColor: hc, time: esc(clock(m.kickoff)), venue: esc(m.stadium || ""),
    badges: [E.pill(C.count ? `${C.count} call${C.count === 1 ? "" : "s"}` : "No calls", C.count ? "good" : "muted")],
    away: team("away"), home: team("home"),
    prob: { away: 1 - leoHome, label: "Leo win chance", text: `${esc(m.away)} ${Math.round((1 - leoHome) * 100)}% &middot; ${esc(m.home)} ${Math.round(leoHome * 100)}%` },
    boxes: [
      { label: "Moneyline", value: C.ml.call ? esc(C.ml.label) : "No call", sub: esc(C.ml.call ? `${pct(g.prob)} to win` : C.ml.short || ""), tone: C.ml.call ? "good" : "muted" },
      { label: "Spread", value: C.spread.call ? esc(C.spread.label) : "No call", sub: esc(C.spread.call ? `gap ${C.spread.gap}` : C.spread.short || C.spread.pass || ""), tone: C.spread.call ? "good" : "muted" },
      { label: "Total", value: C.total.call ? esc(C.total.label) : "No call", sub: esc(C.total.call ? `Leo ${g.proj_total}` : C.total.short || C.total.pass || ""), tone: C.total.call ? "good" : "muted" }
    ],
    notes: [
      h4(`Why Leo has the ${esc(nick(g.pick))} at ${pct(g.prob)}`) + `<ul style="margin:0;padding-left:18px;color:${T.text}">${why.map(l => `<li style="margin:0 0 4px">${esc(l)}</li>`).join("")}</ul>`,
      h4("Leo&rsquo;s numbers beside the line") + N.html,
      h4("What Leo read") + I.html + (when ? `<div style="font-size:11px;margin-top:8px">${esc(when)}</div>` : "")
    ],
    cta: "Full game page"
  });
  const text = [`${TEAMS.full(m.away)} at ${TEAMS.full(m.home)}, ${clock(m.kickoff)}`,
    `  Calls: moneyline ${C.ml.call ? nickify(m, C.ml.label) : "no call"}, spread ${C.spread.call ? nickify(m, C.spread.label) : "no call"}, total ${C.total.call ? C.total.label : "no call"}`,
    `  Why Leo has the ${nick(g.pick)} at ${pct(g.prob)}:`, ...why.map(l => `    ${l}`),
    ...N.text.map(l => `  ${l}`), ...I.text.map(l => `  ${l}`), when ? `  ${when}` : "", `  ${E.SITE}${m.url}`].filter(Boolean).join("\n");
  return { html, text };
}

function picksFor(date) {
  try { return Object.fromEntries(JSON.parse(fs.readFileSync(path.join(ROOT, "data/nfl", `picks-${date}.json`), "utf8")).map(p => [p.matchup, p])); }
  catch (e) { return {}; }
}
function readReview() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "data/nfl/results-review.json"), "utf8")); } catch (e) { return null; }
}

function callsTable(games) {
  const th = t => `<td style="${F};font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${T.dim};padding:4px 4px 6px">${t}</td>`;
  const td = c => `<td style="${F};font-size:13px;padding:7px 4px;border-top:1px solid ${E.X.line};${c && c.call ? `font-weight:800;color:${T.good}` : `color:${T.dim}`}">${c && c.call ? esc(c.label) : "no call"}</td>`;
  return E.tbl(`<tr>${th("Game")}${th("Moneyline")}${th("Spread")}${th("Total")}</tr>` +
    games.map(m => { const C = callsOf(m); return C ? `<tr><td style="${F};font-size:13px;padding:7px 4px;border-top:1px solid ${E.X.line};color:${T.text}"><b>${esc(m.away)} @ ${esc(m.home)}</b><br><span style="color:${T.dim};font-size:11px">${esc(clock(m.kickoff))}</span></td>${td(C.ml)}${td(C.spread)}${td(C.total)}</tr>` : ""; }).join("")) +
    `<div style="${F};font-size:11px;color:${T.dim};margin-top:8px">Moneyline needs more than 60% and a price better than -230. Spread needs Leo 1 point off the line with both models on the same winner. Total needs Leo 1.5 to 7 points off the line.</div>`;
}

/**
 * The member brief for one slate. games: data/nfl/matchups/<date>.json sorted
 * by kickoff. opts.sample: the Thanksgiving free list sample (HO-0060 item 4).
 */
function brief(games, opts = {}) {
  const date = games[0].date, week = games[0].week, nice = longDate(date);
  const P = picksFor(date), rv = readReview(), R = recordTiles(rv);
  const nCalls = games.reduce((a, m) => { const C = callsOf(m); return a + (C ? C.count : 0); }, 0);
  const sample = opts.sample ? "This is a sample of the brief Leo members receive before every slate." : "";
  const subject = `${opts.sample ? "Sample member brief" : "Members"}: Leo NFL Week ${week}, ${nice}`;
  const cards = games.map(m => memberGame(m, P[m.matchup] || {}));
  const body = [
    E.header("NFL"),
    sample ? E.panel("A sample for you", `<div style="${F};font-size:15px;color:${T.text};line-height:1.5">${esc(sample)} <a href="${MEMBERSHIP}" style="color:${T.navy};font-weight:800">See membership &rarr;</a></div>`) : "",
    E.hero({ eyebrow: `Leo NFL members &middot; Week ${esc(week)} &middot; ${esc(nice)}`,
      title: `Member brief: ${games.length} game${games.length === 1 ? "" : "s"}`,
      subtitle: "Leo&rsquo;s three calls for every game, the reasoning behind each in plain words, and the numbers Leo read. Every call is graded after the game, wins and losses alike." }),
    E.tiles([
      { label: "Games", value: games.length, sub: esc(nice.split(",")[0]) },
      { label: "First kickoff", value: esc(clock(games[0].kickoff).replace(" ET", "")), sub: "Eastern time" },
      { label: "Leo&rsquo;s calls", value: nCalls, sub: `of ${games.length * 3} possible` }
    ]),
    R.html,
    E.panel("This slate&rsquo;s calls", callsTable(games)),
    ...cards.map(c => c.html),
    E.footer({ links: [[`${E.SITE}/nfl/results/`, "Leo&rsquo;s record"], [`${E.SITE}/nfl/scoreboard/`, "Live scores"]],
      note: "A call is Leo&rsquo;s graded read of a game, not a wager. Leo can lose any of them, and the record shows every loss." })
  ].filter(Boolean).join("\n");
  const html = E.shell({ title: subject, preheader: `${nCalls} call${nCalls === 1 ? "" : "s"} across ${games.length} game${games.length === 1 ? "" : "s"}, with the reasoning behind each`, body });
  const text = [sample, `Leo NFL member brief, Week ${week}, ${nice}`, R.text, "",
    ...cards.map(c => c.text + "\n"),
    `Leo's record: ${E.SITE}/nfl/results/`, "A call is Leo's graded read of a game, not a wager. Analysis only, not betting advice. 21+. 1-800-MY-RESET.", 'Reply "unsubscribe" to stop these.'].filter(x => x !== "").join("\n");
  return { subject, html, text };
}

/* ------------------------------------------------------------ review */

const REASON = Object.fromEntries(Object.entries(VIEW.REASON).map(([k, v]) => [k, strip(v)]));
const HELP = Object.fromEntries(Object.entries(VIEW.REASON_HELP).map(([k, v]) => [k, strip(v)]));
const MARKET = { ml: "Moneyline", spread: "Spread", total: "Total" };

/**
 * The morning after review of one graded game day. rv: results-review.json.
 * Returns null when the date has no graded games.
 */
function review(rv, date) {
  const gs = rv.games.filter(g => g.date === date);
  if (!gs.length) return null;
  const week = gs[0].week, nice = longDate(date);
  const score = g => g.score.away === g.score.home ? `${g.away_name} ${g.score.away}, ${g.home_name} ${g.score.home}`
    : `${g.winner === g.home ? g.home_name : g.away_name} ${Math.max(g.score.away, g.score.home)}, ${g.winner === g.home ? g.away_name : g.home_name} ${Math.min(g.score.away, g.score.home)}${g.overtime ? " in overtime" : ""}`;
  const three = gs.filter(g => g.three);
  const dayCalls = three.flatMap(g => g.calls.map(c => ({ ...c, g })));
  const sum = cs => ({ w: cs.filter(c => c.result === "W").length, l: cs.filter(c => c.result === "L").length, p: cs.filter(c => c.result === "P").length, units: cs.reduce((a, c) => a + (c.units || 0), 0) });
  const D = sum(dayCalls);
  const run = sum(rv.games.filter(g => g.three && g.date <= date).flatMap(g => g.calls));
  const misses = gs.filter(g => g.miss), ups = gs.filter(g => g.upset);
  const right = gs.filter(g => g.calls.some(c => c.result === "W") || g.leo_right_winner);
  const slug = VIEW.weekSlug(date.slice(0, 4), week);
  const subject = `Members: Leo NFL review, ${nice}: ${D.w + D.l + D.p ? `calls ${rec(D.w, D.l, D.p)}, ${u(D.units)}` : `${gs.length} game${gs.length === 1 ? "" : "s"}`}`;

  const callRows = dayCalls.map(c => [`<b>${esc(c.g.away_name)} at ${esc(c.g.home_name)}</b><br><span style="color:${T.dim};font-size:12px">${MARKET[c.market]}: ${esc(c.text)}</span>`, result(c.result), c.units != null ? `<b>${u(c.units)}</b>` : ""]);
  const missBlock = g => {
    const M = g.miss;
    return `<div style="border-top:1px solid ${E.X.line};padding:10px 0 8px">
      <div style="${F};font-size:15px;font-weight:800;color:${T.text}">${esc(g.away_name)} at ${esc(g.home_name)} <span style="font-weight:600;color:${T.dim};font-size:13px">&middot; ${esc(score(g))}</span></div>
      <div style="${F};font-size:13px;color:${T.dim};margin:4px 0">${E.pill(esc(REASON[M.reason] || M.reason), M.reason === "model_error" ? "live" : M.reason === "variance" ? "muted" : "gold")} &nbsp;${esc(M.why.join(", "))}</div>
      <div style="${F};font-size:14px;color:${T.text};line-height:1.5">${esc(M.evidence)}</div>
      ${HELP[M.reason] ? `<div style="${F};font-size:12px;color:${T.dim};margin-top:2px">${esc(REASON[M.reason])} means ${esc(HELP[M.reason])}.</div>` : ""}</div>`;
  };
  const upRow = g => [`<b>${esc(TEAMS.nick(g.winner))}</b> beat the ${esc(TEAMS.nick(g.upset.fav))}<br><span style="color:${T.dim};font-size:12px">${esc(score(g))}</span>`,
    `${g.upset.fav_prob_market != null ? `market had the ${esc(TEAMS.nick(g.upset.fav))} ${Math.round(g.upset.fav_prob_market)}%` : ""}${g.upset.leo_prob_winner != null ? `<br>Leo gave the ${esc(TEAMS.nick(g.winner))} ${Math.round(g.upset.leo_prob_winner)}%` : ""}`,
    g.upset.leo_saw_it ? E.pill("Leo saw it", "good") : E.pill("Leo missed it", "muted")];
  const rightRow = g => {
    const won = g.calls.filter(c => c.result === "W");
    return [`<b>${esc(g.away_name)} at ${esc(g.home_name)}</b><br><span style="color:${T.dim};font-size:12px">${esc(score(g))}</span>`,
      esc([...(g.leo_right_winner ? [`had the ${TEAMS.nick(g.winner)} as the likelier winner (${Math.round(g.leo.prob)}%)`] : []), ...won.map(c => `${MARKET[c.market].toLowerCase()} ${c.text.split(",")[0]} won`)].join("; "))];
  };

  const body = [
    E.header("NFL"),
    E.hero({ eyebrow: `Leo NFL members &middot; Week ${esc(week)} &middot; morning review`,
      title: `${esc(nice)}, graded`,
      subtitle: "Every call graded, every miss with its reason and the evidence for it, and the upsets. The same reasons as Leo&rsquo;s public record, written for members first." }),
    E.tiles([
      { label: "Calls", value: D.w + D.l + D.p ? rec(D.w, D.l, D.p) : "none", sub: D.w + D.l + D.p ? u(D.units) : "no calls this day" },
      { label: `Since ${esc(shortDate(rv.three ? rv.three.from : CALLS.RULES.FROM))}`, value: rec(run.w, run.l, run.p), sub: `${u(run.units)} &middot; ${run.w + run.l + run.p < 50 ? `early read, ${run.w + run.l + run.p} of 50` : "all three calls"}` },
      { label: "Misses", value: misses.length, sub: `of ${gs.length} game${gs.length === 1 ? "" : "s"}` },
      { label: "Upsets", value: ups.length, sub: ups.length ? `Leo saw ${ups.filter(g => g.upset.leo_saw_it).length}` : "favorites held" }
    ]),
    dayCalls.length ? E.panel("The calls", grid(callRows, ["Call", "Result", "Units"])) : "",
    E.panel("What Leo missed and why", misses.length ? misses.map(missBlock).join("") : `<div style="${F};font-size:14px;color:${T.dim}">No misses on this day.</div>`),
    ups.length ? E.panel("Upsets", grid(ups.map(upRow))) : "",
    right.length ? E.panel("What Leo got right", grid(right.map(rightRow))) : "",
    E.footer({ links: [[`${E.SITE}/nfl/results/${slug}/`, `Week ${esc(week)} results`], [`${E.SITE}/nfl/results/`, "Leo&rsquo;s record"]],
      note: "Variance means the closing line missed by about as much as Leo, or more. Leo&rsquo;s error means the closing line was closer than Leo by more than 3 points." })
  ].filter(Boolean).join("\n");
  const html = E.shell({ title: subject, preheader: `${misses.length} miss${misses.length === 1 ? "" : "es"} explained, ${ups.length} upset${ups.length === 1 ? "" : "s"}`, body });
  const text = [`Leo NFL morning review, ${nice} (Week ${week})`,
    `Calls: ${D.w + D.l + D.p ? `${rec(D.w, D.l, D.p)}, ${u(D.units)}` : "none"}. Since ${shortDate(rv.three ? rv.three.from : CALLS.RULES.FROM)}: ${rec(run.w, run.l, run.p)}, ${u(run.units)}.`, "",
    ...(dayCalls.length ? ["THE CALLS", ...dayCalls.map(c => `  ${c.g.away_name} at ${c.g.home_name}, ${MARKET[c.market]}: ${c.text}: ${c.result === "W" ? "won" : c.result === "L" ? "lost" : "push"}${c.units != null ? ` (${u(c.units)})` : ""}`), ""] : []),
    "WHAT LEO MISSED AND WHY", ...(misses.length ? misses.map(g => `  ${g.away_name} at ${g.home_name} (${score(g)}): ${REASON[g.miss.reason] || g.miss.reason}. ${g.miss.evidence}`) : ["  No misses."]), "",
    ...(ups.length ? ["UPSETS", ...ups.map(g => `  ${TEAMS.nick(g.winner)} beat the ${TEAMS.nick(g.upset.fav)} (${score(g)}); Leo ${g.upset.leo_saw_it ? "saw it" : "missed it"}`), ""] : []),
    ...(right.length ? ["WHAT LEO GOT RIGHT", ...right.map(g => `  ${g.away_name} at ${g.home_name}: ${strip(rightRow(g)[1])}`), ""] : []),
    `Week ${week} results: ${E.SITE}/nfl/results/${slug}/`, "Analysis only, not betting advice. 21+. 1-800-MY-RESET.", 'Reply "unsubscribe" to stop these.'].join("\n");
  return { subject, html, text, games: gs.length, misses: misses.length };
}

/* ------------------------------------------------------------ free card line */

function upsell() {
  const line = "Members get the full reasoning behind every call, and a review of every miss the next morning.";
  return {
    html: E.panel("Leo members", `<div style="${F};font-size:14px;color:${T.text};line-height:1.5">${esc(line)} <a href="${MEMBERSHIP}" style="color:${T.navy};font-weight:800;text-decoration:none">See membership &rarr;</a></div>`),
    text: `${line} ${MEMBERSHIP}`
  };
}

module.exports = { brief, review, upsell, recordTiles };
