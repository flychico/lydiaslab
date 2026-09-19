#!/usr/bin/env node
/**
 * Does the ratings model beat point margin — and does either beat the market?
 *
 * Walk-forward over a completed season. Three predictors compared on the same
 * games, same weeks, no lookahead:
 *   MARKET   the no-vig closing line
 *   MARGIN   current production: regressed point margin  (leo-nflml-v1)
 *   RATINGS  EPA/CPOE/pressure/turnover composite        (lib/nfl-ratings.js)
 *   BLEND    ratings + margin averaged
 *
 * Brier is the verdict. Accuracy is not — it ignores confidence.
 */
const { execFileSync } = require("child_process");
const fs=require("fs"), path=require("path");
const { buildRatings, headToHead } = require("./lib/nfl-ratings.js");
const FEED="https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";
const REL="https://github.com/nflverse/nflverse-data/releases/download";
const argv=process.argv.slice(2);
const F=(n,d)=>{const i=argv.indexOf("--"+n);return i>=0?argv[i+1]:d;};
const SEASON=Number(F("season",2025)), PRIOR=SEASON-1;
const SWEEP=argv.includes("--sweep");

const HFA=2.0, SD=13.2, K_PSEUDO=4, K_MARKET=8;
let NET_SCALE=Number(F("scale",7.0));   // z-units -> points

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
function normCdf(z){const t=1/(1+0.2316419*Math.abs(z)),d=0.3989423*Math.exp(-z*z/2);
 let p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return z>0?1-p:p;}
const impl=a=>{const x=n(a);return x==null?null:(x>0?100/(x+100):(-x)/((-x)+100));};
function devig(a,b){const x=impl(a),y=impl(b);if(x==null||y==null)return[null,null];const s=x+y;return s>0?[x/s,y/s]:[null,null];}
const payout=(pr,w)=>w?(pr>0?pr/100:100/(-pr)):-1;

function marginRatings(hist, prior){
  const m={},gp={};
  const add=(t,v)=>{(m[t]=m[t]||[]).push(v);};
  hist.forEach(g=>{const as=n(g.away_score),hs=n(g.home_score);if(as==null||hs==null)return;
    add(g.away_team,(as-hs)+HFA); add(g.home_team,(hs-as)-HFA);});
  const pm={};
  prior.forEach(g=>{const as=n(g.away_score),hs=n(g.home_score);if(as==null||hs==null)return;
    (pm[g.away_team]=pm[g.away_team]||[]).push((as-hs)+HFA);
    (pm[g.home_team]=pm[g.home_team]||[]).push((hs-as)-HFA);});
  const R={};
  new Set([...Object.keys(m),...Object.keys(pm)]).forEach(t=>{
    const c=m[t]||[],p=pm[t]||[]; gp[t]=c.length;
    const pr=p.length?shrink(mean(p),p.length,0,6):0;
    R[t]=shrink(c.length?mean(c):0,c.length,pr);});
  return {R,gp};
}

function run(games, priorGames, wkCur, wkPri, scale){
  const weeks=[...new Set(games.map(g=>n(g.week)))].filter(Boolean).sort((a,b)=>a-b);
  const out=[];
  for(const wk of weeks){
    const hist=games.filter(g=>n(g.week)<wk && g.away_score!=="" && g.home_score!=="");
    const slate=games.filter(g=>n(g.week)===wk && g.away_score!=="" && g.home_score!=="");
    if(!slate.length||!hist.length) continue;
    const MM=marginRatings(hist, priorGames);
    const RR=buildRatings(wkCur.filter(r=>n(r.week)<wk), wkPri);
    for(const g of slate){
      const as=n(g.away_score),hs=n(g.home_score);
      const [mA,mH]=devig(g.away_moneyline,g.home_moneyline);
      if(mA==null||mH==null) continue;
      const seen=Math.min(MM.gp[g.home_team]||0,MM.gp[g.away_team]||0);
      const w=seen/(seen+K_MARKET);
      // MARGIN
      const expM=(MM.R[g.home_team]??0)-(MM.R[g.away_team]??0)+HFA;
      const rawMargin=normCdf(expM/SD);
      // RATINGS
      const h2h=headToHead(RR,g.away_team,g.home_team);
      const expR=h2h? (scale*h2h.net_home + HFA) : expM;
      const rawRat=normCdf(expR/SD);
      const rawBlend=normCdf(((expM+expR)/2)/SD);
      out.push({homeWon:hs>as, push:hs===as, mktH:mH,
        priceH:n(g.home_moneyline), priceA:n(g.away_moneyline),
        margin:w*rawMargin+(1-w)*mH, rawMargin,
        ratings:w*rawRat+(1-w)*mH,   rawRat,
        blend:w*rawBlend+(1-w)*mH,   rawBlend});
    }
  }
  return out;
}

const brier=(rows,k)=>mean(rows.filter(r=>!r.push).map(r=>Math.pow(r[k]-(r.homeWon?1:0),2)));
function roi(rows,key,th){
  let bets=0,units=0,wins=0;
  rows.filter(r=>!r.push).forEach(r=>{
    const eH=r[key]-r.mktH, eA=(1-r[key])-(1-r.mktH);
    let price=null,won=null;
    if(eH>=th&&eH>=eA){price=r.priceH;won=r.homeWon;}
    else if(eA>=th){price=r.priceA;won=!r.homeWon;}
    if(price!=null){bets++;units+=payout(price,won);if(won)wins++;}
  });
  return {bets,wins,units,roi:bets?units/bets:0};
}

(function main(){
  console.log(`\nRATINGS vs MARGIN vs MARKET — ${SEASON}, walk-forward\n${"=".repeat(64)}`);
  const all=get(FEED);
  const games=all.filter(g=>g.season===String(SEASON));
  const priorGames=all.filter(g=>g.season===String(PRIOR)&&g.away_score!==""&&g.home_score!=="");
  const wkCur=get(`${REL}/stats_player/stats_player_week_${SEASON}.csv`);
  const wkPri=get(`${REL}/stats_player/stats_player_week_${PRIOR}.csv`);

  if(SWEEP){
    console.log("\nsweeping z-units -> points scale\n  scale   ratings Brier   vs market");
    let best=null;
    for(const sc of [3,4,5,6,7,8,10,12,14]){
      const rows=run(games,priorGames,wkCur,wkPri,sc);
      const b=brier(rows,"ratings"), bm=brier(rows,"mktH");
      console.log(`  ${String(sc).padStart(5)}   ${b.toFixed(4)}        ${b-bm>=0?"+":""}${(b-bm).toFixed(4)}`);
      if(!best||b<best.b) best={sc,b};
    }
    console.log(`\n  best scale = ${best.sc}`);
    return;
  }

  const rows=run(games,priorGames,wkCur,wkPri,NET_SCALE);
  const bm=brier(rows,"mktH");
  console.log(`\ngraded games: ${rows.length}   z->points scale: ${NET_SCALE}\n`);
  console.log("BRIER (lower is better; market is the bar)");
  console.log(`  MARKET   ${bm.toFixed(4)}`);
  for(const [k,label] of [["margin","MARGIN "],["ratings","RATINGS"],["blend","BLEND  "]]){
    const b=brier(rows,k), raw=brier(rows,"raw"+(k==="margin"?"Margin":k==="ratings"?"Rat":"Blend"));
    console.log(`  ${label}  ${b.toFixed(4)}   vs market ${b-bm>=0?"+":""}${(b-bm).toFixed(4)}   ${b<bm?"BEATS MARKET":"loses"}   (raw ${raw.toFixed(4)})`);
  }
  console.log("\nROI at 3% edge (flat 1u, real closing prices)");
  for(const [k,label] of [["margin","MARGIN "],["ratings","RATINGS"],["blend","BLEND  "]]){
    const r=roi(rows,k,0.03);
    console.log(`  ${label}  ${String(r.bets).padStart(3)} bets  ${String(r.wins).padStart(3)} wins  ${r.units>=0?"+":""}${r.units.toFixed(1).padStart(6)}u  ${(r.roi*100>=0?"+":"")}${(r.roi*100).toFixed(1)}%`);
  }
  fs.writeFileSync(path.join(__dirname,"..","data/nfl",`backtest-ratings-${SEASON}.json`),
    JSON.stringify({season:SEASON,scale:NET_SCALE,graded:rows.length,
      brier:{market:bm,margin:brier(rows,"margin"),ratings:brier(rows,"ratings"),blend:brier(rows,"blend")},
      roi_3pct:{margin:roi(rows,"margin",.03),ratings:roi(rows,"ratings",.03),blend:roi(rows,"blend",.03)}},null,2));
  console.log(`\nwrote data/nfl/backtest-ratings-${SEASON}.json`);
})();
