/**
 * Pick Safety Gate (Lynold, 2026-11-23). NBA lane, built by the Manager on his named instruction.
 * A Leo Pick is skipped when one of the favoured team's top two players by last season's value is listed Out
 * and has played fewer than 3 games this season. Leo's injury count only covers regulars with 3+ games this
 * season (nba-model.js REG_GAMES), so such an absence is not in Leo's number (Banchero, Nov 22; Leonard, Nov 18).
 *
 * check({ team, injuries, seasonPlayers, prior }) -> null or { players: [{ name, prior_value, games }] }
 *   injuries: [{ id, name, team, status }] (ESPN), seasonPlayers: this season's player lines before the game
 *   (nba-model.js loadSeason players), prior: data/nba/prior-players.json values.
 */
"use strict";
const MIN_GAMES = 3, TOP = 2;
function check({ team, injuries, seasonPlayers, prior }) {
  if (!prior || !team) return null;
  const byName = new Map(Object.entries(prior).map(([id, v]) => [String(v.name).toLowerCase(), id]));
  const roster = new Map(), games = new Map();
  for (const p of seasonPlayers) {
    if (p.team === team) roster.set(String(p.id), p.name);
    if (p.played) games.set(String(p.id), (games.get(String(p.id)) || 0) + 1);
  }
  const listed = (injuries || []).filter(i => i.team === team);
  const idOf = i => (i.id && prior[i.id]) ? String(i.id) : byName.get(String(i.name).toLowerCase()) || String(i.id || "");
  for (const i of listed) { const id = idOf(i); if (id && !roster.has(id)) roster.set(id, i.name); }
  const top = [...roster].map(([id, name]) => ({ id, name, v: (prior[id] || {}).value || 0 })).filter(x => x.v > 0)
    .sort((a, b) => b.v - a.v).slice(0, TOP);
  const outIds = new Set(listed.filter(i => String(i.status).toLowerCase().includes("out")).map(idOf));
  const hit = top.filter(t => outIds.has(t.id) && (games.get(t.id) || 0) < MIN_GAMES)
    .map(t => ({ name: t.name, prior_value: +t.v.toFixed(1), games: games.get(t.id) || 0 }));
  return hit.length ? { players: hit } : null;
}
const reason = g => `pick safety gate: ${g.players.map(p => p.name).join(" and ")} ${g.players.length > 1 ? "are" : "is"} out (a top two player last season, under ${MIN_GAMES} games this season)`;
module.exports = { check, reason, MIN_GAMES, TOP };
