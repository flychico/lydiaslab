#!/usr/bin/env node
/*
  LyDia source-of-truth daily engine.
  Order: schedule -> pitchers -> bullpen -> market -> model -> Lab Score -> official/watch/pass.
  Outputs member brief, picks JSON, market tracker, and public preview from one decision source.
*/
const fs = require("fs");

const HFA = 54 / 46;
const PYTH_EXP = 1.83;
const FORM_WEIGHT = 0.25;
const ERA_K = 0.20;
const LEAGUE_ERA = 4.20;
const MIN_IP = 20;
const ERA_CLAMP = [2.75, 6.00];
const VALUE_EDGE = 0.03;
const OFFICIAL_LAB_SCORE = 60;
const WATCHLIST_LAB_SCORE = 65;

const args = parseArgs(process.argv.slice(2));
const today = new Date();
const DATE = args.date || localISODate(today);
const SNAPSHOT = args.snapshot || process.env.SNAPSHOT_TYPE || "posted";
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";

main().catch(err => { console.error(err); process.exit(1); });

async function main() {
  ["data/member-brief","data/picks","data/market","previews"].forEach(p => fs.mkdirSync(p, { recursive:true }));

  const [sched, standings, oddsEvents] = await Promise.all([
    fetchJson(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}&hydrate=probablePitcher`),
    fetchJson(`https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${seasonYear(DATE)}&standingsTypes=regularSeason`),
    ODDS_API_KEY ? fetchJson(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${encodeURIComponent(ODDS_API_KEY)}&regions=us&markets=h2h&oddsFormat=american`).catch(() => []) : Promise.resolve([])
  ]);

  const games = ((((sched.dates || [])[0]) || {}).games || [])
    .filter(g => g.status && g.status.abstractGameState === "Preview")
    .sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate));

  const strength = buildStrength(standings);
  const pitchers = await fetchPitchers(games);
  const oddsMap = buildOddsMap(oddsEvents);
  const bullpen = await buildBullpenIndex(games, DATE);

  const rows = games.map(g => modelGame(g, strength, pitchers, oddsMap, bullpen)).filter(Boolean)
    .sort((a, b) => (b.lab_score || 0) - (a.lab_score || 0));

  const generatedAt = new Date().toISOString();

  const brief = {
    date: DATE,
    generated_at: generatedAt,
    snapshot_type: SNAPSHOT,
    source_of_truth: "scripts/generate-member-lab.js",
    summary: summarize(rows, Boolean(ODDS_API_KEY)),
    games: rows
  };
  writeJson(`data/member-brief/${DATE}.json`, brief);
  writeJson("data/member-brief/today.json", brief);

  const picks = buildPicksFile(rows, generatedAt);
  writeJson(`data/picks/${DATE}.json`, picks);
  writeJson("data/picks/today.json", picks);

  mergeAndWriteMarket(buildMarketFile(rows, generatedAt));

  fs.writeFileSync(`previews/${DATE}.html`, renderPreviewPage(rows, brief), "utf8");
  updatePreviewArchive(DATE);

  console.log(`Generated LyDia source-of-truth outputs for ${DATE}. Games: ${rows.length}. Official picks: ${picks.picks.length}.`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (!v.startsWith("--")) continue;
    const key = v.slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith("--") ? next : "true";
    if (next && !next.startsWith("--")) i++;
  }
  return out;
}
function localISODate(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
async function fetchJson(url){ const res = await fetch(url); if(!res.ok) throw new Error(`HTTP ${res.status}: ${url}`); return res.json(); }
function writeJson(file,obj){ fs.writeFileSync(file, JSON.stringify(obj,null,2)+"\n","utf8"); }
function seasonYear(date){ const d = new Date(date+"T12:00:00"); return d.getMonth() >= 2 ? d.getFullYear() : d.getFullYear()-1; }
function pythag(rs,ra){ const num=Math.pow(rs,PYTH_EXP); return num/(num+Math.pow(ra,PYTH_EXP)); }
function log5Home(sHome,sAway){ const raw=(sHome*(1-sAway))/(sHome*(1-sAway)+sAway*(1-sHome)); const odds=(raw/(1-raw))*HFA; return odds/(1+odds); }
function clamp(n,min,max){ return Math.min(max,Math.max(min,n)); }
function round(n,dp=4){ if(typeof n!=="number" || !Number.isFinite(n)) return null; const m=Math.pow(10,dp); return Math.round(n*m)/m; }
function clampEra(e){ return Math.min(ERA_CLAMP[1],Math.max(ERA_CLAMP[0],e)); }
function ipToNum(ip){ if(!ip || ip==="-.--") return 0; const [w,f]=String(ip).split("."); return Number(w||0)+(Number(f||0)/3); }
function amToDec(am){ am=Number(am); return am>0 ? 1+am/100 : 1+100/Math.abs(am); }
function amToProb(am){ am=Number(am); return am>0 ? 100/(am+100) : Math.abs(am)/(Math.abs(am)+100); }
function decToAm(dec){ return dec>=2 ? Math.round((dec-1)*100) : Math.round(-100/(dec-1)); }
function fmtPct(v,dp=1){ return typeof v==="number" && Number.isFinite(v) ? `${(v*100).toFixed(dp)}%` : "—"; }
function fmtOdds(v){ if(typeof v!=="number" || !Number.isFinite(v)) return "—"; return v>0 ? `+${v}` : String(v); }
function esc(s){ return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function slug(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,""); }
function displayDate(date){ return new Date(date+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",year:"numeric",month:"long",day:"numeric"}); }

function buildStrength(standings){
  const strength={};
  for(const rec of standings.records||[]){
    for(const t of rec.teamRecords||[]){
      const l10=(((t.records||{}).splitRecords)||[]).find(r=>r.type==="lastTen");
      const gp=Math.max(1,t.wins+t.losses);
      strength[t.team.id]={pyth:pythag(t.runsScored,t.runsAllowed), form:l10 ? l10.wins/Math.max(1,l10.wins+l10.losses):null, l10:l10?`${l10.wins}-${l10.losses}`:"—", wins:t.wins, losses:t.losses, gp};
    }
  }
  return strength;
}

async function fetchPitchers(games){
  const ids=[...new Set(games.flatMap(g=>["away","home"].map(s=>g.teams[s].probablePitcher&&g.teams[s].probablePitcher.id).filter(Boolean)))];
  const out={}; if(!ids.length) return out;
  try{
    const data=await fetchJson(`https://statsapi.mlb.com/api/v1/people?personIds=${ids.join(",")}&hydrate=stats(group=[pitching],type=[season])`);
    for(const person of data.people||[]){
      const split=(((person.stats||[])[0]||{}).splits||[])[0];
      const st=split&&split.stat?split.stat:{};
      out[person.id]={id:person.id,name:person.fullName,era:Number(st.era),whip:Number(st.whip),ip:ipToNum(st.inningsPitched),so:Number(st.strikeOuts||0),bb:Number(st.baseOnBalls||0),gs:Number(st.gamesStarted||0)};
    }
  } catch(e){ console.warn("Pitcher stats unavailable:", e.message); }
  return out;
}

function pitcherScore(st){
  if(!st || !Number.isFinite(st.era)) return {score:50,label:"Unknown",k9:null,bb9:null};
  const era=st.era||LEAGUE_ERA, whip=Number.isFinite(st.whip)?st.whip:1.30, ip=st.ip||0;
  const k9=ip?(st.so/ip)*9:null, bb9=ip?(st.bb/ip)*9:null;
  const eraScore=clamp(100-(era-2.00)*16,20,92);
  const whipScore=clamp(100-(whip-0.90)*90,20,92);
  const kbbScore=(k9!==null&&bb9!==null)?clamp(50+(k9-8.0)*4-(bb9-3.0)*6,20,90):50;
  const sampleScore=clamp(35+Math.min(ip,100)*0.35,35,70);
  const score=Math.round(eraScore*.40+whipScore*.25+kbbScore*.20+sampleScore*.15);
  let label="Average"; if(score>=75) label="Strong"; else if(score>=65) label="Above avg"; else if(score<45) label="Weak"; else if(score<55) label="Below avg";
  return {score,label,k9,bb9};
}
function starterEff(g,side,pitchers){ const p=g.teams[side].probablePitcher; if(!p) return LEAGUE_ERA; const st=pitchers[p.id]; if(!st||!isFinite(st.era)||st.ip<MIN_IP) return LEAGUE_ERA; return clampEra(st.era); }

function buildOddsMap(events){
  const map={};
  for(const ev of events||[]){
    const rows=[];
    for(const bk of ev.bookmakers||[]){
      const m=(bk.markets||[]).find(m=>m.key==="h2h"); if(!m) continue;
      const oA=m.outcomes.find(o=>o.name===ev.away_team); const oH=m.outcomes.find(o=>o.name===ev.home_team);
      if(oA&&oH) rows.push([oA.price,oH.price]);
    }
    if(!rows.length) continue;
    const avgA=rows.reduce((s,r)=>s+amToProb(r[0]),0)/rows.length;
    const avgH=rows.reduce((s,r)=>s+amToProb(r[1]),0)/rows.length;
    const tot=avgA+avgH;
    map[ev.away_team+"@"+ev.home_team]={pAway:avgA/tot,pHome:avgH/tot,bestAway:decToAm(Math.max(...rows.map(r=>amToDec(r[0])))),bestHome:decToAm(Math.max(...rows.map(r=>amToDec(r[1])))),books:rows.length};
  }
  return map;
}

async function buildBullpenIndex(todayGames,date){
  const teams={};
  for(const g of todayGames){
    teams[g.teams.away.team.id]={id:g.teams.away.team.id,name:g.teams.away.team.name,games:[],pitcherDates:{}};
    teams[g.teams.home.team.id]={id:g.teams.home.team.id,name:g.teams.home.team.name,games:[],pitcherDates:{}};
  }
  for(const d of [-1,-2,-3].map(n=>dateShift(date,n))){
    let schedule=[]; try{ schedule=await getGamesForDate(d); }catch(e){ continue; }
    for(const g of schedule){
      if(!g.status || g.status.abstractGameState!=="Final") continue;
      const a=g.teams.away.team.id, h=g.teams.home.team.id; if(!teams[a]&&!teams[h]) continue;
      try{ const box=await fetchJson(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`); processBoxSide(box,"away",a,d,teams); processBoxSide(box,"home",h,d,teams); }catch(e){}
    }
  }
  const out={}; for(const t of Object.values(teams)) out[t.name]=scoreBullpen(t); return out;
}
async function getGamesForDate(date){ const data=await fetchJson(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`); return (((data.dates||[])[0])||{}).games||[]; }
function dateShift(base,n){ const d=new Date(base+"T12:00:00"); d.setDate(d.getDate()+n); return localISODate(d); }
function processBoxSide(box,side,teamId,date,teams){
  const team=teams[teamId]; if(!team) return;
  const tb=box.teams&&box.teams[side]; if(!tb||!tb.pitchers||!tb.players) return;
  let totalIP=0,starterIP=0,relievers=0;
  for(let i=0;i<tb.pitchers.length;i++){
    const id=tb.pitchers[i], player=tb.players["ID"+id];
    const ip=ipToNum(player&&player.stats&&player.stats.pitching&&player.stats.pitching.inningsPitched);
    totalIP+=ip; if(i===0) starterIP=ip; else { relievers++; if(!team.pitcherDates[id]) team.pitcherDates[id]=new Set(); team.pitcherDates[id].add(date); }
  }
  team.games.push({date,bpIP:Math.max(0,totalIP-starterIP),relievers});
}
function scoreBullpen(team){
  const games=team.games.sort((a,b)=>new Date(b.date)-new Date(a.date));
  const last=games[0]||{bpIP:0,relievers:0}; const last3BP=games.reduce((s,g)=>s+g.bpIP,0); let b2b=0;
  for(const dates of Object.values(team.pitcherDates)){
    const arr=[...dates].sort(); for(let i=1;i<arr.length;i++){ const prev=new Date(arr[i-1]+"T12:00:00"), curr=new Date(arr[i]+"T12:00:00"); if((curr-prev)/86400000===1){b2b++; break;} }
  }
  // Centered on a normal workload (last3 ~9 bullpen IP, last game ~3 IP). Deviations move the score, so the index discriminates instead of pinning everyone at 100.
  const score=Math.round(clamp(45+(last3BP-9)*3.5+(last.bpIP-3)*4+b2b*6,0,100));
  let label="Normal"; if(score>=78) label="High risk"; else if(score>=60) label="Tired"; else if(score<35) label="Fresh";
  return {score,label,last_game_bp_ip:round(last.bpIP,1),last3_bp_ip:round(last3BP,1),last_game_relievers:last.relievers,back_to_back_arms:b2b};
}

function modelGame(g,strength,pitchers,oddsMap,bullpen){
  const aT=g.teams.away.team,hT=g.teams.home.team; const sA=strength[aT.id],sH=strength[hT.id]; if(!sA||!sH) return null;
  const blendA=sA.form===null?sA.pyth:(1-FORM_WEIGHT)*sA.pyth+FORM_WEIGHT*sA.form;
  const blendH=sH.form===null?sH.pyth:(1-FORM_WEIGHT)*sH.pyth+FORM_WEIGHT*sH.form;
  const pBase=log5Home(blendH,blendA);
  const spA=starterEff(g,"away",pitchers), spH=starterEff(g,"home",pitchers);
  const pHome=((pBase/(1-pBase))*Math.exp(ERA_K*(spA-spH)))/(1+((pBase/(1-pBase))*Math.exp(ERA_K*(spA-spH))));
  const pickHome=pHome>=0.5; const pickTeam=pickHome?hT.name:aT.name; const oppTeam=pickHome?aT.name:hT.name; const side=pickHome?"home":"away"; const modelProb=pickHome?pHome:1-pHome;
  const awayPitcher=g.teams.away.probablePitcher, homePitcher=g.teams.home.probablePitcher;
  const awayStats=awayPitcher?pitchers[awayPitcher.id]:null, homeStats=homePitcher?pitchers[homePitcher.id]:null;
  const awayScore=pitcherScore(awayStats), homeScore=pitcherScore(homeStats);
  const pitchGap=Math.abs(homeScore.score-awayScore.score); const pitchEdgeTeam=pitchGap<4?"No clear SP edge":(homeScore.score>awayScore.score?hT.name:aT.name);
  const pitcherConflict=pitchEdgeTeam!=="No clear SP edge"&&pitchEdgeTeam!==pickTeam&&pitchGap>=8;
  const m=oddsMap?oddsMap[aT.name+"@"+hT.name]:null; const marketProb=m?(pickHome?m.pHome:m.pAway):null; const bestPrice=m?(pickHome?m.bestHome:m.bestAway):null; const edge=marketProb!==null?modelProb-marketProb:null;
  const pickBullpen=bullpen[pickTeam]||null, oppBullpen=bullpen[oppTeam]||null; const bullpenRead=bullpenLabel(pickBullpen,oppBullpen); const majorBullpenCaution=bullpenRead==="Adds caution"&&pickBullpen&&pickBullpen.score>=60;
  const labScore=calcLabScore({edge,pitchGap,pitchEdgeSupports:pitchEdgeTeam===pickTeam,pickBullpen,oppBullpen,hasMarket:!!m});
  let status="pass";
  if(edge!==null&&edge>=VALUE_EDGE&&labScore>=OFFICIAL_LAB_SCORE&&!pitcherConflict&&!majorBullpenCaution) status="official_pick";
  else if(labScore>=WATCHLIST_LAB_SCORE) status="watchlist";
  const passReason=status==="pass"?passReasonFor({edge,pitchEdgeTeam,pickTeam,pitcherConflict,labScore,market:m,majorBullpenCaution}):null;
  const read=status==="official_pick"?`${pickTeam} cleared the model, market, pitcher, and bullpen checks with a Lab Score of ${labScore}.`:status==="watchlist"?`${pickTeam} did not fully clear the official threshold, but the Lab Score keeps this game on the watchlist.`:passReason;
  return {
    game_pk:g.gamePk, game_id:`${slug(aT.name)}-${slug(hT.name)}-${DATE}`, game:`${aT.name} @ ${hT.name}`, time:new Date(g.gameDate).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/New_York"}), game_time_iso:g.gameDate,
    away_team:aT.name, home_team:hT.name, away_record:`${sA.wins}-${sA.losses}`, home_record:`${sH.wins}-${sH.losses}`, away_l10:sA.l10, home_l10:sH.l10,
    pick_team:pickTeam, side, model_probability:round(modelProb,4), edge:edge===null?null:round(edge,4), status, value_tag:status==="official_pick"?(labScore>=75?"STRONG SETUP":"QUALIFIED SETUP"):(status==="watchlist"?"WATCHLIST":"PASS"), lab_score:labScore, pass_reason:passReason, read,
    pitcher_edge:{team:pitchEdgeTeam,gap:pitchGap,conflict:pitcherConflict,away_score:awayScore.score,home_score:homeScore.score,away_pitcher:awayPitcher?awayPitcher.fullName:"TBD",home_pitcher:homePitcher?homePitcher.fullName:"TBD",away_era:awayStats&&Number.isFinite(awayStats.era)?awayStats.era:null,home_era:homeStats&&Number.isFinite(homeStats.era)?homeStats.era:null,away_whip:awayStats&&Number.isFinite(awayStats.whip)?awayStats.whip:null,home_whip:homeStats&&Number.isFinite(homeStats.whip)?homeStats.whip:null},
    bullpen:{pick_team:pickBullpen,opponent:oppBullpen,label:bullpenRead,major_caution:majorBullpenCaution},
    market:{no_vig_probability:marketProb===null?null:round(marketProb,4),best_price:bestPrice,books:m?m.books:0}
  };
}
function calcLabScore({edge,pitchGap,pitchEdgeSupports,pickBullpen,oppBullpen,hasMarket}){
  const modelPts=edge===null?0:clamp(edge/0.08,0,1)*35;
  const pitcherPts=pitchEdgeSupports?clamp(pitchGap/20,0,1)*25:Math.max(0,8-clamp(pitchGap/20,0,1)*8);
  let bullpenPts=7; if(pickBullpen&&oppBullpen) bullpenPts=8+clamp((oppBullpen.score-pickBullpen.score)/45,-1,1)*7;
  const marketPts=!hasMarket?0:edge>=VALUE_EDGE?15:edge>=0?10:edge>-VALUE_EDGE?5:1;
  return Math.round(clamp(modelPts+pitcherPts+bullpenPts+marketPts+5,0,100));
}
function bullpenLabel(pick,opp){ if(!pick||!opp) return "Unknown"; if(pick.score+15<opp.score) return "Supports LyDia side"; if(pick.score>opp.score+15) return "Adds caution"; return "Neutral"; }
function passReasonFor({edge,pitchEdgeTeam,pickTeam,pitcherConflict,labScore,market,majorBullpenCaution}){
  if(!market) return "No market data available, so this stays research-only until pricing is checked.";
  if(edge!==null&&edge<0) return "Market is higher than LyDia's model probability.";
  if(edge!==null&&edge<VALUE_EDGE) return "Model and market are too close for a clear official pick.";
  if(pitcherConflict) return "Starting pitcher edge conflicts with the model side.";
  if(majorBullpenCaution) return "Bullpen fatigue adds too much late-game caution.";
  if(labScore<OFFICIAL_LAB_SCORE) return "The combined Lab Score did not clear the official threshold.";
  return "No clear setup.";
}
function summarize(rows,hasOdds){ const official=rows.filter(r=>r.status==="official_pick").length, watch=rows.filter(r=>r.status==="watchlist").length, high=rows.filter(r=>r.lab_score>=75).length; if(!hasOdds) return "Brief generated without Odds API pricing. No official picks should be treated as complete until market pricing is available."; if(official) return `${official} official pick${official===1?"":"s"} cleared the full Lab process. ${watch} additional game${watch===1?"":"s"} landed on the watchlist.`; return `No official picks cleared the full Lab process. ${high} game${high===1?"":"s"} reached a Lab Score of 75+ but did not clear every check.`; }

function riskNote(r){ const notes=[]; if(r.pitcher_edge.conflict) notes.push("starting pitcher edge conflicts with the model side"); if(r.bullpen.major_caution) notes.push("bullpen fatigue adds late-game caution"); if(r.market.books&&r.market.books<3) notes.push("limited sportsbook sample"); if(!notes.length) return "No model can see every live lineup, injury, or late bullpen availability update. Recheck official news before first pitch."; return `Primary caution: ${notes.join("; ")}. Recheck official news before first pitch.`; }
function buildPicksFile(rows,generatedAt){ const official=rows.filter(r=>r.status==="official_pick"); return {date:DATE,generated:generatedAt,source_of_truth:"scripts/generate-member-lab.js",note:"Official picks are created only after pitcher matchup, bullpen fatigue, market pricing, and Lab Score checks.",picks:official.map(r=>({gamePk:r.game_pk,away:r.away_team,home:r.home_team,time:r.game_time_iso,labScore:r.lab_score,status:r.status,pitcherEdge:r.pitcher_edge,bullpen:r.bullpen,moneyline:{pick:r.pick_team,side:r.side,prob:r.model_probability,mktProb:r.market.no_vig_probability,bestAm:r.market.best_price,valueTag:r.value_tag,isPass:false,tier:r.lab_score>=75?"Strong Setup":"Qualified Setup",edgeScore:r.lab_score,rawEdge:r.edge,why:r.read,risk:riskNote(r)}}))}; }
function buildMarketFile(rows,generatedAt){ return {date:DATE,generated_at:generatedAt,snapshot_type:SNAPSHOT,items:rows.filter(r=>r.status==="official_pick").map(r=>({pick_id:`${r.game_id}-ml`,date:DATE,game:r.game,market:"Moneyline",pick:`${r.pick_team} ML`,pick_team:r.pick_team,lab_score:r.lab_score,posted_price:SNAPSHOT==="posted"?r.market.best_price:null,current_price:SNAPSHOT==="current"?r.market.best_price:null,closing_price:SNAPSHOT==="closing"?r.market.best_price:null,posted_at:SNAPSHOT==="posted"?generatedAt:null,last_checked_at:generatedAt,movement:"pending",read:"Market tracking compares LyDia's posted number against later current and closing snapshots."}))}; }
function mergeAndWriteMarket(newMarket){ const file=`data/market/${DATE}.json`; let existing=null; try{existing=JSON.parse(fs.readFileSync(file,"utf8"));}catch(e){} let merged=existing&&Array.isArray(existing.items)?existing:{date:DATE,generated_at:new Date().toISOString(),items:[]}; const byId=new Map(merged.items.map(i=>[i.pick_id,i])); for(const item of newMarket.items){ const prev=byId.get(item.pick_id)||{}; const updated={...prev,...item}; if(SNAPSHOT!=="posted"&&prev.posted_price!==undefined) updated.posted_price=prev.posted_price; if(SNAPSHOT!=="posted"&&prev.posted_at) updated.posted_at=prev.posted_at; if(SNAPSHOT!=="current"&&prev.current_price!==undefined) updated.current_price=prev.current_price; if(SNAPSHOT!=="closing"&&prev.closing_price!==undefined) updated.closing_price=prev.closing_price; updated.movement=movement(updated.posted_price,updated.current_price||updated.closing_price); byId.set(item.pick_id,updated); } merged.items=[...byId.values()]; merged.generated_at=new Date().toISOString(); merged.snapshot_type=SNAPSHOT; writeJson(file,merged); writeJson("data/market/today.json",merged); }
function movement(posted,later){ if(typeof posted!=="number"||typeof later!=="number") return "pending"; const postedDec=amToDec(posted), laterDec=amToDec(later); if(Math.abs(postedDec-laterDec)<0.015) return "stable"; return laterDec<postedDec?"toward_lydia":"away_from_lydia"; }

function renderPreviewPage(rows,brief){
  const official=rows.filter(r=>r.status==="official_pick"); const titleDate=displayDate(DATE);
  const cards=rows.map((r,i)=>renderPreviewCard(r,i===0)).join("\n");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MLB Game Previews &amp; Lab Scores ${esc(titleDate)} | LyDia</title>
<meta name="description" content="LyDia MLB previews for ${esc(titleDate)} with Lab Score, pitcher matchup, bullpen fatigue, market edge, and pass reasons.">
<link rel="stylesheet" href="/css/style.css"><style>
.pv{border:1px solid var(--border);border-radius:10px;background:var(--bg-card);padding:18px;margin:16px 0}.pv.featured{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}.pv h2{margin:0 0 4px;font-size:1.15rem}.pv .meta{color:var(--text-dim);font-size:.85rem;margin-bottom:8px}.featured-flag{display:inline-block;background:var(--accent);color:#fff;font-size:.75rem;font-weight:700;padding:2px 9px;border-radius:20px;margin-bottom:8px}.status-badge{display:inline-block;color:#fff;font-size:.75rem;font-weight:700;padding:3px 10px;border-radius:20px;margin:4px 0 8px;background:var(--accent2)}.status-badge.official{background:var(--good)}.status-badge.pass{background:var(--text-dim)}.field-grid{display:grid;grid-template-columns:auto 1fr;gap:3px 14px;font-size:.85rem;margin:10px 0;padding:10px 0;border-top:1px dashed var(--border);border-bottom:1px dashed var(--border)}.field-grid dt{color:var(--text-dim);margin:0}.field-grid dd{margin:0;font-weight:600}.why-block,.risk-block{font-size:.88rem;margin-top:10px;line-height:1.45}.why-block b,.risk-block b{display:block;margin-bottom:3px;color:var(--text)}
</style></head><body><nav id="nav"></nav><main>
<h1>MLB Game Previews — ${esc(titleDate)}</h1>
<p class="subtitle">Generated from LyDia's source-of-truth engine after pitcher matchup, bullpen fatigue, market pricing, and Lab Score are calculated.</p>
<p class="dim small">Generated ${esc(brief.generated_at)} · ${rows.length} games · ${official.length} official pick${official.length===1?"":"s"}.</p>
<div class="lead-box" style="border-color:var(--accent2)"><h3 style="margin:0 0 4px">Get the organized member view</h3><p class="dim small" style="margin:0">Members get the Daily Member Brief: official picks first, watchlist second, pass reasons third, and market tracking as prices change.</p><p style="margin-top:10px"><a class="btn blue" href="/membership/">Join LyDia — $30/mo →</a> <a class="btn secondary" href="/member-brief/">Open Member Brief</a></p></div>
${cards}
</main><footer id="footer"></footer><script src="/js/app.js"></script><script>renderNav("/previews/"); renderFooter();</script></body></html>\n`;
}
function renderPreviewCard(r,featured){
  const official=r.status==="official_pick", pass=r.status==="pass"; const statusClass=official?"official":pass?"pass":""; const statusLabel=official?"Official Pick":r.status==="watchlist"?"Watchlist":"Pass";
  const pe=r.pitcher_edge||{}, bp=r.bullpen||{}, m=r.market||{};
  return `<div class="${featured&&official?"pv featured":"pv"}" data-lab-score="${r.lab_score}">
  ${featured&&official?`<span class="featured-flag">Top Lab Score</span>`:""}<h2>${esc(r.game)}</h2><div class="meta">${esc(r.time)} ET · ${esc(pe.away_pitcher||"TBD")} vs ${esc(pe.home_pitcher||"TBD")}</div>
  <span class="status-badge ${statusClass}">${esc(statusLabel)}</span><dl class="field-grid">
    <dt>LyDia side</dt><dd>${esc(r.pick_team?r.pick_team+" Moneyline":"—")}</dd><dt>Lab Score</dt><dd>${r.lab_score}/100</dd><dt>Model probability</dt><dd>${fmtPct(r.model_probability)}</dd><dt>Market probability</dt><dd>${fmtPct(m.no_vig_probability)}</dd><dt>Model vs market</dt><dd>${r.edge===null?"—":(r.edge>=0?"+":"")+fmtPct(r.edge)}</dd><dt>Current price</dt><dd>${fmtOdds(m.best_price)}</dd><dt>Pitcher edge</dt><dd>${esc(pe.team||"—")} ${pe.gap?`(gap ${pe.gap})`:""}</dd><dt>Bullpen read</dt><dd>${esc(bp.label||"—")}</dd>
  </dl><div class="why-block"><b>Read</b>${esc(r.read||"")}</div>${pass?`<div class="risk-block"><b>Pass reason</b>${esc(r.pass_reason||"No clear setup.")}</div>`:`<div class="risk-block"><b>Risk note</b>${esc(riskNote(r))}</div>`}</div>`;
}
function updatePreviewArchive(date){
  const file="previews/index.html"; const link=`<a href="/previews/${date}.html">Game Previews — ${displayDate(date)}</a>`; let existing=""; try{existing=fs.readFileSync(file,"utf8");}catch(e){}
  let links=[]; if(existing){ const matches=existing.match(/<a href="\/previews\/\d{4}-\d{2}-\d{2}\.html">[^<]+<\/a>/g)||[]; links=matches.filter(x=>!x.includes(`/previews/${date}.html`));}
  links.unshift(link); links=[...new Set(links)].slice(0,60);
  const html=`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>MLB Game Previews — archive | LyDia</title><meta name="description" content="Daily MLB game previews generated after LyDia's Lab Score, pitcher matchup, bullpen fatigue, and market checks."><link rel="stylesheet" href="/css/style.css"><style>.archive-list a{display:block;padding:8px 0;border-bottom:1px solid var(--border)}</style></head><body><nav id="nav"></nav><main><h1>Game Previews</h1><p class="subtitle">Daily previews generated from LyDia's source-of-truth engine.</p><div class="card archive-list">\n${links.join("\n")}\n</div></main><footer id="footer"></footer><script src="/js/app.js"></script><script>renderNav("/previews/"); renderFooter();</script></body></html>\n`;
  fs.writeFileSync(file,html,"utf8");
}
