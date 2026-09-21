#!/usr/bin/env node
/**
 * NFL team ratings, moneyline picks and team stats.
 *
 * Same discipline as the props model (claude/K_PROPS_MODEL_ANALYSIS.md):
 * every input real, every small-sample rate regressed toward a prior.
 *
 *   rating      = shrink(point margin per game, games, prior-season margin)
 *   exp_margin  = ratingA - ratingB + HFA
 *   win_prob    = normal CDF(exp_margin / SD)
 *   edge        = win_prob - no-vig market probability
 *
 * Sources: nflverse games.csv (schedule, results, closing odds)
 *          nflverse stats_player_week_{2026,2025}.csv (team yardage)
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { buildRatings, headToHead } = require("./lib/nfl-ratings.js");
const ML = require("./lib/nfl-moneyline.js");
const ROOT = path.join(__dirname, "..");
const FEED = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";
const REL  = "https://github.com/nflverse/nflverse-data/releases/download";

const SEASON = 2026, PRIOR = 2025;
const HFA = 2.0;        // home-field advantage in points (modern NFL ~2)
const SD  = 13.2;       // SD of NFL game margin vs spread
const K_PSEUDO = 4;     // regression strength, matches the props model
const EDGE_MIN = 0.04;  // minimum edge to call an official pick
// No NFL market has a backtested profitable threshold yet, so Leo publishes
// numbers and passes -- never a wager. Flip this only when
// scripts/backtest-nfl.js shows a positive ROI band holding across seasons.
const PICKS_ENABLED = false;
const K_MARKET = 8;     // pseudo-games before the model outweighs the market prior
const EDGE_CAP = 0.15;  // a disagreement past this means the MODEL is wrong, not the market
const TOTAL_SD = 10.4;  // SD of actual combined points vs the closing total
const TOTAL_EDGE_MIN = 1.5;   // points of disagreement before a total is playable
const TOTAL_EDGE_CAP = 7.0;   // past this the totals model is wrong, not the market
const SPREAD_EDGE_MIN = 1.0;  // points vs the closing spread
const ROOF_BUMP = { dome: 0.8, closed: 0.8, open: 0.0, outdoors: 0.0 };

function parseCSV(text){
  const rows=[]; let row=[], f="", q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; }
    else if(c==='"') q=true;
    else if(c===",") {row.push(f);f="";}
    else if(c==="\n"){row.push(f);rows.push(row);row=[];f="";}
    else if(c!=="\r") f+=c; }
  if(f.length||row.length){row.push(f);rows.push(row);}
  const h=rows.shift().map(x=>x.trim());
  return rows.filter(r=>r.length>1).map(r=>Object.fromEntries(h.map((k,i)=>[k,(r[i]??"").trim()])));
}
function get(url){
  return parseCSV(execFileSync("curl",["-sSL","--fail","--max-time","120",url],
    {maxBuffer:1024*1024*512, encoding:"utf8"}));
}
const n = v => { const x=parseFloat(v); return Number.isFinite(x)?x:null; };
const mean = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0;
const r1 = x => Math.round(x*10)/10;
const r3 = x => Math.round(x*1000)/1000;
function shrink(obs,nObs,prior,k=K_PSEUDO){ return nObs ? ((nObs*obs)+(k*prior))/(nObs+k) : prior; }
// Abramowitz-Stegun normal CDF
function normCdf(z){
  const t=1/(1+0.2316419*Math.abs(z));
  const d=0.3989423*Math.exp(-z*z/2);
  let p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));
  return z>0 ? 1-p : p;
}
const impl = a => { const x=n(a); return x==null?null : (x>0 ? 100/(x+100) : (-x)/((-x)+100)); };
function devig(a,b){ const x=impl(a),y=impl(b); if(x==null||y==null) return [null,null];
  const s=x+y; return s>0?[x/s,y/s]:[null,null]; }

(async function main(){
  const target = process.argv[2] || new Date(Date.now()+864e5).toISOString().slice(0,10);
  console.log(`NFL model for ${target}`);

  const games = get(FEED);
  const played = s => games.filter(g => g.season===String(s) && g.away_score!=="" && g.home_score!=="");

  // ---- point-margin ratings, regressed toward the prior season -------------
  function margins(rows){
    const m={};
    rows.forEach(g=>{
      const as=n(g.away_score), hs=n(g.home_score);
      if(as==null||hs==null) return;
      (m[g.away_team]=m[g.away_team]||[]).push(as-hs-(-HFA));
      (m[g.home_team]=m[g.home_team]||[]).push(hs-as-HFA);
    });
    return m;
  }
  const cur = margins(played(SEASON));
  const pri = margins(played(PRIOR));
  const teams = [...new Set(games.filter(g=>g.season===String(SEASON)).flatMap(g=>[g.away_team,g.home_team]))].filter(Boolean);

  const rating = {}, gp = {};
  teams.forEach(t=>{
    const c = cur[t]||[], p = pri[t]||[];
    gp[t] = c.length;
    const priorRating = p.length ? shrink(mean(p), p.length, 0, 6) : 0;
    rating[t] = shrink(mean(c), c.length, priorRating);
  });

  // ---- team yardage from weekly player stats -------------------------------
  const wk = get(`${REL}/stats_player/stats_player_week_${SEASON}.csv`);
  const off={}, def={}, offW={}, defW={};
  wk.forEach(r=>{
    const py=n(r.passing_yards)||0, ry=n(r.rushing_yards)||0;
    const k=`${r.team}|${r.week}`, o=`${r.opponent_team}|${r.week}`;
    (offW[k]=offW[k]||{p:0,r:0}); offW[k].p+=py; offW[k].r+=ry;
    (defW[o]=defW[o]||{p:0,r:0}); defW[o].p+=py; defW[o].r+=ry;
  });
  const roll=(src,dst)=>Object.entries(src).forEach(([k,v])=>{
    const t=k.split("|")[0]; (dst[t]=dst[t]||{p:[],r:[]}); dst[t].p.push(v.p); dst[t].r.push(v.r);
  });
  roll(offW,off); roll(defW,def);

  // ---- records -------------------------------------------------------------
  const rec={};
  teams.forEach(t=>rec[t]={w:0,l:0,t:0,pf:0,pa:0});
  played(SEASON).forEach(g=>{
    const as=n(g.away_score), hs=n(g.home_score);
    const A=rec[g.away_team], H=rec[g.home_team];
    if(!A||!H) return;
    A.pf+=as; A.pa+=hs; H.pf+=hs; H.pa+=as;
    if(as>hs){A.w++;H.l++;} else if(hs>as){H.w++;A.l++;} else {A.t++;H.t++;}
  });

  // ---- component ratings: QB, offense, defense, turnover battle -----------
  // DISPLAY AND CONTEXT ONLY. The 2025 backtest (claude/NFL_BACKTEST_RESULTS.md)
  // showed this composite scores WORSE than plain point margin on win
  // probability (Brier .2182 vs .2146, market .2123), so it deliberately does
  // NOT feed model_prob. Wiring it in would make picks worse. Revisit only
  // with FITTED weights, not the hand-assigned ones in lib/nfl-ratings.js.
  let RATINGS = {};
  let WK_PRIOR = [];
  try{
    const wkPrior = get(`${REL}/stats_player/stats_player_week_${PRIOR}.csv`);
    WK_PRIOR = wkPrior;
    RATINGS = buildRatings(wk, wkPrior);
    console.log(`  component ratings: ${Object.keys(RATINGS).length} teams (context only)`);
  }catch(e){ console.log("  component ratings unavailable: "+e.message); }

  // ---- conference / division ----------------------------------------------
  let confDiv = {};
  try{
    const meta = get("https://raw.githubusercontent.com/nflverse/nflverse-pbp/master/teams_colors_logos.csv");
    meta.forEach(r=>{ if(r.team_abbr) confDiv[r.team_abbr] = {
      conf:r.team_conf||"", div:r.team_division||"", name:r.team_name||r.team_abbr,
      color:r.team_color||"", color2:r.team_color2||"" }; });
  }catch(e){ console.log("  conf/div: unavailable ("+e.message+")"); }

  // ---- scoring pace, regressed (drives the totals model) -------------------
  const pf={}, pa={};
  played(SEASON).forEach(g=>{
    const as=n(g.away_score), hs=n(g.home_score);
    (pf[g.away_team]=pf[g.away_team]||[]).push(as); (pa[g.away_team]=pa[g.away_team]||[]).push(hs);
    (pf[g.home_team]=pf[g.home_team]||[]).push(hs); (pa[g.home_team]=pa[g.home_team]||[]).push(as);
  });
  const pfP={}, paP={};
  played(PRIOR).forEach(g=>{
    const as=n(g.away_score), hs=n(g.home_score);
    (pfP[g.away_team]=pfP[g.away_team]||[]).push(as); (paP[g.away_team]=paP[g.away_team]||[]).push(hs);
    (pfP[g.home_team]=pfP[g.home_team]||[]).push(hs); (paP[g.home_team]=paP[g.home_team]||[]).push(as);
  });
  const allPf = played(SEASON).flatMap(g=>[n(g.away_score),n(g.home_score)]).filter(x=>x!=null);
  const leaguePPG = allPf.length ? mean(allPf) : 22.5;
  const paceFor={}, paceAgainst={};
  teams.forEach(t=>{
    const priorFor = pfP[t] ? shrink(mean(pfP[t]), pfP[t].length, leaguePPG, 6) : leaguePPG;
    const priorAgn = paP[t] ? shrink(mean(paP[t]), paP[t].length, leaguePPG, 6) : leaguePPG;
    paceFor[t]     = shrink(pf[t]?mean(pf[t]):leaguePPG, (pf[t]||[]).length, priorFor);
    paceAgainst[t] = shrink(pa[t]?mean(pa[t]):leaguePPG, (pa[t]||[]).length, priorAgn);
  });

  const teamStats = teams.map(t=>({
    team:t, games:gp[t],
    name:(confDiv[t]||{}).name||t, conf:(confDiv[t]||{}).conf||"", division:(confDiv[t]||{}).div||"",
    pace_for:r1(paceFor[t]??leaguePPG), pace_against:r1(paceAgainst[t]??leaguePPG),
    record: `${rec[t].w}-${rec[t].l}${rec[t].t?"-"+rec[t].t:""}`,
    rating: r1(rating[t]),
    points_for: gp[t]?r1(rec[t].pf/gp[t]):null,
    points_against: gp[t]?r1(rec[t].pa/gp[t]):null,
    point_diff: gp[t]?r1((rec[t].pf-rec[t].pa)/gp[t]):null,
    pass_yards_for: off[t]?r1(mean(off[t].p)):null,
    rush_yards_for: off[t]?r1(mean(off[t].r)):null,
    pass_yards_against: def[t]?r1(mean(def[t].p)):null,
    rush_yards_against: def[t]?r1(mean(def[t].r)):null,
    ...(RATINGS[t] ? {
      qb_rating:RATINGS[t].qb_rating, off_rating:RATINGS[t].off_rating,
      def_rating:RATINGS[t].def_rating, overall_rating:RATINGS[t].overall,
      ints_thrown_pg:RATINGS[t].ints_thrown_pg, ints_caught_pg:RATINGS[t].ints_caught_pg,
      takeaways_pg:RATINGS[t].takeaways_pg, giveaways_pg:RATINGS[t].giveaways_pg,
      turnover_diff_pg:RATINGS[t].turnover_diff_pg,
      epa_per_dropback:RATINGS[t].epa_per_dropback, cpoe:RATINGS[t].cpoe,
      int_rate:RATINGS[t].int_rate, sack_rate_taken:RATINGS[t].sack_rate_taken,
      def_epa_per_play:RATINGS[t].def_epa_per_play, def_sack_rate:RATINGS[t].def_sack_rate,
      def_int_rate:RATINGS[t].def_int_rate, def_yards_per_play:RATINGS[t].def_yards_per_play
    } : {})
  })).sort((a,b)=>b.rating-a.rating).map((x,i)=>({...x, rank:i+1}));

  // ---- picks for the target slate -----------------------------------------
  const slate = games.filter(g=>g.gameday===target)
                     .sort((a,b)=>String(a.gametime).localeCompare(String(b.gametime)));
  /*
    MONEYLINE = leo-nflml-v2 (live since 2026-09-21, DEC-20260921-10).
    Win probability from a fitted logistic model: expected starting QB
    rating, supporting offense, defense, fitted home field. No sportsbook
    input. Coefficients come from data/nfl/moneyline-v2-model.json (fit by
    scripts/train-nfl-moneyline.js); inputs use only weeks before the slate.
    A Leo Pick needs one side strictly above 60%; otherwise Too Close to Call.
    Spread and total still use the v1 point-margin rating (expMargin).
  */
  const ML_MODEL = JSON.parse(fs.readFileSync(path.join(ROOT,"data/nfl/moneyline-v2-model.json"),"utf8"));
  const mlByWeek = {};
  const mlInputs = week => mlByWeek[week] || (mlByWeek[week] = (() => {
    const pre = wk.filter(r => (n(r.week)||0) < week);
    return { pre, qb: ML.buildQbRatings(pre, WK_PRIOR), team: ML.buildTeamRatings(pre, WK_PRIOR) };
  })());
  // Expected starter: games.csv names him for the coming week; otherwise the
  // team's QB with the most attempts this season, then last season.
  const starterQb = (named, team, pre) => {
    if (named) return named;
    for (const rows of [pre, WK_PRIOR]) {
      const att = {};
      rows.forEach(r => { if (r.position==="QB" && r.team===team) {
        const nm = r.player_display_name || r.player_name; att[nm] = (att[nm]||0) + (n(r.attempts)||0); } });
      const best = Object.entries(att).sort((a,b)=>b[1]-a[1])[0];
      if (best) return best[0];
    }
    return "";
  };
  const picks = slate.map(g=>{
    const expMargin = (rating[g.home_team]??0) - (rating[g.away_team]??0) + HFA;
    const v1Home = normCdf(expMargin/SD);
    const inp = mlInputs(n(g.week)||1);
    const homeQb = starterQb(g.home_qb_name, g.home_team, inp.pre);
    const awayQb = starterQb(g.away_qb_name, g.away_team, inp.pre);
    const h2h3 = ML.h2hRecord(games, g.away_team, g.home_team, g.gameday, 3);
    const feats = ML.featureRow({ homeTeam:g.home_team, awayTeam:g.away_team, homeQb, awayQb,
      qbRatings:inp.qb, teamRatings:inp.team, h2h:h2h3 });
    const rawHome = ML.predict(ML_MODEL, feats);
    const call = ML.classifyPick(rawHome, g.home_team, g.away_team);
    const [mktAway,mktHome] = devig(g.away_moneyline,g.home_moneyline);

    // LEO'S NUMBER IS LEO'S. No market blending anywhere in this file.
    // A probability blended toward the closing line cannot show a real edge
    // against that line -- it is damped toward zero by construction, so the
    // "edge" becomes a statement about itself. The posted price already tells
    // you what the market thinks. This is Leo's independent read.
    //
    // The cost of that honesty is measured, not assumed: across 599 bets in
    // 2023-2025 this unblended model returns -8.1% at a 3% edge threshold and
    // -38.7% at 20%. Its most confident disagreements are its worst bets.
    // Hence PICKS_ENABLED below -- the number publishes, the wager does not.
    const gamesSeen = Math.min(gp[g.home_team]??0, gp[g.away_team]??0);
    const w = 1;                        // kept for reporting; no longer blends
    const homeProb = rawHome;
    const awayProb = 1-homeProb;
    const edgeHome = mktHome!=null ? homeProb-mktHome : null;
    const edgeAway = mktAway!=null ? awayProb-mktAway : null;
    /*
      PICK THE WINNER. The side is whichever team Leo's own probability
      favours -- the market plays no part in choosing it.

      It used to be chosen by the larger market edge, i.e. whichever team the
      book priced furthest from Leo's number. That is coherent betting logic
      but it is not a prediction, and it produced published cards Leo did not
      believe: on 2026-09-20 it named CLE at 35% while Leo had TB at 65%, and
      named CIN at 49% while Leo had HOU at 51%. Six of thirteen picks that
      day were on the side Leo expected to LOSE. It also put the sportsbook
      back in the moneyline decision through the back door -- Leo's number was
      never blended, but the book still decided which team we named.

      The graded record moved from 10-3 to 8-5 when this changed. The 10-3 was
      a value-betting record being displayed as a forecasting record.

      The market edge is still computed and published as context -- it is what
      a bet would hinge on -- but it no longer selects the side.
    */
    let side=null, edge=null, prob=null, price=null, mkt=null;
    if(homeProb>=0.5){
      side=g.home_team; prob=homeProb; price=n(g.home_moneyline); mkt=mktHome; edge=edgeHome;
    } else {
      side=g.away_team; prob=awayProb; price=n(g.away_moneyline); mkt=mktAway; edge=edgeAway;
    }
    // Edge on the side we actually named. Null when the market has no price.
    const valueSide = (edgeHome!=null&&edgeAway!=null)
      ? (edgeHome>=edgeAway ? g.home_team : g.away_team) : null;
    // Cards carry two states only: official_pick or pass. Nuance about WHY a
    // game passes belongs on the matchup page, not on a card.
    const rawDisagree = (mktHome!=null) ? Math.abs(rawHome-mktHome) : null;
    const suspect = rawDisagree!=null && rawDisagree>EDGE_CAP;
    const status = edge==null ? "no_market"
                 : (PICKS_ENABLED && edge>=EDGE_MIN && !suspect) ? "official_pick"
                 : "pass";

    // ---- TOTALS MODEL -----------------------------------------------------
    // Each side's expected points = its own scoring pace blended with what the
    // opponent's defense concedes. Both inputs are already regressed toward a
    // prior-season baseline, so one blowout cannot move a number.
    const awayPts = ((paceFor[g.away_team]??leaguePPG) + (paceAgainst[g.home_team]??leaguePPG))/2;
    const homePts = ((paceFor[g.home_team]??leaguePPG) + (paceAgainst[g.away_team]??leaguePPG))/2;
    const roofKey = String(g.roof||"").toLowerCase();
    const roofAdj = ROOF_BUMP[roofKey] ?? 0;
    const windAdj = (n(g.wind)!=null && n(g.wind) >= 15) ? -1.6 : 0;   // heavy wind suppresses scoring
    const rawTotal = awayPts + homePts + roofAdj + windAdj;
    const mktTotal = n(g.total_line);
    // Same market-prior discipline as the moneyline: the closing total is sharp.
    const projTotal = rawTotal;    // Leo total, unblended
    const totalEdge = mktTotal!=null ? projTotal-mktTotal : null;
    const rawTotalDisagree = mktTotal!=null ? Math.abs(rawTotal-mktTotal) : null;
    const totalSuspect = rawTotalDisagree!=null && rawTotalDisagree>TOTAL_EDGE_CAP;
    const totalStatus = totalEdge==null ? "no_market"
                      : (PICKS_ENABLED && Math.abs(totalEdge)>=TOTAL_EDGE_MIN && !totalSuspect)
                        ? "official_pick" : "pass";
    const totalSide = totalEdge==null ? null : (totalEdge>0 ? "Over" : "Under");
    // P(total clears the line), for sizing context
    const overProb = mktTotal==null ? null : 1-normCdf((mktTotal-projTotal)/TOTAL_SD);

    // ---- SPREAD MODEL -----------------------------------------------------
    // spread_line is stated from the HOME side: positive = home favoured.
    const mktSpread = n(g.spread_line);
    const projSpread = expMargin;  // Leo spread, unblended
    const spreadEdge = mktSpread!=null ? projSpread-mktSpread : null;
    const spreadSide = spreadEdge==null ? null : (spreadEdge>0 ? g.home_team : g.away_team);
    const coverProb = mktSpread==null ? null : 1-normCdf((mktSpread-projSpread)/SD);
    const spreadStatus = spreadEdge==null ? "no_market"
                       : (PICKS_ENABLED && Math.abs(spreadEdge)>=SPREAD_EDGE_MIN)
                         ? "official_pick" : "pass";
    return {
      date:target, game_id:g.game_id, matchup:`${g.away_team} @ ${g.home_team}`,
      away:g.away_team, home:g.home_team, kickoff:g.gametime, stadium:g.stadium,
      week:g.week, model_version:"leo-nflml-v2", status,
      // Leo Pick only above 60%. The favoured side and its probability stay
      // in pick/model_prob; ml_call says whether it counts as a pick.
      ml_call: call.status, v1_model_prob: r3(v1Home >= 0.5 ? v1Home : 1-v1Home),
      home_qb: homeQb, away_qb: awayQb,
      home_qb_rating: feats.home_qb_rating, away_qb_rating: feats.away_qb_rating,
      h2h_3yr: { home_wins:h2h3.home_wins, away_wins:h2h3.away_wins, ties:h2h3.ties, games:h2h3.games },
      pick:side, model_prob:prob!=null?r3(prob):null, market_prob:mkt!=null?r3(mkt):null,
      edge:edge!=null?r3(edge):null, price,
      // The side the market underprices, which may differ from the side Leo
      // expects to win. Reported, never picked.
      value_side:valueSide, value_side_differs: valueSide!=null && valueSide!==side,
      exp_margin:r1(expMargin), raw_model_prob:r3(rawHome), model_flagged:suspect,
      model_weight:r3(w), raw_disagreement:rawDisagree!=null?r3(rawDisagree):null,
      spread_line:n(g.spread_line), total_line:n(g.total_line),
      // head-to-head component comparison (context, not an input to model_prob)
      h2h: headToHead(RATINGS, g.away_team, g.home_team),
      away_ratings: RATINGS[g.away_team] ? {
        qb:RATINGS[g.away_team].qb_rating, off:RATINGS[g.away_team].off_rating,
        def:RATINGS[g.away_team].def_rating, overall:RATINGS[g.away_team].overall,
        ints_thrown_pg:RATINGS[g.away_team].ints_thrown_pg,
        ints_caught_pg:RATINGS[g.away_team].ints_caught_pg,
        turnover_diff_pg:RATINGS[g.away_team].turnover_diff_pg,
        epa_per_dropback:RATINGS[g.away_team].epa_per_dropback,
        def_epa_per_play:RATINGS[g.away_team].def_epa_per_play } : null,
      home_ratings: RATINGS[g.home_team] ? {
        qb:RATINGS[g.home_team].qb_rating, off:RATINGS[g.home_team].off_rating,
        def:RATINGS[g.home_team].def_rating, overall:RATINGS[g.home_team].overall,
        ints_thrown_pg:RATINGS[g.home_team].ints_thrown_pg,
        ints_caught_pg:RATINGS[g.home_team].ints_caught_pg,
        turnover_diff_pg:RATINGS[g.home_team].turnover_diff_pg,
        epa_per_dropback:RATINGS[g.home_team].epa_per_dropback,
        def_epa_per_play:RATINGS[g.home_team].def_epa_per_play } : null,
      // totals model
      total_status:totalStatus, total_side:totalSide,
      proj_total:r1(projTotal), raw_proj_total:r1(rawTotal),
      total_edge:totalEdge==null?null:r1(totalEdge),
      over_prob:overProb==null?null:r3(overProb),
      roof_adj:roofAdj, wind_adj:windAdj,
      away_exp_points:r1(awayPts), home_exp_points:r1(homePts),
      // spread model
      spread_status:spreadStatus, spread_side:spreadSide,
      proj_spread:r1(projSpread),
      spread_edge:spreadEdge==null?null:r1(spreadEdge),
      cover_prob:coverProb==null?null:r3(coverProb),
      away_rating:r1(rating[g.away_team]??0), home_rating:r1(rating[g.home_team]??0),
      away_ml:n(g.away_moneyline), home_ml:n(g.home_moneyline)
    };
  });

  // ---- injury report -------------------------------------------------------
  let injuries=[];
  try{
    const inj = get(`${REL}/injuries/injuries_${SEASON}.csv`);
    const maxWk = Math.max(...inj.map(r=>n(r.week)||0));
    injuries = inj.filter(r => (n(r.week)||0) === maxWk && (r.report_status||r.practice_status))
      .map(r=>({
        week:n(r.week), team:r.team, player:r.full_name, position:r.position,
        status:r.report_status||"", practice:r.practice_status||"",
        injury:[r.report_primary_injury,r.report_secondary_injury].filter(Boolean).join(" / ")
               || [r.practice_primary_injury,r.practice_secondary_injury].filter(Boolean).join(" / ")
      }))
      .sort((a,b)=> a.team.localeCompare(b.team) || a.player.localeCompare(b.player));
    console.log(`  injuries: ${injuries.length} listed for week ${maxWk}`);
  }catch(e){ console.log("  injuries: unavailable ("+e.message+")"); }

  // ---- completed results ---------------------------------------------------
  const results = played(SEASON).map(g=>{
    const as=n(g.away_score), hs=n(g.home_score);
    const tot=as+hs, tl=n(g.total_line), sp=n(g.spread_line);
    const [mktAway,mktHome]=devig(g.away_moneyline,g.home_moneyline);
    const favHome = sp!=null ? sp>0 : null;
    return {
      date:g.gameday, week:n(g.week), game_id:g.game_id,
      matchup:`${g.away_team} @ ${g.home_team}`, away:g.away_team, home:g.home_team,
      away_score:as, home_score:hs, winner: as>hs?g.away_team:(hs>as?g.home_team:"TIE"),
      margin:Math.abs(hs-as), total:tot, total_line:tl,
      total_result: tl==null?null:(tot>tl?"Over":(tot<tl?"Under":"Push")),
      spread_line:sp,
      favorite_covered: (sp==null||favHome==null)?null
        : (favHome ? (hs-as) > sp : (as-hs) > -sp),
      underdog_won: (mktAway==null||mktHome==null)?null
        : ((mktHome>mktAway && as>hs) || (mktAway>mktHome && hs>as)),
      stadium:g.stadium
    };
  }).sort((a,b)=> b.date.localeCompare(a.date) || a.matchup.localeCompare(b.matchup));

  const dir=path.join(ROOT,"data/nfl");
  fs.mkdirSync(dir,{recursive:true});
  for(const [name,data] of [["team-stats",teamStats],["picks",picks],["injuries",injuries],["results",results]]){
    fs.writeFileSync(path.join(dir,`${name}-${target}.json`), JSON.stringify(data,null,2));
    // Only promote to the rolling -today file when there is something to show.
    // Most calendar days have no NFL games; without this guard the daily
    // gather blanks the live pages every Tuesday by publishing an empty array.
    if(Array.isArray(data) && data.length){
      fs.writeFileSync(path.join(dir,`${name}-today.json`), JSON.stringify(data,null,2));
    } else {
      console.log(`  ${name}: empty for ${target}, leaving -today.json untouched`);
    }
  }
  /*
    FREEZE THE PREDICTION. picks-{target}.json is rewritten by every
    prepare-slate run, including the ones that fire after kickoff -- and those
    reruns recompute ratings from completed games, so a post-kickoff rerun
    "predicts" a game it has already seen. Grading read that file and produced
    a 10-3 moneyline record that was really 6-7.
    The append-only history below is what grading reads instead. Nothing here
    is ever rewritten.
  */
  try {
    const { record } = require("./lib/prediction-history");
    const h = record(dir, picks);
    console.log(`  prediction history: +${h.appended} new/changed, ${h.unchanged} unchanged` +
                (h.created ? " (created prediction-history.csv)" : ""));
  } catch(e) {
    console.warn(`  prediction history NOT written: ${e.message}`);
  }

  const official=picks.filter(p=>p.status==="official_pick").length;
  const flagged=picks.filter(p=>p.status==="model_flag").length;
  console.log(`  model weight this week: ${(picks[0]?picks[0].model_weight:0)} (rest is market prior)`);
  console.log(`  flagged as model-unreliable: ${flagged}`);
  console.log(`  teams rated: ${teamStats.length}  (top: ${teamStats[0].team} ${teamStats[0].rating}, bottom: ${teamStats[teamStats.length-1].team} ${teamStats[teamStats.length-1].rating})`);
  console.log(`  slate: ${picks.length} games  official picks: ${official}  passes: ${picks.length-official-flagged}`);
  const tOff=picks.filter(p=>p.total_status==="official_pick").length;
  const sOff=picks.filter(p=>p.spread_status==="official_pick").length;
  console.log(`  totals model: ${tOff} playable  (league pace ${r1(leaguePPG)} ppg)`);
  console.log(`  spread model: ${sOff} playable`);
  console.log(`  results logged: ${results.length} completed games`);
})();
