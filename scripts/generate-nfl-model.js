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
const ROOT = path.join(__dirname, "..");
const FEED = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";
const REL  = "https://github.com/nflverse/nflverse-data/releases/download";

const SEASON = 2026, PRIOR = 2025;
const HFA = 2.0;        // home-field advantage in points (modern NFL ~2)
const SD  = 13.2;       // SD of NFL game margin vs spread
const K_PSEUDO = 4;     // regression strength, matches the props model
const EDGE_MIN = 0.04;  // minimum edge to call an official pick
const K_MARKET = 8;     // pseudo-games before the model outweighs the market prior
const EDGE_CAP = 0.15;  // a disagreement past this means the MODEL is wrong, not the market

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

  const teamStats = teams.map(t=>({
    team:t, games:gp[t],
    record: `${rec[t].w}-${rec[t].l}${rec[t].t?"-"+rec[t].t:""}`,
    rating: r1(rating[t]),
    points_for: gp[t]?r1(rec[t].pf/gp[t]):null,
    points_against: gp[t]?r1(rec[t].pa/gp[t]):null,
    point_diff: gp[t]?r1((rec[t].pf-rec[t].pa)/gp[t]):null,
    pass_yards_for: off[t]?r1(mean(off[t].p)):null,
    rush_yards_for: off[t]?r1(mean(off[t].r)):null,
    pass_yards_against: def[t]?r1(mean(def[t].p)):null,
    rush_yards_against: def[t]?r1(mean(def[t].r)):null
  })).sort((a,b)=>b.rating-a.rating).map((x,i)=>({...x, rank:i+1}));

  // ---- picks for the target slate -----------------------------------------
  const slate = games.filter(g=>g.gameday===target)
                     .sort((a,b)=>String(a.gametime).localeCompare(String(b.gametime)));
  const picks = slate.map(g=>{
    const expMargin = (rating[g.home_team]??0) - (rating[g.away_team]??0) + HFA;
    const rawHome = normCdf(expMargin/SD);
    const [mktAway,mktHome] = devig(g.away_moneyline,g.home_moneyline);

    // The betting market is a strong, well-calibrated prior. Early in the season a
    // margin rating built on 1-2 games cannot beat it, so the model only earns
    // weight as real games accumulate. Without this the model "finds" 30% edges,
    // which is a symptom of overfitting, not an opportunity.
    const gamesSeen = Math.min(gp[g.home_team]??0, gp[g.away_team]??0);
    const w = gamesSeen/(gamesSeen+K_MARKET);
    const homeProb = (mktHome!=null) ? (w*rawHome + (1-w)*mktHome) : rawHome;
    const awayProb = 1-homeProb;
    const edgeHome = mktHome!=null ? homeProb-mktHome : null;
    const edgeAway = mktAway!=null ? awayProb-mktAway : null;
    let side=null, edge=null, prob=null, price=null, mkt=null;
    if(edgeHome!=null&&edgeAway!=null){
      if(edgeHome>=edgeAway){side=g.home_team;edge=edgeHome;prob=homeProb;price=n(g.home_moneyline);mkt=mktHome;}
      else {side=g.away_team;edge=edgeAway;prob=awayProb;price=n(g.away_moneyline);mkt=mktAway;}
    }
    // A residual disagreement past EDGE_CAP means the model is broken for this
    // game, not that the market is wrong. Flag it rather than betting it.
    const rawDisagree = (mktHome!=null) ? Math.abs(rawHome-mktHome) : null;
    const suspect = rawDisagree!=null && rawDisagree>EDGE_CAP;
    const status = edge==null ? "no_market"
                 : suspect     ? "model_flag"
                 : (edge>=EDGE_MIN ? "official_pick" : "pass");
    return {
      date:target, game_id:g.game_id, matchup:`${g.away_team} @ ${g.home_team}`,
      away:g.away_team, home:g.home_team, kickoff:g.gametime, stadium:g.stadium,
      week:g.week, model_version:"leo-nflml-v1", status,
      pick:side, model_prob:prob!=null?r3(prob):null, market_prob:mkt!=null?r3(mkt):null,
      edge:edge!=null?r3(edge):null, price,
      exp_margin:r1(expMargin), raw_model_prob:r3(rawHome),
      model_weight:r3(w), raw_disagreement:rawDisagree!=null?r3(rawDisagree):null,
      spread_line:n(g.spread_line), total_line:n(g.total_line),
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
    fs.writeFileSync(path.join(dir,`${name}-today.json`), JSON.stringify(data,null,2));
  }
  const official=picks.filter(p=>p.status==="official_pick").length;
  const flagged=picks.filter(p=>p.status==="model_flag").length;
  console.log(`  model weight this week: ${(picks[0]?picks[0].model_weight:0)} (rest is market prior)`);
  console.log(`  flagged as model-unreliable: ${flagged}`);
  console.log(`  teams rated: ${teamStats.length}  (top: ${teamStats[0].team} ${teamStats[0].rating}, bottom: ${teamStats[teamStats.length-1].team} ${teamStats[teamStats.length-1].rating})`);
  console.log(`  slate: ${picks.length} games  official picks: ${official}  passes: ${picks.length-official-flagged}`);
  console.log(`  results logged: ${results.length} completed games`);
})();
