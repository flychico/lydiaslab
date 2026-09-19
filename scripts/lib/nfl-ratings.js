/**
 * Leo NFL team ratings — QB, offense, defense, turnovers.
 *
 * Built because the 2025 backtest proved point margin alone cannot beat a
 * closing line (see claude/NFL_BACKTEST_RESULTS.md). This module derives
 * component ratings from efficiency data instead: EPA per play, CPOE,
 * pressure, takeaways and turnover differential.
 *
 * Every rate is regressed toward the league mean by sample size before it is
 * used, and every rating is expressed as a z-score against that week's league
 * so two teams can be compared directly head to head.
 *
 * Pure functions, no I/O — the live generator and the backtest both call this,
 * so they can never drift apart.
 */
const K = 4;                       // pseudo-games for shrinkage
const shrink = (obs, n, prior, k = K) => (n ? ((n * obs) + (k * prior)) / (n + k) : prior);
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const num  = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };

function stdev(a){
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map(x => (x - m) ** 2)));
}
/** z-score vs the supplied population; 0 when the population is degenerate. */
function z(v, pop){ const s = stdev(pop); return s ? (v - mean(pop)) / s : 0; }
/** z -> 0..100, centred on 50, ~15 per SD (so 2 SD ≈ 80). */
const scale = zz => Math.max(0, Math.min(100, 50 + zz * 15));

/**
 * Roll weekly player rows up to team-week totals for both sides of the ball.
 * `rows` are nflverse stats_player_week records.
 */
function teamWeeks(rows){
  const off = {}, def = {};
  const O = k => (off[k] = off[k] || {
    dropbacks:0, attempts:0, completions:0, pass_yds:0, pass_td:0, ints:0,
    pass_epa:0, cpoe_sum:0, cpoe_n:0, sacks_taken:0, carries:0, rush_yds:0,
    rush_td:0, rush_epa:0, explosive:0, first_downs:0, fum_lost:0, plays:0
  });
  const D = k => (def[k] = def[k] || {
    pass_yds_all:0, rush_yds_all:0, pass_epa_all:0, rush_epa_all:0,
    sacks:0, qb_hits:0, ints:0, pass_def:0, ff:0, plays:0, tds_all:0
  });

  for (const r of rows){
    const wk = num(r.week); if (!wk) continue;
    // TWO different keyings, and mixing them up silently corrupts the model:
    //   "allowed" stats  -> the OPPONENT's defense faced this offense
    //   "made" stats (def_*) -> already belong to the defender's OWN team
    const ok = `${r.team}|${wk}`;
    const dAllowed = D(`${r.opponent_team}|${wk}`);   // defense that conceded this
    const dMade    = D(`${r.team}|${wk}`);            // defense that made the play
    const o = O(ok), d = dAllowed;

    const att = num(r.attempts), comp = num(r.completions);
    const py = num(r.passing_yards), ptd = num(r.passing_tds), ints = num(r.passing_interceptions);
    const sk = num(r.sacks_suffered), pepa = num(r.passing_epa);
    const car = num(r.carries), ry = num(r.rushing_yards), rtd = num(r.rushing_tds), repa = num(r.rushing_epa);

    o.attempts += att; o.completions += comp; o.pass_yds += py; o.pass_td += ptd;
    o.ints += ints; o.sacks_taken += sk; o.pass_epa += pepa;
    o.dropbacks += att + sk;
    if (att > 0 && r.passing_cpoe !== "" && r.passing_cpoe != null){
      o.cpoe_sum += num(r.passing_cpoe) * att; o.cpoe_n += att;
    }
    o.carries += car; o.rush_yds += ry; o.rush_td += rtd; o.rush_epa += repa;
    o.explosive += num(r.passing_20) + num(r.rushing_20);
    o.first_downs += num(r.passing_first_downs) + num(r.rushing_first_downs);
    o.fum_lost += num(r.rushing_fumbles_lost) + num(r.receiving_fumbles_lost) + num(r.sack_fumbles_lost);
    o.plays += att + sk + car;

    // conceded by the opponent's defense
    d.pass_yds_all += py; d.rush_yds_all += ry;
    d.pass_epa_all += pepa; d.rush_epa_all += repa;
    d.plays += att + sk + car; d.tds_all += ptd + rtd;
    // produced by this player's own defense
    dMade.sacks   += num(r.def_sacks);
    dMade.qb_hits += num(r.def_qb_hits);
    dMade.ints    += num(r.def_interceptions);
    dMade.pass_def+= num(r.def_pass_defended);
    dMade.ff      += num(r.def_fumbles_forced);
  }
  return { off, def };
}

/** Collapse team-week buckets into per-team arrays of per-game rates. */
function perGame(bucket){
  const out = {};
  for (const [k, v] of Object.entries(bucket)){
    const t = k.split("|")[0];
    (out[t] = out[t] || []).push(v);
  }
  return out;
}

/**
 * Build ratings for every team.
 * @param rows        current-season weekly rows (history only — no lookahead)
 * @param priorRows   prior-season weekly rows, used as the shrinkage prior
 */
function buildRatings(rows, priorRows = []){
  const cur = teamWeeks(rows), pri = teamWeeks(priorRows);
  const curOff = perGame(cur.off), curDef = perGame(cur.def);
  const priOff = perGame(pri.off), priDef = perGame(pri.def);
  const teams = [...new Set([...Object.keys(curOff), ...Object.keys(curDef),
                             ...Object.keys(priOff), ...Object.keys(priDef)])].filter(Boolean);

  // --- raw per-team rates, each regressed toward its own prior season -------
  const raw = {};
  for (const t of teams){
    const c = curOff[t] || [], p = priOff[t] || [];
    const cd = curDef[t] || [], pd = priDef[t] || [];
    const sum = (arr, f) => arr.reduce((s, g) => s + f(g), 0);
    const rate = (arr, num_, den_) => { const d = sum(arr, den_); return d ? sum(arr, num_) / d : 0; };

    const pr = {
      epa_db:  rate(p, g=>g.pass_epa, g=>g.dropbacks),
      cpoe:    p.length ? (sum(p,g=>g.cpoe_sum) / (sum(p,g=>g.cpoe_n)||1)) : 0,
      int_r:   rate(p, g=>g.ints, g=>g.attempts),
      sack_r:  rate(p, g=>g.sacks_taken, g=>g.dropbacks),
      td_r:    rate(p, g=>g.pass_td, g=>g.attempts),
      rush_epa:rate(p, g=>g.rush_epa, g=>g.carries),
      expl_r:  rate(p, g=>g.explosive, g=>g.plays),
      fd_r:    rate(p, g=>g.first_downs, g=>g.plays),
      to_r:    rate(p, g=>g.ints + g.fum_lost, g=>g.plays),
      d_epa:   rate(pd, g=>g.pass_epa_all + g.rush_epa_all, g=>g.plays),
      d_sack:  rate(pd, g=>g.sacks, g=>g.plays),
      d_int:   rate(pd, g=>g.ints, g=>g.plays),
      d_pd:    rate(pd, g=>g.pass_def, g=>g.plays),
      d_ff:    rate(pd, g=>g.ff, g=>g.plays),
      d_ypp:   rate(pd, g=>g.pass_yds_all + g.rush_yds_all, g=>g.plays)
    };
    const n = c.length, nd = cd.length;
    raw[t] = {
      games: n,
      epa_db:  shrink(rate(c,g=>g.pass_epa,g=>g.dropbacks), n, pr.epa_db),
      cpoe:    shrink(c.length ? (sum(c,g=>g.cpoe_sum)/(sum(c,g=>g.cpoe_n)||1)) : 0, n, pr.cpoe),
      int_r:   shrink(rate(c,g=>g.ints,g=>g.attempts), n, pr.int_r),
      sack_r:  shrink(rate(c,g=>g.sacks_taken,g=>g.dropbacks), n, pr.sack_r),
      td_r:    shrink(rate(c,g=>g.pass_td,g=>g.attempts), n, pr.td_r),
      rush_epa:shrink(rate(c,g=>g.rush_epa,g=>g.carries), n, pr.rush_epa),
      expl_r:  shrink(rate(c,g=>g.explosive,g=>g.plays), n, pr.expl_r),
      fd_r:    shrink(rate(c,g=>g.first_downs,g=>g.plays), n, pr.fd_r),
      to_r:    shrink(rate(c,g=>g.ints+g.fum_lost,g=>g.plays), n, pr.to_r),
      ints_thrown_pg: n ? sum(c,g=>g.ints)/n : 0,
      d_epa:   shrink(rate(cd,g=>g.pass_epa_all+g.rush_epa_all,g=>g.plays), nd, pr.d_epa),
      d_sack:  shrink(rate(cd,g=>g.sacks,g=>g.plays), nd, pr.d_sack),
      d_int:   shrink(rate(cd,g=>g.ints,g=>g.plays), nd, pr.d_int),
      d_pd:    shrink(rate(cd,g=>g.pass_def,g=>g.plays), nd, pr.d_pd),
      d_ff:    shrink(rate(cd,g=>g.ff,g=>g.plays), nd, pr.d_ff),
      d_ypp:   shrink(rate(cd,g=>g.pass_yds_all+g.rush_yds_all,g=>g.plays), nd, pr.d_ypp),
      ints_caught_pg: nd ? sum(cd,g=>g.ints)/nd : 0,
      fum_forced_pg:  nd ? sum(cd,g=>g.ff)/nd : 0,
      fum_lost_pg:    n  ? sum(c,g=>g.fum_lost)/n : 0
    };
  }

  // --- z-score each rate against the league, then composite ----------------
  const pop = f => teams.map(t => f(raw[t]));
  const R = {};
  for (const t of teams){
    const r = raw[t];
    // QB: efficiency and accuracy up, giveaways and pressure down
    const qb = 0.45*z(r.epa_db, pop(x=>x.epa_db))
             + 0.20*z(r.cpoe,   pop(x=>x.cpoe))
             + 0.15*z(r.td_r,   pop(x=>x.td_r))
             - 0.12*z(r.int_r,  pop(x=>x.int_r))
             - 0.08*z(r.sack_r, pop(x=>x.sack_r));
    // Offense: move the ball efficiently, hit explosives, do not turn it over
    const off = 0.40*z(r.epa_db,   pop(x=>x.epa_db))
              + 0.18*z(r.rush_epa, pop(x=>x.rush_epa))
              + 0.16*z(r.fd_r,     pop(x=>x.fd_r))
              + 0.14*z(r.expl_r,   pop(x=>x.expl_r))
              - 0.12*z(r.to_r,     pop(x=>x.to_r));
    // Defense: EPA and yards allowed are negatives; pressure and takeaways positives
    const def = -0.42*z(r.d_epa,  pop(x=>x.d_epa))
              - 0.16*z(r.d_ypp,   pop(x=>x.d_ypp))
              + 0.18*z(r.d_sack,  pop(x=>x.d_sack))
              + 0.14*z(r.d_int,   pop(x=>x.d_int))
              + 0.06*z(r.d_pd,    pop(x=>x.d_pd))
              + 0.04*z(r.d_ff,    pop(x=>x.d_ff));
    const takeaways = r.ints_caught_pg + r.fum_forced_pg;
    const giveaways = r.ints_thrown_pg + r.fum_lost_pg;
    R[t] = {
      team: t, games: r.games,
      qb_rating: Math.round(scale(qb)*10)/10,
      off_rating: Math.round(scale(off)*10)/10,
      def_rating: Math.round(scale(def)*10)/10,
      overall: Math.round(scale((off + def) / 2)*10)/10,
      // turnover profile — INTs thrown vs INTs caught, as asked for
      ints_thrown_pg: Math.round(r.ints_thrown_pg*100)/100,
      ints_caught_pg: Math.round(r.ints_caught_pg*100)/100,
      fum_lost_pg:    Math.round(r.fum_lost_pg*100)/100,
      fum_forced_pg:  Math.round(r.fum_forced_pg*100)/100,
      takeaways_pg:   Math.round(takeaways*100)/100,
      giveaways_pg:   Math.round(giveaways*100)/100,
      turnover_diff_pg: Math.round((takeaways-giveaways)*100)/100,
      // raw components, for the head-to-head table
      epa_per_dropback: Math.round(r.epa_db*1000)/1000,
      cpoe:             Math.round(r.cpoe*10)/10,
      int_rate:         Math.round(r.int_r*1000)/1000,
      sack_rate_taken:  Math.round(r.sack_r*1000)/1000,
      rush_epa_per_carry: Math.round(r.rush_epa*1000)/1000,
      explosive_rate:   Math.round(r.expl_r*1000)/1000,
      def_epa_per_play: Math.round(r.d_epa*1000)/1000,
      def_sack_rate:    Math.round(r.d_sack*1000)/1000,
      def_int_rate:     Math.round(r.d_int*1000)/1000,
      def_yards_per_play: Math.round(r.d_ypp*100)/100,
      _z: { qb, off, def }
    };
  }
  return R;
}

/**
 * Head-to-head: each side's offense measured against the other's defense,
 * plus the turnover battle. Returns a net edge in z-units from the HOME side.
 */
function headToHead(R, away, home){
  const A = R[away], H = R[home];
  if (!A || !H) return null;
  const offVsDef = (o, d) => (o._z.off - d._z.def) / 2;   // attacker minus defender
  const homeAtt = offVsDef(H, A), awayAtt = offVsDef(A, H);
  const toEdge  = (H.turnover_diff_pg - A.turnover_diff_pg);
  const qbEdge  = (H._z.qb - A._z.qb);
  return {
    home_attack: Math.round(homeAtt*1000)/1000,
    away_attack: Math.round(awayAtt*1000)/1000,
    qb_edge_home: Math.round(qbEdge*1000)/1000,
    turnover_edge_home: Math.round(toEdge*100)/100,
    // composite, home-positive
    net_home: Math.round((0.62*(homeAtt-awayAtt) + 0.24*qbEdge + 0.14*toEdge)*1000)/1000
  };
}

module.exports = { buildRatings, headToHead, teamWeeks, z, scale, shrink };
