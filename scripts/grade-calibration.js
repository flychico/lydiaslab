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
// 2026-08-14: this require was missing entirely in every version of this file
// built this session (08-11 through 08-13) -- each one was built from a base
// that predated the 08-09 xlsx work, so the data/k-props/<date>.xlsx refresh
// below silently stopped running days ago with no error, no warning, nothing.
// export-kprops-xlsx.js (prepare-slate.yml) still wrote the FIRST version of
// that file pre-game; this script was supposed to overwrite it post-game with
// real outcomes filled in, and hasn't been doing that.
const { buildRow: buildKpropsXlsxRow, writeWorkbook: writeKpropsXlsx } = require("./lib/kprops-xlsx");
// 2026-08-25, Lynold's explicit instruction: ERA_K imported here now too (see the block below where it used to be a local hardcoded 0.20) -- single source of truth shared with generate-member-lab.js and export-pregame-attribution.js.
const { ERA_K, PITCHER_SCORE_GAP_CLAMP } = require("./lib/pitcher-boost-constants");

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

// Ledger dates have historically been written in two different string
// formats (legacy M/D/YYYY from an older build, current YYYY-MM-DD/en-CA).
// The idempotency check below is a straight string comparison, so without
// normalizing first, a game graded under one format is invisible to a rerun
// using the other and gets silently re-appended as a "new" row. Confirmed
// this happened for 08-01..08-06 (61 duplicate rows) before this fix.
function normDate(s) {
  s = String(s || "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return s;
}

// 2026-08-14, Lynold's explicit instruction: every ledger's date COLUMN
// standardizes on MM/DD/YYYY going forward (was YYYY-MM-DD). DATE itself
// stays ISO -- it's still what every internal lookup/comparison in this file
// uses -- only what actually gets WRITTEN into a row changes. normDate()
// above already reads either shape back to ISO, so every dedup Set below
// that built its comparison key straight from raw file text (kSeen, tSeen,
// sExisting, the K-props xlsx-refresh backfill, and voided_log's dedup) had
// to be routed through normDate() too, not just the header-name lookups --
// otherwise a re-run today would silently stop recognizing this run's own
// rows as already-graded the moment the on-disk format flips, and start
// duplicating them.
function mmddyyyy(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
}
const DATE_OUT = mmddyyyy(DATE);

async function main() {
  const briefPath = path.join(ROOT, "data", "member-brief", `${DATE}.json`);
  if (!fs.existsSync(briefPath)) { console.log(`No member brief for ${DATE} — nothing to calibrate.`); return; }
  const brief = JSON.parse(fs.readFileSync(briefPath, "utf8"));
  const games = Array.isArray(brief.games) ? brief.games : [];
  if (!games.length) { console.log(`Member brief for ${DATE} has no games.`); return; }

  // 2026-08-26, Lynold's explicit instruction: this ledger's status/pick used
  // to come ONLY from the member-brief snapshot for each game, which is not
  // guaranteed to match what was actually published -- a game can clear the
  // official gate on a run AFTER member-brief's last capture for the day, or
  // (rarer) clear it in member-brief but never get a moneyline attached to
  // the published card at all. Concretely: on 08-16 three games logged here
  // as watchlist/value_watch had gone out as real official picks, and on
  // 08-22 one game logged here as official_pick never got a published
  // moneyline (moneyline: null in the real file) -- see ERR-20260826-01/02.
  // data/published-picks/<date>.json is the actual public record members
  // saw, so it now overrides member-brief's snapshot in both directions
  // whenever it has an opinion about a game.
  const publishedByPk = new Map();
  {
    const pubPath = path.join(ROOT, "data", "published-picks", `${DATE}.json`);
    if (fs.existsSync(pubPath)) {
      try {
        const pub = JSON.parse(fs.readFileSync(pubPath, "utf8"));
        for (const p of pub.picks || []) publishedByPk.set(String(p.gamePk), p);
      } catch (e) { console.warn(`Could not read ${pubPath}: ${e.message}`); }
    }
  }

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
    if (isScratched(pe.away_pitcher, actual.away)) { voidRows.push(`${DATE_OUT},${g.game_pk},away,${csvField(pe.away_pitcher)},${csvField(actual.away)}`); return true; }
    if (isScratched(pe.home_pitcher, actual.home)) { voidRows.push(`${DATE_OUT},${g.game_pk},home,${csvField(pe.home_pitcher)},${csvField(actual.home)}`); return true; }
    return false;
  }

  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, HEADER);
  // Header upgrade in place: this file predates the final_score column, and
  // (unlike KLOG below) never had upgrade logic, so 115+ rows have a 12th
  // value sitting under an 11-name header — the value that then gets
  // misread as a date ("3-2") by any spreadsheet app that opens the file,
  // because there's no header telling it otherwise.
  {
    const cur = fs.readFileSync(LOG, "utf8");
    const nl = cur.indexOf("\n");
    const curHead = (nl === -1 ? cur : cur.slice(0, nl)).trim();
    const wantHead = HEADER.trim();
    if (curHead !== wantHead && curHead.startsWith("date,gamePk,model_version,matchup")) {
      fs.writeFileSync(LOG, wantHead + "\n" + (nl === -1 ? "" : cur.slice(nl + 1)));
      console.log(`Calibration ledger header upgraded (+final_score).`);
    }
  }
  const existing = new Set(
    fs.readFileSync(LOG, "utf8").split("\n").slice(1)
      .map(l => { const p = l.split(","); return p.length >= 2 ? `${normDate(p[0])},${p[1]}` : ""; })
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

    const pub = publishedByPk.get(String(g.game_pk));
    const pubMl = pub && pub.moneyline;
    let status = g.status || "", pickTeam = g.pick_team, side = g.side;
    let modelProb = g.model_probability;
    let marketProb = (g.market && typeof g.market.no_vig_probability === "number") ? g.market.no_vig_probability : "";
    let labScore = typeof g.lab_score === "number" ? g.lab_score : "";
    let bestPrice = (g.market && g.market.best_price != null) ? g.market.best_price : "";
    if (pubMl) {
      // The real public record has an official moneyline for this game --
      // its numbers are what actually went out, so they win outright.
      status = "official_pick";
      pickTeam = pubMl.pick;
      side = pubMl.side;
      if (typeof pubMl.prob === "number") modelProb = pubMl.prob;
      if (typeof pubMl.mktProb === "number") marketProb = pubMl.mktProb;
      if (typeof pubMl.edgeScore === "number") labScore = pubMl.edgeScore;
      if (pubMl.bestAm != null) bestPrice = pubMl.bestAm;
    } else if (pub && status === "official_pick") {
      // member-brief thought this cleared the gate, but the published-picks
      // file tracked this game today and never attached a moneyline to it --
      // it was not actually published as official. Downgrade rather than
      // trust the stale snapshot.
      status = "watchlist";
    }

    const homeWon = f.homeScore > f.awayScore;
    const pickWon = side === "home" ? homeWon : !homeWon;
    rows.push([
      DATE_OUT, g.game_pk, csvField(g.model_source || brief.model_version || "unknown"), csvField(g.game), csvField(pickTeam),
      status, modelProb, marketProb, labScore, bestPrice,
      pickWon ? "W" : "L", `${f.awayScore}-${f.homeScore}`
    ].join(","));
    added++;
  }
  if (rows.length) fs.appendFileSync(LOG, rows.join("\n") + "\n");

  // ---- Attribution ledger: the INPUTS behind each graded game, for the
  // n>=150 weight-relevance analysis. Pick-side/opp-side values are the real
  // number for each team; the *_gap/*_diff columns are pick-minus-opp,
  // pre-computed for anyone who just wants the differential. matchup/
  // pick_team/opp_team added 2026-08-11 so a row can be read without a
  // separate join against calibration_model_log.csv. Everything below
  // pitcher_gap is pick-side then opp-side, in that order, per metric. ----
  const ALOG = path.join(ROOT, "data", "calibration", "attribution_model_log.csv");
  // 2026-08-13: full moneyline decision-trace chain, so a row can be walked
  // step by step -- team strength (both sides) -> team-strength-only prob ->
  // +starter ERA (pre_bullpen_prob) -> +bullpen (legacy_strength_prob) ->
  // +calibration (model_prob, already existed). home_strength_blend/
  // away_strength_blend (renamed 2026-08-19, were pick_team_strength_blend/
  // opp_team_strength_blend) are each team's raw blend, reported home/away
  // rather than pick/opp on purpose: pBase in generate-member-lab.js is
  // always the HOME team's blend regardless of which side is picked, so
  // home_strength_blend is always the number that anchored the odds calc --
  // no conditional needed to know which column matters. bullpen_log_odds_adj
  // is what the bullpen risk gap actually did to the odds, pick-relative.
  // Also: pick_era/opp_era below now read the EXACT effective ERA leo used
  // (model_effective_era_away/home, clamped and workload-blended), not the
  // pitcher's raw season ERA -- those two numbers differ and the raw one was
  // never what the model actually priced.
  // 2026-08-13, Lynold's exact spec: full column reorder, several columns
  // dropped (lab, kbb/gb/babip diffs, OPS-delta pair), and 6 new "show your
  // work" columns appended that turn the manual reverse-engineering walkthrough
  // from chat into real, checkable formulas run on every row:
  //   pre_bullpen_odds     = odds(pre_bullpen_prob)
  //   team_strength_odds   = odds(team_strength_prob)
  //   pitcher_boost        = exp(ERA_K * (opp_era - pick_era))            -- the ERA step's multiplier
  //   legacy_strength_prob_calc = calibrate(legacy_strength_prob)         -- recomputed FINAL prob; cross-check against model_prob
  //   prob_calc            = odds(legacy_strength_prob)                  -- NOTE: identical to legacy_strength_odds on every row checked; kept as asked, flagged as a likely duplicate
  //   legacy_strength_odds = odds(legacy_strength_prob)
  // This is a RESHAPE, not an append -- column order changed and columns were
  // removed, so the header-upgrade-in-place trick used elsewhere in this file
  // (safe only for pure trailing additions) does not apply here. Pair this
  // code with a full CSV rebuild; do not rely on this alone to fix old rows.
  // 2026-08-14, Lynold's exact spec (2nd reorder): pick_pitcher/opp_pitcher
  // names added; off_diff renamed to woba_diff and moved later in the row;
  // bullpen_log_odds_adj renamed to bullpen_adj. team_strength_prob and
  // team_strength_odds DROPPED -- both were log5Home()'s output, and log5
  // was removed from generate-member-lab.js the same day (Lynold's explicit
  // instruction), so team_strength_prob is now just a duplicate of
  // pick_team_strength_blend and no longer worth a separate column.
  // legacy_strength_prob_calc and prob_calc DROPPED (the calibration
  // cross-check and the flagged-duplicate column). legacy_strength_prob and
  // legacy_strength_odds RENAMED to moneyline_prop / money_line_odds and
  // moved to the end -- same numbers, same formulas, just now named for what
  // they are: the final pre-calibration moneyline read, distinct from
  // model_prob (post-calibration) up near the top of the row.
  // 2026-08-25, Lynold's explicit instruction: full schema rewrite from
  // pick/opp-relative to home/away-relative -- see the matching header
  // comment block in export-pregame-attribution.js for the complete
  // rationale (same rewrite, kept in sync). Short version: added
  // away_team/home_team, pick_team now holds "home team"/"away team" (not
  // a team name), dropped opp_team + both whip columns + both hr9 columns
  // (never read downstream, confirmed by the 2026-08-25 unused-column
  // audit), every remaining pick/opp pair converted to a direct home_X/
  // away_X pair, model_prob -> home_model_prob, result -> winner, and the
  // 6 gap/calc columns converted to home-relative and KEPT (not dropped).
  const ALOG_COLUMNS = [
    "date", "gamePk", "model_version", "matchup", "away_team", "home_team",
    "pick_team", "status", "winner",
    "home_model_prob", "home_pitcher_gap", "home_pitcher", "home_pitcher_score",
    "away_pitcher", "away_pitcher_score", "home_era", "away_era",
    "home_woba", "away_woba", "home_bullpen_risk", "away_bullpen_risk",
    "home_strength_blend", "away_strength_blend", "home_woba_gap", "home_bullpen_gap",
    "home_pitcher_boost", "home_pre_bullpen_odds", "home_pre_bullpen_prob", "home_bullpen_adj",
    "home_money_line_odds", "home_moneyline_prop"
  ];
  const AHEAD = ALOG_COLUMNS.join(",") + "\n";
  if (!fs.existsSync(ALOG)) fs.writeFileSync(ALOG, AHEAD);
  // 2026-08-14: this header check used to only gate whether the HEADER TEXT got
  // rewritten -- it did NOT stop the code below from building and appending
  // rows in the NEW shape regardless of the outcome. On a width mismatch that
  // meant: header stays old, warning gets printed, and new rows STILL get
  // appended underneath it in the new column count -- silently misaligning
  // every column for anyone reading the file, worse than doing nothing.
  // alogHeaderOk now actually gates the append below, not just the header swap.
  let alogHeaderOk = true;
  {
    const cur = fs.readFileSync(ALOG, "utf8");
    const nl = cur.indexOf("\n");
    const curHead = (nl === -1 ? cur : cur.slice(0, nl)).trim();
    const wantHead = AHEAD.trim();
    if (curHead !== wantHead) {
      if (curHead.split(",").length === ALOG_COLUMNS.length) {
        // Same width, different names/order -- safe to swap the header text only.
        fs.writeFileSync(ALOG, wantHead + "\n" + (nl === -1 ? "" : cur.slice(nl + 1)));
        console.log("Attribution ledger header text updated (same column count, new names/order).");
      } else {
        alogHeaderOk = false;
        console.warn(`Attribution ledger header does not match the current ${ALOG_COLUMNS.length}-column schema `
          + `and is a different width -- NOT auto-upgrading (would misalign existing rows). `
          + `SKIPPING attribution grading this run so nothing gets appended under the wrong header. `
          + `Rebuild the file from a fresh backfill, then re-run.`);
      }
    }
  }
  const aSeen = alogHeaderOk
    ? new Set(fs.readFileSync(ALOG, "utf8").split("\n").slice(1).map(l => { const p = l.split(","); return p.length >= 2 ? `${normDate(p[0])},${p[1]}` : ""; }).filter(Boolean))
    : new Set();
  const aRows = [];
  // 2026-08-13, Lynold's explicit instruction: "ensure everything is rounded
  // 4 decimal places before any calculations so we can avoid rounding
  // discrepancies." r4() is the single rounding point — every raw value below
  // is passed through it BEFORE it's used in any diff/odds/exp formula, not
  // just when written to the cell. That's what makes the 6 calc columns
  // reproducible by hand against the raw columns in this same row.
  const r4 = v => (typeof v === "number" && isFinite(v)) ? Number(v.toFixed(4)) : null;
  const n2 = v => v === null || v === undefined ? "" : v;
  const bpRiskNum = t => { const v = t ? (t.risk_index ?? t.score) : null; return r4(typeof v === "number" ? v : NaN); };
  // odds(p) = p / (1-p). Guarded against p<=0 or p>=1 (division by zero / negative odds).
  const odds = p => (p !== null && p > 0 && p < 1) ? r4(p / (1 - p)) : null;
  // MONEYLINE_CALIBRATION_K and ERA_K are not exported from
  // generate-member-lab.js (module.exports = { summarize, officialMarketCounts }
  // only) -- hardcoded here, kept in sync manually with the constant of
  // the same name in that file.
  // 2026-08-25, Lynold's explicit instruction: ERA_K now imported from
  // scripts/lib/pitcher-boost-constants.js instead of a local hardcoded
  // copy. That local copy (0.20) had drifted stale -- generate-member-lab.js's
  // live value had been retuned to 0.15 and this file was never updated to
  // match, so home_pitcher_boost/home_pre_bullpen_odds in this ledger
  // silently stopped matching what the live model actually priced. (A
  // same-day 2026-08-24 attempt to centralize this via a shared
  // PITCHER_SCORE_K=0.03 constant in that same module was reverted back to
  // local copies per Lynold's call that day -- this is that centralization
  // done for real, at the current correct value.)
  const MONEYLINE_CALIBRATION_K = 0.50;
  if (alogHeaderOk) for (const g of games) {
    const key = `${DATE},${g.game_pk}`;
    if (aSeen.has(key)) continue;
    const f = finals[g.game_pk];
    if (!f || f.awayScore == null || f.homeScore == null || !g.side) continue;
    if (await gameVoided(g)) continue;
    const homeWon = f.homeScore > f.awayScore;
    const winner = homeWon ? "home" : "away";
    const pickHome = g.side === "home";
    const pe = g.pitcher_edge || {};
    // 2026-08-25: pe.home_pitcher/away_pitcher, pe.home_score/away_score,
    // g.model_effective_era_home/away, and offense_form.home/away are all
    // ALREADY home/away-direct at the source -- no pickHome conditional
    // needed to read them (this is what made the home/away rewrite safe:
    // most of the pick/opp split below was only ever a display convention
    // layered on top of data that was home/away-shaped underneath).
    const homePitcher = pe.home_pitcher;
    const awayPitcher = pe.away_pitcher;
    const homeScore = r4(pe.home_score);
    const awayScore = r4(pe.away_score);
    // 2026-08-13: was pe.home_era/away_era (raw season ERA) -- corrected to
    // the exact effective ERA leo's exponential adjustment used.
    const homeEra = r4(g.model_effective_era_home);
    const awayEra = r4(g.model_effective_era_away);
    const of_ = g.offense_form || {};
    const homeWoba = r4(of_.home ? of_.home.woba_15d : NaN);
    const awayWoba = r4(of_.away ? of_.away.woba_15d : NaN);
    const bp = g.bullpen || {};
    // bp only stores pick_team/opponent (no home/away split at the source),
    // so this is the one pair that still needs the pickHome flip to land on
    // the correct physical side.
    const homeRisk = bpRiskNum(pickHome ? bp.pick_team : bp.opponent);
    const awayRisk = bpRiskNum(pickHome ? bp.opponent : bp.pick_team);
    // 2026-08-19, Lynold's explicit instruction (carried forward): pBase in
    // generate-member-lab.js is ALWAYS the home team's blend
    // (team_strength_blend_home), regardless of which side is picked --
    // home_strength_blend IS the number that anchors the odds calc on every
    // row; away_strength_blend never feeds the formula (kept for reference
    // only). Already home/away-direct, unchanged by this rewrite.
    const homeBlend = r4(g.team_strength_blend_home);
    const awayBlend = r4(g.team_strength_blend_away);

    // 2026-08-25: model_probability, model_probability_pre_bullpen, and
    // bullpen_log_odds_adjustment are all stored PICK-relative on the member
    // brief game object (pickHome ? X : 1-X, or pickHome ? X : -X --
    // confirmed by reading generate-member-lab.js directly, lines
    // 1125/1272/1317/1344). To make these home-relative: when the pick IS
    // home the stored value already reads home-relative; when the pick is
    // away, undo the flip.
    const pickProb = r4(g.model_probability);
    const homeModelProb = pickHome ? pickProb : (pickProb !== null ? r4(1 - pickProb) : null);
    const pickPreBullpenProb = r4(g.model_probability_pre_bullpen);
    const homePreBullpenProb = pickHome ? pickPreBullpenProb : (pickPreBullpenProb !== null ? r4(1 - pickPreBullpenProb) : null);
    const pickBullpenAdj = r4(g.bullpen_log_odds_adjustment);
    const homeBullpenAdj = pickHome ? pickBullpenAdj : (pickBullpenAdj !== null ? r4(-pickBullpenAdj) : null);

    const homePitcherGap = (homeScore !== null && awayScore !== null) ? r4(homeScore - awayScore) : null;
    const homeWobaGap = (homeWoba !== null && awayWoba !== null) ? r4(homeWoba - awayWoba) : null;
    // Mirrors the old bullpen_gap convention (opponent risk minus the
    // favored side's risk, so positive = the favored side is safer) just
    // restated home-relative: away risk minus home risk.
    const homeBullpenGap = (homeRisk !== null && awayRisk !== null) ? r4(awayRisk - homeRisk) : null;

    // -- the 3 calc columns, built only from the already-rounded values above --
    const homePreBullpenOdds = odds(homePreBullpenProb);
    // 2026-08-21, bug fix (carried forward): pitcher_boost must use the same
    // score-gap formula as pitcher_gap above, clamped +/-20 before the
    // exponential -- matches export-pregame-attribution.js exactly.
    const homeScoreGap = (homeScore !== null && awayScore !== null) ? Math.max(-PITCHER_SCORE_GAP_CLAMP, Math.min(PITCHER_SCORE_GAP_CLAMP, homeScore - awayScore)) : null;
    const homePitcherBoost = homeScoreGap !== null ? r4(Math.exp(ERA_K * homeScoreGap)) : null;
    // 2026-08-18, Lynold's explicit instruction (carried forward):
    // moneyline_prop/money_line_odds must use the SAME formula as model_prob
    // -- both now read homeModelProb.
    const homeMoneyLineOdds = odds(homeModelProb);
    const homeMoneylineProp = homeModelProb;

    const pickTeamSide = g.side === "home" ? "home team" : "away team";

    aRows.push([
      DATE_OUT, g.game_pk, csvField(g.model_source || brief.model_version || "unknown"),
      csvField(g.game), csvField(g.away_team), csvField(g.home_team),
      csvField(pickTeamSide), g.status || "", winner,
      n2(homeModelProb), n2(homePitcherGap), csvField(homePitcher || ""), n2(homeScore),
      csvField(awayPitcher || ""), n2(awayScore),
      n2(homeEra), n2(awayEra),
      n2(homeWoba), n2(awayWoba), n2(homeRisk), n2(awayRisk),
      n2(homeBlend), n2(awayBlend), n2(homeWobaGap), n2(homeBullpenGap),
      n2(homePitcherBoost), n2(homePreBullpenOdds), n2(homePreBullpenProb), n2(homeBullpenAdj),
      n2(homeMoneyLineOdds), n2(homeMoneylineProp)
    ].join(","));
  }
  if (aRows.length) fs.appendFileSync(ALOG, aRows.join("\n") + "\n");

  // ---- K-props grading: projection vs market line vs actual strikeouts ----
  const KLOG = path.join(ROOT, "data", "calibration", "kprops_log.csv");
  // 2026-08-14, Lynold's exact spec: full column reorder + rename, 5 columns
  // dropped from the 43-column 2026-08-09 schema (recent_form_capped,
  // whiff_leverage, whiff_leverage_applied, whiff_lineup_source,
  // opp_lineup_source). This is a RESHAPE, not an append -- same pattern as
  // the 2026-08-13 attribution_model_log.csv reorder above: column order AND
  // count both changed, so the safe "upgrade header text in place" trick only
  // applies when the width matches. Existing rows stay under whatever header
  // they were written under until a separate rebuild-from-backfill is run.
  // date/pitcher stay columns 1-2, so the dedup key below (kSeen) is unaffected.
  // update-k-props.js's self-calibration reader used to address this file
  // POSITIONALLY (r[5]=projection, r[6]=actual_k, r[10]=projection_raw) --
  // switched to a header-name lookup in the same pass so it survives this
  // reorder and any future one without silently misreading columns.
  const KLOG_COLUMNS = [
    "date", "pitcher", "line", "over_price", "under_price",
    "game", "game_pk", "role", "expected_innings", "bullpen_game", "pitching_plan_reported", "books",
    "k_rate_season", "recent_form_starts", "recent_form_bf", "bf_per_ip", "recent_form_k_rate", "recent_form_weight",
    "opp_k_source", "opp_lineup_k", "opp_lineup_k_weighted", "opp_lineup_k_resolved", "opp_team_season_k", "league_lineup_k",
    "whiff_leverage",
    "actual_k", "ou_result", "lean", "lean_result",
    "projection_raw", "calibration_band", "k_rate_used", "opp_k_adjustment", "calibration_bias",
    "error_raw", "abs_error_raw", "error_corrected", "abs_error_corrected", "projection"
  ];
  const KHEAD = KLOG_COLUMNS.join(",") + "\n";
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
      // 2026-08-14: same bug fixed the same way as the attribution ledger above
      // -- this check used to only gate the HEADER TEXT rewrite, not whether
      // rows got appended below. On a width mismatch that meant: header stays
      // old, a warning prints, and new rows still get appended in the NEW
      // column count underneath it -- silently misaligning every column.
      // klogHeaderOk now actually gates the grading loop and append below.
      let klogHeaderOk = true;
      {
        const cur = fs.readFileSync(KLOG, "utf8");
        const nl = cur.indexOf("\n");
        const curHead = (nl === -1 ? cur : cur.slice(0, nl)).trim();
        const wantHead = KHEAD.trim();
        if (curHead !== wantHead) {
          if (curHead.split(",").length === KLOG_COLUMNS.length) {
            // Same width, different names/order -- safe to swap the header text only.
            fs.writeFileSync(KLOG, wantHead + "\n" + (nl === -1 ? "" : cur.slice(nl + 1)));
            console.log("K-props ledger header text updated (same column count, new names/order).");
          } else {
            klogHeaderOk = false;
            console.warn(`K-props ledger header does not match the current ${KLOG_COLUMNS.length}-column schema `
              + `and is a different width -- NOT auto-upgrading (would misalign existing rows). `
              + `SKIPPING K-props grading this run so nothing gets appended under the wrong header. `
              + `Rebuild the file from a fresh backfill, then re-run.`);
          }
        }
      }
      if (!klogHeaderOk) {
        console.log("K-props: skipped grading this run — header mismatch, see warning above. Nothing appended.");
      } else {
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
      const kSeen = new Set(fs.readFileSync(KLOG, "utf8").split("\n").slice(1).map(l => { const p = l.split(","); return p.length >= 2 ? `${normDate(p[0])},${p[1]}` : ""; }).filter(Boolean));
      const kRows = [];
      // Collected alongside kRows so the data/k-props/<date>.xlsx refresh
      // below can include EVERY pitcher captured that day (graded or not),
      // not just the ones newly graded this run — kSeen would otherwise
      // silently drop already-graded pitchers from a re-run's xlsx.
      const gradedByName = {};
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
        kRows.push([
          DATE_OUT, csvField(rec.name), rec.line, rec.over ?? "", rec.under ?? "",
          csvField(rec.game || ""), rec.game_pk ?? "", csvField(rec.pitcher_role_label || ""),
          num(rec.expected_innings), bool(rec.bullpen_game), bool(rec.pitching_plan_reported), rec.books ?? "",
          num(rec.k_rate_season), num(rf.starts), num(rf.batters_faced), num(rec.bf_per_ip), num(rf.recent_k_rate), num(rf.weight),
          csvField(rec.opp_k_source || ""), num(rec.opp_lineup_k), num(rec.opp_lineup_k_weighted), rec.opp_lineup_k_resolved ?? "",
          num(rec.opp_team_season_k), num(rec.league_lineup_k),
          num(rec.whiff_leverage),
          actual, ou, lean, leanRes,
          Number.isFinite(rec.projection_raw) ? rec.projection_raw : "", rec.calibration_band || "",
          num(rec.k_rate_used), num(rec.opp_k_adjustment), num(rec.calibration_bias),
          errRaw, absErrRaw, errCorr, absErrCorr,
          Number.isFinite(rec.projection) ? rec.projection : ""
        ].join(","));
        gradedByName[rec.name] = { actual_k: actual, ou_result: ou, lean, lean_result: leanRes };
        kGraded++;
      }
      if (kRows.length) fs.appendFileSync(KLOG, kRows.join("\n") + "\n");
      console.log(`K-props: graded ${kGraded}, scratched ${kScratched}, unlinked-to-a-game ${kUnlinked}.`);

      // Refresh data/k-props/<date>.xlsx with real outcomes now that grading
      // has run. export-kprops-xlsx.js (prepare-slate.yml) already wrote this
      // file pre-game with graded=null on every row; this is what fills in
      // actual_k/ou_result/lean_result/the error columns. gradedByName only
      // holds pitchers graded THIS run (kSeen skips already-graded ones on a
      // re-run), so pull anything already in kprops_log.csv for this date too
      // — the xlsx should always show every pitcher captured that day, graded
      // or not, regardless of how many times this script has run for it.
      // 2026-08-14: reads kprops_log.csv by HEADER NAME (via KLOG_COLUMNS),
      // not by hardcoded position — the 08-09 version of this block read
      // r[6]/r[8] against the old 12-column layout, which would have silently
      // misread the wrong columns under the new 38-column order.
      try {
        const iDate = KLOG_COLUMNS.indexOf("date"), iPitcher = KLOG_COLUMNS.indexOf("pitcher");
        const iActualK = KLOG_COLUMNS.indexOf("actual_k"), iOu = KLOG_COLUMNS.indexOf("ou_result");
        const iLean = KLOG_COLUMNS.indexOf("lean"), iLeanRes = KLOG_COLUMNS.indexOf("lean_result");
        const existingRows = fs.readFileSync(KLOG, "utf8").trim().split("\n").slice(1).map(l => l.split(","));
        for (const r of existingRows) {
          if (r.length <= Math.max(iDate, iPitcher, iActualK, iOu, iLean, iLeanRes)) continue;
          if (normDate(r[iDate]) !== DATE || !r[iPitcher]) continue;
          if (gradedByName[r[iPitcher]]) continue; // this run's fresher value wins
          if (r[iActualK] === "" || r[iActualK] === undefined) continue; // not graded (no actual_k)
          gradedByName[r[iPitcher]] = {
            actual_k: Number(r[iActualK]), ou_result: r[iOu] || "",
            lean: r[iLean] === "" ? "" : Number(r[iLean]), lean_result: r[iLeanRes] || ""
          };
        }
        const xlsxRows = Object.values(kp.pitchers)
          .filter(rec => rec && rec.name)
          .map(rec => buildKpropsXlsxRow(DATE_OUT, rec, gradedByName[rec.name] || null));
        const xlsxPath = path.join(ROOT, "data", "k-props", `${DATE}.xlsx`);
        await writeKpropsXlsx(xlsxPath, xlsxRows);
        console.log(`K-props: refreshed data/k-props/${DATE}.xlsx (${xlsxRows.length} rows, ${Object.keys(gradedByName).length} graded).`);
      } catch (e) {
        // Never let the Excel export break the actual grading run — the CSV
        // ledger above is the real learning data; the xlsx is a convenience
        // export on top of it.
        console.warn(`K-props: xlsx refresh failed (non-fatal): ${e.message}`);
      }
      }
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
      const tSeen = new Set(fs.readFileSync(TLOG, "utf8").split("\n").slice(1).map(l => { const p = l.split(","); return p.length >= 2 ? `${normDate(p[0])},${p[1]}` : ""; }).filter(Boolean));
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
        tRows.push([DATE_OUT, pk, csvField(totalsModelVersion), hasLine ? g.line : "", g.over ?? "", g.under ?? "", Number.isFinite(g.projection) ? g.projection : "", actual, ou, lean, leanRes, Number.isFinite(g.lab) ? g.lab : "", g.classification || (qualifies ? "research_lean" : "no_lean"), csvField(g.game || "")].join(","));
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
  const sExisting = new Set(fs.readFileSync(SLOG, "utf8").split("\n").slice(1).map(l => { const p = l.split(","); return p.length >= 2 ? `${normDate(p[0])},${p[1]}` : ""; }).filter(Boolean));
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
      DATE_OUT, g.game_pk, csvField(officialVersion), csvField(shadowVersion), pHomeOfficial, v3.p_home, f.homeScore > f.awayScore ? 1 : 0,
      Number.isFinite(v3.fip_away) ? v3.fip_away : "", Number.isFinite(v3.fip_home) ? v3.fip_home : "",
      Number.isFinite(v3.off_adj) ? v3.off_adj : "", Number.isFinite(v3.bp_adj) ? v3.bp_adj : "",
      effEraAway, effEraHome, legacyHome, bpRiskAway, bpRiskHome
    ].join(","));
  }
  if (sRows.length) fs.appendFileSync(SLOG, sRows.join("\n") + "\n");
  if (voidRows.length) {
    if (!fs.existsSync(VOIDLOG)) fs.writeFileSync(VOIDLOG, "date,gamePk,side,analyzed_starter,actual_starter\n");
    // 2026-08-14: was a raw full-line Set (including the header line, which
    // never collides with real data so that was harmless) -- switched to a
    // normDate-based date,gamePk,side key, same pattern as every other ledger
    // in this file, so a re-run recognizes today's own already-voided rows
    // regardless of which date format they were written under.
    const seen = new Set(
      fs.readFileSync(VOIDLOG, "utf8").split("\n").slice(1)
        .map(l => { const p = l.split(","); return p.length >= 3 ? `${normDate(p[0])},${p[1]},${p[2]}` : ""; })
        .filter(Boolean)
    );
    const fresh = [...new Set(voidRows)].filter(r => {
      const p = r.split(",");
      return !seen.has(`${normDate(p[0])},${p[1]},${p[2]}`);
    });
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
