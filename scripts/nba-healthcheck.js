#!/usr/bin/env node
/**
 * Refuse to publish a broken NBA card. Fails (exit 1) on structural defects,
 * warns on things the nightly audit should look at.
 *
 *   node scripts/nba-healthcheck.js [YYYY-MM-DD]
 */
const fs = require("fs");
const path = require("path");
const DIR = path.join(__dirname, "..", "data", "nba");
const DATE = process.argv[2] || new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const fails = [], warns = [];
const file = path.join(DIR, `picks-${DATE}.json`);
if (!fs.existsSync(file)) { console.log(`No NBA card for ${DATE}. Nothing to check.`); process.exit(0); }
const d = JSON.parse(fs.readFileSync(file, "utf8"));
const model = JSON.parse(fs.readFileSync(path.join(DIR, "model.json"), "utf8"));
const teams = new Set(Object.keys(model.prior_ratings));

if (!Array.isArray(d.games) || !d.games.length) fails.push("card has no games");
for (const g of d.games || []) {
  const id = `${g.away}@${g.home}`, L = g.leo;
  if (!L) { fails.push(`${id}: no Leo read`); continue; }
  if (!teams.has(g.home) || !teams.has(g.away)) fails.push(`${id}: team code not in model ratings (ESPN code change?)`);
  if (!(L.p_home > 0.01 && L.p_home < 0.99)) fails.push(`${id}: win chance ${L.p_home} out of range`);
  if (!(Math.abs(L.home_margin) < 35)) fails.push(`${id}: margin ${L.home_margin} out of range`);
  if (Math.abs((L.lost.home || 0) - (L.lost.away || 0)) > 40) warns.push(`${id}: value missing gap ${L.lost.home}/${L.lost.away} is unusually large`);
  if (!g.market || g.market.home_spread == null) warns.push(`${id}: no DraftKings spread yet`);
  if (L.edge_pts != null && Math.abs(L.edge_pts) >= 10) warns.push(`${id}: Leo is ${Math.abs(L.edge_pts)} pts off the line; check the injury inputs`);
}
const n = (d.games || []).length, leans = (d.games || []).filter(g => g.leo && g.leo.lean).length;
if (n >= 4 && leans / n > 0.5) warns.push(`${leans} of ${n} games are leans. An efficient market should not leave that many; check ratings and injuries.`);
if (d.data_through) {
  const lag = (Date.parse(DATE) - Date.parse(d.data_through)) / 864e5;
  if (lag > 4) fails.push(`results data ends ${d.data_through}, ${lag} days before the card`);
  else if (lag > 2) warns.push(`results data ends ${d.data_through}`);
}
const injAge = d.injuries_as_of ? (Date.parse(d.generated_at) - Date.parse(d.injuries_as_of)) / 36e5 : 99;
if (injAge > 24) fails.push(`injury report is ${injAge.toFixed(0)} hours old`);

for (const w of warns) console.log(`::warning::NBA ${w}`);
for (const f of fails) console.log(`::error::NBA ${f}`);
console.log(`NBA health ${DATE}: ${n} games, ${leans} leans, ${fails.length} failures, ${warns.length} warnings.`);
process.exit(fails.length ? 1 : 0);
