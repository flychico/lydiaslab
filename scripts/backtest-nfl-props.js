#!/usr/bin/env node
/**
 * NFL player-prop backtest — walk-forward accuracy on a completed season.
 *
 * We have no historical prop LINES, so ROI is not measurable. What IS
 * measurable, and matters more at this stage, is whether the projections are
 * accurate and unbiased: MAE against actuals, systematic bias, and whether
 * the model beats the naive baselines it must beat to be worth running at all.
 *
 * Baselines:
 *   season-to-date  — the player's mean so far this season
 *   last-3          — the player's mean over their last three games
 * A projection that cannot beat both is adding nothing.
 *
 * NO LOOKAHEAD: week W is projected from weeks < W only.
 */
const { execFileSync } = require("child_process");
const fs=require("fs"), path=require("path");
const PROPS=require("./lib/nfl-props-model");
const REL="https://github.com/nflverse/nflverse-data/releases/download";
const argv=process.argv.slice(2);
const flag=(n,d)=>{const i=argv.indexOf("--"+n);return i>=0?argv[i+1]:d;};
const SEASON=Number(flag("season",2025)), PRIOR=SEASON-1;

const K_PSEUDO=4, CLAMP_LO=0.85, CLAMP_HI=1.15;
function weights(n){
  if(n>=6) return {recent:.60,season:.40,prior:.00};
  if(n>=3) return {recent:.45,season:.30,prior:.25};
  return {recent:.30,season:.20,prior:.50};
}
function parseCSV(text){
  const rows=[];let row=[],f="",q=false;
  for(let i=0;i<text.length;i++){const c=text[i];
    if(q){if(c==='"'){if(text[i+1]==='"'){f+='"';i++;}else q=false;}else f+=c;}
    else if(c==='"')q=true; else if(c===","){row.push(f);f="";}
    else if(c==="\n"){row.push(f);rows.push(row);row=[];f="";}
    else if(c!=="\r")f+=c;}
  if(f.length||row.length){row.push(f);rows.push(row);}
  const h=rows.shift().map(x=>x.trim());
  return rows.filter(r=>r.length>1).map(r=>Object.fromEntries(h.map((k,i)=>[k,(r[i]??"").trim()])));
}
const get=u=>parseCSV(execFileSync("curl",["-sSL","--fail","--max-time","180",u],
  {maxBuffer:1024*1024*512,encoding:"utf8"}));
const n=v=>{const x=parseFloat(v);return Number.isFinite(x)?x:0;};
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const shrink=(o,nn,p,k=K_PSEUDO)=>nn?((nn*o)+(k*p))/(nn+k):p;
function blend(cur,pri){
  const w=weights(cur.length);
  const r=mean(cur.slice(-3)), s=mean(cur), p=mean(pri);
  const wp=pri.length?w.prior:0, d=w.recent+w.season+wp;
  return d? ((r*w.recent)+(s*w.season)+(p*wp))/d : 0;
}

const MARKETS=[
  {key:"QB_PASS_YARDS", pos:"QB", rate:g=>g.att?g.pyds/g.att:0, vol:g=>g.att, act:g=>g.pyds, def:"pass"},
  {key:"RB_RUSH_YARDS", pos:"RB", rate:g=>g.car?g.ryds/g.car:0, vol:g=>g.car, act:g=>g.ryds, def:"rush"},
  {key:"WR_REC_YARDS",  pos:"WR", rate:g=>g.tgt?g.recy/g.tgt:0, vol:g=>g.tgt, act:g=>g.recy, def:"pass"}
];

(function main(){
  console.log(`\nNFL PROPS BACKTEST — ${SEASON}, walk-forward, no lookahead\n${"=".repeat(62)}`);
  const cur=get(`${REL}/stats_player/stats_player_week_${SEASON}.csv`);
  const pri=get(`${REL}/stats_player/stats_player_week_${PRIOR}.csv`);
  // Injury report as published before each game: sidelined players are never
  // projected, exactly as in the live model.
  let inj=[]; try{ inj=get(`${REL}/injuries/injuries_${SEASON}.csv`); }catch(e){ console.log("injuries unavailable: "+e.message); }
  const sidelined=new Set(inj.filter(r=>(!r.game_type||r.game_type==="REG")&&PROPS.SIDELINED.test(r.report_status||""))
                               .map(r=>r.team+"|"+n(r.week)+"|"+r.gsis_id));
  console.log(`weekly rows: ${SEASON}=${cur.length}  ${PRIOR}=${pri.length}`);

  const norm=r=>({id:r.player_id,player:r.player_display_name,pos:r.position,team:r.team,opp:r.opponent_team,
    week:n(r.week),att:n(r.attempts),pyds:n(r.passing_yards),car:n(r.carries),ryds:n(r.rushing_yards),
    tgt:n(r.targets),recy:n(r.receiving_yards)});
  // Regular season only: a playoff game is not part of "last season" for the
  // live model either, and post-season weeks are not projected.
  const REG=r=>!r.season_type||r.season_type==="REG";
  const C=cur.filter(REG).map(norm), P=pri.filter(REG).map(norm);
  const qbLeague=PROPS.qbLeagueBaseline(P.filter(r=>r.pos==="QB"));
  // team targets per game, both seasons; attached to every player-game row
  const teamTgt=rows=>{const m={};rows.forEach(r=>{const k=r.team+"|"+r.week;m[k]=(m[k]||0)+r.tgt;});return m;};
  const TC=teamTgt(C), TP=teamTgt(P);
  C.forEach(r=>r.team_tgt=TC[r.team+"|"+r.week]||0); P.forEach(r=>r.team_tgt=TP[r.team+"|"+r.week]||0);
  const priorTeamAvg={}; { const acc={}; Object.entries(TP).forEach(([k,v])=>{const t=k.split("|")[0];(acc[t]=acc[t]||[]).push(v);});
    Object.entries(acc).forEach(([t,a])=>priorTeamAvg[t]=mean(a)); }
  const lgTeamTgt=mean(Object.values(TP));
  const priorBy={}; P.forEach(r=>{(priorBy[r.player]=priorBy[r.player]||[]).push(r);});
  const weeks=[...new Set(C.map(r=>r.week))].filter(w=>w>0).sort((a,b)=>a-b);

  const res={}; MARKETS.forEach(m=>res[m.key]={err:[],errSeason:[],errLast3:[],bias:[],act:[]});

  for(const wk of weeks){
    const hist=C.filter(r=>r.week<wk);
    const slate=C.filter(r=>r.week===wk);
    if(!hist.length) continue;
    // defensive yards allowed, per week, from history only
    const dw={}; hist.forEach(r=>{const k=r.opp+"|"+r.week;(dw[k]=dw[k]||{pass:0,rush:0});dw[k].pass+=r.pyds;dw[k].rush+=r.ryds;});
    const def={}; Object.entries(dw).forEach(([k,v])=>{const t=k.split("|")[0];(def[t]=def[t]||{pass:[],rush:[]});def[t].pass.push(v.pass);def[t].rush.push(v.rush);});
    const lgPass=mean(Object.values(def).map(d=>mean(d.pass)));
    const lgRush=mean(Object.values(def).map(d=>mean(d.rush)));
    const histBy={}; hist.forEach(r=>{(histBy[r.player]=histBy[r.player]||[]).push(r);});
    // Starters exactly as the live model picks them: by usage on his current
    // team so far, skipping anyone listed Out or Doubtful for this week.
    const qbStarter={}, wrStarters={}; { const cand={QB:{},WR:{}};
      Object.entries(histBy).forEach(([pl,gs])=>{ const last=gs[gs.length-1]; if(!cand[last.pos]) return;
        if(sidelined.has(last.team+"|"+wk+"|"+last.id)) return;
        const onTeam=gs.filter(x=>x.team===last.team);
        const use=mean(onTeam.map(x=>last.pos==="QB"?x.att:x.tgt)); if(use<=0) return;
        (cand[last.pos][last.team]=cand[last.pos][last.team]||[]).push([pl,use]); });
      Object.entries(cand.QB).forEach(([t,a])=>qbStarter[t]=a.sort((x,y)=>y[1]-x[1])[0][0]);
      Object.entries(cand.WR).forEach(([t,a])=>wrStarters[t]=new Set(a.sort((x,y)=>y[1]-x[1]).slice(0,3).map(x=>x[0]))); }
    const teamGames={}; Object.entries(TC).forEach(([k,v])=>{const [t,w]=k.split("|");if(Number(w)<wk)(teamGames[t]=teamGames[t]||[]).push(v);});

    for(const g of slate){
      for(const m of MARKETS){
        if(g.pos!==m.pos) continue;
        const h=histBy[g.player]||[]; if(h.length<1) continue;
        // QB: same starter rule as the live model -- the team's QB with the
        // most attempts per game so far. Scoring backups' cameo games would
        // measure a population the live model never projects.
        if(m.key==="QB_PASS_YARDS" && qbStarter[g.team]!==g.player) continue;
        if(m.key==="WR_REC_YARDS" && !(wrStarters[g.team]&&wrStarters[g.team].has(g.player))) continue;
        if(m.vol(g)<=0) continue;                       // did not participate in that market
        const d=def[g.opp]||{pass:[],rush:[]};
        const lg=m.def==="pass"?lgPass:lgRush;
        const arr=m.def==="pass"?d.pass:d.rush;
        const blended=(0.6*(mean(arr.slice(-3))||mean(arr)))+(0.4*mean(arr));
        const adj=lg?Math.max(CLAMP_LO,Math.min(CLAMP_HI,shrink(blended,arr.length,lg)/lg)):1;
        const pr=priorBy[g.player]||[];
        let rate, vol;
        if(m.key==="QB_PASS_YARDS"){            // v2: shared with the live model
          const q=PROPS.qbProjection(h,pr,qbLeague); rate=q.rate; vol=q.att;
        } else if(m.key==="WR_REC_YARDS"){      // v2 volume: share of team targets
          rate=blend(h.map(m.rate), pr.map(m.rate));
          vol=PROPS.wrTargets(h.filter(x=>x.team===g.team),pr,teamGames[g.team]||[],priorTeamAvg[g.team]||lgTeamTgt).targets;
        } else {
          rate=blend(h.map(m.rate), pr.map(m.rate));
          vol =blend(h.map(m.vol),  pr.map(m.vol));
        }
        const proj=Math.max(0, rate*vol*adj);
        const actual=m.act(g);
        res[m.key].err.push(Math.abs(proj-actual));
        res[m.key].bias.push(proj-actual);
        res[m.key].act.push(actual);
        res[m.key].errSeason.push(Math.abs(mean(h.map(m.act))-actual));
        res[m.key].errLast3.push(Math.abs(mean(h.slice(-3).map(m.act))-actual));
      }
    }
  }

  console.log(`\n${"MARKET".padEnd(16)}${"n".padStart(6)}${"MAE".padStart(8)}${"season".padStart(9)}${"last3".padStart(8)}${"bias".padStart(8)}   VERDICT`);
  const summary={};
  for(const m of MARKETS){
    const r=res[m.key]; if(!r.err.length) continue;
    const mae=mean(r.err), ms=mean(r.errSeason), m3=mean(r.errLast3), b=mean(r.bias);
    const beatsBoth = mae<ms && mae<m3;
    const v = beatsBoth ? "beats both baselines"
            : (mae<ms||mae<m3) ? "beats one baseline only"
            : "BEATS NEITHER — adds nothing";
    console.log(`${m.key.padEnd(16)}${String(r.err.length).padStart(6)}${mae.toFixed(1).padStart(8)}${ms.toFixed(1).padStart(9)}${m3.toFixed(1).padStart(8)}${(b>=0?"+":"")+b.toFixed(1).padStart(7)}   ${v}`);
    summary[m.key]={n:r.err.length,mae,mae_season_baseline:ms,mae_last3_baseline:m3,bias:b,
                    mean_actual:mean(r.act),beats_both:beatsBoth};
  }
  fs.mkdirSync(path.join(__dirname,"..","data/nfl"),{recursive:true});
  fs.writeFileSync(path.join(__dirname,"..","data/nfl",`backtest-props-${SEASON}.json`),
    JSON.stringify({season:SEASON,summary},null,2));
  console.log(`\nwrote data/nfl/backtest-props-${SEASON}.json`);
})();
