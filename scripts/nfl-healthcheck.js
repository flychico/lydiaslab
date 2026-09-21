#!/usr/bin/env node
/**
 * NFL health check — the smell tests for bugs that have ACTUALLY bitten us.
 *
 * Every check here corresponds to a real defect that shipped or nearly shipped
 * during the NFL build. They are cheap, they are mechanical, and they catch the
 * class of bug that looks like working output: plausible-shaped numbers that
 * are silently wrong.
 *
 * Exit 0 = clean, 1 = at least one FAIL. WARNs never fail the run.
 * See claude/NFL_WATCH_LIST.md for the story behind each one.
 */
const fs=require("fs"), path=require("path");
const ROOT=path.join(__dirname,"..");
const P=p=>path.join(ROOT,p);
const read=p=>{try{return JSON.parse(fs.readFileSync(P(p),"utf8"));}catch(e){return null;}};

let fails=0, warns=0, passes=0;
const ok  =(id,m)=>{passes++;console.log(`  PASS  [${id}] ${m}`);};
const warn=(id,m)=>{warns++; console.log(`  WARN  [${id}] ${m}`);};
const fail=(id,m)=>{fails++; console.log(`  FAIL  [${id}] ${m}`);};

console.log("\nNFL HEALTH CHECK\n" + "=".repeat(58));

// ---- 1. team rates computed per-GAME, not per player-week row -------------
// Bug: agg() sets games = rows.length. Correct for one player, catastrophic
// for a team. Showed "GAMES 40" and "PASS YARDS/G 9" on a 2-game season.
const mu = read("data/nfl/matchups/today.json");
if (!mu) warn("TEAM-RATE","no matchup data to check");
else {
  const bad=[];
  for (const m of mu) for (const s of ["away","home"]) {
    const o=m.sides[s].team_offense;
    for (const [k,tot] of Object.entries(o)) {
      if (tot.games > 25) bad.push(`${m.sides[s].team} ${k} games=${tot.games}`);
      if (tot.games >= 3 && (tot.pass_ypg < 80 || tot.pass_ypg > 400))
        bad.push(`${m.sides[s].team} ${k} pass_ypg=${tot.pass_ypg}`);
    }
  }
  bad.length ? fail("TEAM-RATE",`implausible team rates: ${bad.slice(0,3).join("; ")}`)
             : ok("TEAM-RATE","team per-game rates in plausible range");
}

// ---- 2. defensive stats keyed to the right team ---------------------------
// Bug: all def_* keyed by opponent_team, so every team's "INTs caught" was
// really its own INTs thrown. Symptom: the two columns matched league-wide.
const ts = read("data/nfl/team-stats-today.json");
if (!ts) warn("DEF-KEY","no team stats to check");
else {
  const withBoth = ts.filter(t=>t.ints_thrown_pg!=null && t.ints_caught_pg!=null);
  if (!withBoth.length) warn("DEF-KEY","turnover fields absent");
  else {
    const same = withBoth.filter(t=>Math.abs(t.ints_thrown_pg-t.ints_caught_pg)<1e-9).length;
    const r = same/withBoth.length;
    r > 0.5 ? fail("DEF-KEY",`${same}/${withBoth.length} teams have ints_thrown == ints_caught — def_* keying is inverted`)
            : ok("DEF-KEY",`${same}/${withBoth.length} teams coincidentally equal (expected: a few)`);
  }
}

// ---- 3. published rolling files are never blanked -------------------------
// Bug: generators wrote *-today.json unconditionally, so a Tuesday gather
// (no NFL games) overwrote the live card with [].
for (const f of ["picks","team-stats","props","results"]) {
  const d = read(`data/nfl/${f}-today.json`);
  if (d==null) warn("NOT-EMPTY",`${f}-today.json missing`);
  else if (!Array.isArray(d) || d.length===0) fail("NOT-EMPTY",`${f}-today.json is empty — a no-games day blanked it`);
  else ok("NOT-EMPTY",`${f}-today.json has ${d.length} records`);
}

// ---- 4. every referenced team has a logo ----------------------------------
const picks = read("data/nfl/picks-today.json");
if (picks) {
  const teams=[...new Set(picks.flatMap(g=>[g.away,g.home]))];
  const missing=teams.filter(t=>!fs.existsSync(P(`img/nfl/${t}.png`)));
  missing.length ? fail("LOGO-EXISTS",`missing logos: ${missing.join(" ")}`)
                 : ok("LOGO-EXISTS",`all ${teams.length} referenced teams have logos`);
}

// ---- 5. logos actually FILL their box -------------------------------------
// Bug: Image.thumbnail() never upscales, so cropped logos sat at 14-27% fill.
const logoDir=P("img/nfl");
if (fs.existsSync(logoDir)) {
  const files=fs.readdirSync(logoDir).filter(f=>f.endsWith(".png"));
  const small=[];
  for (const f of files) {
    const b=fs.readFileSync(path.join(logoDir,f));
    if (b.length<24 || b.readUInt32BE(12)!==0x49484452) continue;   // not IHDR
    const w=b.readUInt32BE(16), h=b.readUInt32BE(20);
    if (w<96 || h<96) small.push(`${f} ${w}x${h}`);
  }
  small.length ? warn("LOGO-SIZE",`under-sized logos: ${small.slice(0,4).join(", ")}`)
               : ok("LOGO-SIZE",`${files.length} logos at adequate resolution`);
}

// ---- 6. matchup pages exist for every game on the card --------------------
if (picks && mu) {
  const slug=t=>String(t).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
  const miss=mu.filter(m=>!fs.existsSync(P(`nfl/${slug(m.away)}-vs-${slug(m.home)}-prediction-odds-${m.date}/index.html`)));
  miss.length ? fail("MATCHUP-PAGE",`${miss.length} games have no matchup page`)
              : ok("MATCHUP-PAGE",`all ${mu.length} matchup pages rendered`);
}

// ---- 7. nav links resolve, both sports ------------------------------------
{
  const pre=s=>s==="MLB"?"/":"/"+s.toLowerCase()+"/";
  const links=s=>{const p=pre(s);return [p+"scoreboard/",p+"previews/",p+"tools/",p+"stats/",
    p+"results/",p+"recaps/",p+"member-brief/",
    s==="MLB"?"/tools/strikeout-projections/":p+"tools/player-props/"];};
  const bad=[];
  for (const s of ["MLB","NFL"]) for (const h of links(s))
    if (!fs.existsSync(P("."+h+"index.html"))) bad.push(h);
  bad.length ? fail("NAV",`broken nav links: ${bad.join(" ")}`)
             : ok("NAV","all nav links resolve for both sports");
}

// ---- 8. prop projections stay inside sane bounds --------------------------
// Bug: tiny samples produced a -5 yard receiver and an 89.6% anytime TD.
const props = read("data/nfl/props-today.json");
if (props) {
  const neg=props.filter(p=>p.market.endsWith("YARDS") && p.projection<0);
  const hotTD=props.filter(p=>p.market==="ANYTIME_TD" && p.projection>0.75);
  const adj=props.map(p=>p.opp_adjustment).filter(x=>x!=null);
  const pegged=adj.filter(a=>a<=0.85||a>=1.15).length;
  neg.length   ? fail("PROP-RANGE",`${neg.length} negative yardage projections`)
               : ok("PROP-RANGE","no negative yardage projections");
  hotTD.length ? fail("PROP-RANGE",`${hotTD.length} anytime-TD above 75%`)
               : ok("PROP-RANGE","anytime-TD within ceiling");
  adj.length && pegged/adj.length > 0.25
    ? fail("OPP-ADJ",`${Math.round(100*pegged/adj.length)}% of opponent adjustments pinned to the clamp rails — shrinkage is not working`)
    : ok("OPP-ADJ",`${adj.length?Math.round(100*pegged/adj.length):0}% of opponent adjustments at the rails`);
}

// ---- 9. a large disagreement must never become a wager --------------------
// Leo's number is deliberately unblended, so large gaps vs the market are
// EXPECTED, not bugs -- the model is allowed to disagree loudly. What is
// never allowed is turning one into a pick: the backtest shows this model's
// most confident disagreements are its worst bets (-38.7% ROI at a 20%
// threshold across 599 bets). So the check is on PICKS, not on edges.
if (picks) {
  const bigPicks = picks.filter(g=>g.status==="official_pick" && g.edge!=null && Math.abs(g.edge)>0.15);
  bigPicks.length
    ? fail("EDGE-SANITY",`${bigPicks.length} OFFICIAL PICKS with >15% edge — the model's worst historical bets`)
    : ok("EDGE-SANITY","no official pick rests on an implausible edge");

  const loud = picks.filter(g=>g.edge!=null && Math.abs(g.edge)>0.15).length;
  if (loud) warn("EDGE-SANITY",`${loud} games disagree with the market by >15% (expected while unblended, but watch the direction)`);

  // Picks must stay gated until a backtest opens them.
  const anyPick = picks.filter(g=>g.status==="official_pick").length
                + picks.filter(g=>g.total_status==="official_pick").length
                + picks.filter(g=>g.spread_status==="official_pick").length;
  anyPick
    ? warn("PICKS-GATE",`${anyPick} official picks published — confirm PICKS_ENABLED was opened on backtest evidence`)
    : ok("PICKS-GATE","no official picks; gate is closed as intended");
}

// ---- 10. palette discipline ----------------------------------------------
// Gold on cream is 2.0:1 and fails as text; navy carries every text role.
for (const f of ["css/style.css","css/scoreboard.css"]) {
  if (!fs.existsSync(P(f))) continue;
  const css=fs.readFileSync(P(f),"utf8");
  const leftovers=(css.match(/6d5dfc|109,\s*93,\s*252|d9468f|217,\s*70,\s*143|23b8c7/g)||[]).length;
  leftovers ? fail("PALETTE",`${f} has ${leftovers} pre-rebrand colour refs`)
            : ok("PALETTE",`${f} clean of old palette`);
}

// ---- 11. matchup directory growth ----------------------------------------
{
  const dirs=fs.readdirSync(P("nfl")).filter(d=>/-vs-.*-prediction-odds-/.test(d));
  dirs.length > 200 ? warn("DIR-GROWTH",`${dirs.length} matchup directories — time to prune or archive`)
                    : ok("DIR-GROWTH",`${dirs.length} matchup directories`);
}

// ---- 12. team name map covers every team in use --------------------------
// gameKeyFromFullNames() turns the book's "Kansas City Chiefs" into our "KC".
// A relocation, rename or new abbreviation silently drops that game's lines --
// which is indistinguishable from "no lines were posted". Fail, don't warn.
{
  try {
    const { assertTeamMap } = require("./lib/nfl-names");
    const ts = P("data/nfl/team-stats-today.json");
    if (fs.existsSync(ts)) {
      const inUse = JSON.parse(fs.readFileSync(ts,"utf8")).map(t=>t.team);
      const r = assertTeamMap(inUse);
      r.ok ? ok("TEAM-MAP",`all ${inUse.length} teams map to a full club name`)
           : fail("TEAM-MAP",`no full-name mapping for: ${r.missing.join(", ")} — those games lose every prop line`);
    }
  } catch (e) { fail("TEAM-MAP",`team map check could not run: ${e.message}`); }
}

// ---- 13. prop line coverage ----------------------------------------------
// Props are publishable without lines, so absence is not a failure. But a
// SUDDEN COLLAPSE in coverage means name matching broke, and that looks
// exactly like "the books posted nothing" (NFL_WATCH_LIST #23). Surface it.
{
  const pf = P("data/nfl/props-today.json"), of = P("data/nfl/prop-odds-today.json");
  if (!fs.existsSync(pf)) {
    warn("LINE-COVER","no props-today.json to check");
  } else if (!fs.existsSync(of)) {
    warn("LINE-COVER","no prop odds fetched yet — projections publish without lines or leans");
  } else {
    const props = JSON.parse(fs.readFileSync(pf,"utf8"));
    const odds  = JSON.parse(fs.readFileSync(of,"utf8"));
    const posted = (odds.entries||[]).length;
    /*
      DENOMINATOR MATTERS. The first version of this check divided by `posted`,
      which is every player the books price -- 715 entries, most of them
      anytime-TD longshots deep on a roster. We only project 304 players, so
      that ratio could never exceed ~42% and the check FAILED on a perfectly
      healthy run, blocking the publish.

      The question this check actually asks is: of the players WE projected,
      how many found a line? Injured and sidelined players are excluded,
      because a missing line for a player listed Out is correct behaviour, not
      a matching failure.
    */
    const eligible = props.filter(x => !x.sidelined);
    const linked = eligible.filter(x=>x.line!=null||x.market_prob!=null||x.lean_blocked==="one_sided_no_devig").length;
    const rate = eligible.length ? linked/eligible.length : 0;
    if (!posted)          warn("LINE-COVER","odds file present but empty");
    else if (rate < 0.75) fail("LINE-COVER",`only ${linked}/${eligible.length} active projections got a line (${(rate*100).toFixed(0)}%) — name matching is likely broken`);
    else                  ok("LINE-COVER",`${linked}/${eligible.length} active projections matched a line (${(rate*100).toFixed(0)}%) from ${posted} posted`);
  }
}

// ---- 14. no lean may be presented as a pick ------------------------------
// A lean is descriptive. Prop ROI has never been backtested, so nothing in
// the props file may carry a pick flag until it has been.
{
  const pf = P("data/nfl/props-today.json");
  if (fs.existsSync(pf)) {
    const props = JSON.parse(fs.readFileSync(pf,"utf8"));
    const picky = props.filter(x=>x.status==="official_pick"||x.pick===true||x.is_pick===true).length;
    picky ? fail("PROP-GATE",`${picky} prop(s) flagged as a pick — prop ROI has never been measured`)
          : ok("PROP-GATE","no prop is flagged as a pick; gate is closed as intended");
  }
}

// ---- 15. grading ledgers -------------------------------------------------
// The whole point of the NFL grading side is that it ACCUMULATES. A ledger
// that stops growing is indistinguishable from one that is working, until you
// go looking months later and find the sample never moved.
{
  const ledgers = [
    ["nfl-results-log.csv",   "game"],
    ["nfl-props-graded.csv",  "prop"],
    ["odds-history-props.csv","odds observation"]
  ];
  for (const [f, label] of ledgers) {
    const fp = P(`data/nfl/${f}`);
    if (!fs.existsSync(fp)) {
      warn("LEDGER", `${label} ledger not created yet (${f}) — expected until the first graded slate`);
      continue;
    }
    const lines = fs.readFileSync(fp, "utf8").split(/\r?\n/).filter(Boolean);
    const rows = Math.max(0, lines.length - 1);
    // A header with no rows means something wrote the file and then never
    // populated it — worse than the file being absent, because it looks done.
    rows === 0 ? fail("LEDGER", `${f} exists but has 0 rows — created and never written`)
               : ok("LEDGER", `${label} ledger has ${rows} rows`);
  }
}

// ---- 16. tracker feed matches the ledger ---------------------------------
// /nfl/results/ reads tracker.json, not the CSVs. If the generator stops
// running, the page keeps serving a stale record that looks perfectly healthy
// -- the worst failure mode on a page whose whole job is an honest count.
{
  const tf = P("data/nfl/tracker.json"), pf = P("data/nfl/nfl-props-graded.csv");
  if (!fs.existsSync(pf)) {
    warn("TRACKER", "no graded props yet — tracker not expected");
  } else if (!fs.existsSync(tf)) {
    fail("TRACKER", "graded props exist but tracker.json was never built — /nfl/results/ will be empty");
  } else {
    const t = JSON.parse(fs.readFileSync(tf, "utf8"));
    const ledgerDates = new Set(fs.readFileSync(pf, "utf8").split(/\r?\n/).slice(1)
      .filter(Boolean).map(l => l.split(",")[0]));
    const newest = [...ledgerDates].sort().pop();
    if (t.through !== newest) {
      fail("TRACKER", `tracker covers through ${t.through} but the ledger has ${newest} — rebuild it`);
    } else {
      const calls = (t.counts && t.counts.prop_calls) || 0;
      ok("TRACKER", `tracker current through ${t.through} (${calls} prop calls, ${(t.games||[]).length} games)`);
    }
  }
}

console.log("=".repeat(58));
console.log(`  ${passes} passed · ${warns} warnings · ${fails} failures\n`);
process.exit(fails ? 1 : 0);
