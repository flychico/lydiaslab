#!/usr/bin/env node
/**
 * Render permanent NFL matchup pages from data/nfl/matchups/<date>.json.
 *
 * These are STAT pages, not prediction pages. Both backtests said the model
 * cannot beat the closing line, so the pages lead with what is true — last
 * season beside this season, the starting QB, the skill players and the
 * touchdown scorers — and show the market number as market, not as a pick.
 *
 * Data is inlined per page so each URL is self-contained and indexable.
 */
const fs=require("fs"), path=require("path");
const ROOT=path.join(__dirname,"..");
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const v=(x,d="—")=>(x==null||x===""||Number.isNaN(x))?d:x;
const fmtAm=x=>x==null?"—":(x>0?"+"+x:""+x);
const d2=x=>x==null?"\u2014":Number(x).toFixed(2);

function qbRow(q){
  if(!q) return `<tr><td colspan="8" class="none">No qualifying passer</td></tr>`;
  return `<tr><td class="pl">${esc(q.name)}</td><td>${v(q.games)}</td><td>${v(q.cmp)}/${v(q.att)}</td>
    <td>${v(q.comp_pct)}%</td><td><b>${v(q.pass_yds)}</b></td><td>${v(q.pass_ypg)}</td>
    <td>${v(q.pass_td)} / ${v(q.ints)}</td><td>${v(q.ypa)}</td></tr>`;
}
function rbRow(p){
  if(!p) return `<tr><td colspan="6" class="none">No qualifying rusher</td></tr>`;
  return `<tr><td class="pl">${esc(p.name)}</td><td>${v(p.games)}</td><td>${v(p.car)}</td>
    <td><b>${v(p.rush_yds)}</b></td><td>${v(p.ypc)}</td><td>${v(p.rush_td)}</td></tr>`;
}
function wrRow(p,label){
  if(!p) return `<tr><td colspan="7" class="none">No qualifying ${label}</td></tr>`;
  return `<tr><td class="pl">${esc(p.name)} <span class="rl">${label}</span></td><td>${v(p.games)}</td>
    <td>${v(p.rec)}/${v(p.tgt)}</td><td>${v(p.catch_pct)}%</td><td><b>${v(p.rec_yds)}</b></td>
    <td>${v(p.rec_ypg)}</td><td>${v(p.rec_td)}</td></tr>`;
}

function sideBlock(side, seasonKey, seasonLabel, rating){
  const p=side[seasonKey];
  // Leo's QB rating sits beside the passer's line so the two sides can be
  // compared directly without scrolling back up to the ratings band.
  const qbBadge = (rating && rating.qb_rating!=null)
    ? `<span class="qbr" title="Leo QB rating: 50 is league average, 15 points per standard deviation">
         <em>Leo QB</em><b>${rating.qb_rating.toFixed(0)}</b></span>` : "";
  return `
  <div class="statcard">
    <div class="sc-head"><img src="/img/nfl/${encodeURIComponent(side.team)}.png" alt=""><b>${esc(side.team)}</b>
      <span class="sc-season">${esc(seasonLabel)}</span></div>
    <div class="sc-body">
      <h4>Quarterback ${qbBadge}</h4>
      <div class="tw"><table><thead><tr><th>Player</th><th>G</th><th>C/ATT</th><th>Comp%</th><th>Yards</th><th>Y/G</th><th>TD/INT</th><th>Y/A</th></tr></thead>
      <tbody>${qbRow(p.qb)}</tbody></table></div>

      <h4>Running back</h4>
      <div class="tw"><table><thead><tr><th>Player</th><th>G</th><th>Car</th><th>Yards</th><th>Y/C</th><th>TD</th></tr></thead>
      <tbody>${rbRow(p.rb1)}${p.rb2?rbRow(p.rb2):""}</tbody></table></div>

      <h4>Receivers</h4>
      <div class="tw"><table><thead><tr><th>Player</th><th>G</th><th>Rec/Tgt</th><th>Catch%</th><th>Yards</th><th>Y/G</th><th>TD</th></tr></thead>
      <tbody>${wrRow(p.wr1,"WR1")}${wrRow(p.wr2,"WR2")}${p.te?wrRow(p.te,"TE"):""}</tbody></table></div>
    </div>
  </div>`;
}

function scorers(side, label){
  const s=side.this_season.top_scorers||[];
  if(!s.length) return `<div class="tdcard"><div class="td-head"><img src="/img/nfl/${encodeURIComponent(side.team)}.png" alt=""><b>${esc(side.team)}</b></div>
    <p class="none">No touchdowns scored yet this season.</p></div>`;
  return `<div class="tdcard"><div class="td-head"><img src="/img/nfl/${encodeURIComponent(side.team)}.png" alt=""><b>${esc(side.team)}</b>
      <span class="sc-season">${esc(label)}</span></div>
    <ol class="tdlist">${s.map(x=>`<li><span class="tdn">${esc(x.name)}</span>
      <span class="tdp">${esc(x.pos)}</span>
      <span class="tdc">${x.tds}</span>
      <span class="tdd">${x.rush_td} rush &middot; ${x.rec_td} rec</span></li>`).join("")}</ol></div>`;
}


/**
 * Column heads for any comparison table: logo + abbreviation on each side,
 * repeated at every band. Module scope because both page() and
 * ratingsSection() emit these tables — a page-scoped helper was invisible to
 * the latter.
 */
function vsHead(m, band){
  return `<tr class="vshead">
    <th><span class="vst"><img src="/img/nfl/${encodeURIComponent(m.away)}.png" alt="">${esc(m.away)}</span></th>
    <th class="vsband">${esc(band)}</th>
    <th><span class="vst vsr">${esc(m.home)}<img src="/img/nfl/${encodeURIComponent(m.home)}.png" alt=""></span></th></tr>`;
}

/** One rating row: two 0-100 scores facing each other with a shared bar. */
function ratingRow(label, a, h, hint){
  if (a==null || h==null) return "";
  const aw=Math.max(2,Math.min(98,a)), hw=Math.max(2,Math.min(98,h));
  const lead = a>h ? "a" : (h>a ? "h" : "");
  return `<div class="rrow">
    <span class="rv rva ${lead==="a"?"lead":""}">${a.toFixed(0)}</span>
    <span class="rlab">${esc(label)}${hint?`<em>${esc(hint)}</em>`:""}</span>
    <span class="rv rvh ${lead==="h"?"lead":""}">${h.toFixed(0)}</span>
    <span class="rbar"><i class="ra" style="width:${aw/2}%"></i><i class="rh" style="width:${hw/2}%"></i></span>
  </div>`;
}
/** A plain stat comparison line (raw numbers, lower-is-better aware). */
function statRow(label, a, h, fmt=x=>v(x), lowerBetter=false){
  if (a==null && h==null) return "";
  const lead = (a==null||h==null) ? "" : (lowerBetter ? (a<h?"a":(h<a?"h":"")) : (a>h?"a":(h>a?"h":"")));
  return `<tr><td class="${lead==="a"?"lead":""}">${fmt(a)}</td><th>${esc(label)}</th><td class="${lead==="h"?"lead":""}">${fmt(h)}</td></tr>`;
}

function ratingsSection(m){
  const R=m.ratings; if(!R) return "";
  const cur=R.this_season, pri=R.last_season;
  if(!cur||!cur.away||!cur.home) return "";
  const A=cur.away, H=cur.home, Ap=pri&&pri.away, Hp=pri&&pri.home;
  const pc=x=>x==null?"—":(x*100).toFixed(1)+"%";
  const sg=x=>x==null?"—":(x>0?"+":"")+x;
  return `
  <h2 class="sec">Leo ratings &mdash; head to head</h2>
  <p class="sub">Each rating is 0&ndash;100 against the league this season, built from efficiency rather than record: 50 is average, every 15 points is one standard deviation. These describe the teams &mdash; they are not used to price the game.</p>

  <div class="rcard">
    <div class="rhead">
      <span class="rt"><img src="/img/nfl/${encodeURIComponent(m.away)}.png" alt=""><b>${esc(m.away)}</b></span>
      <span class="rmid">This season</span>
      <span class="rt rr"><b>${esc(m.home)}</b><img src="/img/nfl/${encodeURIComponent(m.home)}.png" alt=""></span>
    </div>
    <div class="rbody">
      ${ratingRow("Quarterback", A.qb_rating, H.qb_rating, "EPA, accuracy, giveaways")}
      ${ratingRow("Offense", A.off_rating, H.off_rating, "efficiency, explosives, ball security")}
      ${ratingRow("Defense", A.def_rating, H.def_rating, "EPA allowed, pressure, takeaways")}
      ${ratingRow("Overall", A.overall, H.overall)}
    </div>
    ${Ap&&Hp?`<div class="rprior">
      <span class="rpv">QB ${Ap.qb_rating.toFixed(0)} &middot; OFF ${Ap.off_rating.toFixed(0)} &middot; DEF ${Ap.def_rating.toFixed(0)}</span>
      <span class="rpl">Last season</span>
      <span class="rpv rr">QB ${Hp.qb_rating.toFixed(0)} &middot; OFF ${Hp.off_rating.toFixed(0)} &middot; DEF ${Hp.def_rating.toFixed(0)}</span>
    </div>`:""}
  </div>

  <h2 class="sec">The turnover battle</h2>
  <p class="sub">Interceptions thrown against interceptions caught, and the same for fumbles. Bold is the better side of each line.</p>
  <table class="vs">
    ${vsHead(m, "Per game, this season")}
    ${statRow("Interceptions thrown", A.ints_thrown_pg, H.ints_thrown_pg, d2, true)}
    ${statRow("Interceptions caught", A.ints_caught_pg, H.ints_caught_pg, d2)}
    ${statRow("Fumbles lost", A.fum_lost_pg, H.fum_lost_pg, d2, true)}
    ${statRow("Fumbles forced", A.fum_forced_pg, H.fum_forced_pg, d2)}
    ${statRow("Takeaways", A.takeaways_pg, H.takeaways_pg, d2)}
    ${statRow("Giveaways", A.giveaways_pg, H.giveaways_pg, d2, true)}
    ${statRow("Net turnover margin", A.turnover_diff_pg, H.turnover_diff_pg, sg)}
  </table>

  <h2 class="sec">Efficiency detail</h2>
  <p class="sub">The inputs behind the ratings above, shown raw so you can check the work.</p>
  <table class="vs">
    ${vsHead(m, "Offense")}
    ${statRow("EPA per dropback", A.epa_per_dropback, H.epa_per_dropback, x=>x==null?"—":(x>0?"+":"")+x.toFixed(3))}
    ${statRow("Completion % over expected", A.cpoe, H.cpoe, x=>x==null?"—":(x>0?"+":"")+x.toFixed(1))}
    ${statRow("Interception rate", A.int_rate, H.int_rate, pc, true)}
    ${statRow("Sack rate taken", A.sack_rate_taken, H.sack_rate_taken, pc, true)}
    ${statRow("Rush EPA per carry", A.rush_epa_per_carry, H.rush_epa_per_carry, x=>x==null?"—":(x>0?"+":"")+x.toFixed(3))}
    ${statRow("Explosive play rate", A.explosive_rate, H.explosive_rate, pc)}
    ${vsHead(m, "Defense")}
    ${statRow("EPA allowed per play", A.def_epa_per_play, H.def_epa_per_play, x=>x==null?"—":(x>0?"+":"")+x.toFixed(3), true)}
    ${statRow("Yards allowed per play", A.def_yards_per_play, H.def_yards_per_play, v, true)}
    ${statRow("Sack rate", A.def_sack_rate, H.def_sack_rate, pc)}
    ${statRow("Interception rate forced", A.def_int_rate, H.def_int_rate, pc)}
  </table>`;
}

const MK={QB_PASS_YARDS:["Passing yards","yds/att","att"],RB_RUSH_YARDS:["Rushing yards","yds/carry","car"],
          WR_REC_YARDS:["Receiving yards","yds/tgt","tgt"]};
const sg=x=>x==null?"\u2014":(x>0?"+":"")+(Math.round(x*10)/10);
const pct=x=>x==null?"\u2014":Math.round(x*100)+"%";
const r1=x=>x==null?"\u2014":Math.round(x*10)/10;
// spread is stated from the HOME side (positive = home favoured). Say it the
// way a person reads it: "BAL by 9.2", "BAL -8.5".
const fav=(m,x)=>x==null?"\u2014":(x===0?"Pick'em":(x>0?m.home:m.away)+" by "+Math.abs(Math.round(x*10)/10));
const lineTxt=(m,x)=>x==null?"\u2014":(x===0?"Pick'em":(x>0?m.home:m.away)+" \u2212"+Math.abs(x));
const verdict=r=>r==="W"?'<span class="vd w">RIGHT</span>':r==="L"?'<span class="vd l">WRONG</span>':r==="P"?'<span class="vd p">PUSH</span>':"";

/*
  LEO'S READ — pre-game analysis. Every number here was frozen before kickoff
  (prediction-history.csv), so this section reads the same before and after the
  game. The point of the page is to be able to look back at what Leo expected
  and why, which only works if what Leo expected cannot be revised.
*/
function leoSection(m){
  const L=m.leo; if(!L) return "";
  const g=L.game;
  const when=L.captured_at?new Date(L.captured_at).toLocaleString("en-US",{timeZone:"America/New_York",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})+" ET":"";
  const game=g?`
  <div class="leo-grid">
    ${g.call==="too_close_to_call"
      ? `<div class="box"><span class="lbl">Leo pick</span><span class="val">Too Close to Call</span><span class="lbl2">leans ${esc(g.pick)} ${pct(g.prob)}, under the 60% bar</span></div>`
      : `<div class="box"><span class="lbl">${g.call==="leo_pick"?"Leo pick":"Leo winner"}</span><span class="val">${esc(g.pick)} ${pct(g.prob)}</span><span class="lbl2">above the 60% bar</span></div>`}
    <div class="box"><span class="lbl">Leo total</span><span class="val">${v(g.proj_total)}</span><span class="lbl2">points, both teams</span></div>
    <div class="box"><span class="lbl">Leo margin</span><span class="val">${esc(fav(m,g.proj_spread))}</span><span class="lbl2">expected winning margin</span></div>
  </div>`:"";
  const byMk={};
  for(const p of (L.props||[])) (byMk[p.market]=byMk[p.market]||[]).push(p);
  const props=Object.keys(MK).filter(k=>byMk[k]).map(k=>{
    const [label,ru,vu]=MK[k];
    return `<h3 class="sec3">${label}</h3>
    <div class="fxw"><table class="fx"><thead><tr><th>Player</th><th>${ru}</th><th>${vu}</th><th>opp adj</th><th>games</th><th>Leo</th></tr></thead><tbody>`+
    byMk[k].sort((a,b)=>b.projection-a.projection).map(p=>`<tr>
      <td><b>${esc(p.player)}</b> <span class="mut">${esc(p.team)} ${esc(p.depth||"")}</span></td>
      <td>${r1(p.rate)}</td><td>${r1(p.volume)}</td><td>${r1(p.adj)}</td><td>${v(p.games_played)}</td>
      <td><b>${v(p.projection)}</b></td></tr>`).join("")+`</tbody></table></div>`;
  }).join("");
  return `
  <h2 class="sec">Leo&rsquo;s read</h2>
  <p class="sub">What the model expected, frozen before kickoff${when?" ("+esc(when)+")":""}. Each player projection is rate &times; volume &times; opponent adjustment &mdash; the columns show every input. None of this is a wager.</p>
  ${game}${props}`;
}

/*
  FINAL REPORT — the only place the game's own result appears. Rendered only
  once nflverse marks the game complete. It sets the frozen expectation beside
  what happened, and splits each player miss into the rate half and the volume
  half so the page says what to learn, not just whether Leo was right.
*/
/*
  FINAL REPORT — the only place the game's own result appears. Rendered only
  once nflverse marks the game complete. Shows what Leo expected, the side
  that implied against the line, and what happened -- in that order, so a
  "CHI by 4.1" projection against "CHI -4.5" reads as the MIN +4.5 side it
  actually was. Inside the model's playable threshold (1 pt spread, 1.5 pts
  total, 5% of the line on props) there is no call, and none is graded.
*/
const noLean='<span class="vd p">NO LEAN</span>';
// A side's own number against a home-stated spread line.
function sideLine(m, side, line){
  if(line==null) return "—";
  if(line===0) return esc(side)+" pick'em";
  const homeFav=line>0, x=Math.abs(line);
  if(side===m.home) return esc(m.home)+(homeFav?" −":" +")+x;
  return esc(m.away)+(homeFav?" +":" −")+x;
}
// One short reason in words: which of Leo's two inputs was further off.
function why(p){
  if(p.projection==null||p.actual==null) return "";
  const miss=Math.abs(p.actual-p.projection);
  if(miss<=Math.max(8,0.1*p.projection)) return '<span class="mut">On target</span>';
  if(p.rate_effect==null||p.volume_effect==null) return "";
  const [, ru, vu] = MK[p.market] || [];
  const unit={att:"attempts",car:"carries",tgt:"targets"}[vu]||vu;
  if(Math.abs(p.volume_effect)>=Math.abs(p.rate_effect)){
    return (p.actual_volume<p.volume?"Fewer ":"More ")+unit+` (${r1(p.actual_volume)} vs ${r1(p.volume)} expected)`;
  }
  return (p.actual_rate<p.rate?"Less ":"More ")+`efficient (${r1(p.actual_rate)} vs ${r1(p.rate)} ${ru})`;
}
/*
  TOUCHDOWN PROPS, not season leaders. Leo's chance that each player scores in
  THIS game, from the frozen pre-kickoff capture, top three a side. Once the
  game is final each line says whether he actually scored, so the page grades
  itself in public. Falls back to season scorers on older pages that have no
  prop capture.
*/
function tdCard(m, team, rows){
  const F=m.final_report, scored=F&&F.td_scored||null;
  return `<div class="tdcard"><div class="td-head"><img src="/img/nfl/${encodeURIComponent(team)}.png" alt=""><b>${esc(team)}</b>
      <span class="sc-season">Leo&rsquo;s chance</span></div>
    <ol class="tdlist tdprops">${rows.map(x=>{
      const n = scored ? (scored[x.player]||0) : null;
      const tag = n==null ? "" : (n>0
        ? `<span class="td-hit">scored${n>1?` ${n}`:""}</span>`
        : `<span class="td-miss">no TD</span>`);
      return `<li><span class="tdn">${esc(x.player)}</span>
        <span class="tdp">${esc(x.depth||"")}</span>
        <span class="tdc">${Math.round(x.prob*100)}%</span>
        <span class="tdd">${tag}</span></li>`;
    }).join("")}</ol></div>`;
}

function tdSection(m){
  const T=m.td_props;
  if(!T) return `
  <h2 class="sec">Touchdown leaders</h2>
  <p class="sub">Top three scrimmage touchdown scorers on each side this season, rushing and receiving.</p>
  <div class="tdgrid">${scorers(m.sides.away,m.date.slice(0,4))}${scorers(m.sides.home,m.date.slice(0,4))}</div>`;
  const a=T[m.away]||[], h=T[m.home]||[];
  if(!a.length && !h.length) return "";
  return `
  <h2 class="sec">Touchdown props</h2>
  <p class="sub">Leo&rsquo;s chance that each player scores a touchdown in this game &mdash; the three most likely on each side, from his last read before kickoff.</p>
  <div class="tdgrid">${tdCard(m,m.away,a)}${tdCard(m,m.home,h)}</div>`;
}

/* The morning-after box score: what the quarterbacks, backs and receivers did. */
function boxTable(side){
  if(!side) return "";
  const q=side.qb, rb=side.rb||[], wr=side.wr||[];
  const rows=[];
  if(q) rows.push(`<tr><td class="bxp"><b>${esc(q.name)}</b> <span class="mut">QB</span></td>
    <td>${q.cmp}/${q.att}</td><td><b>${q.pass_yds}</b> yds</td><td>${q.pass_td} TD</td><td>${q.ints} INT</td></tr>`);
  rb.forEach(x=>rows.push(`<tr><td class="bxp"><b>${esc(x.name)}</b> <span class="mut">${esc(x.pos)}</span></td>
    <td>${x.car} car</td><td><b>${x.rush_yds}</b> yds</td><td>${x.rush_td} TD</td><td>${x.rec?`${x.rec} rec, ${x.rec_yds} yds`:""}</td></tr>`));
  wr.forEach(x=>rows.push(`<tr><td class="bxp"><b>${esc(x.name)}</b> <span class="mut">${esc(x.pos)}</span></td>
    <td>${x.rec}/${x.tgt}</td><td><b>${x.rec_yds}</b> yds</td><td>${x.rec_td} TD</td><td></td></tr>`));
  if(!rows.length) return "";
  return `<div class="bxcard"><div class="td-head"><img src="/img/nfl/${encodeURIComponent(side.team)}.png" alt=""><b>${esc(side.team)}</b></div>
    <table class="bx"><tbody>${rows.join("")}</tbody></table></div>`;
}

function boxScore(F){
  if(!F||!F.box) return "";
  const a=boxTable(F.box.away), h=boxTable(F.box.home);
  if(!a && !h) return "";
  return `<h3 class="sec3">How the game was played</h3>
  <p class="sub">Quarterback, the backs who carried it and the receivers who caught it.</p>
  <div class="bxgrid">${a}${h}</div>`;
}

function finalReport(m){
  const F=m.final_report; if(!F) return "";
  const ml=F.moneyline, tp=F.total_pick, sp=F.spread;
  const off=(leo,act)=>leo==null||act==null?"":`<span class="mut">off by ${r1(Math.abs(act-leo))}</span>`;
  const row=(label,leo,actual,verd)=>`<tr><td>${label}</td><td>${leo}</td><td><b>${actual}</b></td><td>${verd}</td></tr>`;
  const rows=[
    ml?row("Winner", esc(ml.side)+" "+pct(ml.leo), esc(ml.actual)+" won",
           ml.result===""?'<span class="vd p">NO PICK &middot; too close to call</span>':verdict(ml.result)):"",
    tp?row("Total points", v(tp.leo), v(tp.actual), off(tp.leo,tp.actual)):"",
    sp?row("Margin", esc(fav(m,sp.leo)), esc(fav(m,Number(sp.actual))), off(sp.leo,Number(sp.actual))):""
  ].join("");
  const games=`<div class="fxw"><table class="fx"><thead><tr><th>Market</th><th>Leo expected</th><th>Actual</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;

  const byMk={};
  for(const p of (F.props||[])) (byMk[p.market]=byMk[p.market]||[]).push(p);
  const props=Object.keys(MK).filter(k=>byMk[k]).map(k=>{
    const [label]=MK[k];
    return `<h3 class="sec3">${label}</h3>
    <div class="fxw"><table class="fx"><thead><tr><th>Player</th><th>Leo</th><th>Actual</th><th>Off by</th><th>Main reason</th></tr></thead><tbody>`+
    byMk[k].sort((a,b)=>Math.abs(b.actual-b.projection)-Math.abs(a.actual-a.projection)).map(p=>`<tr>
      <td><b>${esc(p.player)}</b> <span class="mut">${esc(p.team)}</span></td>
      <td>${v(p.projection)}</td><td><b>${v(p.actual)}</b></td>
      <td>${p.projection==null||p.actual==null?"":r1(Math.abs(p.actual-p.projection))}</td>
      <td class="why">${why(p)}</td></tr>`).join("")+`</tbody></table></div>`;
  }).join("");

  return `
  <section class="final">
    <h2 class="sec">Final result</h2>
    <p class="final-score"><img src="/img/nfl/${encodeURIComponent(m.away)}.png" alt=""> ${esc(m.away)} <b>${F.away_score}</b>
      &ndash; <b>${F.home_score}</b> ${esc(m.home)} <img src="/img/nfl/${encodeURIComponent(m.home)}.png" alt="">${F.overtime?' <span class="mut">(OT)</span>':""}</p>
    ${boxScore(F)}
    <h3 class="sec3">How Leo&rsquo;s read held up</h3>
    <p class="sub">What Leo expected before kickoff and what actually happened. A winner call is only made when one side is above 60%.</p>
    ${F.graded?games:'<p class="sub">Grading runs the morning after the game; the comparison appears once it has.</p>'}
    ${props?`<p class="sub" style="margin-top:14px">&ldquo;Main reason&rdquo; names which of Leo&rsquo;s two inputs was further off &mdash; how much the player was used, or how efficient he was when he was.</p>`+props:""}
  </section>`;
}

function page(m){
  const A=m.sides.away, H=m.sides.home;
  const cur=(m.ratings&&m.ratings.this_season)||null;
  const pri=(m.ratings&&m.ratings.last_season)||null;
  const title=`${m.away} vs ${m.home} — Stats, Odds and Matchup | Leo`;
  const spread = m.spread_line==null?"—":(m.spread_line>0?`${m.home} -${m.spread_line}`:(m.spread_line<0?`${m.away} -${Math.abs(m.spread_line)}`:"PK"));
  const cmp=(label,a,h,fmt=x=>v(x))=>{
    const lead = (a==null||h==null||a===h) ? "" : (Number(a)>Number(h) ? "a" : "h");
    return `<tr><td class="${lead==="a"?"lead":""}">${fmt(a)}</td><th>${esc(label)}</th><td class="${lead==="h"?"lead":""}">${fmt(h)}</td></tr>`;
  };

  const ao=A.team_offense, ho=H.team_offense, ad=A.team_defense, hd=H.team_defense;
  return `<!DOCTYPE html>
<html lang="en">
<head>
${require("./lib/ga").GA_HEAD}
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(m.away)} at ${esc(m.home)} on ${esc(m.date)}: starting quarterbacks, running backs, top receivers and touchdown props for this game and last, with the closing market numbers.">
<link rel="canonical" href="https://ndhorizon.com${m.url}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Leo">
<meta property="og:title" content="${esc(title)}">
<meta property="og:url" content="https://ndhorizon.com${m.url}">
<meta property="og:image" content="https://ndhorizon.com/img/og-card.png">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>&#127944;</text></svg>">
<link rel="stylesheet" href="/css/style.css">
<link rel="stylesheet" href="/css/scoreboard.css">
<style>
.mh{display:flex;align-items:center;justify-content:center;gap:24px;flex-wrap:wrap;margin:6px 0 4px}
.mh .t{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:110px}
.mh .t img{width:66px;height:66px;object-fit:contain}
.mh .t b{font-size:1.02rem}
.mh .at{color:var(--text-dim);font-weight:700;font-size:.82rem;text-transform:uppercase;letter-spacing:.1em}
.mkt{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}
.mkt .box{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:13px 15px;box-shadow:var(--shadow-sm)}
.mkt .lbl{display:block;color:var(--text-dim);font-size:.66rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
.mkt .val{font-size:1.28rem;font-weight:800;display:block}
.mkt .sub{color:var(--text-dim);font-size:.75rem}
h2.sec{font-size:1.32rem;margin:34px 0 4px}
p.sub{color:var(--text-dim);font-size:.88rem;margin:0 0 14px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.statcard{background:var(--bg-card);border:1px solid var(--border);border-radius:16px;overflow:hidden;box-shadow:var(--shadow-sm)}
.sc-head{display:flex;align-items:center;gap:10px;padding:11px 15px;background:var(--bg-elev);border-bottom:1px solid var(--border)}
.sc-head img{width:30px;height:30px;object-fit:contain}
.sc-season{margin-left:auto;font-size:.66rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim);background:var(--bg-card);border:1px solid var(--border);padding:3px 9px;border-radius:999px}
.sc-body{padding:12px 15px}
.sc-body h4{margin:12px 0 6px;font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--text-dim);font-family:"Onest",sans-serif}
.sc-body h4:first-child{margin-top:0}
.tw{overflow-x:auto}
.sc-body table{width:100%;border-collapse:collapse;font-size:.83rem}
.sc-body th,.sc-body td{padding:6px 7px;text-align:right;white-space:nowrap}
.sc-body thead th{color:var(--text-dim);font-size:.6rem;font-weight:800;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--border)}
.sc-body td.pl,.sc-body thead th:first-child{text-align:left}
.sc-body tbody tr+tr td{border-top:1px solid var(--border)}
.rl{font-size:.6rem;font-weight:800;color:var(--text-dim);background:var(--bg-elev);padding:1px 6px;border-radius:999px;margin-left:4px}
.none{color:var(--text-dim);font-style:italic;text-align:center!important}
.vs{width:100%;border-collapse:collapse;background:var(--bg-card);border:1px solid var(--border);border-radius:16px;overflow:hidden;box-shadow:var(--shadow-sm)}
.vs td,.vs th{padding:9px 14px;font-size:.9rem}
.vs td{text-align:center;font-weight:700;width:34%}
.vs th{text-align:center;color:var(--text-dim);font-size:.66rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;background:var(--bg-elev)}
.vs tr+tr td,.vs tr+tr th{border-top:1px solid var(--border)}
.tdgrid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.tdcard{background:var(--bg-card);border:1px solid var(--border);border-radius:16px;overflow:hidden;box-shadow:var(--shadow-sm)}
.td-head{display:flex;align-items:center;gap:10px;padding:11px 15px;background:var(--bg-elev);border-bottom:1px solid var(--border)}
.td-head img{width:28px;height:28px;object-fit:contain}
.tdlist{list-style:none;margin:0;padding:6px 0}
.tdlist li{display:grid;grid-template-columns:1fr auto auto;grid-template-areas:"n p c" "d d c";gap:2px 10px;padding:10px 15px;align-items:center}
.tdlist li+li{border-top:1px solid var(--border)}
.tdn{grid-area:n;font-weight:700}
.tdp{grid-area:p;font-size:.64rem;font-weight:800;color:var(--text-dim);background:var(--bg-elev);padding:2px 7px;border-radius:999px}
.tdc{grid-area:c;font-size:1.5rem;font-weight:800;color:var(--accent2)}
.tdd{grid-area:d;color:var(--text-dim);font-size:.74rem}
.note{margin-top:8px}
.rcard{background:var(--bg-card);border:1px solid var(--border);border-radius:16px;overflow:hidden;box-shadow:var(--shadow-sm)}
.rhead{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 16px;background:var(--bg-elev);border-bottom:1px solid var(--border)}
.rt{display:flex;align-items:center;gap:9px;font-size:.98rem}
.rt img{width:30px;height:30px;object-fit:contain}
.rmid{font-size:.64rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim)}
.rbody{padding:6px 16px 14px}
.rrow{display:grid;grid-template-columns:48px 1fr 48px;grid-template-areas:"a l h" "b b b";gap:2px 10px;align-items:center;padding:11px 0}
.rrow+.rrow{border-top:1px solid var(--border)}
.rv{font-size:1.32rem;font-weight:800;color:var(--text-dim)}
.rv.rva{grid-area:a;text-align:left}
.rv.rvh{grid-area:h;text-align:right}
.rv.lead{color:var(--accent2)}
.rlab{grid-area:l;text-align:center;font-weight:700;font-size:.85rem;line-height:1.3}
.rlab em{display:block;font-style:normal;font-weight:500;font-size:.68rem;color:var(--text-dim)}
.rbar{grid-area:b;display:flex;height:6px;border-radius:999px;overflow:hidden;background:var(--bg-elev);margin-top:5px}
.rbar i{display:block;height:100%}
.rbar .ra{background:var(--accent2);margin-right:auto}
.rbar .rh{background:var(--accent)}
.bxgrid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:10px 0 6px}
@media(max-width:760px){.bxgrid{grid-template-columns:1fr}}
.bxcard{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;overflow:hidden}
table.bx{width:100%;border-collapse:collapse;font-size:.85rem}
table.bx td{padding:7px 10px;border-bottom:1px solid var(--border);text-align:center;white-space:nowrap;font-variant-numeric:tabular-nums}
table.bx td.bxp{text-align:left;white-space:normal}
table.bx tr:last-child td{border-bottom:0}
.tdprops .tdc{color:var(--accent2);font-weight:800}
.td-hit{color:var(--good);font-weight:800}
.td-miss{color:var(--text-dim)}
.rprior{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px;padding:9px 16px;border-top:1px solid var(--border);background:var(--bg-elev);font-size:.76rem;color:var(--text-dim)}
.rprior .rpv{text-align:left}
.rprior .rpv.rr{text-align:right}
.rprior .rpl{text-align:center}
@media(max-width:560px){.rprior{grid-template-columns:1fr;gap:3px;text-align:center}
  .rprior .rpv,.rprior .rpv.rr,.rprior .rpl{text-align:center}.rprior .rpl{order:-1}}
.rpl{font-weight:800;text-transform:uppercase;letter-spacing:.07em;font-size:.62rem}
.rr{justify-content:flex-end;text-align:right}
.vs td.lead{color:var(--accent2);font-weight:800}
/* Column heads repeat at every band and carry the logo, so a number is never
   ambiguous about which team it belongs to. */
.vs tr.vshead th{position:sticky;top:0;z-index:2;background:var(--bg-elev)}
.vst{display:inline-flex;align-items:center;gap:7px;font-size:.78rem;font-weight:800;color:var(--text);letter-spacing:.02em;text-transform:none}
.vst img{width:22px;height:22px;object-fit:contain}
.vst.vsr{flex-direction:row}
.vs .vsband{color:var(--text-dim)}
/* Player tables: centre everything except the name column. */
.sc-body table{text-align:center}
.sc-body th,.sc-body td{text-align:center}
.sc-body td.pl,.sc-body thead th:first-child{text-align:left}
.sc-body h4{display:flex;align-items:center;gap:10px}
.qbr{margin-left:auto;display:inline-flex;align-items:center;gap:6px;background:var(--bg-elev);border:1px solid var(--border);border-radius:999px;padding:3px 10px}
.qbr em{font-style:normal;font-size:.58rem;font-weight:800;letter-spacing:.07em;color:var(--text-dim)}
.qbr b{font-size:.92rem;font-weight:800;color:var(--accent2);letter-spacing:0}
@media(max-width:820px){.grid2,.tdgrid{grid-template-columns:1fr}}
/* pre-game read + final report */
.leo-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:6px 0 12px}
.leo-grid .box{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:11px 13px;display:flex;flex-direction:column;gap:2px}
.leo-grid .lbl{font-size:.64rem;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:var(--text-dim)}
.leo-grid .val{font-size:1.15rem;font-weight:800;font-variant-numeric:tabular-nums}
.leo-grid .lbl2{font-size:.74rem;color:var(--text-dim)}
.sec3{font-size:.9rem;margin:16px 0 6px}
.fxw{overflow-x:auto;-webkit-overflow-scrolling:touch;margin-bottom:4px}
.fx{width:100%;border-collapse:collapse;font-size:.84rem;font-variant-numeric:tabular-nums;background:transparent}
.fx th{font-size:.62rem;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--text-dim);text-align:right;padding:6px 8px;border-bottom:1.5px solid var(--border);white-space:nowrap}
.fx td{text-align:right;padding:7px 8px;border-bottom:1px solid var(--border);white-space:nowrap}
.fx th:first-child,.fx td:first-child{text-align:left;padding-left:0}
.fx .mut,.mut{color:var(--text-dim);font-weight:500;font-size:.78em;text-transform:none;letter-spacing:0}
.fx td.why{text-align:left;white-space:normal;min-width:190px;color:var(--text-dim)}
.fx .fxsplit{white-space:nowrap}.fx .fxr{color:#4A6478;font-weight:700;font-size:inherit}.fx .fxv{color:#8A6D3B;font-weight:700;font-size:inherit}
.vd{font-size:.62rem;font-weight:800;letter-spacing:.06em;padding:3px 9px;border-radius:999px}
.vd.w{background:rgba(47,110,74,.13);color:var(--good)}.vd.l{background:rgba(166,58,46,.13);color:var(--danger)}.vd.p{background:var(--bg-elev);color:var(--text-dim)}
.final{margin-top:34px;padding-top:6px;border-top:3px double var(--border)}
.final-score{display:flex;align-items:center;gap:8px;font-size:1.25rem;font-weight:700;flex-wrap:wrap;margin:4px 0 8px}
.final-score img{width:34px;height:34px;object-fit:contain}
</style>
</head>
<body>
<nav id="nav"></nav>
<main class="scoreboard-shell">
  <section class="score-hero">
    <p class="eyebrow">Week ${v(m.week)} &middot; ${esc(m.weekday||"")} ${esc(m.kickoff||"")}</p>
    <div class="mh">
      <span class="t"><img src="/img/nfl/${encodeURIComponent(m.away)}.png" alt="${esc(m.away)}"><b>${esc(m.away)}</b></span>
      <span class="at">at</span>
      <span class="t"><img src="/img/nfl/${encodeURIComponent(m.home)}.png" alt="${esc(m.home)}"><b>${esc(m.home)}</b></span>
    </div>
    <p class="subtitle">${esc(m.stadium||"Venue TBD")}${m.roof&&m.roof!=="NA"?" &middot; "+esc(m.roof):""}${m.surface?" &middot; "+esc(m.surface):""}${m.div_game?" &middot; Division game":""}</p>
  </section>

  <section class="mkt">
    <div class="box"><span class="lbl">${esc(m.away)} moneyline</span><span class="val">${fmtAm(m.away_moneyline)}</span></div>
    <div class="box"><span class="lbl">${esc(m.home)} moneyline</span><span class="val">${fmtAm(m.home_moneyline)}</span></div>
    <div class="box"><span class="lbl">Spread</span><span class="val">${esc(spread)}</span></div>
    <div class="box"><span class="lbl">Total</span><span class="val">${v(m.total_line)}</span></div>
  </section>
  <div class="notice note">This is a pre-game analysis page. Every stat above the Final result comes from games played <b>before</b> this one${m.pregame_through_week?" (through Week "+m.pregame_through_week+")":""}, and Leo&rsquo;s numbers were frozen before kickoff. Market numbers are the closing line. Nothing here is a wager &mdash; the pick gate stays closed until Leo shows it can beat that line.</div>

  ${leoSection(m)}

  ${ratingsSection(m)}

  <h2 class="sec">Team comparison</h2>
  <p class="sub">Season totals on both sides of the ball. Left column is ${esc(m.away)}, right is ${esc(m.home)}.</p>
  <table class="vs">
    ${vsHead(m, "This season")}
    ${cmp("Games", ao.this_season.games, ho.this_season.games)}
    ${cmp("Pass yards/g", ao.this_season.pass_ypg, ho.this_season.pass_ypg)}
    ${cmp("Rush yards/g", ao.this_season.rush_ypg, ho.this_season.rush_ypg)}
    ${cmp("Passing TD", ao.this_season.pass_td, ho.this_season.pass_td)}
    ${cmp("Interceptions thrown", ao.this_season.ints, ho.this_season.ints)}
    ${cmp("Pass yards allowed/g", ad.this_season.pass_ypg, hd.this_season.pass_ypg)}
    ${cmp("Rush yards allowed/g", ad.this_season.rush_ypg, hd.this_season.rush_ypg)}
    ${cmp("Interceptions forced", ad.this_season.ints_forced, hd.this_season.ints_forced)}
    ${vsHead(m, "Last season")}
    ${cmp("Pass yards/g", ao.last_season.pass_ypg, ho.last_season.pass_ypg)}
    ${cmp("Rush yards/g", ao.last_season.rush_ypg, ho.last_season.rush_ypg)}
    ${cmp("Passing TD", ao.last_season.pass_td, ho.last_season.pass_td)}
    ${cmp("Interceptions thrown", ao.last_season.ints, ho.last_season.ints)}
    ${cmp("Pass yards allowed/g", ad.last_season.pass_ypg, hd.last_season.pass_ypg)}
    ${cmp("Rush yards allowed/g", ad.last_season.rush_ypg, hd.last_season.rush_ypg)}
  </table>

  <h2 class="sec">This season</h2>
  <p class="sub">Starting quarterback, lead backs and top receivers, by actual usage this season &mdash; games before this one only.</p>
  <div class="grid2">${sideBlock(A,"this_season",m.date.slice(0,4),cur&&cur.away)}${sideBlock(H,"this_season",m.date.slice(0,4),cur&&cur.home)}</div>

  <h2 class="sec">Last season</h2>
  <p class="sub">The same players' full prior season, for a baseline the early-season sample cannot give you.</p>
  <div class="grid2">${sideBlock(A,"last_season",String(Number(m.date.slice(0,4))-1),pri&&pri.away)}${sideBlock(H,"last_season",String(Number(m.date.slice(0,4))-1),pri&&pri.home)}</div>

  ${tdSection(m)}

  ${finalReport(m)}

  <p class="data-note">Player and team statistics from the open nflverse dataset. Roles assigned by actual usage &mdash; most attempts, carries and targets &mdash; not depth chart.</p>
</main>
<footer id="footer"></footer><script src="/js/app.js"></script>
<script>renderNav("/nfl/scoreboard/"); renderFooter();</script>
</body>
</html>`;
}

(function main(){
  const target=process.argv[2]||new Date(Date.now()+864e5).toISOString().slice(0,10);
  const src=path.join(ROOT,"data/nfl/matchups",`${target}.json`);
  if(!fs.existsSync(src)){ console.log(`No matchup data for ${target}. Run generate-nfl-matchups.js first.`); return; }
  const data=JSON.parse(fs.readFileSync(src,"utf8"));
  let wrote=0;
  for(const m of data){
    const dir=path.join(ROOT,"nfl",m.slug);
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,"index.html"), page(m));
    wrote++;
  }
  console.log(`rendered ${wrote} matchup pages for ${target}`);
  console.log(`sitemap.xml: ${require("./lib/sitemap").writeSitemap(ROOT)} pages`);
  data.slice(0,3).forEach(m=>console.log(`  ${m.url}`));
})();
