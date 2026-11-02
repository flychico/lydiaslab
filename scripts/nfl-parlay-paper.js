#!/usr/bin/env node
/**
 * Leo NFL: two-leg moneyline parlays, tracked on paper (DEC-20261102-07).
 *
 * Lynold's yes, Nov 2: track every pair of moneyline CALLS on the same slate
 * date as a two-leg parlay, privately. Nothing is published: this prints to
 * the terminal only and writes no file. The scheduled review copies the
 * result into the Project doc nfl/PARLAY_PAPER.md.
 *
 * Legs: the graded moneyline rows in data/nfl/nfl-results-log.csv (frozen
 * pre-kickoff read) that pass the calls rule: more than 60% and priced
 * better than -230 (scripts/lib/nfl-calls.js). Price is the price at the
 * frozen read. One unit per parlay. A pushed leg drops out (the parlay
 * becomes a single at that leg's price).
 *
 * Parlays are a test, not advice. The gate for anything public stays: a
 * single-leg market must show profit and positive closing line value first.
 *
 * Usage: node scripts/nfl-parlay-paper.js [--from=2026-11-01]
 */
const fs = require("fs"), path = require("path");
const { RULES } = require("./lib/nfl-calls");
const ROOT = path.join(__dirname, "..");
const FROM = (process.argv.find(a => a.startsWith("--from=")) || "--from=2026-11-01").slice(7);

const lines = fs.readFileSync(path.join(ROOT, "data/nfl/nfl-results-log.csv"), "utf8").trim().split(/\r?\n/);
const head = lines.shift().split(",");
const rows = lines.map(l => { const c = l.split(","); return Object.fromEntries(head.map((h, i) => [h, c[i]])); });
const dec = p => p > 0 ? 1 + p / 100 : 1 + 100 / -p;

const legs = rows.filter(r => r.market === "moneyline" && r.date >= FROM && ["W", "L", "P"].includes(r.result))
  .map(r => ({ date: r.date, matchup: r.matchup, side: r.leo_side, prob: +r.leo_value, price: +r.market_price, result: r.result }))
  .filter(x => x.prob > RULES.ML_MIN_PROB && Number.isFinite(x.price) && x.price !== 0 && x.price > RULES.ML_PRICE_LIMIT);

const byDate = {};
for (const l of legs) (byDate[l.date] = byDate[l.date] || []).push(l);
let n = 0, won = 0, units = 0;
const out = [];
for (const [date, L] of Object.entries(byDate).sort()) {
  for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
    const a = L[i], b = L[j];
    let res, pay;
    if (a.result === "L" || b.result === "L") { res = "L"; pay = -1; }
    else { const m = (a.result === "W" ? dec(a.price) : 1) * (b.result === "W" ? dec(b.price) : 1); res = m === 1 ? "P" : "W"; pay = m - 1; }
    n++; if (res === "W") won++; units += pay;
    out.push(`${date}  ${a.side} ${a.price > 0 ? "+" : ""}${a.price} (${a.result}) + ${b.side} ${b.price > 0 ? "+" : ""}${b.price} (${b.result})  ${res} ${pay >= 0 ? "+" : ""}${pay.toFixed(2)}u`);
  }
}
const sw = legs.filter(l => l.result === "W").length, sl = legs.filter(l => l.result === "L").length;
const su = legs.reduce((s, l) => s + (l.result === "W" ? dec(l.price) - 1 : l.result === "L" ? -1 : 0), 0);
console.log(`Two-leg moneyline parlays on paper, from ${FROM}`);
console.log(out.join("\n") || "  none yet");
console.log(`Parlays: ${won}-${n - won} of ${n}, ${units >= 0 ? "+" : ""}${units.toFixed(2)}u at 1 unit each`);
console.log(`Same legs as singles: ${sw}-${sl}, ${su >= 0 ? "+" : ""}${su.toFixed(2)}u`);
console.log(n < 50 ? `Early read: ${n} parlays, under 50.` : "");
