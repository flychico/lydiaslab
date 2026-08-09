#!/usr/bin/env node
/*
  LyDia — full-slate calibration grading.

  Grades EVERY game the model analyzed (official picks, value watches,
  watchlist, and passes) against final scores, so learning can measure
  calibration — does 65% mean 65%? — instead of only seeing the ~1
  official pick per day that clears the strict gates.

  - Input:  data/member-brief/<date>.json (every game's model read, locked pregame)
  - Output: appends to data/calibration/calibration_model_log.csv (idempotent per date+gamePk)
  - Never touches the public record: this is a learning ledger, not results.

  Usage: node scripts/grade-calibration.js [YYYY-MM-DD]   (defaults to yesterday ET)
*/
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LOG = path.join(ROOT, "data", "calibration", "calibration_model_log.csv");
const HEADER = "date,gamePk,model_version,matchup,model_side,status,model_prob,market_prob,lab_score,best_price,result,final_score\n";

const DATE = (process.argv[2] || "").match(/^\d{4}-\d{2}-\d{2}$/)
  ? process.argv[2]
  : new Date(Date.now() - 24 * 3600 * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

function csvField(s) {
  s = String(s == null ? "" : s);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const briefPath = path.join(ROOT, "data", "member-brief", `${DATE}.json`);
  if (!fs.existsSync(briefPath)) { console.log(`No member brief for ${DATE} — nothing to calibrate.`); return; }
  const brief = JSON.parse(fs.readFileSync(briefPath, "utf8"));
  const games = Array.isArray(brief.games) ? brief.games : [];
  if (!games.length) { console.log(`Member brief for ${DATE} has no games.`); return; }

  const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${DATE}`);
  if (!res.ok) { console.warn(`MLB schedule lookup failed: HTTP ${res.status}`); return; }
  const sched = await res.json();
  const finals = {};
  for (const d of sched.dates || []) {
    for (const g of d.games || []) {
      if ((g.status && g.status.abstractGameState) === "Final" && g.teams) {
        finals[g.gamePk] = { awayScore: g.teams.away.score, homeScore: g.teams.home.score };
      }
    }
  }

  // Scratched-starter detection: a game where the analyzed starter never pitched
  // is voided from the learning ledgers — grading it would measure roster news, not the model.
  const starterCache = {};
  const boxCache = {};
  async function getBox(gamePk) {
    if (boxCache[gamePk] !== undefined) return boxCache[gamePk];
    try {
      const res = await fetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`);
      boxCache[gamePk] = res.ok ? await res.json() : null;
    } catch (e) { boxCache[gamePk] = null; }
    return boxCache[gamePk];
  }
  async function actualStarters(gamePk) {
    if (starterCache[gamePk]) return starterCache[gamePk];
    try {
      const box = await getBox(gamePk);
      if (!box) return null;
      const first = side => {
        const tb = box.teams && box.teams[side];
        const id = tb && tb.pitchers && tb.pitchers[0];
        return id ? (((tb.players || {})["ID" + id] || {}).person || {}).fullName || null : null;
      };
      return (starterCache[gamePk] = { away: first("away"), home: first("home") });
    } catch (e) { return null; }
  }
  const isScratched = (analyzed, actual) => analyzed && analyzed !== "TBD" && actual && analyzed.trim().toLowerCase() !== actual.trim().toLowerCase();
  const VOIDLOG = path.join(ROOT, "data", "calibration", "voided_log.csv");
  const voidRows = [];
  async function gameVoided(g) {
    const pe = g.pitcher_edge || {};
    const actual = await actualStarters(g.game_pk);
    if (!actual) return false;
    if (isScratched(pe.away_pitcher, actual.away)) { voidRows.push(`${DATE},${g.game_pk},away,${csvField(pe.away_pitcher)},${csvField(actual.away)}`); return true; }
    if (isScratched(pe.home_pitcher, actual.home)) { voidRows.push(`${DATE},${g.game_pk},home,${csvField(pe.home_pitcher)},${csvField(actual.home)}`); return true; }
    return false;
  }

  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, HEADER);
  const existing = new Set(
    fs.readFileSync(LOG, "utf8").split("\n").slice(1)
      .map(l => l.split(",").slice(0, 2).join(","))
      .filter(Boolean)
  );

  let added = 0, skippedDone = 0, notFinal = 0;
  const rows = [];
  for (const g of games) {
    const key = `${DATE},${g.game_pk}`;
    if (existing.has(key)) { skippedDone++; continue; }
    const f = finals[g.game_pk];
    if (!f || f.awayScore == null || f.homeScore == null) { notFinal++; continue; }
    if (!g.side || typeof g.model_probability !== "number") continue;
    if (await gameVoided(g)) continue;
    const homeWon = f.homeScore > f.awayScore;
    const pickWon = g.side === "home" ? homeWon : !homeWon;
    rows.push([
      DATE, g.game_pk, csvField(g.model_source || brief.model_version || "unknown"), csvField(g.game), csvField(g.pick_team),
      g.status || "", g.model_probability,
      (g.market && typeof g.market.no_vig_probability === "number") ? g.market.no_vig_probability : "",
      typeof g.lab_score === "number" ? g.lab_score : "",
      (g.market && g.market.best_price != null) ? g.market.best_price : "",
      pickWon ? "W" : "L", `${f.awayScore}-${f.homeScore}`
    ].join(","));
    added++;
  }
  if (rows.length) fs.appendFileSync(LOG, rows.join("\n") + "\n");

  // ---- Attribution ledger: the INPUTS behind each graded game, for the
  // n>=150 weight-relevance analysis. All values are pick-side relative. ----
  const ALOG = path.join(ROOT, "data", "calibration", "attribution_model_log.csv");
  const AHEAD = "date,gamePk,model_version,status,result,model_prob,lab,pitcher_gap,kbb_diff,gb_pick,babip_pick,off_delta_diff,bullpen_gap\n";
  if (!fs.existsSync(ALOG)) fs.writeFileSync(ALOG, AHEAD);
  const aSeen = new Set(fs.readFileSync(ALOG, "utf8").split("\n").slice(1).map(l => l.split(",").slice(0, 2).join(",")).filter(Boolean));
  const aRows = [];
  const n2 = v => (typeof v === "number" && isFinite(v)) ? v : "";
  for (const g of games) {
    const key = `${DATE},${g.game_pk}`;
    if (aSeen.has(key)) continue;
    const f = finals[g.game_pk];
    if (!f || f.awayScore == null || f.homeScore == null || !g.side) continue;
    if (await gameVoided(g)) continue;
    const homeWon = f.homeScore > f.awayScore;
    const won = (g.side === "home") === homeWon;
    const pe = g.pitcher_edge || {};
    const pickHome = g.side === "home";
    const pAdv = pickHome ? pe.home_advanced : pe.away_advanced;
    const oAdv = pickHome ? pe.away_advanced : pe.home_advanced;
    const pScore = pickHome ? pe.home_score : pe.away_score;
    const oScore = pickHome ? pe.away_score : pe.home_score;
    const of_ = g.offense_form || {};
    const pOff = pickHome ? of_.home : of_.away;
    const oOff = pickHome ? of_.away : of_.home;
    const bp = g.bullpen || {};
    aRows.push([DATE, g.game_pk, csvField(g.model_source || brief.model_version || "unknown"), g.status || "", won ? "W" : "L",
      n2(g.model_probability), n2(g.lab_score),
      (isFinite(pScore) && isFinite(oScore)) ? pScore - oScore : "",
      (pAdv && oAdv && isFinite(pAdv.kbb_pct) && isFinite(oAdv.kbb_pct)) ? Number((pAdv.kbb_pct - oAdv.kbb_pct).toFixed(4)) : "",
      pAdv && isFinite(pAdv.gb_pct) ? pAdv.gb_pct : "",
      pAdv && isFinite(pAdv.babip) ? pAdv.babip : "",
      (pOff && oOff && isFinite(pOff.delta_ops) && isFinite(oOff.delta_ops)) ? Number((pOff.delta_ops - oOff.delta_ops).toFixed(3)) : "",
      (bp.opponent && bp.pick_team && isFinite(bp.opponent.score) && isFinite(bp.pick_team.score)) ? bp.opponent.score - bp.pick_team.score : ""
    ].join(","));
  }
  if (aRows.length) fs.appendFileSync(ALOG, aRows.join("\n") + "\n");

  // ---- K-props grading: projection vs market line vs actual strikeouts ----
  const KLOG = path.join(ROOT, "data", "calibration", "kprops_log.csv");
  // The first 12 columns are the ORIGINAL layout and must never move — see the
  // 2026-08-09 addition below. update-k-props.js's self-calibration reader
  // addresses this file positionally (r[5]=projection, r[6]=actual_k,
  // r[10]=projection_raw), so any reorder of columns 1-12 corrupts every
  // already-graded row without the reader ever throwing an error. Everything
  // new is appended after column 12 instead.
  const KHEAD = "date,pitcher,line,over_price,under_price,projection,actual_k,ou_result,lean,lean_result,projection_raw,calibration_band,"
    + "game,game_pk,role,expected_innings,bullpen_game,pitching_plan_reported,books,"
    + "k_rate_season,k_rate_used,recent_form_starts,recent_form_bf,recent_form_k_rate,recent_form_weight,recent_form_capped,"
    + "bf_per_ip,opp_k_adjustment,opp_k_source,opp_lineup_k,opp_lineup_k_weighted,opp_lineup_k_resolved,opp_team_season_k,league_lineup_k,"
    + "whiff_leverage,whiff_leverage_applied,whiff_lineup_source,opp_lineup_source,"
    + "calibration_bias,error_raw,abs_error_raw,error_corrected,abs_error_corrected\n";
  const kpPath = path.join(ROOT, "data", "k-props", `${DATE}.json`);
  // A missing capture used to fall straight through this block with no output at
  // all, so "the K loop is broken" and "there were no K props that day" looked
  // identical in the run log. Say which one it is.
  if (!fs.existsSync(kpPath)) {
    console.warn(`K-props: NO CAPTURE at data/k-props/${DATE}.json — nothing graded for ${DATE}. `
      + `If this repeats, update-k-props.js is not running (it exits quietly when ODDS_API_KEY is unset).`);
  }
  if (fs.existsSync(kpPath)) {
    let kp; try { kp = JSON.parse(fs.readFileSync(kpPath, "utf8")); } catch (e) { kp = null; }
    if (kp && kp.pitchers) {
      if (!fs.existsSync(KLOG)) fs.writeFileSync(KLOG, KHEAD);
      // Rows written from here on carry two extra columns. Upgrade an old header
      // in place so the file never has a 10-name header sitting above 12-value
      // rows — a header that does not describe its own data is how a ledger
      // quietly starts lying. Existing rows keep their width; the new columns
      // simply read empty for them.
      {
        const cur = fs.readFileSync(KLOG, "utf8");
        const nl = cur.indexOf("\n");
        const curHead = (nl === -1 ? cur : cur.slice(0, nl)).trim();
        const wantHead = KHEAD.trim();
        if (curHead !== wantHead && curHead.startsWith("date,pitcher,line")) {
          fs.writeFileSync(KLOG, wantHead + "\n" + (nl === -1 ? "" : cur.slice(nl + 1)));
          console.log(`K-props ledger header upgraded (+31 projection-input/error columns, appended after column 12).`);
        }
      }
      /*
        A capture can exist and still be ungradeable. On 2026-08-04 the odds
        fetch returned events_fetched: 0, so 29 of 34 pitchers had line: null,
        and the 5 that did carry a line were stale rows with no game_pk. Net
        result was zero graded rows and no explanation anywhere. Say it plainly.
      */
      const allRecs = Object.values(kp.pitchers).filter(r => r && r.name);
      const withLine = allRecs.filter(r => Number.isFinite(r.line));
      if (!withLine.length) {
        console.warn(`K-props ${DATE}: capture has ${allRecs.length} pitchers but NONE carry a market line `
          + `(events_fetched: ${kp.events_fetched ?? "unknown"}). The odds fetch failed for this date, so there is `
          + `nothing to grade. Fix update-k-props.js / ODDS_API_KEY, not the grader.`);
      } else if (withLine.length < allRecs.length / 2) {
        console.warn(`K-props ${DATE}: only ${withLine.length} of ${allRecs.length} pitchers carry a market line `
          + `(events_fetched: ${kp.events_fetched ?? "unknown"}) — partial odds capture, grading what exists.`);
      }
      const kSeen = new Set(fs.readFileSync(KLOG, "utf8").split("\n").slice(1).map(l => l.split(",").slice(0, 2).join(",")).filter(Boolean));
      const kRows = [];
      let kGraded = 0, kScratched = 0, kUnlinked = 0;
      for (const rec of Object.values(kp.pitchers)) {
        if (!rec || !rec.name || !Number.isFinite(rec.line)) continue;
        const key = `${DATE},${rec.name}`;
        if (kSeen.has(key)) continue;
        // find the pitcher's actual line in the boxscore
        let gamePk = rec.game_pk;
        if (!gamePk && kp.probables) {
          // Names do not always match exactly between the odds feed and the
          // schedule: the 2026-08-04 capture held both "JT Ginn" and
          // "J.T. Ginn". Compare on a normalized key (letters only, lowercased)
          // so punctuation and accents cannot silently drop a gradeable prop.
          const norm = n => String(n || "").toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");
          const want = norm(rec.name);
          for (const [pk, pr] of Object.entries(kp.probables)) {
            if (norm(pr.away) === want || norm(pr.home) === want) { gamePk = pk; break; }
          }
        }
        if (!gamePk) { kUnlinked++; continue; }
        const box = await getBox(gamePk);
        if (!box) continue;
        let actual = null, pitched = false;
        for (const side of ["away", "home"]) {
          const tb = box.teams && box.teams[side];
          if (!tb || !tb.players) continue;
          for (const pl of Object.values(tb.players)) {
            if (pl.person && pl.person.fullName === rec.name && pl.stats && pl.stats.pitching && pl.stats.pitching.inningsPitched !== undefined) {
              actual = Number(pl.stats.pitching.strikeOuts) || 0;
              pitched = true;
            }
          }
        }
        if (!pitched) { kScratched++; continue; } // scratched — listed-pitcher rule, no grade
        const ou = actual > rec.line ? "O" : actual < rec.line ? "U" : "P";
        const lean = Number.isFinite(rec.projection) ? Number((rec.projection - rec.line).toFixed(2)) : "";
        let leanRes = "";
        if (lean !== "" && Math.abs(lean) >= 0.7 && ou !== "P") leanRes = (lean > 0) === (ou === "O") ? "W" : "L";
        const rf = rec.recent_form || {};
        const num = v => Number.isFinite(v) ? v : "";
        const bool = v => v === true ? "true" : v === false ? "false" : "";
        // actual-vs-raw and actual-vs-corrected errors, computed once here at
        // grading time (when actual is finally known) rather than left for
        // every downstream reader to re-derive from projection - actual.
        const errRaw = Number.isFinite(rec.projection_raw) ? Number((actual - rec.projection_raw).toFixed(2)) : "";
        const absErrRaw = errRaw !== "" ? Math.abs(errRaw) : "";
        const errCorr = Number.isFinite(rec.projection) ? Number((actual - rec.projection).toFixed(2)) : "";
        const absErrCorr = errCorr !== "" ? Math.abs(errCorr) : "";
        // Columns 1-12 (through calibration_band) are the ORIGINAL layout —
        // never reordered, see the KHEAD comment above. Columns 13+ are the
        // 2026-08-09 addition: every input the projection formula used, so a
        // graded row is fully self-explaining without needing to go find that
        // day's data/k-props/<date>.json (which isn't retained indefinitely).
        kRows.push([DATE, rec.name, rec.line, rec.over ?? "", rec.under ?? "",
          Number.isFinite(rec.projection) ? rec.projection : "", actual, ou, lean, leanRes,
          Number.isFinite(rec.projection_raw) ? rec.projection_raw : "",
          rec.calibration_band || "",
          csvField(rec.game || ""), rec.game_pk ?? "", csvField(rec.pitcher_role_label || ""),
          num(rec.expected_innings), bool(rec.bullpen_game), bool(rec.pitching_plan_reported), rec.books ?? "",
          num(rec.k_rate_season), num(rec.k_rate_used),
          num(rf.starts), num(rf.batters_faced), num(rf.recent_k_rate), num(rf.weight), bool(rf.capped),
          num(rec.bf_per_ip), num(rec.opp_k_adjustment), csvField(rec.opp_k_source || ""),
          num(rec.opp_lineup_k), num(rec.opp_lineup_k_weighted), rec.opp_lineup_k_resolved ?? "",
          num(rec.opp_team_season_k), num(rec.league_lineup_k),
          num(rec.whiff_leverage), bool(rec.whiff_leverage_applied), csvField(rec.whiff_lineup_source || ""), csvField(rec.opp_lineup_source || ""),
          num(rec.calibration_bias), errRaw, absErrRaw, errCorr, absErrCorr
        ].join(","));
        kGraded++;
      }
      if (kRows.length) fs.appendFileSync(KLOG, kRows.join("\n") + "\n");
      console.log(`K-props: graded ${kGraded}, scratched ${kScratched}, unlinked-to-a-game ${kUnlinked}.`);
    }
  }

  // ---- Totals grading: projection vs line vs actual final score ----
  const TLOG = path.join(ROOT, "data", "calibration", "totals_model_log.csv");
  const THEAD = "date,gamePk,model_version,line,over_price,under_price,projection,actual_total,ou_result,lean,lean_result,setup_rating,classification,matchup\n";
  const tPath = path.join(ROOT, "data", "totals", `${DATE}.json`);
  if (fs.existsSync(tPath)) {
    let tp; try { tp = JSON.parse(fs.readFileSync(tPath, "utf8")); } catch (e) { tp = null; }
    // Grade whatever version produced the capture. This used to require an exact
    // match on "totals-runs-v3-pitching-plan"; when the model was bumped to
    // totals-runs-v4-additive-median-woba the comparison silently stopped
    // grading — one console line, exit 0, and the totals learning loop went dark
    // from 07-28 onward without anything failing. Provenance belongs in the
    // model_version COLUMN, which every row already carries, not in a gate that
    // decides whether history gets recorded at all. An unversioned capture is
    // still graded and simply tagged "unknown".
    if (tp && tp.games) {
      if (!fs.existsSync(TLOG)) fs.writeFileSync(TLOG, THEAD);
      const tSeen = new Set(fs.readFileSync(TLOG, "utf8").split("\n").slice(1).map(l => l.split(",").slice(0, 2).join(",")).filter(Boolean));
      const tRows = [];
      const totalsPolicy = tp.policy || {};
      const minEdge = Number.isFinite(totalsPolicy.research_min_edge) ? totalsPolicy.research_min_edge : 0.7;
      const minSetup = Number.isFinite(totalsPolicy.research_min_setup) ? totalsPolicy.research_min_setup : 70;
      const totalsModelVersion = tp.model_version || "unknown";
      for (const [pk, g] of Object.entries(tp.games)) {
        const key = `${DATE},${pk}`;
        if (tSeen.has(key)) continue;
        const f = finals[pk];
        if (!f || f.awayScore == null || f.homeScore == null) continue;
        // Full-game totals are team markets. An opener/starter change does not
        // void the wager unless the sportsbook voids the market itself.
        const actual = f.awayScore + f.homeScore;
        const hasLine = Number.isFinite(g.line);
        const ou = hasLine ? (actual > g.line ? "O" : actual < g.line ? "U" : "P") : "";
        const lean = (hasLine && Number.isFinite(g.projection)) ? Number((g.projection - g.line).toFixed(1)) : "";
        let leanRes = "";
        const qualifies = lean !== "" && Math.abs(lean) >= minEdge && Number.isFinite(g.lab) && g.lab >= minSetup;
        if (qualifies && ou !== "P" && ou !== "") leanRes = (lean > 0) === (ou === "O") ? "W" : "L";
        tRows.push([DATE, pk, csvField(totalsModelVersion), hasLine ? g.line : "", g.over ?? "", g.under ?? "", Number.isFinite(g.projection) ? g.projection : "", actual, ou, lean, leanRes, Number.isFinite(g.lab) ? g.lab : "", g.classification || (qualifies ? "research_lean" : "no_lean"), csvField(g.game || "")].join(","));
      }
      if (tRows.length) fs.appendFileSync(TLOG, tRows.join("\n") + "\n");
      console.log(`Totals: graded ${tRows.length}.`);
    }
  }

  // ---- Versioned shadow-model ledger ----
  // Start a clean ledger instead of mixing the current run-enhanced official
  // model with historical p_home_v2 values from the retired ERA-only model.
  //
  // 2026-08-07: extended with component columns, per Lynold. The ledger used to
  // record only the two final probabilities (p_home_official, p_home_shadow),
  // which was enough to know THAT shadow's Brier score beats official's across
  // every window checked (see DEC-20260807-01) but not enough to know WHICH of
  // shadow's three formula differences (starter FIP-lite, the 15-day offense-
  // form term, or the shared bullpen term) is actually doing the work. The
  // extra columns below are all read straight off the member-brief game object
  // — generate-member-lab.js was already computing and storing every one of
  // them (model_v3.fip_away/fip_home/off_adj/bp_adj, pitching_plan.*.effective_era,
  // legacy_strength_probability, bullpen.pick_team/opponent) for its own display
  // purposes. Nothing new is computed here; this just stops discarding data
  // that was already sitting in the brief.
  //
  // Same safe-upgrade pattern already used above for kprops_log.csv: the header
  // is upgraded in place, old rows keep their original (shorter) width, and any
  // reader must treat a short row's new fields as blank rather than assume every
  // row is the current width.
  const SLOG = path.join(ROOT, "data", "calibration", "shadow_model_log.csv");
  const SHEAD = "date,gamePk,official_model_version,shadow_model_version,p_home_official,p_home_shadow,home_won,"
    + "shadow_fip_away,shadow_fip_home,shadow_off_adj,shadow_bp_adj,"
    + "official_effective_era_away,official_effective_era_home,official_legacy_strength_home,"
    + "official_bullpen_risk_away,official_bullpen_risk_home\n";
  if (!fs.existsSync(SLOG)) fs.writeFileSync(SLOG, SHEAD);
  {
    const cur = fs.readFileSync(SLOG, "utf8");
    const nl = cur.indexOf("\n");
    const curHead = (nl === -1 ? cur : cur.slice(0, nl)).trim();
    const wantHead = SHEAD.trim();
    if (curHead !== wantHead && curHead.startsWith("date,gamePk,official_model_version")) {
      fs.writeFileSync(SLOG, wantHead + "\n" + (nl === -1 ? "" : cur.slice(nl + 1)));
      console.log(`Shadow-model ledger header upgraded (+component columns).`);
    }
  }
  const sExisting = new Set(fs.readFileSync(SLOG, "utf8").split("\n").slice(1).map(l => l.split(",").slice(0, 2).join(",")).filter(Boolean));
  const sRows = [];
  // risk_index falls back to the older raw fatigue `score` for any bullpen
  // record generated before the efficiency/risk split existed — same fallback
  // generate-member-lab.js itself uses everywhere it reads bullpen risk.
  const riskIndexOf = b => (b && Number.isFinite(b.risk_index ?? b.score)) ? (b.risk_index ?? b.score) : "";
  for (const g of games) {
    const key = `${DATE},${g.game_pk}`;
    if (sExisting.has(key)) continue;
    const f = finals[g.game_pk];
    const v3 = g.model_v3;
    if (!f || !v3 || !Number.isFinite(v3.p_home) || !Number.isFinite(g.model_probability) || !["home", "away"].includes(g.side)) continue;
    if (await gameVoided(g)) continue;
    const pickIsHome = g.side === "home";
    const pHomeOfficial = pickIsHome ? g.model_probability : 1 - g.model_probability;
    const officialVersion = g.model_source || brief.model_version || "unknown";
    const shadowVersion = v3.version || "unknown";
    const plan = g.pitching_plan || {};
    const effEraAway = plan.away && Number.isFinite(plan.away.effective_era) ? plan.away.effective_era : "";
    const effEraHome = plan.home && Number.isFinite(plan.home.effective_era) ? plan.home.effective_era : "";
    const legacyHome = Number.isFinite(g.legacy_strength_probability)
      ? (pickIsHome ? g.legacy_strength_probability : 1 - g.legacy_strength_probability)
      : "";
    const bp = g.bullpen || {};
    // bullpen.pick_team/opponent are relative to which side the model picked,
    // not to home/away — re-orient using the same side flag as everything else.
    const bpRiskHome = pickIsHome ? riskIndexOf(bp.pick_team) : riskIndexOf(bp.opponent);
    const bpRiskAway = pickIsHome ? riskIndexOf(bp.opponent) : riskIndexOf(bp.pick_team);
    sRows.push([
      DATE, g.game_pk, csvField(officialVersion), csvField(shadowVersion), pHomeOfficial, v3.p_home, f.homeScore > f.awayScore ? 1 : 0,
      Number.isFinite(v3.fip_away) ? v3.fip_away : "", Number.isFinite(v3.fip_home) ? v3.fip_home : "",
      Number.isFinite(v3.off_adj) ? v3.off_adj : "", Number.isFinite(v3.bp_adj) ? v3.bp_adj : "",
      effEraAway, effEraHome, legacyHome, bpRiskAway, bpRiskHome
    ].join(","));
  }
  if (sRows.length) fs.appendFileSync(SLOG, sRows.join("\n") + "\n");
  if (voidRows.length) {
    if (!fs.existsSync(VOIDLOG)) fs.writeFileSync(VOIDLOG, "date,gamePk,side,analyzed_starter,actual_starter\n");
    const seen = new Set(fs.readFileSync(VOIDLOG, "utf8").split("\n"));
    const fresh = [...new Set(voidRows)].filter(r => !seen.has(r));
    if (fresh.length) fs.appendFileSync(VOIDLOG, fresh.join("\n") + "\n");
    console.log(`Voided ${new Set(voidRows).size} game(s) — starter scratched (see voided_log.csv).`);
  }
  console.log(`Calibration ${DATE}: logged ${added}, already-logged ${skippedDone}, not-final ${notFinal}, slate ${games.length}. Versioned shadow model: ${sRows.length} graded.`);

  writeHealth();
}

/*
  Ledger health marker.

  Every way this script can stop learning is quiet: a capture file that was never
  written, a version string that stopped matching, an exception swallowed by the
  top-level catch. All of them look like a clean run in the Actions log, and the
  totals loop was dead for five days before anyone noticed.

  This writes the last graded date for each ledger into a committed file, so
  staleness is visible in the repo itself rather than only in a run log. It is
  derived state — safe to delete and regenerate — and it never gates anything.
*/
function writeHealth() {
  try {
    const dir = path.join(ROOT, "data", "calibration");
    const ledgers = {
      moneyline: "calibration_model_log.csv",
      attribution: "attribution_model_log.csv",
      totals: "totals_model_log.csv",
      kprops: "kprops_log.csv",
      shadow: "shadow_model_log.csv"
    };
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
    const out = { generated_at: new Date().toISOString(), graded_through: today, ledgers: {} };
    for (const [name, file] of Object.entries(ledgers)) {
      const p = path.join(dir, file);
      if (!fs.existsSync(p)) { out.ledgers[name] = { file, present: false }; continue; }
      const lines = fs.readFileSync(p, "utf8").trim().split("\n").slice(1).filter(Boolean);
      const last = lines.length ? lines[lines.length - 1].split(",")[0] : null;
      const stale = last ? daysBetween(last, today) : null;
      out.ledgers[name] = {
        file,
        present: true,
        rows: lines.length,
        last_graded: last,
        days_stale: stale,
        // Two days covers a normal run cadence plus an off-day; beyond that
        // something is wrong and this is the line that says so.
        healthy: stale !== null && stale <= 2
      };
    }
    const sick = Object.entries(out.ledgers).filter(([, v]) => v.present && !v.healthy);
    fs.writeFileSync(path.join(dir, "_health.json"), JSON.stringify(out, null, 1));
    if (sick.length) {
      console.warn(`\n!! LEDGER STALENESS — ${sick.length} ledger(s) are not being written:`);
      for (const [n, v] of sick) console.warn(`   ${n}: last graded ${v.last_graded} (${v.days_stale} days ago, ${v.rows} rows)`);
      console.warn(`   See data/calibration/_health.json\n`);
    }
  } catch (e) {
    console.warn("health marker skipped:", e.message);
  }
}

/*
  exit(0) here is deliberate, not an oversight — do not "fix" it to exit(1).

  This script runs at step ~76 of daily-recap.yml and the commit is at step ~139.
  A non-zero exit fails the job, the commit never runs, and every ledger row this
  script DID manage to write that day is thrown away. Failing loudly would cost
  more history than it saves.

  The staleness problem that motivated this comment is handled by writeHealth()
  instead: it records the last graded date per ledger into a committed file, so a
  loop that stops writing becomes visible in the repo rather than only in a run
  log. The banner below is greppable in Actions output.
*/
main().catch(e => {
  console.error("\n!! CALIBRATION RUN FAILED — no rows were written for this date.");
  console.error(`   ${e && e.stack ? e.stack : e}`);
  console.error("   Exiting 0 on purpose so the workflow still commits earlier steps.\n");
  try { writeHealth(); } catch (_) {}
  process.exit(0);
});
