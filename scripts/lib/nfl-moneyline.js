/**
 * Leo NFL moneyline v2 research core.
 *
 * Design rules:
 * - No sportsbook input enters Leo's probability.
 * - Pick only when one side is strictly above 60% win probability.
 * - QB is player-specific, keyed to the expected starter name from games.csv.
 * - Team offense intentionally deemphasizes direct passing-efficiency inputs so
 *   QB and offense are not the same signal twice.
 * - H2H uses only meetings strictly before the game and only the prior 3 years.
 * - Model weights are fitted with L2-regularized logistic regression.
 *
 * This module is pure: no network, filesystem, or clock reads.
 */

(function () {
'use strict';

const PICK_THRESHOLD = 0.60;
const TEAM_K_GAMES = 4;
const QB_PRIOR_DB = 160;
const QB_CURRENT_DB = 100;

const num = v => {
  const x = Number.parseFloat(v);
  return Number.isFinite(x) ? x : 0;
};
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sigmoid = x => x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));

function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map(x => (x - m) ** 2)));
}
function z(v, pop) {
  const s = stdev(pop);
  return s ? (v - mean(pop)) / s : 0;
}
function rating100(zz) {
  return Math.round(clamp(50 + 15 * zz, 0, 100) * 10) / 10;
}
function shrink(obs, nObs, prior, k) {
  return nObs > 0 ? ((nObs * obs) + (k * prior)) / (nObs + k) : prior;
}

function aggregateQb(rows) {
  const out = new Map();
  for (const r of rows) {
    if (r.position !== 'QB') continue;
    const name = r.player_display_name || r.player_name || r.full_name;
    if (!name) continue;
    if (!out.has(name)) out.set(name, {
      name,
      team: r.team || '',
      attempts: 0,
      sacks: 0,
      passing_epa: 0,
      cpoe_sum: 0,
      cpoe_n: 0,
      pass_td: 0,
      ints: 0,
      rows: 0
    });
    const q = out.get(name);
    if (r.team) q.team = r.team;
    const att = num(r.attempts);
    const sacks = num(r.sacks_suffered);
    q.attempts += att;
    q.sacks += sacks;
    q.passing_epa += num(r.passing_epa);
    q.pass_td += num(r.passing_tds);
    q.ints += num(r.passing_interceptions);
    if (att > 0 && r.passing_cpoe !== '' && r.passing_cpoe != null) {
      q.cpoe_sum += num(r.passing_cpoe) * att;
      q.cpoe_n += att;
    }
    q.rows++;
  }
  return out;
}

function qbRates(q) {
  if (!q) return { db: 0, epa_db: 0, cpoe: 0, td_rate: 0, int_rate: 0, sack_rate: 0 };
  const db = q.attempts + q.sacks;
  return {
    db,
    epa_db: db ? q.passing_epa / db : 0,
    cpoe: q.cpoe_n ? q.cpoe_sum / q.cpoe_n : 0,
    td_rate: q.attempts ? q.pass_td / q.attempts : 0,
    int_rate: q.attempts ? q.ints / q.attempts : 0,
    sack_rate: db ? q.sacks / db : 0
  };
}

function leagueQbRates(map) {
  const qs = [...map.values()];
  const total = qs.reduce((a, q) => {
    a.attempts += q.attempts;
    a.sacks += q.sacks;
    a.epa += q.passing_epa;
    a.cpoe_sum += q.cpoe_sum;
    a.cpoe_n += q.cpoe_n;
    a.td += q.pass_td;
    a.ints += q.ints;
    return a;
  }, { attempts: 0, sacks: 0, epa: 0, cpoe_sum: 0, cpoe_n: 0, td: 0, ints: 0 });
  const db = total.attempts + total.sacks;
  return {
    epa_db: db ? total.epa / db : 0,
    cpoe: total.cpoe_n ? total.cpoe_sum / total.cpoe_n : 0,
    td_rate: total.attempts ? total.td / total.attempts : 0,
    int_rate: total.attempts ? total.ints / total.attempts : 0,
    sack_rate: db ? total.sacks / db : 0
  };
}

/**
 * Build a genuine player-specific QB rating.
 * Current-season performance shrinks toward that player's prior season; a QB
 * with no prior shrinks toward the league QB baseline. The returned `z` is the
 * model feature. `rating` is a 0-100 display translation.
 */
function buildQbRatings(currentRows, priorRows) {
  const cur = aggregateQb(currentRows);
  const pri = aggregateQb(priorRows);
  const league = leagueQbRates(pri.size ? pri : cur);
  const names = new Set([...cur.keys(), ...pri.keys()]);
  const raw = new Map();

  for (const name of names) {
    const c = cur.get(name);
    const p = pri.get(name);
    const cr = qbRates(c);
    const pr0 = qbRates(p);
    const priorDb = pr0.db;
    const prior = {
      epa_db: shrink(pr0.epa_db, priorDb, league.epa_db, QB_PRIOR_DB),
      cpoe: shrink(pr0.cpoe, p ? p.attempts : 0, league.cpoe, QB_PRIOR_DB),
      td_rate: shrink(pr0.td_rate, p ? p.attempts : 0, league.td_rate, QB_PRIOR_DB),
      int_rate: shrink(pr0.int_rate, p ? p.attempts : 0, league.int_rate, QB_PRIOR_DB),
      sack_rate: shrink(pr0.sack_rate, priorDb, league.sack_rate, QB_PRIOR_DB)
    };
    const obsDb = cr.db;
    raw.set(name, {
      name,
      team: (c && c.team) || (p && p.team) || '',
      dropbacks: obsDb,
      epa_db: shrink(cr.epa_db, obsDb, prior.epa_db, QB_CURRENT_DB),
      cpoe: shrink(cr.cpoe, c ? c.attempts : 0, prior.cpoe, QB_CURRENT_DB),
      td_rate: shrink(cr.td_rate, c ? c.attempts : 0, prior.td_rate, QB_CURRENT_DB),
      int_rate: shrink(cr.int_rate, c ? c.attempts : 0, prior.int_rate, QB_CURRENT_DB),
      sack_rate: shrink(cr.sack_rate, obsDb, prior.sack_rate, QB_CURRENT_DB)
    });
  }

  const vals = [...raw.values()];
  const pops = {
    epa: vals.map(x => x.epa_db),
    cpoe: vals.map(x => x.cpoe),
    td: vals.map(x => x.td_rate),
    int: vals.map(x => x.int_rate),
    sack: vals.map(x => x.sack_rate)
  };
  const out = {};
  for (const q of vals) {
    // This is a QB-only rating. Model-level weighting versus offense/defense/H2H
    // is learned later by logistic regression.
    const zz = 0.50 * z(q.epa_db, pops.epa)
             + 0.20 * z(q.cpoe, pops.cpoe)
             + 0.12 * z(q.td_rate, pops.td)
             - 0.10 * z(q.int_rate, pops.int)
             - 0.08 * z(q.sack_rate, pops.sack);
    out[q.name] = { ...q, z: zz, rating: rating100(zz) };
  }
  return out;
}

function teamWeeks(rows) {
  const off = {}, def = {};
  const O = k => (off[k] = off[k] || {
    carries: 0, rush_epa: 0, first_downs: 0, explosive: 0, plays: 0,
    sacks_taken: 0, fum_lost: 0
  });
  const D = k => (def[k] = def[k] || {
    pass_yds: 0, rush_yds: 0, pass_epa: 0, rush_epa: 0,
    sacks: 0, ints: 0, ff: 0, plays: 0
  });

  for (const r of rows) {
    const wk = num(r.week);
    if (!wk) continue;
    const ok = `${r.team}|${wk}`;
    const dkAllowed = `${r.opponent_team}|${wk}`;
    const dkMade = `${r.team}|${wk}`;
    const o = O(ok);
    const da = D(dkAllowed);
    const dm = D(dkMade);
    const att = num(r.attempts), sacks = num(r.sacks_suffered), car = num(r.carries);
    o.carries += car;
    o.rush_epa += num(r.rushing_epa);
    o.first_downs += num(r.passing_first_downs) + num(r.rushing_first_downs);
    o.explosive += num(r.passing_20) + num(r.rushing_20);
    o.plays += att + sacks + car;
    o.sacks_taken += sacks;
    o.fum_lost += num(r.rushing_fumbles_lost) + num(r.receiving_fumbles_lost) + num(r.sack_fumbles_lost);

    da.pass_yds += num(r.passing_yards);
    da.rush_yds += num(r.rushing_yards);
    da.pass_epa += num(r.passing_epa);
    da.rush_epa += num(r.rushing_epa);
    da.plays += att + sacks + car;
    dm.sacks += num(r.def_sacks);
    dm.ints += num(r.def_interceptions);
    dm.ff += num(r.def_fumbles_forced);
  }
  return { off, def };
}

function perTeam(bucket) {
  const out = {};
  for (const [key, v] of Object.entries(bucket)) {
    const team = key.split('|')[0];
    (out[team] = out[team] || []).push(v);
  }
  return out;
}

/**
 * Team ratings for v2.
 * Offense is deliberately supporting-offense oriented: rushing EPA, first-down
 * rate, explosive rate, sacks allowed, and non-INT fumble loss. Direct passing
 * EPA/CPOE/TD/INT live in the starting-QB rating instead of being counted twice.
 */
function buildTeamRatings(currentRows, priorRows) {
  const c = teamWeeks(currentRows), p = teamWeeks(priorRows);
  const co = perTeam(c.off), cd = perTeam(c.def), po = perTeam(p.off), pd = perTeam(p.def);
  const teams = [...new Set([...Object.keys(co), ...Object.keys(cd), ...Object.keys(po), ...Object.keys(pd)])];
  const sum = (arr, fn) => arr.reduce((s, x) => s + fn(x), 0);
  const rate = (arr, nfn, dfn) => {
    const d = sum(arr, dfn);
    return d ? sum(arr, nfn) / d : 0;
  };

  const raw = {};
  for (const t of teams) {
    const oc = co[t] || [], op = po[t] || [], dc = cd[t] || [], dp = pd[t] || [];
    const prior = {
      rush_epa: rate(op, g => g.rush_epa, g => g.carries),
      first_down: rate(op, g => g.first_downs, g => g.plays),
      explosive: rate(op, g => g.explosive, g => g.plays),
      sack_allowed: rate(op, g => g.sacks_taken, g => g.plays),
      fum_lost: rate(op, g => g.fum_lost, g => g.plays),
      d_epa: rate(dp, g => g.pass_epa + g.rush_epa, g => g.plays),
      d_ypp: rate(dp, g => g.pass_yds + g.rush_yds, g => g.plays),
      d_sack: rate(dp, g => g.sacks, g => g.plays),
      d_int: rate(dp, g => g.ints, g => g.plays),
      d_ff: rate(dp, g => g.ff, g => g.plays)
    };
    const ng = oc.length, nd = dc.length;
    raw[t] = {
      games: ng,
      rush_epa: shrink(rate(oc, g => g.rush_epa, g => g.carries), ng, prior.rush_epa, TEAM_K_GAMES),
      first_down: shrink(rate(oc, g => g.first_downs, g => g.plays), ng, prior.first_down, TEAM_K_GAMES),
      explosive: shrink(rate(oc, g => g.explosive, g => g.plays), ng, prior.explosive, TEAM_K_GAMES),
      sack_allowed: shrink(rate(oc, g => g.sacks_taken, g => g.plays), ng, prior.sack_allowed, TEAM_K_GAMES),
      fum_lost: shrink(rate(oc, g => g.fum_lost, g => g.plays), ng, prior.fum_lost, TEAM_K_GAMES),
      d_epa: shrink(rate(dc, g => g.pass_epa + g.rush_epa, g => g.plays), nd, prior.d_epa, TEAM_K_GAMES),
      d_ypp: shrink(rate(dc, g => g.pass_yds + g.rush_yds, g => g.plays), nd, prior.d_ypp, TEAM_K_GAMES),
      d_sack: shrink(rate(dc, g => g.sacks, g => g.plays), nd, prior.d_sack, TEAM_K_GAMES),
      d_int: shrink(rate(dc, g => g.ints, g => g.plays), nd, prior.d_int, TEAM_K_GAMES),
      d_ff: shrink(rate(dc, g => g.ff, g => g.plays), nd, prior.d_ff, TEAM_K_GAMES)
    };
  }

  const pop = key => teams.map(t => raw[t][key]);
  const out = {};
  for (const t of teams) {
    const r = raw[t];
    const offZ = 0.34 * z(r.rush_epa, pop('rush_epa'))
               + 0.28 * z(r.first_down, pop('first_down'))
               + 0.20 * z(r.explosive, pop('explosive'))
               - 0.10 * z(r.sack_allowed, pop('sack_allowed'))
               - 0.08 * z(r.fum_lost, pop('fum_lost'));
    const defZ = -0.46 * z(r.d_epa, pop('d_epa'))
               - 0.20 * z(r.d_ypp, pop('d_ypp'))
               + 0.16 * z(r.d_sack, pop('d_sack'))
               + 0.12 * z(r.d_int, pop('d_int'))
               + 0.06 * z(r.d_ff, pop('d_ff'));
    out[t] = {
      team: t,
      games: r.games,
      off_z: offZ,
      def_z: defZ,
      off_rating: rating100(offZ),
      def_rating: rating100(defZ),
      raw: r
    };
  }
  return out;
}

function parseDate(s) {
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Historical meetings in the 3 years strictly before this game. */
function h2hRecord(allGames, away, home, gameday, years = 3) {
  const target = parseDate(gameday);
  if (!target) return { home_wins: 0, away_wins: 0, ties: 0, games: 0, pct_edge: 0, repeat_edge: 0 };
  const cutoff = new Date(target);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  let hw = 0, aw = 0, ties = 0;
  for (const g of allGames) {
    const gd = parseDate(g.gameday);
    if (!gd || gd >= target || gd < cutoff) continue;
    if (g.game_type && !['REG', 'POST'].includes(g.game_type)) continue;
    const same = (g.home_team === home && g.away_team === away) || (g.home_team === away && g.away_team === home);
    if (!same || g.home_score === '' || g.away_score === '') continue;
    const hs = num(g.home_score), as = num(g.away_score);
    if (hs === as) { ties++; continue; }
    const winner = hs > as ? g.home_team : g.away_team;
    if (winner === home) hw++; else if (winner === away) aw++;
  }
  const games = hw + aw + ties;
  const pctEdge = games ? (hw - aw) / games : 0;
  // Interaction lets the fitted model decide whether repeated meetings make a
  // directional H2H result more useful. A 1-0 and 5-4 record need not be equal.
  const repeatEdge = pctEdge * Math.log1p(games);
  return { home_wins: hw, away_wins: aw, ties, games, pct_edge: pctEdge, repeat_edge: repeatEdge };
}

function featureRow({ homeTeam, awayTeam, homeQb, awayQb, qbRatings, teamRatings, h2h }) {
  const hq = qbRatings[homeQb];
  const aq = qbRatings[awayQb];
  const ht = teamRatings[homeTeam];
  const at = teamRatings[awayTeam];
  return {
    qb_diff: (hq ? hq.z : 0) - (aq ? aq.z : 0),
    off_diff: (ht ? ht.off_z : 0) - (at ? at.off_z : 0),
    def_diff: (ht ? ht.def_z : 0) - (at ? at.def_z : 0),
    h2h_edge: h2h ? h2h.pct_edge : 0,
    h2h_repeat: h2h ? h2h.repeat_edge : 0,
    h2h_games: h2h ? h2h.games : 0,
    home_qb_rating: hq ? hq.rating : 50,
    away_qb_rating: aq ? aq.rating : 50,
    home_off_rating: ht ? ht.off_rating : 50,
    away_off_rating: at ? at.off_rating : 50,
    home_def_rating: ht ? ht.def_rating : 50,
    away_def_rating: at ? at.def_rating : 50
  };
}

function standardizer(rows, features) {
  const meanBy = {}, sdBy = {};
  for (const f of features) {
    const vals = rows.map(r => num(r[f]));
    meanBy[f] = mean(vals);
    sdBy[f] = stdev(vals) || 1;
  }
  return { mean: meanBy, sd: sdBy };
}
function vectorize(row, features, scaler) {
  return features.map(f => (num(row[f]) - scaler.mean[f]) / scaler.sd[f]);
}

/** Small dependency-free L2 logistic fit for the research harness. */
function fitLogistic(rows, features, opts = {}) {
  if (!rows.length) throw new Error('fitLogistic requires training rows');
  const lambda = opts.lambda ?? 1.0;
  const iterations = opts.iterations ?? 3000;
  const lr0 = opts.learningRate ?? 0.08;
  const scaler = standardizer(rows, features);
  const X = rows.map(r => vectorize(r, features, scaler));
  const y = rows.map(r => num(r.home_win) > 0 ? 1 : 0);
  let intercept = 0;
  const beta = Array(features.length).fill(0);

  for (let iter = 0; iter < iterations; iter++) {
    let gi = 0;
    const gb = Array(beta.length).fill(0);
    for (let i = 0; i < X.length; i++) {
      let eta = intercept;
      for (let j = 0; j < beta.length; j++) eta += beta[j] * X[i][j];
      const err = sigmoid(eta) - y[i];
      gi += err;
      for (let j = 0; j < beta.length; j++) gb[j] += err * X[i][j];
    }
    gi /= X.length;
    const lr = lr0 / Math.sqrt(1 + iter / 500);
    intercept -= lr * gi;
    for (let j = 0; j < beta.length; j++) {
      const grad = gb[j] / X.length + (lambda / X.length) * beta[j];
      beta[j] -= lr * grad;
    }
  }

  return {
    features: [...features], lambda, intercept, beta, scaler,
    coefficients: Object.fromEntries(features.map((f, i) => [f, beta[i]]))
  };
}

function predict(model, row) {
  const x = vectorize(row, model.features, model.scaler);
  let eta = model.intercept;
  for (let j = 0; j < model.beta.length; j++) eta += model.beta[j] * x[j];
  return sigmoid(eta);
}

/** Strict >60% by default. Exactly 60.0% is Too Close to Call. */
function classifyPick(homeProb, homeTeam = 'HOME', awayTeam = 'AWAY', threshold = PICK_THRESHOLD) {
  const p = clamp(homeProb, 0, 1);
  if (p > threshold) return { pick: homeTeam, probability: p, status: 'leo_pick' };
  if ((1 - p) > threshold) return { pick: awayTeam, probability: 1 - p, status: 'leo_pick' };
  return { pick: null, probability: Math.max(p, 1 - p), status: 'too_close_to_call' };
}

/**
 * The model with each input's weight scaled, for the public Model Tuner.
 * mult = { qb, off, def, hfa }; 1 = as shipped, and with every value at 1
 * this returns exactly predict(model, row). The tuner loads THIS file, so the
 * tuner and the live generator can never run different math.
 */
function predictWeighted(model, row, mult = {}) {
  const x = vectorize(row, model.features, model.scaler);
  const m = { qb_diff: mult.qb ?? 1, off_diff: mult.off ?? 1, def_diff: mult.def ?? 1,
              h2h_edge: mult.h2h ?? 1, h2h_repeat: mult.h2h ?? 1 };
  let eta = model.intercept * (mult.hfa ?? 1);
  for (let j = 0; j < model.beta.length; j++) eta += model.beta[j] * x[j] * (m[model.features[j]] ?? 1);
  return sigmoid(eta);
}

function brier(rows, probabilityKey = 'prob') {
  return mean(rows.map(r => (r[probabilityKey] - (r.home_win ? 1 : 0)) ** 2));
}

const API = {
  PICK_THRESHOLD,
  predictWeighted,
  buildQbRatings,
  buildTeamRatings,
  h2hRecord,
  featureRow,
  fitLogistic,
  predict,
  classifyPick,
  brier,
  sigmoid,
  _test: { aggregateQb, qbRates, teamWeeks, standardizer, vectorize, shrink, z }
};

// Works in Node (require) and in the browser (<script src>, as window.LeoML).
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.LeoML = API;
})();
