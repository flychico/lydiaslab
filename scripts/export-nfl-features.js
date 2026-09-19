#!/usr/bin/env node
/**
 * Export walk-forward feature rows for model fitting.
 *
 * One row per graded game, every feature computed from PRIOR weeks only.
 * Features are home-minus-away so the target (home win) is symmetric.
 *
 * market_logit is included deliberately: with it in the design matrix the fit
 * learns how far to DEVIATE from the closing line, which is the only question
 * that matters. Fitting without it would just relearn the market badly.
 */
const { execFileSync } = require("child_process");
const fs=require("fs"), path=require("path");
const { buildRatings, headToHead } = require("./lib/nfl-ratings.js");
const FEED="https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";
const REL="https://github.com/nflverse/nflverse-data/releases/download";
const SEASONS=(process.argv[2]||"2023,2024,2025").split(",").map(Number);
const HFA=2.0, K_PSEUDO=4;

function parseCSV(t){const rows=[];let row=[],f="",q=false;
 for(let i=0;i<t.length;i++){const c=t[i];
  if(q){if(c==='"'){if(t[i+1]==='"'){f+='"';i++;}else q=false;}else f+=c;}
  else if(c==='"')q=true; else if(c===","){row.push(f);f="";}
  else if(c==="\n"){row.push(f);rows.push(row);row=[];f="";} else if(c!=="\r")f+=c;}
 if(f.length||row.length){row.push(f);rows.push(row);}
 const h=rows.shift().map(x=>x.trim());
 return rows.filter(r=>r.length>1).map(r=>Object.fromEntries(h.map((k,i)=>[k,(r[i]??"").trim()])));}
const get=u=>parseCSV(execFileSync("curl",["-sSL","--fail","--max-time","180",u],{maxBuffer:1<<29,encoding:"utf8"}));
const n=v=>{const x=parseFloat(v);return Number.isFinite(x)?x:null;};
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const shrink=(o,nn,p,k=K_PSEUDO)=>nn?((nn*o)+(k*p))/(nn+k):p;
const impl=a=>{const x=n(a);return x==null?null:(x>0?100/(x+100):(-x)/((-x)+100));};
function devig(a,b){const x=impl(a),y=impl(b);if(x==null||y==null)return[null,null];const s=x+y;return s>0?[x/s,y/s]:[null,null];}

function marginR(hist, prior){
  const m={},gp={},pm={};
  const add=(o,t,v)=>{(o[t]=o[t]||[]).push(v);};
  hist.forEach(g=>{const a=n(g.away_score),h=n(g.home_score);if(a==null||h==null)return;
    add(m,g.away_team,(a-h)+HFA); add(m,g.home_team,(h-a)-HFA);});
  prior.forEach(g=>{const a=n(g.away_score),h=n(g.home_score);if(a==null||h==null)return;
    add(pm,g.away_team,(a-h)+HFA); add(pm,g.home_team,(h-a)-HFA);});
  const R={};
  new Set([...Object.keys(m),...Object.keys(pm)]).forEach(t=>{
    const c=m[t]||[],p=pm[t]||[]; gp[t]=c.length;
    R[t]=shrink(c.length?mean(c):0,c.length,p.length?shrink(mean(p),p.length,0,6):0);});
  return {R,gp};
}

const out=[];
const allGames=get(FEED);
for(const S of SEASONS){
  const games=allGames.filter(g=>g.season===String(S));
  const prior=allGames.filter(g=>g.season===String(S-1)&&g.away_score!==""&&g.home_score!=="");
  const wkCur=get(`${REL}/stats_player/stats_player_week_${S}.csv`);
  const wkPri=get(`${REL}/stats_player/stats_player_week_${S-1}.csv`);
  const weeks=[...new Set(games.map(g=>n(g.week)))].filter(Boolean).sort((a,b)=>a-b);
  let rows=0;
  for(const wk of weeks){
    const hist=games.filter(g=>n(g.week)<wk&&g.away_score!==""&&g.home_score!=="");
    const slate=games.filter(g=>n(g.week)===wk&&g.away_score!==""&&g.home_score!=="");
    if(!slate.length||!hist.length) continue;
    const MM=marginR(hist,prior);
    const RR=buildRatings(wkCur.filter(r=>n(r.week)<wk), wkPri);
    for(const g of slate){
      const a=n(g.away_score),h=n(g.home_score);
      const [mA,mH]=devig(g.away_moneyline,g.home_moneyline);
      if(mA==null||mH==null||h===a) continue;
      const A=RR[g.away_team], H=RR[g.home_team];
      if(!A||!H) continue;
      const seen=Math.min(MM.gp[g.home_team]||0,MM.gp[g.away_team]||0);
      const p=Math.min(0.98,Math.max(0.02,mH));
      out.push({
        season:S, week:wk, games_seen:seen, home_win:h>a?1:0,
        market_logit: Math.log(p/(1-p)),
        margin_diff: (MM.R[g.home_team]??0)-(MM.R[g.away_team]??0)+HFA,
        qb_diff:  H._z.qb  - A._z.qb,
        off_diff: H._z.off - A._z.off,
        def_diff: H._z.def - A._z.def,
        to_diff:  H.turnover_diff_pg - A.turnover_diff_pg,
        h2h_net:  (headToHead(RR,g.away_team,g.home_team)||{}).net_home ?? 0,
        home_price: n(g.home_moneyline), away_price: n(g.away_moneyline)
      });
      rows++;
    }
  }
  console.log(`  ${S}: ${rows} rows`);
}
const cols=Object.keys(out[0]);
const csv=[cols.join(",")].concat(out.map(r=>cols.map(c=>r[c]).join(","))).join("\n");
fs.mkdirSync(path.join(__dirname,"..","data/nfl"),{recursive:true});
fs.writeFileSync(path.join(__dirname,"..","data/nfl","model-features.csv"), csv);
console.log(`wrote data/nfl/model-features.csv  (${out.length} rows, ${cols.length} cols)`);
