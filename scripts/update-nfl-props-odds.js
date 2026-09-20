/*
  Leo — NFL player prop market lines from the-odds-api.

  WHY THIS EXISTS
  ---------------
  Until now the NFL props pipeline produced PROJECTIONS ONLY. There was no
  market number anywhere in it, which meant:
    - no over/under lean could be stated,
    - and, far more important, prop accuracy could never be MEASURED.
  A projection with nothing to price it against cannot be shown to be good or
  bad. This script supplies the missing half.

  WHAT IT DOES NOT DO
  -------------------
  It does not produce picks. It writes lines. Whether our projections beat
  these lines is an open empirical question that the backtest has to answer
  first -- and the moneyline backtest is a standing warning that "our number
  disagrees with the market" is not evidence of edge. See NFL_WATCH_LIST #8/#9.

  QUOTA
  -----
  the-odds-api charges player props per EVENT, at [markets] x [regions]
  credits each. This script requests 4 markets in 1 region across a 14-game
  slate = 14 requests x 4 credits = 56 credits per full refresh. That is not
  free. Remaining quota is printed at the end of every run; --dry-run costs
  nothing but the free event list.

  USAGE
  -----
    node scripts/update-nfl-props-odds.js [--date=YYYY-MM-DD] [--dry-run]
*/
const fs = require("fs");
const path = require("path");
const { fetchOddsApi, getLastQuota } = require("./lib/odds-api-core");
const { appendObservations } = require("./lib/odds-history");

const SPORT = "americanfootball_nfl";
const REGIONS = "us";

// Our market key -> the-odds-api market key. `kind` drives parsing:
// "ou" markets carry a point (a line to go over/under); "yesno" markets
// (anytime TD) carry a price on an event happening at all.
const MARKETS = [
  { ours: "QB_PASS_YARDS", theirs: "player_pass_yds",       kind: "ou"    },
  { ours: "RB_RUSH_YARDS", theirs: "player_rush_yds",       kind: "ou"    },
  { ours: "WR_REC_YARDS",  theirs: "player_reception_yds",  kind: "ou"    },
  { ours: "ANYTIME_TD",    theirs: "player_anytime_td",     kind: "yesno" }
];

const argDate = (process.argv.find(a => a.startsWith("--date=")) || "").split("=")[1];
const DRY = process.argv.includes("--dry-run");
const DATE = argDate || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const DIR = path.join(__dirname, "..", "data", "nfl");

// consensus = the most common posted line. A median can invent a line no book
// actually offers, which makes "best price at the line" meaningless.
// (Same definition as update-k-props.js -- kept identical on purpose.)
const consensus = a => {
  const counts = {};
  for (const v of a) counts[v] = (counts[v] || 0) + 1;
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  return Number(Object.entries(counts)
    .sort((x, y) => y[1] - x[1] || Math.abs(x[0] - mean) - Math.abs(y[0] - mean))[0][0]);
};

const americanToProb = p =>
  !Number.isFinite(p) ? null : (p > 0 ? 100 / (p + 100) : -p / (-p + 100));

async function main() {
  const events = await fetchOddsApi(`https://api.the-odds-api.com/v4/sports/${SPORT}/events`);
  const todays = (events || []).filter(e =>
    new Date(e.commence_time).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === DATE);

  console.log(`NFL prop odds: ${todays.length} event(s) on ${DATE}.`);
  if (!todays.length) {
    console.log("No events — leaving existing files untouched (WATCH LIST #4).");
    return;
  }

  const marketList = MARKETS.map(m => m.theirs).join(",");
  const estimate = todays.length * MARKETS.length;
  console.log(`Requesting ${MARKETS.length} markets x ${todays.length} events ≈ ${estimate} credits.`);
  if (DRY) { console.log("--dry-run: stopping before any paid call."); return; }

  const out = [];
  let fetched = 0, failed = 0;

  for (const ev of todays) {
    let data;
    try {
      data = await fetchOddsApi(
        `https://api.the-odds-api.com/v4/sports/${SPORT}/events/${ev.id}/odds` +
        `?regions=${REGIONS}&markets=${marketList}&oddsFormat=american`);
      fetched++;
    } catch (e) { console.warn(`  event ${ev.id} (${ev.away_team} @ ${ev.home_team}): ${e.message}`); failed++; continue; }

    for (const spec of MARKETS) {
      // rows[playerName] = [{point, over, under, yes, no, book}, ...]
      const rows = {};
      for (const bk of data.bookmakers || []) {
        const mkt = (bk.markets || []).find(m => m.key === spec.theirs);
        if (!mkt) continue;
        const byPlayer = {};
        for (const o of mkt.outcomes || []) {
          const name = (o.description || "").trim();
          if (!name) continue;
          const side = String(o.name || "").toLowerCase();
          (byPlayer[name] = byPlayer[name] || {})[side] = { price: o.price, point: o.point };
        }
        for (const [name, sides] of Object.entries(byPlayer)) {
          if (spec.kind === "ou") {
            const pt = (sides.over && sides.over.point) ?? (sides.under && sides.under.point);
            if (!Number.isFinite(pt)) continue;
            (rows[name] = rows[name] || []).push({
              point: pt,
              over: sides.over ? sides.over.price : null,
              under: sides.under ? sides.under.price : null,
              book: bk.key
            });
          } else {
            const yes = sides.yes ? sides.yes.price : null;
            if (!Number.isFinite(yes)) continue;
            (rows[name] = rows[name] || []).push({
              yes, no: sides.no ? sides.no.price : null, book: bk.key
            });
          }
        }
      }

      for (const [name, arr] of Object.entries(rows)) {
        if (spec.kind === "ou") {
          const line = consensus(arr.map(r => r.point));
          const atLine = arr.filter(r => Math.abs(r.point - line) < 0.01);
          const bestOver  = atLine.filter(r => r.over  !== null).sort((a, b) => b.over  - a.over )[0] || null;
          const bestUnder = atLine.filter(r => r.under !== null).sort((a, b) => b.under - a.under)[0] || null;
          out.push({
            date: DATE, market: spec.ours, name,
            game: `${ev.away_team} @ ${ev.home_team}`,
            kickoff: ev.commence_time,
            line,
            over_price:  bestOver  ? bestOver.over   : null,
            under_price: bestUnder ? bestUnder.under : null,
            books: arr.length, books_at_line: atLine.length
          });
        } else {
          // Anytime TD is a Yes/No market and most US books post only the Yes
          // side. Raw implied probability from a one-sided price INCLUDES the
          // vig, so it is systematically HIGHER than the true probability.
          // Comparing our (true-probability) projection against it would
          // manufacture a phantom "under" lean on every player in the league.
          // So: de-vig only when both sides exist, and flag it when we can't.
          const bestYes = arr.filter(r => Number.isFinite(r.yes)).sort((a, b) => b.yes - a.yes)[0] || null;
          const withNo  = arr.filter(r => Number.isFinite(r.no));
          const pairSrc = withNo.length ? withNo[0] : null;
          const rawYes  = bestYes ? americanToProb(bestYes.yes) : null;
          let devigged = null;
          if (pairSrc) {
            const py = americanToProb(pairSrc.yes), pn = americanToProb(pairSrc.no);
            if (Number.isFinite(py) && Number.isFinite(pn) && py + pn > 0) devigged = py / (py + pn);
          }
          out.push({
            date: DATE, market: spec.ours, name,
            game: `${ev.away_team} @ ${ev.home_team}`,
            kickoff: ev.commence_time,
            line: null,
            yes_price: bestYes ? bestYes.yes : null,
            implied_prob_raw: rawYes == null ? null : Number(rawYes.toFixed(4)),
            implied_prob: devigged == null ? null : Number(devigged.toFixed(4)),
            vig_removed: devigged != null,
            books: arr.length
          });
        }
      }
    }
  }

  const byMarket = {};
  out.forEach(r => byMarket[r.market] = (byMarket[r.market] || 0) + 1);
  console.log(`  fetched ${fetched} event(s), ${failed} failed; ${out.length} priced entries`);
  console.log(`  by market:`, byMarket);

  const noVig = out.filter(r => r.market === "ANYTIME_TD" && !r.vig_removed).length;
  if (noVig) console.log(`  NOTE: ${noVig} anytime-TD entries are one-sided (vig NOT removed) — no lean will be stated for those.`);

  // WATCH LIST #4: never promote an empty payload to the rolling file.
  if (!out.length) {
    console.log("No priced entries — leaving -today.json untouched.");
    return;
  }
  const payload = {
    date: DATE,
    generated_at: new Date().toISOString(),
    source: `the-odds-api ${MARKETS.map(m => m.theirs).join(", ")} (${REGIONS} region; consensus = most common posted line, best price at it)`,
    events_fetched: fetched,
    entries: out
  };
  // PERMANENT RECORD. The snapshots below get overwritten by the next run of
  // the day; this does not. Closing line = the last row here whose captured_at
  // precedes that game's kickoff.
  const capturedAt = new Date().toISOString();
  const HIST_COLS = ["captured_at","date","kickoff","game","market","player",
                     "line","over_price","under_price","implied_prob","implied_prob_raw",
                     "vig_removed","books"];
  const hist = appendObservations(
    path.join(DIR, "odds-history-props.csv"),
    HIST_COLS,
    out.map(r => ({
      captured_at: capturedAt, date: r.date, kickoff: r.kickoff || "",
      game: r.game, market: r.market, player: r.name,
      line: r.line ?? "", over_price: r.over_price ?? "", under_price: r.under_price ?? "",
      implied_prob: r.implied_prob ?? "", implied_prob_raw: r.implied_prob_raw ?? "",
      vig_removed: r.vig_removed ?? "", books: r.books ?? ""
    })),
    ["date","game","market","player"],
    ["line","over_price","under_price","implied_prob","implied_prob_raw"]
  );
  console.log(`  history: +${hist.appended} moved/new, ${hist.unchanged} unchanged` +
              (hist.created ? " (created odds-history-props.csv)" : ""));

  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `prop-odds-${DATE}.json`), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(DIR, `prop-odds-today.json`),   JSON.stringify(payload, null, 2));
  console.log(`  wrote prop-odds-${DATE}.json and prop-odds-today.json`);

  const q = getLastQuota();
  if (q) console.log(`  quota: ${q.remaining} remaining / ${q.used} used (${q.keyName})`);
}

main().catch(e => { console.error(e); process.exit(1); });
