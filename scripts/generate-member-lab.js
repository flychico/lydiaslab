#!/usr/bin/env node
/*
  LyDia source-of-truth daily engine.
  This script creates research data and locked official picks only for an open slate.
  It does not publish closed slates and it never writes empty official records.
*/
const fs = require("fs");
const path = require("path");
const { buildBullpenSource } = require("./lib/bullpen-fatigue-core");

const ROOT = path.join(__dirname, "..");
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
const MAX_ABS_PRICE = 1000;

const args = parseArgs(process.argv.slice(2));
const DATE = args.date || etToday();
const SNAPSHOT = args.snapshot || process.env.SNAPSHOT_TYPE || "posted";
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";

if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error(`Bad date: ${DATE}`);
  process.exit(1);
}
if (!["posted", "current", "closing"].includes(SNAPSHOT)) {
  console.error(`Bad snapshot: ${SNAPSHOT}. Use posted, current, or closing.`);
  process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });

async function main() {
  ["data/member-brief", "data/picks", "data/published-picks", "data/market", "data/bullpen"].forEach(p => fs.mkdirSync(path.join(ROOT, p), { recursive:true }));

  const [sched, standings, oddsEvents] = await Promise.all([
    fetchJson(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}&hydrate=probablePitcher`),
    fetchJson(`https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${seasonYear(DATE)}&standingsTypes=regularSeason`),
    ODDS_API_KEY ? fetchJson(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${encodeURIComponent(ODDS_API_KEY)}&regions=us&markets=h2h&oddsFormat=american`).catch(() => []) : Promise.resolve([])
  ]);

  const allGames = ((((sched.dates || [])[0]) || {}).games || [])
    .filter(g => g.gameType === "R" || g.gameType === undefined)
    .sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate));

  if (!allGames.length) {
    throw new Error(`No MLB games found for ${DATE}. No files were written.`);
  }

  const openGames = allGames.filter(g => g.status && g.status.abstractGameState === "Preview");
  if (!openGames.length) {
    throw new Error(`Closed slate guard: ${DATE} has ${allGames.length} game(s), but none are in Preview state. LyDia will not create or overwrite official picks after games start. Run Site maintenance cleanup or grade-results instead.`);
  }

  const generatedAt = new Date().toISOString();
  const strength = buildStrength(standings);
  const pitchers = await fetchPitchers(openGames);
  const oddsMap = buildOddsMap(oddsEvents);
  const bullpenSource = await buildBullpenSource({ date: DATE, todayGames: openGames, fetchJson, generatedAt });
  const bullpen = bullpenSource.teams_by_name || {};

  writeJson(`data/bullpen/${DATE}.json`, bullpenSource);
  if (DATE === etToday()) writeJson("data/bullpen/today.json", bullpenSource);

  const rows = openGames.map(g => modelGame(g, strength, pitchers, oddsMap, bullpen)).filter(Boolean)
    .sort((a, b) => (b.lab_score || 0) - (a.lab_score || 0));

  if (!rows.length) {
    throw new Error(`Model guard: ${DATE} produced zero game rows from ${openGames.length} open game(s). No official files were written.`);
  }

  const brief = {
    date: DATE,
    generated_at: generatedAt,
    snapshot_type: SNAPSHOT,
    source_of_truth: "LyDia Daily Engine",
    summary: summarize(rows, Boolean(ODDS_API_KEY)),
    games: rows
  };
  writeJson(`data/member-brief/${DATE}.json`, brief);
  if (DATE === etToday()) writeJson("data/member-brief/today.json", brief);

  const candidatePublished = buildPicksFile(rows, generatedAt);
  const published = writeOrReusePublishedPicks(candidatePublished, allGames.length);

  writeJson(`data/picks/${DATE}.json`, published);
  if (DATE === etToday()) writeJson("data/picks/today.json", published);

  mergeAndWriteMarket(buildMarketFile(rows, generatedAt));

  console.log(`Generated LyDia source data for ${DATE}. Games: ${rows.length}. Official picks: ${published.picks.length}.`);
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
function etToday(){ const et = new Date(new Date().toLocaleString("en-US", { timeZone:"America/New_York" })); return `${et.getFullYear()}-${String(et.getMonth()+1).padStart(2,"0")}-${String(et.getDate()).padStart(2,"0")}`; }
async function fetchJson(url){ const res = await fetch(url); if(!res.ok) throw new Error(`HTTP ${res.status}: ${url}`); return res.json(); }
function writeJson(file,obj){ const out = path.join(ROOT, file); fs.mkdirSync(path.dirname(out), { recursive:true }); fs.writeFileSync(out, JSON.stringify(obj,null,2)+"\n","utf8"); }
function readJson(file){ return JSON.parse(fs.readFileSync(path.join(ROOT, file),"utf8")); }
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
function slug(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,""); }

function buildStrength(standings){
  const strength={};
  for(const rec of standings.records||[]){
    for(const t of rec.teamRecords||[]){
      const l10=(((t.records||{}).splitRecords)||[]).find(r=>r.type==="lastTen");
      strength[t.team.id]={pyth:pythag(t.runsScored,t.runsAllowed), form:l10 ? l10.wins/Math.max(1,l10.wins+l10.losses):null, l10:l10?`${l10.wins}-${l10.losses}`:"-", wins:t.wins, losses:t.losses};
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
      if(oA&&oH&&Math.abs(Number(oA.price))<=MAX_ABS_PRICE&&Math.abs(Number(oH.price))<=MAX_ABS_PRICE) rows.push([oA.price,oH.price]);
    }
    if(!rows.length) continue;
    const avgA=rows.reduce((s,r)=>s+amToProb(r[0]),0)/rows.length;
    const avgH=rows.reduce((s,r)=>s+amToProb(r[1]),0)/rows.length;
    const tot=avgA+avgH;
    map[ev.away_team+"@"+ev.home_team]={pAway:avgA/tot,pHome:avgH/tot,bestAway:decToAm(Math.max(...rows.map(r=>amToDec(r[0])))),bestHome:decToAm(Math.max(...rows.map(r=>amToDec(r[1])))),books:rows.length};
  }
  return map;
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
    bullpen:{pick_team:pickBullpen,opponent:oppBullpen,label:bullpenRead,major_caution:majorBullpenCaution,absolute_risk:absoluteBullpenRisk(pickBullpen,oppBullpen)},
    market:{no_vig_probability:marketProb===null?null:round(marketProb,4),best_price:bestPrice,books:m?m.books:0}
  };
}
function calcLabScore({edge,pitchGap,pitchEdgeSupports,pickBullpen,oppBullpen,hasMarket}){
  const modelPts=edge===null?0:clamp(edge/0.08,0,1)*35;
  const pitcherPts=pitchEdgeSupports?clamp(pitchGap/20,0,1)*25:Math.max(0,8-clamp(pitchGap/20,0,1)*8);
  let bullpenPts=7;
  if(pickBullpen&&oppBullpen){ bullpenPts=8+clamp((oppBullpen.score-pickBullpen.score)/45,-1,1)*7; if(pickBullpen.score>=78) bullpenPts-=2; if(pickBullpen.score>=78&&oppBullpen.score>=78) bullpenPts-=1; }
  const marketPts=!hasMarket?0:edge>=VALUE_EDGE?15:edge>=0?10:edge>-VALUE_EDGE?5:1;
  return Math.round(clamp(modelPts+pitcherPts+bullpenPts+marketPts+5,0,100));
}
function bullpenLabel(pick,opp){ if(!pick||!opp) return "Unknown"; if(pick.score>=78&&opp.score>=78) return "Both bullpens stressed"; if(pick.score+15<opp.score) return "Supports LyDia side"; if(pick.score>opp.score+15) return "Adds caution"; if(pick.score>=60||opp.score>=60) return "Elevated volatility"; return "Neutral"; }
function absoluteBullpenRisk(pick,opp){ if(!pick||!opp) return "Unknown"; if(pick.score>=78&&opp.score>=78) return "Both high"; if(pick.score>=78) return "Pick side high"; if(opp.score>=78) return "Opponent high"; if(pick.score>=60||opp.score>=60) return "Elevated"; return "Normal"; }
function passReasonFor({edge,pitchEdgeTeam,pickTeam,pitcherConflict,labScore,market,majorBullpenCaution}){ if(!market) return "No market data available, so this stays research-only until pricing is checked."; if(edge!==null&&edge<0) return "Market is higher than LyDia's model probability."; if(edge!==null&&edge<VALUE_EDGE) return "Model and market are too close for a clear official pick."; if(pitcherConflict) return "Starting pitcher edge conflicts with the model side."; if(majorBullpenCaution) return "Bullpen fatigue adds too much late-game caution."; if(labScore<OFFICIAL_LAB_SCORE) return "The combined Lab Score did not clear the official threshold."; return "No clear setup."; }
function summarize(rows,hasOdds){ const official=rows.filter(r=>r.status==="official_pick").length, watch=rows.filter(r=>r.status==="watchlist").length, high=rows.filter(r=>r.lab_score>=75).length; if(!hasOdds) return "Brief generated without live market pricing. Treat the card as research-only until pricing is checked."; if(official) return `${official} official pick${official===1?"":"s"} cleared the full Lab process. ${watch} additional game${watch===1?"":"s"} landed on the watchlist.`; return `No official picks cleared the full Lab process. ${high} game${high===1?"":"s"} reached a Lab Score of 75+ but did not clear every check.`; }
function riskNote(r){ const notes=[]; if(r.pitcher_edge.conflict) notes.push("starting pitcher edge conflicts with the model side"); if(r.bullpen.major_caution) notes.push("bullpen fatigue adds late-game caution"); if(r.bullpen.label==="Both bullpens stressed") notes.push("both bullpens show elevated recent workload"); else if(r.bullpen.label==="Elevated volatility") notes.push("bullpen workload adds late-game volatility"); if(r.market.books&&r.market.books<3) notes.push("limited sportsbook sample"); if(!notes.length) return "No model can see every live lineup, injury, or late bullpen availability update. Recheck official news before first pitch."; return `Primary caution: ${notes.join("; ")}. Recheck official news before first pitch.`; }
function buildPicksFile(rows,generatedAt){
  const official=rows.filter(r=>r.status==="official_pick");
  return { date:DATE, generated:generatedAt, generated_at:generatedAt, locked_at:generatedAt, source_of_truth:"LyDia Daily Engine", lock_policy:"Dated official pick files are append-only. Re-running the engine for the same date reuses the existing dated file instead of changing official picks.", note:"Official picks are created only after pitcher matchup, bullpen fatigue, market pricing, and Lab Score checks.", picks:official.map(r=>({gamePk:r.game_pk,away:r.away_team,home:r.home_team,time:r.game_time_iso,labScore:r.lab_score,status:r.status,pitcherEdge:r.pitcher_edge,bullpen:r.bullpen,moneyline:{pick:r.pick_team,side:r.side,prob:r.model_probability,mktProb:r.market.no_vig_probability,bestAm:r.market.best_price,valueTag:r.value_tag,isPass:false,tier:r.lab_score>=75?"Strong Setup":"Qualified Setup",edgeScore:r.lab_score,rawEdge:r.edge,why:r.read,risk:riskNote(r)}})) };
}
function writeOrReusePublishedPicks(candidate, scheduledGameCount){
  const file=`data/published-picks/${DATE}.json`;
  if(fs.existsSync(path.join(ROOT, file))){
    const existing=readJson(file);
    if(!existing || !Array.isArray(existing.picks)) throw new Error(`${file} exists but does not contain a picks array.`);
    if(existing.picks.length===0 && scheduledGameCount>0) throw new Error(`${file} is an invalid empty lock for a real slate. Run scripts/site-health-cleanup.js --fix before publishing.`);
    console.log(`Published picks already exist for ${DATE}; reusing ${file}.`);
    if(DATE===etToday()) writeJson("data/published-picks/today.json", existing);
    return existing;
  }
  writeJson(file,candidate);
  if(DATE===etToday()) writeJson("data/published-picks/today.json", candidate);
  return candidate;
}
function buildMarketFile(rows,generatedAt){ return {date:DATE,generated_at:generatedAt,snapshot_type:SNAPSHOT,items:rows.filter(r=>r.status==="official_pick").map(r=>({pick_id:`${r.game_id}-ml`,date:DATE,game:r.game,market:"Moneyline",pick:`${r.pick_team} ML`,pick_team:r.pick_team,lab_score:r.lab_score,posted_price:SNAPSHOT==="posted"?r.market.best_price:null,current_price:SNAPSHOT==="current"?r.market.best_price:null,closing_price:SNAPSHOT==="closing"?r.market.best_price:null,posted_at:SNAPSHOT==="posted"?generatedAt:null,last_checked_at:generatedAt,movement:"pending",read:"Market tracking compares LyDia's posted number against later current and closing snapshots."}))}; }
function mergeAndWriteMarket(newMarket){ const file=`data/market/${DATE}.json`; let existing=null; try{existing=readJson(file);}catch(e){} let merged=existing&&Array.isArray(existing.items)?existing:{date:DATE,generated_at:new Date().toISOString(),items:[]}; const byId=new Map(merged.items.map(i=>[i.pick_id,i])); for(const item of newMarket.items){ const prev=byId.get(item.pick_id)||{}; const updated={...prev,...item}; if(SNAPSHOT!=="posted"&&prev.posted_price!==undefined) updated.posted_price=prev.posted_price; if(SNAPSHOT!=="posted"&&prev.posted_at) updated.posted_at=prev.posted_at; if(SNAPSHOT!=="current"&&prev.current_price!==undefined) updated.current_price=prev.current_price; if(SNAPSHOT!=="closing"&&prev.closing_price!==undefined) updated.closing_price=prev.closing_price; updated.movement=movement(updated.posted_price,updated.current_price||updated.closing_price); byId.set(item.pick_id,updated); } merged.items=[...byId.values()]; merged.generated_at=new Date().toISOString(); merged.snapshot_type=SNAPSHOT; writeJson(file,merged); if(DATE===etToday()) writeJson("data/market/today.json",merged); }
function movement(posted,later){ if(typeof posted!=="number"||typeof later!=="number") return "pending"; const postedDec=amToDec(posted), laterDec=amToDec(later); if(Math.abs(postedDec-laterDec)<0.015) return "stable"; return laterDec<postedDec?"toward_lydia":"away_from_lydia"; }
