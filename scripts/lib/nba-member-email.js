/**
 * Leo NBA member emails (HO-0061, launch plan day 6). Members only.
 *
 *   brief(card, { record })        -> { subject, html, text, picks }
 *     Before the slate. Per game: Leo's call (Leo Pick or no call, with the
 *     reason), Leo's spread beside DraftKings and the gap, the reasoning in
 *     plain words, and the inputs as Leo read them (team ratings, home court,
 *     rest and back to backs, players counted out or day to day, the line and
 *     price at read time). card = data/nba/picks-<date>.json.
 *
 *   review(day, { season })         -> { subject, html, text, misses }
 *     The morning after. Every miss with its reason label and one sentence of
 *     evidence, the upsets, and what Leo got right. day = one entry of
 *     data/nba/results-days.json (the same labels as /nba/results/, built by
 *     scripts/lib/nba-misses.js).
 *
 * Leo Picks are the only call; leans ended (HO-0056) and never appear here.
 * Nicknames in all visible text. No dashes, no exclamation marks, never a
 * promise of a winning record, never an instruction to bet. Footer is the
 * shared email-theme footer, unchanged, so personalize() can swap in the
 * reader's unsubscribe link.
 */
const E = require("./email-theme");
const { T, SANS, SITE, esc, tbl } = E;
const URLS = require("./nba-urls");
const NW = require("./nba-why");
const PK = require("./nba-picks");

const N = c => URLS.nick(c);
const the = c => "the " + N(c);
const pct = p => p == null ? "-" : Math.round(p * 100) + "%";
const pct1 = p => Math.round(p * 100) === 50 ? (p * 100).toFixed(1) + "%" : pct(p);
const f1 = v => (Math.round(Math.abs(v) * 10) / 10).toFixed(1);
const sgn1 = v => (v > 0 ? "+" : v < 0 ? "-" : "") + f1(v);
const money = v => v == null ? "no price" : PK.fmtPrice(+v);
const units = u => (u > 0 ? "+" : u < 0 ? "-" : "") + Math.abs(u).toFixed(2) + " units";
const tip = iso => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
const niceDate = d => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const pageUrl = g => SITE + (g.url || URLS.gamePath(g));
const fav = (g, homeSpread) => NW.favLine(g, homeSpread, N);
const P = (s, style = "") => `<p style="margin:0 0 8px;font-family:${SANS};font-size:15px;line-height:1.55;color:${T.text};${style}">${s}</p>`;
const label = s => `<div style="font-family:${SANS};font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:${T.dim};margin:14px 0 6px">${s}</div>`;
const ul = items => `<ul style="margin:0 0 4px;padding-left:18px">${items.map(i => `<li style="font-family:${SANS};font-size:14px;line-height:1.55;color:${T.text};margin:0 0 5px">${i}</li>`).join("")}</ul>`;
const plain = s => String(s).replace(/<[^>]+>/g, "").replace(/&rsquo;/g, "'").replace(/&middot;/g, "·").replace(/&amp;/g, "&").replace(/&mdash;/g, "-");

/** "Early read, 15 of 50" while under 50 graded. */
function recordLine(r) {
  if (!r || !r.n) return "No Leo Picks graded yet.";
  const won = r.won ?? r.w, lost = r.lost ?? r.l, push = r.push ?? r.p ?? 0;
  return `${won}-${lost}${push ? "-" + push : ""}, ${units(+r.units)} this season` + (r.n < 50 ? ` (early read, ${r.n} of 50)` : ` (${r.n} graded)`);
}

/* ---------------- member brief ---------------- */

/** Plain words for each part of Leo's margin, biggest first, nicknames. */
function reasons(g) {
  const L = g.leo, parts = L.parts || {}, H = g.home, A = g.away;
  const side = v => v > 0 ? H : A, out = [];
  const add = (v, text) => { if (Math.abs(v) >= 0.05) out.push({ v: Math.abs(v), text }); };
  if (parts.ratings != null) add(parts.ratings, `Team strength: worth ${f1(parts.ratings)} points to the ${N(side(parts.ratings))}, from this season's results.`);
  if (parts.home_court != null) add(parts.home_court, g.neutral ? "Neutral court." : `Home court: worth ${f1(parts.home_court)} points to the ${N(H)}.`);
  if (parts.back_to_back) add(parts.back_to_back, `Back to back: the ${N(side(-parts.back_to_back))} played last night, ${f1(parts.back_to_back)} points toward the ${N(side(parts.back_to_back))}.`);
  if (parts.rest) add(parts.rest, `Rest: ${f1(parts.rest)} points toward the ${N(side(parts.rest))} for the extra days off.`);
  if (parts.missing_players) add(parts.missing_players, `Injuries: the ${N(side(-parts.missing_players))} are missing more, ${f1(parts.missing_players)} points toward the ${N(side(parts.missing_players))}.`);
  return out.sort((a, b) => b.v - a.v).map(x => x.text);
}

function playersLine(g, s) {
  const list = ((g.leo.missing || {})[s]) || [];
  if (!list.length) return `${N(g[s])}: nobody Leo counts is out.`;
  return `${N(g[s])}: ` + list.map(p => `${p.name} (${p.weight >= 1 ? "out" : "day to day, 40% counted"}, ${p.mpg} min a game, worth ${p.value * p.weight < 0.05 ? "under 0.1" : f1(p.value * p.weight)})`).join("; ") + ".";
}

function inputs(g, readAt) {
  const L = g.leo, mk = g.market || {}, H = g.home, A = g.away, r = L.rating || {}, rest = L.rest || {}, b2b = L.back_to_back || {};
  const restTxt = s => b2b[s] ? "on a back to back" : rest[s] != null ? `${rest[s]} day${rest[s] === 1 ? "" : "s"} since the last game` : "rest not known";
  return [
    `Team ratings (points better or worse than an average team): ${N(A)} ${sgn1(r.away || 0)}, ${N(H)} ${sgn1(r.home || 0)}.`,
    `Rest: ${N(A)} ${restTxt("away")}; ${N(H)} ${restTxt("home")}. Leo does not use travel.`,
    `Players counted: ${playersLine(g, "away")} ${playersLine(g, "home")}`,
    mk.home_spread == null ? "DraftKings line: none posted at Leo's read."
      : `DraftKings at Leo's read (${readAt}): ${fav(g, mk.home_spread)}, moneyline ${N(A)} ${money(mk.away_ml)} and ${N(H)} ${money(mk.home_ml)}.`
  ];
}

function callText(g) {
  const pt = PK.pickText(g), cb = PK.callBox(g), pk = g.leo.pick;
  if (pt && pt.ok) return { on: true, head: `Leo Pick: ${N(pk.team)} ${money(pk.price)}`, why: `Leo gives the ${N(pk.team)} ${pct(pk.p)} to win, and the price is better than -230.` };
  const t = pk ? N(pk.team) : null;
  let why = "Neither team reaches 60% with Leo.";
  if (pk && (pk.under || pk.p < PK.PICK_P)) why = `Leo has the ${t} at ${(pk.p * 100).toFixed(1)}%, under the 60% bar.`;
  else if (pk && pk.price == null) why = "There is no moneyline yet.";
  else if (pk) why = `Leo has the ${t} at ${pct(pk.p)}, but the price is ${money(pk.price)}, past -230.`;
  return { on: false, head: "No call", why, sub: cb.sub };
}

function gameBlock(g, readAt) {
  const L = g.leo, mk = g.market || {}, C = callText(g);
  const LS = NW.leoLine(g), GS = NW.gapShown(g);
  const spreadTxt = `Leo ${LS == null ? "has no spread" : fav(g, LS)}, DraftKings ${mk.home_spread == null ? "no line" : fav(g, mk.home_spread)}` + (GS == null ? "." : `, ${GS === 0 ? "the same number" : GS + " points apart"}.`);
  const html = tbl(`<tr><td style="padding:14px 16px 12px">
    ${tbl(`<tr><td style="font-family:${SANS}"><div style="font-size:16px;font-weight:800;color:${T.text}">${esc(N(g.away))} at ${esc(N(g.home))}</div><div style="font-size:12px;color:${T.dim}">${esc(tip(g.tip_utc))}</div></td>
      <td align="right" valign="top"><span style="display:inline-block;font-family:${SANS};font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:5px 10px;border-radius:999px;background:${C.on ? T.leanBg : T.noBg};color:${C.on ? T.good : T.dim};white-space:nowrap">${esc(C.on ? C.head.replace("Leo Pick: ", "Pick ") : "No call")}</span></td></tr>`)}
    ${P(`<b>${esc(C.head)}.</b> ${esc(C.why)}`, "margin-top:10px")}
    ${P(`Win chance: ${esc(N(g.away))} ${pct1(L.p_away)}, ${esc(N(g.home))} ${pct1(L.p_home)}. ${esc(spreadTxt)}`)}
    ${label("Why Leo has this number")}${ul(reasons(g).map(esc))}
    ${label("What Leo read")}${ul(inputs(g, readAt).map(esc))}
    <div style="font-family:${SANS};font-size:14px;font-weight:800;margin-top:8px"><a href="${pageUrl(g)}" style="color:${T.navy};text-decoration:none">Game page &rarr;</a></div>
  </td></tr>`, `background:${T.card};border:1px solid rgba(26,37,53,.16);border-radius:18px;margin:0 0 12px`);
  const text = [`${tip(g.tip_utc)}  ${N(g.away)} at ${N(g.home)}`, `  ${C.head}. ${C.why}`,
    `  Win chance: ${N(g.away)} ${pct1(L.p_away)}, ${N(g.home)} ${pct1(L.p_home)}. ${spreadTxt}`,
    "  Why:", ...reasons(g).map(r => "   - " + r), "  What Leo read:", ...inputs(g, readAt).map(r => "   - " + r), `  ${pageUrl(g)}`, ""].join("\n");
  return { html, text, pick: C.on };
}

function brief(doc, { record } = {}) {
  const date = doc.date, nice = niceDate(date);
  const readAt = doc.generated_at ? new Date(doc.generated_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET" : "the last read";
  const games = (doc.games || []).filter(g => g.leo && g.state !== "post");
  const isPick = g => { const t = PK.pickText(g); return !!(t && t.ok); };
  games.sort((a, b) => (isPick(b) - isPick(a)) || a.tip_utc.localeCompare(b.tip_utc));
  const picks = games.filter(isPick), pickList = picks.map(g => `${N(g.leo.pick.team)} ${money(g.leo.pick.price)}`);
  const blocks = games.map(g => gameBlock(g, readAt));
  const subject = `Leo NBA member brief, ${nice}: ${picks.length ? pickList.join(", ") : "no Leo Picks"}`;
  const rec = recordLine(record);
  const body = [
    E.header("NBA members"),
    E.hero({ eyebrow: `Member brief &middot; ${esc(nice)}`, title: `${games.length} game${games.length === 1 ? "" : "s"}, ${picks.length} Leo Pick${picks.length === 1 ? "" : "s"}`,
      subtitle: `Every call with the reasoning and the inputs behind it, as Leo read them at ${esc(readAt)}. Leo Picks so far: ${esc(rec)}. A public test, graded in units, not bets.` }),
    E.panel("Tonight&rsquo;s Leo Picks", picks.length
      ? ul(picks.map(g => `<b>${esc(N(g.leo.pick.team))} ${esc(money(g.leo.pick.price))}</b>, ${esc(N(g.away))} at ${esc(N(g.home))}, ${esc(tip(g.tip_utc))}. Leo ${pct(g.leo.pick.p)} to win.`))
      : P("No team tonight is 60% or more with Leo at a price better than -230.", `color:${T.dim};margin:0`)),
    blocks.map(b => b.html).join(""),
    E.footer({ links: [[`${SITE}/nba/scoreboard/`, "Live scores"], [`${SITE}/nba/results/`, "Leo&rsquo;s record"]],
      note: "You get this as a Leo member. Numbers are frozen at tip and graded on the site, wins and losses alike. Under 50 graded picks is an early read." })
  ].join("\n");
  const html = E.shell({ title: subject, preheader: picks.length ? `Leo Picks: ${pickList.join(", ")}.` : "No Leo Picks tonight. The reasoning behind every game.", body });
  const text = [`Leo NBA member brief, ${nice}`, `Read at ${readAt}. Leo Picks so far: ${rec}.`, "",
    picks.length ? `Leo Picks: ${pickList.join(", ")}` : "No Leo Picks tonight.", "", ...blocks.map(b => b.text),
    "Leo Picks are a public test, not bets. Analysis only, not betting advice. 21+. 1-800-MY-RESET.",
    ...((process.env.EMAIL_POSTAL_ADDRESS || "").trim() ? [(process.env.EMAIL_POSTAL_ADDRESS || "").trim()] : []), 'Reply "unsubscribe" to stop these.'].join("\n");
  return { subject, html, text, picks: pickList };
}

/* ---------------- morning-after review ---------------- */

const KIND = { pick_lost: "Leo Pick lost", wrong_winner: "wrong winner", margin: "margin off by 10 or more" };
function finalWords(g) {
  const hw = g.hs > g.as, w = hw ? g.home : g.away, l = hw ? g.away : g.home;
  return `The ${N(w)} beat ${the(l)} ${Math.max(g.hs, g.as)} to ${Math.min(g.hs, g.as)}${g.ot ? " in overtime" : ""}`;
}
function leoRead(g) {
  const f = g.p_home >= .5 ? g.home : g.away, p = Math.max(g.p_home, 1 - g.p_home), by = Math.abs(g.leo_spread);
  return `Leo had ${the(f)} (${pct1(p)})${by ? `, by ${by}` : ", close to even"}`;
}
const dkRead = g => g.mkt_spread == null ? "No DraftKings line was saved" : g.mkt_spread === 0 ? "DraftKings had a pick'em" : `DraftKings had ${the(g.mkt_spread < 0 ? g.home : g.away)} by ${Math.abs(g.mkt_spread)}`;
const pickWords = p => `Leo Pick ${N(p.team)} ${money(p.price)}: ${p.result === "win" ? "won" : p.result === "loss" ? "lost" : "push"}, ${units(p.units)}`;

function review(day, { season } = {}) {
  const date = day.date, nice = niceDate(date), games = day.games || [];
  const misses = games.filter(g => g.miss), ups = games.filter(g => g.upset), wins = games.filter(g => g.pick && g.pick.result === "win");
  const right = games.filter(g => g.leo_right).length, c = day.calls || { n: 0 };
  const night = c.n ? `${c.w}-${c.l}${c.p ? "-" + c.p : ""}, ${units(c.units)}` : "no Leo Picks";
  const subject = `Leo NBA review, ${nice}: picks ${night}, ${misses.length} miss${misses.length === 1 ? "" : "es"} explained`;
  const missItems = misses.map(g => ({
    head: `${N(g.away)} at ${N(g.home)}: ${g.miss.label}`,
    body: `${finalWords(g)}. ${leoRead(g)}. ${dkRead(g)}. Counted as a miss for: ${g.miss.kinds.map(k => KIND[k] || k).join(", ")}.${g.pick ? " " + pickWords(g.pick) + "." : ""}`,
    why: g.miss.evidence, url: SITE + g.url
  }));
  const upItems = ups.map(g => `${finalWords(g)}. DraftKings gave ${the(g.upset.fav)} ${pct(g.upset.fav_prob_market)}. Leo gave ${the(g.upset.winner)} ${pct(g.upset.leo_prob_winner)}, so Leo ${g.upset.leo_saw_it ? "saw it" : "missed it"}.`);
  const winItems = wins.map(g => `${pickWords(g.pick)}. ${finalWords(g)}.`);
  const S = season || {};
  const body = [
    E.header("NBA members"),
    E.hero({ eyebrow: `Morning review &middot; ${esc(nice)}`, title: `${games.length} game${games.length === 1 ? "" : "s"} graded`,
      subtitle: `Every miss from last night with the reason the data gives, the upsets, and what Leo got right. The same labels as the results page.` }),
    E.tiles([
      { label: "Leo Picks last night", value: c.n ? `${c.w}-${c.l}${c.p ? "-" + c.p : ""}` : "None", sub: c.n ? esc(units(c.units)) : "no team qualified" },
      { label: "Winners right", value: `${right} of ${games.length}`, sub: "the team Leo favored won" },
      { label: "Misses", value: misses.length, sub: "each with one reason" },
      { label: "Leo Picks so far", value: S.picks && S.picks.n ? `${S.picks.w}-${S.picks.l}` : "0-0", sub: S.picks && S.picks.n ? esc(units(S.picks.units) + (S.picks.n < 50 ? `, early read, ${S.picks.n} of 50` : "")) : "&nbsp;" }
    ]),
    E.panel("What Leo missed and why", misses.length ? missItems.map(m =>
      `<div style="border-top:1px solid ${T.border};padding-top:10px;margin-top:10px">${P(`<b><a href="${m.url}" style="color:${T.navy};text-decoration:none">${esc(m.head)}</a></b>`, "margin-bottom:4px")}${P(esc(m.body))}${P(esc(m.why), `color:${T.dim};font-size:14px`)}</div>`).join("").replace(/^<div style="border-top:[^"]*"/, '<div style="padding-top:2px"')
      : P("No misses. Every winner right, no Leo Pick lost, and no margin off by 10 or more.", `color:${T.dim};margin:0`)),
    E.panel("Upsets", upItems.length ? ul(upItems.map(esc)) : P("No upsets. Every DraftKings favorite won.", `color:${T.dim};margin:0`)),
    E.panel("What Leo got right", (winItems.length ? ul(winItems.map(esc)) : P(c.n ? "No Leo Pick won." : "No Leo Picks last night.", `color:${T.dim};margin:0 0 6px`))
      + P(`Leo had the winner in ${right} of ${games.length} games.`, `color:${T.dim};margin:0`)),
    E.footer({ links: [[`${SITE}/nba/results/`, "The full results page"], [`${SITE}/nba/scoreboard/`, "Tonight&rsquo;s games"]],
      note: "You get this as a Leo member. Miss reasons come from the box score, the injury report Leo read and how the DraftKings line moved." })
  ].join("\n");
  const html = E.shell({ title: subject, preheader: `Leo Picks ${night}. ${misses.length} misses, ${ups.length} upsets.`, body });
  const text = [`Leo NBA review, ${nice}`, `Leo Picks last night: ${night}. Winners right: ${right} of ${games.length}. Leo Picks so far: ${recordLine(S.picks && { ...S.picks })}.`, "",
    "WHAT LEO MISSED AND WHY", ...(misses.length ? missItems.flatMap(m => [m.head, "  " + m.body, "  " + m.why, "  " + m.url, ""]) : ["No misses.", ""]),
    "UPSETS", ...(upItems.length ? upItems.map(u => "- " + u) : ["No upsets."]), "",
    "WHAT LEO GOT RIGHT", ...(winItems.length ? winItems.map(w => "- " + w) : ["No winning Leo Pick."]), `Leo had the winner in ${right} of ${games.length} games.`, "",
    `Full results: ${SITE}/nba/results/`, "Analysis only, not betting advice. 21+. 1-800-MY-RESET.",
    ...((process.env.EMAIL_POSTAL_ADDRESS || "").trim() ? [(process.env.EMAIL_POSTAL_ADDRESS || "").trim()] : []), 'Reply "unsubscribe" to stop these.'].join("\n");
  return { subject, html, text: plain(text), misses: misses.length };
}

module.exports = { brief, review, recordLine };
