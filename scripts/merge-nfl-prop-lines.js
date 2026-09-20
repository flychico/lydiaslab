/*
  Leo — attach market lines to NFL prop projections and state an over/under lean.

  READ THIS BEFORE TRUSTING A LEAN
  --------------------------------
  A lean here is DESCRIPTIVE, not a pick. It says only "our number sits above
  / below the posted line." Whether that disagreement predicts anything is an
  open question, and the moneyline evidence argues for caution: across 599
  bets in 2023-25 the model's LARGEST disagreements with the market were its
  WORST bets (ROI -8.1% at a 3% threshold, -38.7% at 20%). See NFL_WATCH_LIST
  #8 and #9. Prop ROI has never been measured at all, which is precisely why
  this script exists -- you cannot measure a projection with nothing to price
  it against.

  Nothing in here sets a pick flag. That gate stays shut until a prop backtest
  says otherwise.

  NOISE FLOOR
  -----------
  Calling "over" on a 0.4-yard difference implies a precision we do not have,
  so a lean is only stated once the gap clears a floor. These floors are
  PROVISIONAL placeholders chosen to suppress obvious noise -- they are not
  backtested and must not be read as thresholds with demonstrated edge.

  USAGE
  -----
    node scripts/merge-nfl-prop-lines.js [--date=YYYY-MM-DD]
*/
const fs = require("fs");
const path = require("path");
const { matchPlayers, gameKeyFromFullNames } = require("./lib/nfl-names");

const DIR = path.join(__dirname, "..", "data", "nfl");
const argDate = (process.argv.find(a => a.startsWith("--date=")) || "").split("=")[1];
const DATE = argDate || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

// Provisional. See header.
const NOISE_FLOOR = {
  QB_PASS_YARDS: { type: "pct", value: 0.05 },
  RB_RUSH_YARDS: { type: "pct", value: 0.05 },
  WR_REC_YARDS:  { type: "pct", value: 0.05 },
  ANYTIME_TD:    { type: "abs", value: 0.03 }
};

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };

function main() {
  const propsFile = path.join(DIR, "props-today.json");
  const oddsFile  = path.join(DIR, "prop-odds-today.json");

  const props = readJson(propsFile);
  if (!Array.isArray(props) || !props.length) {
    console.error(`No props to merge at ${propsFile}`); process.exit(1);
  }
  const odds = readJson(oddsFile);
  if (!odds || !Array.isArray(odds.entries) || !odds.entries.length) {
    // Not an error: odds may simply not be fetched yet. Props stay publishable
    // without lines -- they just carry no lean.
    console.log("No prop odds file yet — props left unchanged (no lines, no lean).");
    process.exit(0);
  }
  if (odds.date !== DATE) {
    console.warn(`WARNING: odds file is dated ${odds.date}, merging for ${DATE}. Stale lines are worse than none.`);
  }

  // Index book entries by "GAME|MARKET" -> Map<bookName, entry>
  const bookIdx = new Map();
  let unmapped = 0;
  for (const e of odds.entries) {
    const [awayFull, homeFull] = String(e.game || "").split(" @ ");
    const gk = gameKeyFromFullNames(awayFull, homeFull);
    if (!gk) { unmapped++; continue; }
    const k = `${gk}|${e.market}`;
    if (!bookIdx.has(k)) bookIdx.set(k, new Map());
    bookIdx.get(k).set(e.name, e);
  }
  if (unmapped) console.warn(`WARNING: ${unmapped} book entries had an unmappable team name — check nfl-names TEAM_BY_FULL_NAME.`);

  // Group our props the same way so matching is scoped to one game + market.
  const groups = new Map();
  for (const p of props) {
    const k = `${p.matchup}|${p.market}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }

  let linked = 0, leaned = 0, noFloor = 0, noDevig = 0;
  const allUnmatched = [], allAmbiguous = [], noGroup = [];

  for (const [k, ours] of groups.entries()) {
    const theirs = bookIdx.get(k);
    if (!theirs) {
      // WATCH LIST #23: skipping this group silently would make these props
      // vanish from every count -- they would be neither linked NOR reported
      // unmatched, and the totals would not add up. Record them explicitly.
      ours.forEach(p => noGroup.push(`${k} :: ${p.player}`));
      continue;
    }
    const { matched, unmatched, ambiguous } = matchPlayers(ours, theirs);
    unmatched.forEach(u => allUnmatched.push(`${k} :: ${u}`));
    ambiguous.forEach(a => allAmbiguous.push(`${k} :: ${a.player} -> ${a.candidates.join(" | ")}`));

    for (const p of ours) {
      const b = matched.get(p.player);
      if (!b) continue;
      linked++;
      p.book_name  = b.name;
      p.books      = b.books;

      if (p.market === "ANYTIME_TD") {
        p.market_prob_raw = b.implied_prob_raw ?? null;
        p.yes_price       = b.yes_price ?? null;
        p.vig_removed     = !!b.vig_removed;
        if (!b.vig_removed || b.implied_prob == null) {
          // One-sided price includes the vig and would fake an "under" on
          // everyone. Refuse to state a lean rather than invent one.
          p.market_prob = null; p.edge = null; p.lean = null; p.lean_blocked = "one_sided_no_devig";
          noDevig++; continue;
        }
        p.market_prob = b.implied_prob;
        p.edge = Number((p.projection - b.implied_prob).toFixed(4));
      } else {
        if (!Number.isFinite(b.line)) continue;
        p.line        = b.line;
        p.over_price  = b.over_price ?? null;
        p.under_price = b.under_price ?? null;
        p.edge = Number((p.projection - b.line).toFixed(2));
      }

      const floor = NOISE_FLOOR[p.market];
      const base  = p.market === "ANYTIME_TD" ? 1 : Math.abs(p.line || 0);
      const need  = floor.type === "pct" ? base * floor.value : floor.value;
      if (Math.abs(p.edge) >= need) { p.lean = p.edge > 0 ? "over" : "under"; leaned++; }
      else { p.lean = null; p.lean_blocked = "inside_noise_floor"; noFloor++; }
    }
  }

  console.log(`\nNFL PROP LINE MERGE — ${DATE}\n${"=".repeat(58)}`);
  console.log(`  projections            ${props.length}`);
  console.log(`  linked to a market line ${linked}`);
  console.log(`  lean stated             ${leaned}`);
  console.log(`  suppressed: noise floor ${noFloor}`);
  console.log(`  suppressed: no de-vig   ${noDevig}`);
  console.log(`  unmatched names         ${allUnmatched.length}`);
  console.log(`  ambiguous names         ${allAmbiguous.length}`);
  console.log(`  no lines for game+market ${noGroup.length}`);
  const accounted = linked + allUnmatched.length + allAmbiguous.length + noGroup.length;
  console.log(`  ${"-".repeat(40)}`);
  console.log(`  accounted for           ${accounted} / ${props.length}` +
              (accounted === props.length ? "  OK" : "  <-- MISMATCH, projections are going missing"));

  // WATCH LIST #23: an unmatched name looks identical to "no line posted".
  // Print them. Never swallow them.
  if (allUnmatched.length) {
    console.log(`\n  UNMATCHED (no line attached — verify these are genuinely unposted):`);
    allUnmatched.slice(0, 25).forEach(u => console.log(`    ${u}`));
    if (allUnmatched.length > 25) console.log(`    ... and ${allUnmatched.length - 25} more`);
  }
  if (noGroup.length) {
    console.log(`\n  NO LINES POSTED for these game+market groups (${noGroup.length} projections):`);
    [...new Set(noGroup.map(g => g.split(" :: ")[0]))].forEach(g => console.log(`    ${g}`));
  }
  if (allAmbiguous.length) {
    console.log(`\n  AMBIGUOUS (refused rather than guessed):`);
    allAmbiguous.forEach(a => console.log(`    ${a}`));
  }
  console.log("=".repeat(58) + "\n");

  fs.writeFileSync(path.join(DIR, `props-${DATE}.json`), JSON.stringify(props, null, 2));
  fs.writeFileSync(path.join(DIR, `props-today.json`),   JSON.stringify(props, null, 2));
  console.log(`  wrote props-${DATE}.json and props-today.json`);
}

main();
