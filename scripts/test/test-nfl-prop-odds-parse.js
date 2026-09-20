/*
  Fixture test for update-nfl-props-odds.js parsing.
  Stubs the-odds-api so no key and no quota are needed.

  Covers the three things most likely to be silently wrong:
   1. consensus picks the MOST COMMON line, not the mean
   2. best price is taken only from books posting AT that line
   3. anytime TD is de-vigged when two-sided and REFUSED when one-sided
*/
const path = require("path");
const corePath = require.resolve(path.join(__dirname, "..", "lib", "odds-api-core.js"));

const book = (key, markets) => ({ key, markets });
const ou = (mkey, player, point, over, under) => ({
  key: mkey, outcomes: [
    { name: "Over",  description: player, price: over,  point },
    ...(under == null ? [] : [{ name: "Under", description: player, price: under, point }])
  ]
});
const td = (player, yes, no) => ({
  key: "player_anytime_td", outcomes: [
    { name: "Yes", description: player, price: yes },
    ...(no == null ? [] : [{ name: "No", description: player, price: no }])
  ]
});

const EVENT = { id: "evt1", away_team: "Indianapolis Colts", home_team: "Kansas City Chiefs",
                commence_time: new Date().toISOString() };

const ODDS = { bookmakers: [
  // pass yards: three books at 250.5, one at 260.5 -> consensus must be 250.5
  book("b1", [ou("player_pass_yds", "Patrick Mahomes", 250.5, -110, -110)]),
  book("b2", [ou("player_pass_yds", "Patrick Mahomes", 250.5, -105, -115)]),
  book("b3", [ou("player_pass_yds", "Patrick Mahomes", 250.5, -120, -102)]),
  // this book is OFF the consensus line with a juicy over -- must NOT be chosen
  book("b4", [ou("player_pass_yds", "Patrick Mahomes", 260.5, +140, -170)]),
  // anytime TD, two-sided -> de-vig possible
  book("b1", [td("Kenneth Walker", -120, +100)]),
  // anytime TD, one-sided -> de-vig impossible, must be flagged
  book("b2", [td("Travis Kelce", +150, null)])
]};

require.cache[corePath] = { id: corePath, filename: corePath, loaded: true, exports: {
  fetchOddsApi: async (url) => url.includes("/events/") ? ODDS : [EVENT],
  getLastQuota: () => ({ remaining: 4321, used: 56, keyName: "TEST", at: "" })
}};

const DATE = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
process.argv = [process.argv[0], "script", `--date=${DATE}`];

const fs = require("fs");
const DIR = path.join(__dirname, "..", "..", "data", "nfl");
const TARGET = path.join(DIR, `prop-odds-${DATE}.json`);
const ROLLING = path.join(DIR, "prop-odds-today.json");
const backup = new Map();
for (const f of [TARGET, ROLLING]) if (fs.existsSync(f)) backup.set(f, fs.readFileSync(f));

const realWrite = fs.writeFileSync;
let captured = null;
fs.writeFileSync = (f, d, ...r) => { if (String(f).includes("prop-odds")) { captured = JSON.parse(d); return; } return realWrite(f, d, ...r); };

require(path.join(__dirname, "..", "update-nfl-props-odds.js"));

setTimeout(() => {
  fs.writeFileSync = realWrite;
  for (const [f, d] of backup.entries()) realWrite(f, d);

  let pass = 0, fail = 0;
  const check = (label, cond, detail) => {
    if (cond) { console.log(`  PASS  ${label}`); pass++; }
    else { console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); fail++; }
  };

  console.log("\nNFL PROP ODDS PARSE TEST\n" + "=".repeat(58));
  if (!captured) { console.log("  FAIL  script wrote nothing"); process.exit(1); }
  const e = captured.entries;
  const mah = e.find(x => x.market === "QB_PASS_YARDS" && /Mahomes/.test(x.name));
  const kw  = e.find(x => x.market === "ANYTIME_TD" && /Walker/.test(x.name));
  const tk  = e.find(x => x.market === "ANYTIME_TD" && /Kelce/.test(x.name));

  check("consensus = most common line (250.5, not mean)", mah && mah.line === 250.5, mah && `got ${mah.line}`);
  check("best over price taken AT the line, ignoring off-line +140", mah && mah.over_price === -105, mah && `got ${mah.over_price}`);
  check("best under price taken at the line", mah && mah.under_price === -102, mah && `got ${mah.under_price}`);
  check("books_at_line excludes the off-line book", mah && mah.books_at_line === 3, mah && `got ${mah.books_at_line}`);
  check("two-sided TD is de-vigged", kw && kw.vig_removed === true && kw.implied_prob < kw.implied_prob_raw,
        kw && `raw ${kw.implied_prob_raw} devig ${kw.implied_prob}`);
  check("one-sided TD refuses to de-vig", tk && tk.vig_removed === false && tk.implied_prob === null,
        tk && `vig_removed ${tk.vig_removed}`);

  console.log("=".repeat(58));
  console.log(`  ${pass} passed · ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}, 300);
