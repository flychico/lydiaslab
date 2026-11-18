/**
 * Team analysis for the NBA team pages (Lynold, 2026-11-17: "Wouldn't it be
 * beneficial to have shooting percentages per team or even so winning chance
 * with a duo in playing or how one player does when another player is or isn't
 * playing"). Display only: nothing here feeds Leo's model.
 *
 * Source: the ESPN box scores saved at grading, data/nba/boxscores/<date>.json
 * (every graded game since Oct 31), plus data/nba/team-stats.json for pace,
 * offense, defense, home and away, last 10.
 *
 *   build() -> { through, games, teams: { ABBR: { shooting, ranks, opp, withWithout, duos, stats } } }
 */
const fs = require("fs");
const path = require("path");
const DIR = path.join(__dirname, "..", "..", "data", "nba");

const split = s => { const [m, a] = String(s || "0-0").split("-").map(Number); return [m || 0, a || 0]; };
const n = v => Number.isFinite(+v) ? +v : 0;

function loadGames() {
  const dir = path.join(DIR, "boxscores");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const g of d.games || []) if (g.away_score != null && g.home_score != null && (g.players || []).length) out.push({ ...g, date: d.date });
  }
  return out;
}

function teamLine(players) {
  const t = { fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, reb: 0, oreb: 0, ast: 0, tov: 0 };
  for (const p of players) {
    if (p.dnp || !p.stats) continue;
    const s = p.stats;
    const [fgm, fga] = split(s["fieldGoalsMade-fieldGoalsAttempted"]);
    const [tpm, tpa] = split(s["threePointFieldGoalsMade-threePointFieldGoalsAttempted"]);
    const [ftm, fta] = split(s["freeThrowsMade-freeThrowsAttempted"]);
    t.fgm += fgm; t.fga += fga; t.tpm += tpm; t.tpa += tpa; t.ftm += ftm; t.fta += fta;
    t.reb += n(s.rebounds); t.oreb += n(s.offensiveRebounds); t.ast += n(s.assists); t.tov += n(s.turnovers);
  }
  return t;
}
const add = (a, b) => { for (const k in b) a[k] = (a[k] || 0) + b[k]; return a; };

function shootingOf(tot, gp) {
  if (!gp) return null;
  return {
    fg: tot.fga ? tot.fgm / tot.fga : null,
    three: tot.tpa ? tot.tpm / tot.tpa : null,
    ft: tot.fta ? tot.ftm / tot.fta : null,
    threes: tot.tpm / gp, threeAtt: tot.tpa / gp, fta: tot.fta / gp,
    reb: tot.reb / gp, oreb: tot.oreb / gp, ast: tot.ast / gp, tov: tot.tov / gp,
    efg: tot.fga ? (tot.fgm + 0.5 * tot.tpm) / tot.fga : null,
  };
}

function build(opts = {}) {
  const games = loadGames();
  const T = {};
  const team = a => T[a] = T[a] || { gp: 0, tot: {}, opp: {}, games: [], players: new Map() };
  for (const g of games) {
    for (const side of ["away", "home"]) {
      const ab = g[side], other = side === "away" ? "home" : "away";
      const mine = g.players.filter(p => p.team === ab), theirs = g.players.filter(p => p.team === g[other]);
      const t = team(ab);
      t.gp++;
      add(t.tot, teamLine(mine)); add(t.opp, teamLine(theirs));
      const pts = side === "away" ? g.away_score : g.home_score, opp = side === "away" ? g.home_score : g.away_score;
      const played = new Set(mine.filter(p => !p.dnp && n(p.minutes) > 0).map(p => p.id));
      t.games.push({ date: g.date, game_id: g.game_id, margin: pts - opp, win: pts > opp, played });
      for (const p of mine) {
        const r = t.players.get(p.id) || { id: p.id, name: p.name, gp: 0, min: 0, pm: 0 };
        if (played.has(p.id)) { r.gp++; r.min += n(p.minutes); r.pm += n((p.stats || {}).plusMinus); }
        t.players.set(p.id, r);
      }
    }
  }
  const stats = (() => { try { return JSON.parse(fs.readFileSync(path.join(DIR, "team-stats.json"), "utf8")); } catch (e) { return null; } })();
  const statOf = ab => stats && (stats.teams || []).find(t => t.team === ab) || null;

  const rec = list => {
    if (!list.length) return null;
    const w = list.filter(x => x.win).length;
    return { w, l: list.length - w, margin: list.reduce((s, x) => s + x.margin, 0) / list.length, n: list.length };
  };
  const out = {};
  for (const ab in T) {
    const t = T[ab];
    const regulars = [...t.players.values()].filter(p => p.gp >= Math.max(3, Math.ceil(t.gp * 0.4)) && p.min / p.gp >= 18)
      .sort((a, b) => b.min - a.min);
    const ww = regulars.map(p => ({
      id: p.id, name: p.name, gp: p.gp, mpg: p.min / p.gp, pm: p.pm / p.gp,
      with: rec(t.games.filter(g => g.played.has(p.id))), without: rec(t.games.filter(g => !g.played.has(p.id))),
    }));
    const top = regulars.slice(0, 5), duos = [];
    for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
      const A = top[i], B = top[j];
      const both = t.games.filter(g => g.played.has(A.id) && g.played.has(B.id));
      const onlyA = t.games.filter(g => g.played.has(A.id) && !g.played.has(B.id));
      const onlyB = t.games.filter(g => !g.played.has(A.id) && g.played.has(B.id));
      const neither = t.games.filter(g => !g.played.has(A.id) && !g.played.has(B.id));
      duos.push({ a: A.name, b: B.name, both: rec(both), onlyA: rec(onlyA), onlyB: rec(onlyB), neither: rec(neither), minutes: A.min + B.min });
    }
    // Duos that have been apart at least once tell the most; then the most minutes together.
    duos.sort((x, y) => ((y.onlyA || y.onlyB || y.neither) ? 1 : 0) - ((x.onlyA || x.onlyB || x.neither) ? 1 : 0) || y.minutes - x.minutes);
    out[ab] = { gp: t.gp, shooting: shootingOf(t.tot, t.gp), opp: shootingOf(t.opp, t.gp), withWithout: ww, duos: duos.slice(0, opts.duos || 4), stats: statOf(ab) };
  }
  // League ranks (1 = best) for the shooting lines and what opponents shot.
  const rankBy = (key, side, higherBetter) => {
    const list = Object.entries(out).filter(([, v]) => v[side] && v[side][key] != null).sort((a, b) => higherBetter ? b[1][side][key] - a[1][side][key] : a[1][side][key] - b[1][side][key]);
    list.forEach(([ab], i) => { (out[ab].ranks = out[ab].ranks || {})[side + "." + key] = i + 1; });
  };
  for (const k of ["fg", "three", "ft", "threes", "efg", "reb", "ast"]) rankBy(k, "shooting", true);
  rankBy("tov", "shooting", false);
  for (const k of ["fg", "three", "efg", "threes"]) rankBy(k, "opp", false);
  const dates = games.map(g => g.date).sort();
  return { from: dates[0] || null, through: dates[dates.length - 1] || null, games: games.length, teams: out };
}

module.exports = { build };
