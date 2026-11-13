/**
 * Leo NBA card email: the scoreboard, built for inboxes.
 *
 * Same content and look as /nba/scoreboard/ and /nba/previews/: the Leo
 * wordmark, the headline panel, summary tiles, then one card per game with
 * the two team-colour stripe, logos, Leo's win chance with the bar, the three
 * boxes (Leo spread, DraftKings, gap), the lean line and the why line. Uses
 * the shared theme (scripts/lib/email-theme.js). Leans ended after 2026-11-10
 * (nba-picks LEANS_UNTIL), so the card no longer lists them. Picks first; a lean line
 * says in plain words whether Leo and DraftKings have the same winner, by how
 * much each, and Leo's side of the spread (scripts/lib/nba-why.js compare(); was
 * "Leo has BOS by 3.5; DraftKings has
 * BOS by 7.5") so a win chance and a lean on the other team never read as a
 * contradiction. Leans are a tracked test, never bets.
 *
 *   build(card, { why, record, memberLine }) -> { subject, html, text, leans }
 * memberLine adds the line pointing free readers to membership (HO-0061).
 * card is data/nba/picks-<date>.json; why is scripts/lib/nba-why.js.
 */
const E = require("./email-theme");
const { T, SANS, SITE, esc, tbl } = E;

// ESPN team colours (team_color in the season's team box file).
const COLOR = { ATL: "c8102e", BOS: "008348", BKN: "000000", CHA: "008ca8", CHI: "ce1141", CLE: "860038", DAL: "0064b1", DEN: "0e2240",
  DET: "1d428a", GS: "fdb927", HOU: "ce0e2d", IND: "0c2340", LAC: "12173f", LAL: "552583", MEM: "5d76a9", MIA: "98002e", MIL: "00471b",
  MIN: "266092", NO: "0a2240", NY: "1d428a", OKC: "007ac1", ORL: "0150b5", PHI: "1d428a", PHX: "29127a", POR: "e03a3e", SAC: "5a2d81",
  SA: "000000", TOR: "d91244", UTAH: "4e008e", WSH: "e31837" };
const col = t => "#" + (COLOR[t] || "1A2535");
const pct = p => p == null ? "&mdash;" : Math.round(p * 100) + "%";
const sgn = v => v == null ? "&mdash;" : v === 0 ? "PK" : (v > 0 ? "+" : "") + v;
const tip = iso => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
const logo = t => `https://a.espncdn.com/i/teamlogos/nba/500/${String(t).toLowerCase()}.png`;
const URLS = require("./nba-urls");   // same address as the game page (SEO-09)
const pageUrl = (g, date) => SITE + (g.url || URLS.gamePath({ ...g, date: g.date || date }));
const NW = require("./nba-why");
const PKS = require("./nba-picks");   // Leo Pick rule and words (DEC-20261102-30)   // leoLine / gapShown / compare: the same rounding and wording as the site
const byTxt = (m, home, away) => m == null ? null : Math.abs(m) < 0.25 ? "a pick'em" : `${m > 0 ? home : away} by ${Math.abs(Math.round(m * 2) / 2)}`;

function teamRow(g, side) {
  const p = side === "home" ? g.leo.p_home : g.leo.p_away, lean = g.leo.lean && g.leo.lean.side === side;
  return `<tr>
    <td width="44" style="padding:7px 0;vertical-align:middle"><img src="${logo(g[side])}" width="36" height="36" alt="${esc(g[side])}" style="display:block;border:0;width:36px;height:36px"></td>
    <td style="padding:7px 8px;vertical-align:middle;font-family:${SANS};font-size:16px;font-weight:${lean ? 800 : 600};color:${T.text}">${esc(g[side + "_name"] || g[side])}</td>
    <td align="right" style="padding:7px 0;vertical-align:middle;font-family:${SANS};white-space:nowrap"><div style="font-size:17px;font-weight:800;color:${T.text}">${pct(p)}</div><div style="font-size:12px;color:${T.dim}">Leo win chance</div></td>
  </tr>`;
}
function box(label, value, sub, gold) {
  return `<td width="33%" valign="top" style="padding:0 3px">${tbl(`<tr><td align="center" style="padding:10px 4px;font-family:${SANS}">
    <div style="font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:${T.dim}">${label}</div>
    <div style="font-size:16px;font-weight:800;color:${T.text};margin:4px 0 3px;white-space:nowrap">${value}</div>
    <div style="font-size:11px;color:${T.dim}">${sub}</div></td></tr>`, `background:${gold ? "#FBF5E4" : "#ffffff"};border:1px solid ${gold ? "#E7D8AC" : T.border};border-radius:12px`)}</td>`;
}
function card(g, date, why) {
  const L = g.leo, mk = g.market || {}, W = why ? why.why(g) : null;
  const LS = NW.leoLine(g), GS = NW.gapShown(g), CMP = NW.compare(g);
  const leoM = LS == null ? null : -LS, mkM = mk.home_spread == null ? null : -mk.home_spread;
  const PT = PKS.pickText(g);
  const badge = [PT && PT.ok ? esc(PT.badge) : "", L.lean ? `Lean ${esc(L.lean.team)} ${sgn(L.lean.line)}` : ""].filter(Boolean).join(" &middot; ") || "No call";
  const pa = Math.max(1, Math.min(99, Math.round((L.p_away || 0) * 100)));
  const leanLine = L.lean
    ? `<div style="font-family:${SANS};font-size:14px;line-height:1.5;color:${T.text};background:${T.leanBg};border-radius:10px;padding:9px 12px;margin-top:12px">${esc(CMP)}</div>`
    : CMP ? `<div style="font-family:${SANS};font-size:14px;line-height:1.5;color:${T.text};margin-top:12px">${esc(CMP)}</div>` : "";
  return tbl(`<tr><td style="padding:0;font-size:0;line-height:0">${tbl(`<tr><td width="50%" style="height:6px;line-height:6px;font-size:0;background:${col(g.away)};border-radius:20px 0 0 0">&nbsp;</td><td width="50%" style="height:6px;line-height:6px;font-size:0;background:${col(g.home)};border-radius:0 20px 0 0">&nbsp;</td></tr>`)}</td></tr>
  <tr><td style="padding:14px 16px 16px">
    ${tbl(`<tr>
      <td style="font-family:${SANS}"><div style="font-size:15px;font-weight:800;color:${T.text}">${esc(tip(g.tip_utc))}</div><div style="font-size:12px;color:${T.dim}">${esc(g.venue || `${g.away} at ${g.home}`)}</div></td>
      <td align="right" valign="top"><span style="display:inline-block;font-family:${SANS};font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:5px 10px;border-radius:999px;background:${L.lean || (PT && PT.ok) ? T.leanBg : T.noBg};color:${L.lean || (PT && PT.ok) ? T.good : T.dim}">${badge}</span></td>
    </tr>`)}
    ${tbl(`${teamRow(g, "away")}${teamRow(g, "home")}`, "margin-top:6px")}
    ${tbl(`<tr><td width="${pa}%" style="height:8px;line-height:8px;font-size:0;background:${T.gold};border-radius:999px 0 0 999px">&nbsp;</td><td width="${100 - pa}%" style="height:8px;line-height:8px;font-size:0;background:${T.navy};border-radius:0 999px 999px 0">&nbsp;</td></tr>`, "margin:10px 0 12px")}
    ${tbl(`<tr>${box("Leo spread", LS == null ? "&mdash;" : esc(NW.favLine(g, LS)), "Leo's favorite, by", true)}${box("DraftKings", mk.home_spread == null ? "&mdash;" : esc(NW.favLine(g, mk.home_spread)), mk.p_home != null ? `market ${esc(g.home)} ${pct(mk.p_home)}` : "&nbsp;")}${box("Call", esc(PKS.callBox(g).value), esc(PKS.callBox(g).sub))}</tr>`)}
    ${PT ? `<div style="font-family:${SANS};font-size:14px;line-height:1.5;color:${T.text};${PT.ok ? `background:${T.leanBg};font-weight:700;` : `color:${T.dim};`}border-radius:10px;padding:${PT.ok ? "9px 12px" : "0"};margin-top:12px">${esc(PT.line)}</div>` : ""}
    ${leanLine}
    ${W && W.summary ? `<div style="font-family:${SANS};font-size:14px;line-height:1.55;color:${T.dim};border-top:1px solid ${T.border};margin-top:12px;padding-top:11px">${esc(W.summary)}</div>` : ""}
    <div style="font-family:${SANS};font-size:14px;font-weight:800;margin-top:11px"><a href="${pageUrl(g, date)}" style="color:${T.navy};text-decoration:none">Full preview: why Leo has this number &rarr;</a></div>
  </td></tr>`, `background:${T.card};border:1px solid rgba(26,37,53,.16);border-radius:20px;margin:0 0 14px`);
}

const MEMBER_LINE = "Members get the full reasoning behind every call, and a review of every miss the next morning.";

function build(doc, { why, record, memberLine = false } = {}) {
  const date = doc.date;
  const nice = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  const games = doc.games.filter(g => g.leo && g.state !== "post");
  const gap = g => { const v = NW.gapShown(g); return v == null ? -1 : v; };
  const isPick = g => { const t = PKS.pickText(g); return !!(t && t.ok); };
  games.sort((a, b) => ((isPick(b) || !!b.leo.lean) - (isPick(a) || !!a.leo.lean)) || a.tip_utc.localeCompare(b.tip_utc) || gap(b) - gap(a));
  const leans = games.filter(g => g.leo.lean);
  const leanList = leans.map(g => `${g.leo.lean.team} ${sgn(g.leo.lean.line)}`);
  const picks = games.filter(isPick), pickList = picks.map(g => PKS.pickText(g).badge.replace(/^Pick /, "") );
  const first = games.map(g => g.tip_utc).sort()[0];
  const big = games.length ? Math.max(...games.map(gap)) : null;
  const subject = `Leo NBA card, ${nice}: ${games.length} game${games.length === 1 ? "" : "s"}, ${picks.length} pick${picks.length === 1 ? "" : "s"}${pickList.length ? ` (${pickList.join(", ")})` : ""}`;
  const pickRows = picks.length
    ? tbl(picks.map(g => `<tr><td style="padding:6px 0;font-family:${SANS};font-size:16px;font-weight:800;color:${T.text};white-space:nowrap">${esc(PKS.pickText(g).badge.replace(/^Pick /, ""))}</td>
        <td align="right" style="padding:6px 0;font-family:${SANS};font-size:13px;color:${T.dim}">${esc(g.away)} at ${esc(g.home)} &middot; ${esc(tip(g.tip_utc))}<br>Leo ${Math.round(g.leo.pick ? g.leo.pick.p * 100 : Math.max(g.leo.p_home, g.leo.p_away) * 100)}% to win</td></tr>`).join(`<tr><td colspan="2" style="border-top:1px solid ${T.border};font-size:0;line-height:0;height:1px">&nbsp;</td></tr>`))
    : `<div style="font-family:${SANS};font-size:14px;color:${T.dim}">No team tonight is 60%+ with Leo at a price better than -230, so there is no Leo Pick.</div>`;
  const leanRows = leans.length
    ? tbl(leans.map(g => `<tr><td style="padding:6px 0;font-family:${SANS};font-size:16px;font-weight:800;color:${T.text};white-space:nowrap">${esc(g.leo.lean.team)} ${sgn(g.leo.lean.line)}</td>
        <td align="right" style="padding:6px 0;font-family:${SANS};font-size:13px;color:${T.dim}">${esc(g.away)} at ${esc(g.home)} &middot; ${esc(tip(g.tip_utc))}<br>Leo ${esc(byTxt(-NW.leoLine(g), g.home, g.away))}, DraftKings ${esc(byTxt(-g.market.home_spread, g.home, g.away))}</td></tr>`).join(`<tr><td colspan="2" style="border-top:1px solid ${T.border};font-size:0;line-height:0;height:1px">&nbsp;</td></tr>`))
    : `<div style="font-family:${SANS};font-size:14px;color:${T.dim}">No game tonight is 4 or more points off the DraftKings spread, so Leo records no lean.</div>`;
  const body = [
    E.header("NBA"),
    E.hero({
      eyebrow: `Leo NBA &middot; ${esc(nice)}`,
      title: `Tonight&rsquo;s card: ${games.length} game${games.length === 1 ? "" : "s"}`,
      subtitle: "Leo&rsquo;s win chance and spread for every game, with DraftKings beside it. A Leo Pick is a team Leo gives 60% or more at a price better than -230. Picks are a public test, graded every morning in units, not bets.",
      chips: ["&#127936; Full slate", "&#129657; Injury report built in", "&#128274; Frozen before tip"]
    }),
    E.tiles([
      { label: "Games", value: games.length, sub: first ? `first tip ${esc(tip(first))}` : esc(nice.split(",")[0]) },
      { label: "Leo Picks tonight", value: picks.length, sub: "60%+, better than -230" },
      // Running record from results.json season.picks (DEC-20261102-33)
      { label: "Leo Picks so far", value: record && record.n ? `${record.won}-${record.lost}` : "0-0",
        sub: record && record.n ? `${record.units > 0 ? "+" : ""}${(+record.units).toFixed(2)} units since ${new Date(record.from + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : "first picks graded tomorrow" }
    ]),
    E.panel("Tonight&rsquo;s Leo Picks (moneyline)", pickRows),
    games.map(g => card(g, date, why)).join(""),
    // Free list only (HO-0061 item 3): one line pointing to the member emails.
    memberLine ? tbl(`<tr><td style="padding:14px 16px;font-family:${SANS};font-size:15px;line-height:1.55;color:${T.text}">${MEMBER_LINE} <a href="${SITE}/membership/" style="color:${T.navy};font-weight:800;text-decoration:none">See membership &rarr;</a></td></tr>`, `background:${T.heroBg};border:1px solid ${T.border};border-radius:16px;margin:0 0 16px`) : "",
    E.footer({
      links: [[`${SITE}/nba/scoreboard/`, "Live scores and every card"], [`${SITE}/nba/results/`, "Leo&rsquo;s record"]],
      note: "Every number is frozen before tip and graded on the site, wins and losses alike. Under 50 graded picks is an early read."
    })
  ].join("\n");
  const html = E.shell({ title: subject, preheader: [picks.length ? `Leo Picks: ${pickList.join(", ")}.` : "", leans.length ? `Leans: ${leanList.join(", ")}.` : ""].filter(Boolean).join(" ") || "No Leo Picks tonight. Leo's read on every game.", body });
  const text = [`Leo NBA card, ${nice}`, "",
    picks.length ? `Leo Picks (moneyline): ${pickList.join(", ")}` : "No Leo Picks tonight.",
    ...(record && record.n ? [`Leo Picks so far: ${record.won}-${record.lost}, ${record.units > 0 ? "+" : ""}${(+record.units).toFixed(2)} units since ${record.from}`] : []),
    "",
    ...games.map(g => { const L = g.leo, mk = g.market || {}, W = why ? why.why(g) : null;
      return `${tip(g.tip_utc)}  ${g.away} at ${g.home}  ${[PKS.pickText(g) && PKS.pickText(g).ok ? PKS.pickText(g).badge.toUpperCase() : "", L.lean ? `LEAN ${L.lean.team} ${sgn(L.lean.line)}` : ""].filter(Boolean).join("  ") || "No call"}\n  Leo win chance: ${g.away} ${Math.round(L.p_away * 100)}%, ${g.home} ${Math.round(L.p_home * 100)}%\n  ${NW.compare(g)}\n${W && W.summary ? "  " + W.summary + "\n" : ""}  ${pageUrl(g, date)}\n`; }),
    ...(memberLine ? ["", `${MEMBER_LINE} ${SITE}/membership/`] : []),
    "", `Every card: ${SITE}/nba/scoreboard/`, "Leo Picks are a public test, not bets. Analysis only, not betting advice. 21+. 1-800-MY-RESET.",
    ...((process.env.EMAIL_POSTAL_ADDRESS || "").trim() ? [(process.env.EMAIL_POSTAL_ADDRESS || "").trim()] : []), 'Reply "unsubscribe" to stop these.'].join("\n").replace(/&mdash;/g, "-").replace(/&rsquo;/g, "'");
  return { subject, html, text, leans: leanList };
}

module.exports = { build, MEMBER_LINE };
