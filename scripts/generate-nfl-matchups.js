#!/usr/bin/env node
/**
 * NFL matchup data — one record per game on a slate.
 *
 * Deliberately NOT a projection. The 2025 backtest and a fitted logistic
 * regression both showed the model cannot beat the closing line
 * (claude/NFL_BACKTEST_RESULTS.md, claude/NFL_RATINGS_SPEC.md), so these
 * pages present STATS, not predictions: last season alongside this season,
 * the starting QB, the RB / WR1 / WR2, and each side's top three touchdown
 * scorers.
 *
 * Roles are assigned by ACTUAL USAGE, not depth chart:
 *   QB  most pass attempts        RB  most carries        WR  most targets
 */
const { execFileSync } = require("child_process");
const fs=require("fs"), path=require("path");
const ROOT=path.join(__dirname,"..");
const FEED="https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";
const REL="https://github.com/nflverse/nflverse-data/releases/download";
const SEASON=2026, PRIOR=2025;

function parseCSV(t){const rows=[];let row=[],f="",q=false;
 for(let i=0;i<t.length;i++){const c=t[i];
  if(q){if(c==='"'){if(t[i+1]==='"'){f+='"';i++;}else q=false;}else f+=c;}
  else if(c==='"')q=true; else if(c===","){row.push(f);f="";}
  else if(c==="\n"){row.push(f);rows.push(row);row=[];f="";} else if(c!=="\r")f+=c;}
 if(f.length||row.length){row.push(f);rows.push(row);}
 const h=rows.shift().map(x=>x.trim());
 return rows.filter(r=>r.length>1).map(r=>Object.fromEntries(h.map((k,i)=>[k,(r[i]??"").trim()])));}
const get=u=>parseCSV(execFileSync("curl",["-sSL","--fail","--max-time","180",u],{maxBuffer:1<<29,encoding:"utf8"}));
const n=v=>{const x=parseFloat(v);return Number.isFinite(x)?x:0;};
const r1=x=>Math.round(x*10)/10;
const r2=x=>Math.round(x*100)/100;
const slug=s=>String(s).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");

/** Aggregate a player's weekly rows into a season line. */
function agg(rows){
  const s={games:rows.length,att:0,cmp:0,pass_yds:0,pass_td:0,ints:0,sacks:0,
           car:0,rush_yds:0,rush_td:0,tgt:0,rec:0,rec_yds:0,rec_td:0,epa:0};
  rows.forEach(r=>{
    s.att+=n(r.attempts); s.cmp+=n(r.completions); s.pass_yds+=n(r.passing_yards);
    s.pass_td+=n(r.passing_tds); s.ints+=n(r.passing_interceptions); s.sacks+=n(r.sacks_suffered);
    s.car+=n(r.carries); s.rush_yds+=n(r.rushing_yards); s.rush_td+=n(r.rushing_tds);
    s.tgt+=n(r.targets); s.rec+=n(r.receptions); s.rec_yds+=n(r.receiving_yards);
    s.rec_td+=n(r.receiving_tds); s.epa+=n(r.passing_epa)+n(r.rushing_epa)+n(r.receiving_epa);
  });
  const g=s.games||1;
  return {
    games:s.games,
    // passing
    att:s.att, cmp:s.cmp, comp_pct: s.att?r1(100*s.cmp/s.att):null,
    pass_yds:s.pass_yds, pass_ypg:r1(s.pass_yds/g), pass_td:s.pass_td, ints:s.ints,
    ypa: s.att?r1(s.pass_yds/s.att):null, sacks:s.sacks,
    td_int: s.ints?r2(s.pass_td/s.ints):(s.pass_td?null:0),
    // rushing
    car:s.car, rush_yds:s.rush_yds, rush_ypg:r1(s.rush_yds/g), rush_td:s.rush_td,
    ypc: s.car?r1(s.rush_yds/s.car):null,
    // receiving
    tgt:s.tgt, rec:s.rec, rec_yds:s.rec_yds, rec_ypg:r1(s.rec_yds/g), rec_td:s.rec_td,
    ypr: s.rec?r1(s.rec_yds/s.rec):null, catch_pct: s.tgt?r1(100*s.rec/s.tgt):null,
    total_td: s.pass_td+s.rush_td+s.rec_td,
    scrim_td: s.rush_td+s.rec_td,
    epa:r1(s.epa)
  };
}

function teamProfile(rows, team, active){
  const mine=rows.filter(r=>r.team===team);
  const byPlayer={};
  mine.forEach(r=>{(byPlayer[r.player_display_name]=byPlayer[r.player_display_name]||[]).push(r);});
  const lines=Object.entries(byPlayer).map(([name,rs])=>({
    name, pos:rs[0].position, ...agg(rs)
  })).filter(p=>!active || active.has(p.name) || p.games>0);

  const top=(pos,key,count)=>lines.filter(p=>p.pos===pos&&p[key]>0)
      .sort((a,b)=>b[key]-a[key]).slice(0,count);
  const qb = top("QB","att",1)[0]||null;
  const rbs= top("RB","car",2);
  const wrs= top("WR","tgt",2);
  const te = top("TE","tgt",1)[0]||null;
  // top three touchdown scorers of any position (scrimmage TDs — rushing + receiving)
  const scorers = lines.filter(p=>p.scrim_td>0)
      .sort((a,b)=>b.scrim_td-a.scrim_td || b.total_td-a.total_td)
      .slice(0,3)
      .map(p=>({name:p.name,pos:p.pos,tds:p.scrim_td,rush_td:p.rush_td,rec_td:p.rec_td,games:p.games}));
  return {
    qb, rb1:rbs[0]||null, rb2:rbs[1]||null,
    wr1:wrs[0]||null, wr2:wrs[1]||null, te,
    top_scorers:scorers,
    team_totals: agg(mine)
  };
}

(function main(){
  const target = process.argv[2] || new Date(Date.now()+864e5).toISOString().slice(0,10);
  console.log(`NFL matchups for ${target}`);
  const games = get(FEED).filter(g=>g.gameday===target)
                  .sort((a,b)=>String(a.gametime).localeCompare(String(b.gametime)));
  if(!games.length){ console.log("No games on that date. Nothing written."); return; }

  const wkCur=get(`${REL}/stats_player/stats_player_week_${SEASON}.csv`);
  const wkPri=get(`${REL}/stats_player/stats_player_week_${PRIOR}.csv`);
  let active=null;
  try{
    const ros=get(`${REL}/rosters/roster_${SEASON}.csv`);
    active=new Set(ros.filter(r=>r.status==="ACT").map(r=>r.full_name));
  }catch(e){ console.log("  roster unavailable; including all players with snaps"); }

  // team season totals, both seasons, for the team-vs-team band.
  // agg() sets games = row count, which is right for ONE player but wrong for a
  // team (it counts player-weeks). Team rates must divide by distinct weeks.
  const teamAgg=(rows,team)=>{
    const mine=rows.filter(r=>r.team===team);
    const a=agg(mine);
    const wks=new Set(mine.map(r=>r.week)).size||1;
    return {...a, games:wks,
      pass_ypg:r1(a.pass_yds/wks), rush_ypg:r1(a.rush_yds/wks), rec_ypg:r1(a.rec_yds/wks)};
  };
  const defAgg=(rows,team)=>{
    const opp=rows.filter(r=>r.opponent_team===team);
    const a=agg(opp);
    const wks=new Set(opp.map(r=>r.week)).size||1;
    return {games:wks, pass_ypg:r1(a.pass_yds/wks), rush_ypg:r1(a.rush_yds/wks),
            pass_td:a.pass_td, rush_td:a.rush_td, ints_forced:a.ints};
  };

  const out=games.map(g=>{
    const pageSlug=`${slug(g.away_team)}-vs-${slug(g.home_team)}-prediction-odds-${target}`;
    const build=(team)=>({
      team,
      this_season: teamProfile(wkCur, team, active),
      last_season: teamProfile(wkPri, team, null),
      team_offense: { this_season: teamAgg(wkCur,team), last_season: teamAgg(wkPri,team) },
      team_defense: { this_season: defAgg(wkCur,team),  last_season: defAgg(wkPri,team) }
    });
    return {
      date:target, game_id:g.game_id, slug:pageSlug,
      url:`/nfl/${pageSlug}/`,
      matchup:`${g.away_team} @ ${g.home_team}`,
      away:g.away_team, home:g.home_team,
      kickoff:g.gametime, weekday:g.weekday, week:n(g.week), stadium:g.stadium,
      roof:g.roof, surface:g.surface, div_game:g.div_game==="1",
      away_moneyline:n(g.away_moneyline)||null, home_moneyline:n(g.home_moneyline)||null,
      spread_line:g.spread_line===""?null:n(g.spread_line),
      total_line:g.total_line===""?null:n(g.total_line),
      away_qb_name:g.away_qb_name, home_qb_name:g.home_qb_name,
      away_coach:g.away_coach, home_coach:g.home_coach,
      sides:{ away: build(g.away_team), home: build(g.home_team) }
    };
  });

  const dir=path.join(ROOT,"data/nfl/matchups");
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,`${target}.json`), JSON.stringify(out,null,2));
  fs.writeFileSync(path.join(dir,"today.json"), JSON.stringify(out,null,2));

  const withQb=out.filter(m=>m.sides.away.this_season.qb&&m.sides.home.this_season.qb).length;
  const withScorers=out.filter(m=>m.sides.away.this_season.top_scorers.length).length;
  console.log(`  ${out.length} matchups  ·  ${withQb} with both starting QBs  ·  ${withScorers} with TD scorers`);
  console.log(`  wrote data/nfl/matchups/${target}.json`);
  out.slice(0,2).forEach(m=>console.log(`    ${m.url}`));
})();
