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

function sideBlock(side, seasonKey, seasonLabel){
  const p=side[seasonKey];
  return `
  <div class="statcard">
    <div class="sc-head"><img src="/img/nfl/${encodeURIComponent(side.team)}.png" alt=""><b>${esc(side.team)}</b>
      <span class="sc-season">${esc(seasonLabel)}</span></div>
    <div class="sc-body">
      <h4>Quarterback</h4>
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

function page(m){
  const A=m.sides.away, H=m.sides.home;
  const title=`${m.away} vs ${m.home} — Stats, Odds and Matchup | Leo`;
  const spread = m.spread_line==null?"—":(m.spread_line>0?`${m.home} -${m.spread_line}`:(m.spread_line<0?`${m.away} -${Math.abs(m.spread_line)}`:"PK"));
  const cmp=(label,a,h,fmt=x=>v(x))=>`<tr><td>${fmt(a)}</td><th>${esc(label)}</th><td>${fmt(h)}</td></tr>`;
  const ao=A.team_offense, ho=H.team_offense, ad=A.team_defense, hd=H.team_defense;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(m.away)} at ${esc(m.home)} on ${esc(m.date)}: starting quarterbacks, running backs, top receivers and touchdown leaders for this season and last, with the closing market numbers.">
<link rel="canonical" href="https://lydiaslab.com${m.url}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Leo">
<meta property="og:title" content="${esc(title)}">
<meta property="og:url" content="https://lydiaslab.com${m.url}">
<meta property="og:image" content="https://lydiaslab.com/img/og-card.png">
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
.mkt .val{font-size:1.15rem;font-weight:800}
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
@media(max-width:820px){.grid2,.tdgrid{grid-template-columns:1fr}}
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
    <div class="box"><span class="lbl">${esc(m.away)} moneyline</span><span class="val">${fmtAm(m.away_moneyline)}</span><span class="sub">closing price</span></div>
    <div class="box"><span class="lbl">${esc(m.home)} moneyline</span><span class="val">${fmtAm(m.home_moneyline)}</span><span class="sub">closing price</span></div>
    <div class="box"><span class="lbl">Spread</span><span class="val">${esc(spread)}</span><span class="sub">closing line</span></div>
    <div class="box"><span class="lbl">Total</span><span class="val">${v(m.total_line)}</span><span class="sub">closing total</span></div>
  </section>
  <div class="notice note">Market numbers are the closing line, shown for context. Leo does not publish a pick on this game &mdash; testing against the 2025 season showed the model does not beat the closing price, so these pages report stats rather than projections.</div>

  <h2 class="sec">Team comparison</h2>
  <p class="sub">Season totals on both sides of the ball. Left column is ${esc(m.away)}, right is ${esc(m.home)}.</p>
  <table class="vs">
    <tr><th>${esc(m.away)}</th><th>This season</th><th>${esc(m.home)}</th></tr>
    ${cmp("Games", ao.this_season.games, ho.this_season.games)}
    ${cmp("Pass yards/g", ao.this_season.pass_ypg, ho.this_season.pass_ypg)}
    ${cmp("Rush yards/g", ao.this_season.rush_ypg, ho.this_season.rush_ypg)}
    ${cmp("Passing TD", ao.this_season.pass_td, ho.this_season.pass_td)}
    ${cmp("Interceptions thrown", ao.this_season.ints, ho.this_season.ints)}
    ${cmp("Pass yards allowed/g", ad.this_season.pass_ypg, hd.this_season.pass_ypg)}
    ${cmp("Rush yards allowed/g", ad.this_season.rush_ypg, hd.this_season.rush_ypg)}
    ${cmp("Interceptions forced", ad.this_season.ints_forced, hd.this_season.ints_forced)}
    <tr><th>${esc(m.away)}</th><th>Last season</th><th>${esc(m.home)}</th></tr>
    ${cmp("Pass yards/g", ao.last_season.pass_ypg, ho.last_season.pass_ypg)}
    ${cmp("Rush yards/g", ao.last_season.rush_ypg, ho.last_season.rush_ypg)}
    ${cmp("Passing TD", ao.last_season.pass_td, ho.last_season.pass_td)}
    ${cmp("Interceptions thrown", ao.last_season.ints, ho.last_season.ints)}
    ${cmp("Pass yards allowed/g", ad.last_season.pass_ypg, hd.last_season.pass_ypg)}
    ${cmp("Rush yards allowed/g", ad.last_season.rush_ypg, hd.last_season.rush_ypg)}
  </table>

  <h2 class="sec">This season</h2>
  <p class="sub">Starting quarterback, lead backs and top receivers, by actual usage this season.</p>
  <div class="grid2">${sideBlock(A,"this_season",m.date.slice(0,4))}${sideBlock(H,"this_season",m.date.slice(0,4))}</div>

  <h2 class="sec">Last season</h2>
  <p class="sub">The same players' full prior season, for a baseline the early-season sample cannot give you.</p>
  <div class="grid2">${sideBlock(A,"last_season",String(Number(m.date.slice(0,4))-1))}${sideBlock(H,"last_season",String(Number(m.date.slice(0,4))-1))}</div>

  <h2 class="sec">Touchdown leaders</h2>
  <p class="sub">Top three scrimmage touchdown scorers on each side this season, rushing and receiving.</p>
  <div class="tdgrid">${scorers(A,m.date.slice(0,4))}${scorers(H,m.date.slice(0,4))}</div>

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
  data.slice(0,3).forEach(m=>console.log(`  ${m.url}`));
})();
