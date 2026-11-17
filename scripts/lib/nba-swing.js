/**
 * Day-to-day swing check (HO-0097, NBA-H36).
 *
 * Leo counts a player listed day-to-day at 0.4 of his value (doubtful 0.75,
 * questionable 0.5, probable 0.1). That is a guess about a status that is
 * still open. For each game this recomputes Leo's chance with every such
 * player counted at 0 (he plays) and at 1 (he sits), one player at a time and
 * every open player on a team together. If either end puts the game on the
 * other side of the Leo Pick line than the read itself (pick to no pick, no
 * pick to pick, or a pick on the other team), the game "depends on" him.
 *
 * Works from the card alone: leo.home_margin, leo.missing (value, weight,
 * status) and the market moneyline. Only the injury term moves:
 *   margin' = margin + coef.lost_d * (new weight - weight) * value * (+1 home, -1 away)
 * The Leo Pick rule is scripts/lib/nba-picks.js (60% and better than -230).
 * Never a model input and never read by the grader: it flags, it does not pick.
 */
(function () {
'use strict';
const isNode = typeof module !== "undefined" && module.exports;
const PK = isNode ? require("./nba-picks") : window.NBA_PICKS;
const URLS = isNode ? require("./nba-urls") : window.NBA_URLS;

function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
const open = p => p && p.weight > 0 && p.weight < 1;
const pickOf = (g, pHome) => PK.pick({ p_home: pHome, home_ml: (g.market || {}).home_ml, away_ml: (g.market || {}).away_ml, home: g.home, away: g.away });
const key = pk => pk && pk.ok ? pk.side : "none";
const pct = p => (Math.round(p * 100) === 60 && p < 0.6 ? (p * 100).toFixed(1) : Math.round(p * 100)) + "%";   // 59.7%, never a "60%" that is no pick
const sideName = (g, side) => URLS.nick(g[side], g[side + "_name"]);
const shortDetail = d => String(d || "").replace(/\s*soreness$/i, "").replace(/\s+/g, " ").trim().toLowerCase();
const statusWord = s => String(s || "day-to-day").toLowerCase();

/** The plain line for one flag. */
function sentence(g, f) {
  const who = f.players.length === 1
    ? `${f.players[0].name} (${statusWord(f.players[0].status)}${f.players[0].detail ? ", " + shortDetail(f.players[0].detail) : ""})`
    : f.players.map(p => p.name).join(" and ");
  const pron = f.players.length === 1 ? (f.if === "sits" ? "he sits" : "he plays") : (f.if === "sits" ? "they all sit" : "they all play");
  const now = f.before, after = f.after;
  let what;
  if (now.ok && !after.ok) what = `Leo drops to ${pct(after.p_team)} on the ${sideName(g, now.side)} and this is no pick`;
  else if (now.ok && after.ok) what = `Leo moves to ${pct(after.p)} on the ${sideName(g, after.side)} and the pick switches sides`;
  else what = `Leo moves to ${pct(after.p)} on the ${sideName(g, after.side)}${after.price != null ? " at " + PK.fmtPrice(after.price) : ""} and this is a Leo Pick`;
  return `Depends on ${who}. If ${pron}, ${what}.`;
}

/**
 * check(game, model) -> { open: n, flags: [...] }
 * flag = { if: "sits"|"plays", scope: "player"|"team", team, players:[{name,status,detail,value,weight}],
 *          before: {ok, side, p, price}, after: {ok, side, p, p_team, price}, text }
 */
function check(g, model) {
  const L = g.leo || {}, c = (model && model.coef) || {}, sd = model && model.resid_sd;
  if (L.home_margin == null || !sd || c.lost_d == null || !L.missing) return { open: 0, flags: [] };
  const base = Number(L.home_margin);
  const basePick = pickOf(g, normCdf(base / sd));
  const before = { ok: !!(basePick && basePick.ok), side: basePick ? basePick.side : null, p: basePick ? basePick.p : null, price: basePick ? basePick.price : null };
  // When a pick is already locked, judge flips against the card's own pick.
  if (L.pick && L.pick.ok) Object.assign(before, { ok: true, side: L.pick.side, p: L.pick.p, price: L.pick.price });
  const sets = [];
  for (const side of ["home", "away"]) {
    const ps = (L.missing[side] || []).filter(open).map(p => ({ ...p, side }));
    for (const p of ps) sets.push({ scope: "player", team: side, players: [p] });
    if (ps.length > 1) sets.push({ scope: "team", team: side, players: ps });
  }
  const flags = [];
  for (const s of sets) for (const to of [1, 0]) {
    const d = s.players.reduce((acc, p) => acc + c.lost_d * (to - p.weight) * p.value * (p.side === "home" ? 1 : -1), 0);
    const pH = normCdf((base + d) / sd), pk = pickOf(g, pH);
    const after = { ok: !!(pk && pk.ok), side: pk ? pk.side : (pH >= 0.5 ? "home" : "away"), p: pk ? pk.p : Math.max(pH, 1 - pH), price: pk ? pk.price : null,
      p_team: before.side ? (before.side === "home" ? pH : 1 - pH) : Math.max(pH, 1 - pH) };
    if (key(pk) === (before.ok ? before.side : "none")) continue;
    const f = { if: to === 1 ? "sits" : "plays", scope: s.scope, team: g[s.team],
      players: s.players.map(p => ({ name: p.name, status: p.status, detail: p.detail, value: p.value, weight: p.weight })),
      before, after: { ...after, p: +after.p.toFixed(4), p_team: +after.p_team.toFixed(4) }, home_margin: +(base + d).toFixed(2) };
    f.text = sentence(g, f);
    flags.push(f);
  }
  // One player at a time first; a team set only when no single player in it flips the game alone.
  const singles = new Set(flags.filter(f => f.scope === "player").map(f => f.if + "|" + f.players[0].name));
  const kept = flags.filter(f => f.scope === "player" || !f.players.some(p => singles.has(f.if + "|" + p.name)));
  return { open: sets.filter(s => s.scope === "player").length, flags: kept };
}

/** The one line to show for a game (the first flag), or "". */
function line(g) {
  const d = g && g.leo && g.leo.depends;
  return d && d.length ? d[0].text : "";
}

const api = { check, line, sentence };
if (isNode) module.exports = api; else window.NBA_SWING = api;
})();
