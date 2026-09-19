#!/usr/bin/env node
/**
 * NFL model backtest — walk-forward over a completed season.
 *
 * WHY: at Week 3 of 2026 there are 1-2 games of data. Nothing can be
 * calibrated on that. 2025 is a finished season with closing moneylines,
 * spreads and totals on every game, so the models can be measured properly
 * and their constants tuned before they ever price a live card.
 *
 * NO LOOKAHEAD. Predicting week W uses only games from weeks < W. Ratings are
 * rebuilt from scratch at every week. A backtest that peeks is worse than no
 * backtest, because it manufactures confidence.
 *
 * Usage:
 *   node scripts/backtest-nfl.js                 # measure current constants
 *   node scripts/backtest-nfl.js --sweep         # grid-search the constants
 *   node scripts/backtest-nfl.js --season 2024
 */
const { execFileSync } = require("child_process");
const fs = require("fs"), path = require("path");
const FEED = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const SEASON = Number(flag("season", 2025));
const PRIOR  = SEASON - 1;
const SWEEP  = argv.includes("--sweep");

// ---- current production constants (scripts/generate-nfl-model.js) ----------
const BASE = { HFA: 2.0, SD: 13.2, K_PSEUDO: 4, K_MARKET: 8, TOTAL_SD: 10.4 };

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
const get = u => parseCSV(execFileSync("curl",["-sSL","--fail","--max-time","120",u],
                  {maxBuffer:1024*1024*512, encoding:"utf8"}));
const n = v => { const x=parseFloat(v); return Number.isFinite(x)?x:null; };
const mean = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0;
const shrink = (obs,nObs,prior,k) => nObs ? ((nObs*obs)+(k*prior))/(nObs+k) : prior;
function normCdf(z){
  const t=1/(1+0.2316419*Math.abs(z)), d=0.3989423*Math.exp(-z*z/2);
  let p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));
  return z>0?1-p:p;
}
const impl = a => { const x=n(a); return x==null?null:(x>0?100/(x+100):(-x)/((-x)+100)); };
function devig(a,b){ const x=impl(a),y=impl(b); if(x==null||y==null) return [null,null];
  const s=x+y; return s>0?[x/s,y/s]:[null,null]; }
// profit on a 1-unit win bet at American odds
const payout = (price,won) => won ? (price>0 ? price/100 : 100/(-price)) : -1;

function buildRatings(history, priorGames, C){
  const marg={}, pf={}, pa={}, gp={};
  const add=(m,t,v)=>{(m[t]=m[t]||[]).push(v);};
  history.forEach(g=>{
    const as=n(g.away_score), hs=n(g.home_score); if(as==null||hs==null) return;
    add(marg,g.away_team,(as-hs)+C.HFA); add(marg,g.home_team,(hs-as)-C.HFA);
    add(pf,g.away_team,as); add(pa,g.away_team,hs);
    add(pf,g.home_team,hs); add(pa,g.home_team,as);
  });
  const pMarg={}, pPf={}, pPa={};
  priorGames.forEach(g=>{
    const as=n(g.away_score), hs=n(g.home_score); if(as==null||hs==null) return;
    add(pMarg,g.away_team,(as-hs)+C.HFA); add(pMarg,g.home_team,(hs-as)-C.HFA);
    add(pPf,g.away_team,as); add(pPa,g.away_team,hs);
    add(pPf,g.home_team,hs); add(pPa,g.home_team,as);
  });
  const allPts=history.flatMap(g=>[n(g.away_score),n(g.home_score)]).filter(x=>x!=null);
  const leaguePPG = allPts.length ? mean(allPts) : 22.5;
  const R={}, PF={}, PA={}, GP={};
  const teams=new Set([...Object.keys(marg),...Object.keys(pMarg)]);
  teams.forEach(t=>{
    const cur=marg[t]||[], pri=pMarg[t]||[];
    GP[t]=cur.length;
    const priorR = pri.length ? shrink(mean(pri), pri.length, 0, 6) : 0;
    R[t]=shrink(cur.length?mean(cur):0, cur.length, priorR, C.K_PSEUDO);
    const prF = pPf[t] ? shrink(mean(pPf[t]), pPf[t].length, leaguePPG, 6) : leaguePPG;
    const prA = pPa[t] ? shrink(mean(pPa[t]), pPa[t].length, leaguePPG, 6) : leaguePPG;
    PF[t]=shrink(pf[t]?mean(pf[t]):leaguePPG,(pf[t]||[]).length,prF,C.K_PSEUDO);
    PA[t]=shrink(pa[t]?mean(pa[t]):leaguePPG,(pa[t]||[]).length,prA,C.K_PSEUDO);
  });
  return {R,PF,PA,GP,leaguePPG};
}

function run(games, priorGames, C){
  const weeks=[...new Set(games.map(g=>n(g.week)))].filter(w=>w!=null).sort((a,b)=>a-b);
  const rows=[];
  for(const wk of weeks){
    const history = games.filter(g=>n(g.week)<wk && g.away_score!=="" && g.home_score!=="");
    const slate   = games.filter(g=>n(g.week)===wk && g.away_score!=="" && g.home_score!=="");
    if(!slate.length) continue;
    const M=buildRatings(history, priorGames, C);
    for(const g of slate){
      const as=n(g.away_score), hs=n(g.home_score);
      const [mA,mH]=devig(g.away_moneyline,g.home_moneyline);
      if(mA==null||mH==null) continue;
      const seen=Math.min(M.GP[g.home_team]||0, M.GP[g.away_team]||0);
      const w=seen/(seen+C.K_MARKET);
      const expM=(M.R[g.home_team]??0)-(M.R[g.away_team]??0)+C.HFA;
      const rawH=normCdf(expM/C.SD);
      const pH=w*rawH+(1-w)*mH;
      // totals
      const aPts=((M.PF[g.away_team]??M.leaguePPG)+(M.PA[g.home_team]??M.leaguePPG))/2;
      const hPts=((M.PF[g.home_team]??M.leaguePPG)+(M.PA[g.away_team]??M.leaguePPG))/2;
      const rawT=aPts+hPts;
      const mT=n(g.total_line);
      const pT= mT!=null ? w*rawT+(1-w)*mT : rawT;
      const mS=n(g.spread_line);
      const pS= mS!=null ? w*expM+(1-w)*mS : expM;
      rows.push({
        week:wk, homeWon: hs>as, push: hs===as,
        pH, rawH, mktH:mH, priceH:n(g.home_moneyline), priceA:n(g.away_moneyline),
        actTotal:as+hs, projTotal:pT, rawTotal:rawT, mktTotal:mT,
        actMargin:hs-as, projSpread:pS, rawSpread:expM, mktSpread:mS, seen, w
      });
    }
  }
  return rows;
}

function score(rows, label){
  const ml=rows.filter(r=>!r.push);
  const brier = mean(ml.map(r=>Math.pow(r.pH-(r.homeWon?1:0),2)));
  const brierMkt = mean(ml.map(r=>Math.pow(r.mktH-(r.homeWon?1:0),2)));
  const brierRaw = mean(ml.map(r=>Math.pow(r.rawH-(r.homeWon?1:0),2)));
  const logl = -mean(ml.map(r=>{const p=Math.min(.999,Math.max(.001,r.pH)); return r.homeWon?Math.log(p):Math.log(1-p);}));
  const acc = mean(ml.map(r=>((r.pH>=0.5)===r.homeWon)?1:0));
  const accMkt = mean(ml.map(r=>((r.mktH>=0.5)===r.homeWon)?1:0));

  const T=rows.filter(r=>r.mktTotal!=null);
  const tMae = mean(T.map(r=>Math.abs(r.projTotal-r.actTotal)));
  const tMaeMkt = mean(T.map(r=>Math.abs(r.mktTotal-r.actTotal)));
  const tMaeRaw = mean(T.map(r=>Math.abs(r.rawTotal-r.actTotal)));
  const tBias = mean(T.map(r=>r.rawTotal-r.actTotal));

  const S=rows.filter(r=>r.mktSpread!=null);
  const sMae = mean(S.map(r=>Math.abs(r.projSpread-r.actMargin)));
  const sMaeMkt = mean(S.map(r=>Math.abs(r.mktSpread-r.actMargin)));

  return {label,nGames:rows.length,brier,brierMkt,brierRaw,logl,acc,accMkt,
          tMae,tMaeMkt,tMaeRaw,tBias,sMae,sMaeMkt};
}

// ROI across edge thresholds — the question that actually matters
function roi(rows, thresholds){
  return thresholds.map(th=>{
    let bets=0, units=0, wins=0;
    rows.filter(r=>!r.push).forEach(r=>{
      const eH=r.pH-r.mktH, eA=(1-r.pH)-(1-r.mktH);
      let side=null, price=null, won=null;
      if(eH>=th && eH>=eA){ side="H"; price=r.priceH; won=r.homeWon; }
      else if(eA>=th){ side="A"; price=r.priceA; won=!r.homeWon; }
      if(side && price!=null){ bets++; units+=payout(price,won); if(won)wins++; }
    });
    return {th,bets,wins,units,roi:bets?units/bets:0};
  });
}

function totalsRoi(rows, thresholds){
  return thresholds.map(th=>{
    let bets=0,units=0,wins=0;
    rows.filter(r=>r.mktTotal!=null).forEach(r=>{
      const e=r.projTotal-r.mktTotal;
      if(Math.abs(e)<th) return;
      const over=e>0;
      if(r.actTotal===r.mktTotal) return;              // push
      const won = over ? r.actTotal>r.mktTotal : r.actTotal<r.mktTotal;
      bets++; units+=payout(-110,won); if(won)wins++;
    });
    return {th,bets,wins,units,roi:bets?units/bets:0};
  });
}

(function main(){
  console.log(`\nNFL BACKTEST — ${SEASON} season, walk-forward, no lookahead\n${"=".repeat(62)}`);
  const all = get(FEED);
  const games = all.filter(g=>g.season===String(SEASON));
  const priorGames = all.filter(g=>g.season===String(PRIOR) && g.away_score!=="" && g.home_score!=="");
  console.log(`games: ${games.length}  prior-season games available: ${priorGames.length}`);

  if(!SWEEP){
    const rows=run(games, priorGames, BASE);
    const s=score(rows,"current");
    console.log(`\nGraded games: ${s.nGames}\n`);
    console.log("MONEYLINE");
    console.log(`  Brier   model ${s.brier.toFixed(4)}   market ${s.brierMkt.toFixed(4)}   raw-model ${s.brierRaw.toFixed(4)}`);
    console.log(`          ${s.brier<s.brierMkt?"model beats market":"MARKET BEATS MODEL"} by ${Math.abs(s.brier-s.brierMkt).toFixed(4)}`);
    console.log(`  LogLoss ${s.logl.toFixed(4)}`);
    console.log(`  Accuracy model ${(s.acc*100).toFixed(1)}%   market ${(s.accMkt*100).toFixed(1)}%`);
    console.log("\n  ROI by edge threshold (flat 1u, real closing prices)");
    console.log("    edge   bets  wins    units     ROI");
    roi(rows,[0.02,0.03,0.04,0.05,0.06,0.08,0.10]).forEach(r=>
      console.log(`    ${(r.th*100).toFixed(0).padStart(2)}%   ${String(r.bets).padStart(4)}  ${String(r.wins).padStart(4)}  ${r.units>=0?"+":""}${r.units.toFixed(1).padStart(7)}  ${(r.roi*100>=0?"+":"")}${(r.roi*100).toFixed(1)}%`));

    console.log("\nTOTALS");
    console.log(`  MAE     model ${s.tMae.toFixed(2)}   market ${s.tMaeMkt.toFixed(2)}   raw-model ${s.tMaeRaw.toFixed(2)}`);
    console.log(`  Raw bias ${s.tBias>0?"+":""}${s.tBias.toFixed(2)} pts  ${Math.abs(s.tBias)>2?"<-- systematic, needs correcting":"(acceptable)"}`);
    console.log("\n  ROI by edge threshold (-110 both sides)");
    console.log("    edge   bets  wins    units     ROI");
    totalsRoi(rows,[1,1.5,2,3,4,5]).forEach(r=>
      console.log(`  ${r.th.toFixed(1).padStart(5)}   ${String(r.bets).padStart(4)}  ${String(r.wins).padStart(4)}  ${r.units>=0?"+":""}${r.units.toFixed(1).padStart(7)}  ${(r.roi*100>=0?"+":"")}${(r.roi*100).toFixed(1)}%`));

    console.log("\nSPREAD");
    console.log(`  MAE vs actual margin: model ${s.sMae.toFixed(2)}   market ${s.sMaeMkt.toFixed(2)}`);

    fs.mkdirSync(path.join(__dirname,"..","data/nfl"),{recursive:true});
    fs.writeFileSync(path.join(__dirname,"..","data/nfl",`backtest-${SEASON}.json`),
      JSON.stringify({season:SEASON,constants:BASE,summary:s,
        moneyline_roi:roi(rows,[0.02,0.03,0.04,0.05,0.06,0.08,0.10]),
        totals_roi:totalsRoi(rows,[1,1.5,2,3,4,5])},null,2));
    console.log(`\nwrote data/nfl/backtest-${SEASON}.json`);
    return;
  }

  // ---- parameter sweep ----------------------------------------------------
  console.log("\nSWEEP — lower Brier is better. Market Brier is the bar to beat.\n");
  const out=[];
  for(const HFA of [1.0,1.5,2.0,2.5,3.0])
  for(const SD of [12.0,13.2,14.5])
  for(const K_PSEUDO of [2,4,6,8])
  for(const K_MARKET of [4,6,8,12,16,24]){
    const C={...BASE,HFA,SD,K_PSEUDO,K_MARKET};
    const s=score(run(games,priorGames,C),"");
    out.push({HFA,SD,K_PSEUDO,K_MARKET,brier:s.brier,tMae:s.tMae,sMae:s.sMae,
              vsMarket:s.brier-s.brierMkt, brierMkt:s.brierMkt});
  }
  out.sort((a,b)=>a.brier-b.brier);
  console.log("  HFA    SD  Kpse  Kmkt   Brier   vs market");
  out.slice(0,12).forEach(r=>console.log(
    `  ${r.HFA.toFixed(1)}  ${r.SD.toFixed(1)}  ${String(r.K_PSEUDO).padStart(4)}  ${String(r.K_MARKET).padStart(4)}  ${r.brier.toFixed(4)}   ${r.vsMarket>=0?"+":""}${r.vsMarket.toFixed(4)}`));
  console.log(`\n  market Brier = ${out[0].brierMkt.toFixed(4)}`);
  const beats=out.filter(r=>r.vsMarket<0);
  console.log(`  configs that beat the market: ${beats.length} of ${out.length}`);
  fs.writeFileSync(path.join(__dirname,"..","data/nfl",`backtest-sweep-${SEASON}.json`),
    JSON.stringify(out.slice(0,50),null,2));
  console.log(`  wrote data/nfl/backtest-sweep-${SEASON}.json`);
})();
