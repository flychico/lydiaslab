// HO-0097 ask 5: day-to-day sit rate, 0.4 weight check, flagged and flipped Leo Picks. Read only. node scripts/backtest-nba-swing.js [out.json]
const fs=require("fs"),path=require("path");
const R=process.cwd(), S=require(R+"/scripts/lib/nba-swing"), PK=require(R+"/scripts/lib/nba-picks"), URLS=require(R+"/scripts/lib/nba-urls");
const model=require(R+"/data/nba/model.json"); const c=model.coef, sd=model.resid_sd;
const M=require(R+"/scripts/lib/nba-model");
const csv=t=>{const L=t.trim().split("\n"),h=L[0].split(",");return L.slice(1).map(l=>{const v=l.split(",");return Object.fromEntries(h.map((k,i)=>[k,v[i]]))})};
const ledger=Object.fromEntries(csv(fs.readFileSync(R+"/data/nba/results-ledger.csv","utf8")).map(r=>[r.date+"|"+r.game_id,r]));
const dates=fs.readdirSync(R+"/data/nba").filter(f=>/^picks-2026-\d\d-\d\d\.json$/.test(f)).map(f=>f.slice(6,16)).sort();
const listings=[], games=[];
for(const d of dates){
  const card=JSON.parse(fs.readFileSync(R+`/data/nba/picks-${d}.json`,"utf8"));
  const bf=R+`/data/nba/boxscores/${d}.json`; const box=fs.existsSync(bf)?JSON.parse(fs.readFileSync(bf,"utf8")):{games:[]};
  for(const g of card.games){
    const led=ledger[d+"|"+g.game_id]; if(!led||!g.leo||!g.leo.missing) continue;
    const bg=box.games.find(x=>String(x.game_id)===String(g.game_id)); if(!bg) continue;
    const played=new Map(bg.players.map(p=>[String(p.id),!p.dnp&&(p.minutes||0)>0]));
    const opens=[];
    for(const side of ["home","away"]) for(const p of g.leo.missing[side]||[]) if(p.weight>0&&p.weight<1){
      const pl=played.get(String(p.id)); const sat=pl!==true;
      const row={date:d,game:`${URLS.nick(g.away,g.away_name)} at ${URLS.nick(g.home,g.home_name)}`,team:URLS.nick(g[side],g[side+"_name"]),side,name:p.name,status:p.status,mpg:p.mpg,value:p.value,weight:p.weight,sat,inBox:played.has(String(p.id))};
      listings.push(row); opens.push(row);
    }
    games.push({d,g,led,opens});
  }
}
// 1. sit rate
const by=(f)=>{const m={};for(const l of listings){const k=f(l);m[k]=m[k]||{n:0,sat:0};m[k].n++;if(l.sat)m[k].sat++;}return m};
console.log("Open listings at read of record:",listings.length,"sat",listings.filter(l=>l.sat).length,"not in box (counted as sat)",listings.filter(l=>!l.inBox).length);
console.log("by status",JSON.stringify(by(l=>l.status)));
console.log("by mpg",JSON.stringify(by(l=>l.mpg<20?"<20":l.mpg<28?"20-28":"28+")));
console.log("by value",JSON.stringify(by(l=>l.value<2?"<2":l.value<5?"2-5":"5+")));
// 2. weight test on graded games
function marginWith(G,wf){let d=0;for(const o of G.opens){d+=c.lost_d*(wf(o)-o.weight)*o.value*(o.side==="home"?1:-1)}return Number(G.g.leo.home_margin)+d}
const sitRate=listings.filter(l=>l.sat).length/listings.length;
const variants={"0.4 (today)":o=>o.weight,"0.3":o=>o.status==="day-to-day"?0.3:o.weight,"0.5":o=>o.status==="day-to-day"?0.5:o.weight,[`${sitRate.toFixed(2)} (observed)`]:o=>o.status==="day-to-day"?sitRate:o.weight,"real status (upper limit)":o=>o.sat?1:0};
const aff=games.filter(G=>G.opens.length);
for(const [k,wf] of Object.entries(variants)){let miss=0,br=0,n=0;for(const G of aff){const m=marginWith(G,wf),act=Number(G.led.margin),ph=M.normCdf(m/sd),hw=act>0?1:0;miss+=Math.abs(m-act);br+=(ph-hw)**2;n++}console.log(`weight ${k}: games ${n} miss ${(miss/n).toFixed(3)} brier ${(br/n).toFixed(4)}`)}
// 3 & 4. picks since Nov 2
const out={flagged:[],flips:[]};
for(const G of games){ if(G.d<"2026-11-02") continue;
  const g=G.g, chk=S.check(g,model), L=g.leo, wasPick=!!(L.pick&&L.pick.ok);
  if(chk.flags.length) out.flagged.push({date:G.d,game:`${URLS.nick(g.away,g.away_name)} at ${URLS.nick(g.home,g.home_name)}`,pick:wasPick?`${URLS.nick(L.pick.team)} ${PK.fmtPrice(L.pick.price)}`:"no pick",result:G.led.pick_result||"",units:G.led.pick_units||"",text:chk.flags[0].text,flags:chk.flags.length});
  if(!G.opens.length) continue;
  const m=marginWith(G,o=>o.sat?1:0), ph=M.normCdf(m/sd), real=PK.pick({p_home:ph,home_ml:(g.market||{}).home_ml,away_ml:(g.market||{}).away_ml,home:g.home,away:g.away});
  const realKey=real&&real.ok?real.side:"none", wasKey=wasPick?L.pick.side:"none";
  if(realKey!==wasKey){ const fin={hs:+G.led.home_score,as:+G.led.away_score};
    let newRes="",newU="";
    if(real&&real.ok){const won=real.side==="home"?fin.hs>fin.as:fin.as>fin.hs;newRes=won?"win":"loss";newU=PK.units(newRes,real.price).toFixed(2)}
    out.flips.push({date:G.d,game:`${URLS.nick(g.away,g.away_name)} at ${URLS.nick(g.home,g.home_name)}`,
      was:wasPick?`${URLS.nick(L.pick.team)} ${PK.fmtPrice(L.pick.price)} (${(L.pick.p*100).toFixed(1)}%) ${G.led.pick_result} ${G.led.pick_units}`:`no pick (${(Math.max(L.p_home,L.p_away)*100).toFixed(1)}%)`,
      real:real&&real.ok?`${URLS.nick(real.team)} ${PK.fmtPrice(real.price)} (${(real.p*100).toFixed(1)}%) would ${newRes} ${newU}`:`no pick (${((ph>=.5?ph:1-ph)*100).toFixed(1)}%)`,
      players:G.opens.map(o=>`${o.name} (${o.team}, ${o.sat?"sat":"played"})`).join("; "),flagged:!!S.check(g,model).flags.length});
  }
}
const fp=out.flagged.filter(f=>f.pick!=="no pick"), u=fp.reduce((s,f)=>s+(+f.units||0),0);
console.log("\nGames flagged since Nov 2:",out.flagged.length,"of which Leo Picks",fp.length,"record",fp.filter(f=>f.result==="win").length+"-"+fp.filter(f=>f.result==="loss").length,"units",u.toFixed(2));
for(const f of out.flagged) console.log(" FLAG",f.date,f.game,"|",f.pick,f.result,f.units,"|",f.text);
console.log("\nFlips under real status:",out.flips.length);
for(const f of out.flips) console.log(" FLIP",f.date,f.game,"| was:",f.was,"| real:",f.real,"| flagged at read:",f.flagged,"|",f.players);
const allPicks=games.filter(G=>G.d>="2026-11-02"&&G.led.pick_result);console.log("\nAll graded Leo Picks since Nov 2:",allPicks.length);
fs.writeFileSync(process.argv[2]||"/dev/null",JSON.stringify({listings,out},null,1));
