/*
  Leo — NFL learning system.

  The NFL counterpart to generate-learning-summary.js. That one turns graded
  MLB results into a process review; this one answers a narrower and more
  useful question:

      WHICH FACTOR made the projection wrong?

  Every yardage projection is rate x volume x opponent adjustment. Knowing a
  QB projection missed by 45 yards is not actionable. Knowing the RATE was
  right and the VOLUME was over-projected by nine attempts tells you exactly
  which half of the model to fix. Tyler Shough, 2026-09-20: projected 7.1
  yards per attempt on 42.9 attempts, actually went 7.4 on 34. Rate +10.6,
  volume -63.2. That is a volume model problem, not a passing model problem.

  MARKETS ARE KEPT SEPARATE throughout. QB passing, RB rushing and WR
  receiving have different drivers and different volume stability, and the
  standing rule is that models are never tuned together
  (MODEL_IMPROVEMENT_FRAMEWORK.md).

  READS ONLY FROZEN, GRADED DATA. nfl-props-graded.csv is built from
  pre-kickoff projections, so nothing here is contaminated by hindsight.

  Writes:
    data/nfl/learning/<date>.json        per-run archive
    data/nfl/nfl-learning.json           latest, for any page that wants it
    data/nfl/learning_factors.csv        one row per market per run
    data/nfl/learning_buckets.csv        error by sample size and by adjustment
    data/nfl/learning_findings.csv       plain-language readings

  USAGE
    node scripts/generate-nfl-learning.js
*/
const fs = require("fs");
const path = require("path");
const { splitCsv } = require("./lib/odds-history");

const DIR = path.join(__dirname, "..", "data", "nfl");
const LEDGER = path.join(DIR, "nfl-props-graded.csv");
const MARKETS = [
  { key: "QB_PASS_YARDS", label: "QB passing",   rate: "yards per attempt", vol: "attempts" },
  { key: "RB_RUSH_YARDS", label: "RB rushing",   rate: "yards per carry",   vol: "carries"  },
  { key: "WR_REC_YARDS",  label: "WR receiving", rate: "yards per target",  vol: "targets"  }
];

const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const r2 = x => x == null ? null : Math.round(x * 100) / 100;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const mae  = a => a.length ? mean(a.map(Math.abs)) : null;

function readLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  const lines = fs.readFileSync(LEDGER, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const head = splitCsv(lines[0]);
  return lines.slice(1).map(l => {
    const c = splitCsv(l); const o = {};
    head.forEach((h, i) => o[h] = c[i]);
    return o;
  });
}

function analyseMarket(rows, spec) {
  const r = rows.filter(x => x.market === spec.key && x.excluded !== "Y" && x.actual !== ""
                          && x.rate_effect !== "" && x.volume_effect !== "");
  if (!r.length) return null;

  const projRate = r.map(x => n(x.rate_used)),      actRate = r.map(x => n(x.actual_rate));
  const projVol  = r.map(x => n(x.expected_volume)), actVol = r.map(x => n(x.actual_volume));
  const rateEff  = r.map(x => n(x.rate_effect)),     volEff = r.map(x => n(x.volume_effect));
  const signed   = r.map(x => n(x.actual) - n(x.projection));
  const adj      = r.map(x => n(x.opp_adjustment));

  // Which half of the model does the error live in?
  const rateShare = mae(rateEff), volShare = mae(volEff);
  const dominant = rateShare == null || volShare == null ? null
                 : (volShare > rateShare ? "volume" : "rate");

  /*
    WAS THE OPPONENT ADJUSTMENT WORTH APPLYING?
    Compare the error we got against the error we WOULD have got with the
    adjustment removed. If stripping it lowers the error, the adjustment is
    costing accuracy -- which is worth knowing before adding more of them.
  */
  const withAdj = [], withoutAdj = [];
  for (const x of r) {
    const p = n(x.projection), a = n(x.actual), ad = n(x.opp_adjustment);
    if (p == null || a == null || !ad) continue;
    withAdj.push(p - a);
    withoutAdj.push((p / ad) - a);
  }

  // Does more sample help? games_played is tiny early season, so this is the
  // check that tells us when to trust the model at all.
  const buckets = {};
  for (const x of r) {
    const gp = n(x.games_played);
    const k = gp == null ? "unknown" : gp <= 1 ? "1 game" : gp <= 2 ? "2 games" : gp <= 4 ? "3-4 games" : "5+ games";
    (buckets[k] = buckets[k] || []).push(Math.abs(n(x.actual) - n(x.projection)));
  }
  const bySample = Object.entries(buckets).map(([k, v]) => ({ bucket: k, n: v.length, mae: r2(mean(v)) }))
                    .sort((a, b) => a.bucket.localeCompare(b.bucket));

  const lineErr = r.map(x => n(x.line_abs_error)).filter(x => x != null);
  const ourErr  = r.filter(x => x.line_abs_error !== "").map(x => Math.abs(n(x.actual) - n(x.projection)));
  const beat = r.filter(x => x.beat_line === "Y").length;
  const cmp  = r.filter(x => x.beat_line).length;

  return {
    market: spec.key, label: spec.label, n: r.length,
    rate_unit: spec.rate, volume_unit: spec.vol,
    projection: { mae: r2(mae(signed)), bias: r2(mean(signed)) },
    rate:   { projected: r2(mean(projRate)), actual: r2(mean(actRate)),
              bias: r2(mean(actRate.map((v, i) => v - projRate[i]))),
              mae: r2(mae(actRate.map((v, i) => v - projRate[i]))) },
    volume: { projected: r2(mean(projVol)), actual: r2(mean(actVol)),
              bias: r2(mean(actVol.map((v, i) => v - projVol[i]))),
              mae: r2(mae(actVol.map((v, i) => v - projVol[i]))) },
    attribution: { rate_yards: r2(rateShare), volume_yards: r2(volShare), dominant },
    opponent_adjustment: {
      mean: r2(mean(adj)),
      mae_with: r2(mae(withAdj)), mae_without: r2(mae(withoutAdj)),
      helps: withAdj.length && withoutAdj.length ? mae(withAdj) < mae(withoutAdj) : null
    },
    by_sample: bySample,
    vs_line: { beat, compared: cmp, beat_pct: cmp ? r2(100 * beat / cmp) : null,
               our_mae: r2(mean(ourErr)), line_mae: r2(mean(lineErr)) }
  };
}

function findings(analyses) {
  const out = [];
  for (const a of analyses) {
    if (!a) continue;
    const d = a.attribution.dominant;
    if (d) {
      out.push({ market: a.label, title: "Where the error lives",
        read: `${d === "volume" ? "Volume" : "Rate"} is the larger source of error ` +
              `(${a.attribution.volume_yards} yds from volume vs ${a.attribution.rate_yards} from rate). ` +
              `Fix the ${d} model first; tuning the other half cannot recover this.` });
    }
    if (a.volume.bias != null) {
      const dir = a.volume.bias < 0 ? "OVER" : "under";
      out.push({ market: a.label, title: "Volume bias",
        read: `We ${dir}-project ${a.volume_unit} by ${Math.abs(a.volume.bias)} per player ` +
              `(projected ${a.volume.projected}, actual ${a.volume.actual}).` });
    }
    if (a.rate.bias != null) {
      const dir = a.rate.bias < 0 ? "over" : "under";
      out.push({ market: a.label, title: "Rate bias",
        read: `${a.rate_unit} is ${dir}-projected by ${Math.abs(a.rate.bias)} ` +
              `(projected ${a.rate.projected}, actual ${a.rate.actual}).` });
    }
    if (a.opponent_adjustment.helps === false) {
      out.push({ market: a.label, title: "Opponent adjustment is costing accuracy",
        read: `Error with the adjustment ${a.opponent_adjustment.mae_with}, without it ` +
              `${a.opponent_adjustment.mae_without}. Removing it would be more accurate on this sample.` });
    }
    if (a.vs_line.beat_pct != null) {
      out.push({ market: a.label, title: "Against the closing line",
        read: `Beat the line on ${a.vs_line.beat}/${a.vs_line.compared} (${a.vs_line.beat_pct}%). ` +
              `Our MAE ${a.vs_line.our_mae} vs the line's ${a.vs_line.line_mae}. ` +
              (a.vs_line.beat_pct < 50 ? "The book is the better projection." : "We are ahead, on a small sample.") });
    }
  }
  return out;
}

function main() {
  const rows = readLedger();
  if (!rows.length) { console.log("No graded props yet — nothing to learn from."); return; }

  const dates = [...new Set(rows.map(r => r.date))].sort();
  const analyses = MARKETS.map(m => analyseMarket(rows, m)).filter(Boolean);
  if (!analyses.length) { console.log("No yardage rows with factor data yet."); return; }

  const payload = {
    generated_at: new Date().toISOString(),
    through: dates[dates.length - 1], slates: dates.length,
    graded_rows: rows.filter(r => r.excluded !== "Y" && r.actual !== "").length,
    markets: analyses, findings: findings(analyses)
  };

  fs.mkdirSync(path.join(DIR, "learning"), { recursive: true });
  fs.writeFileSync(path.join(DIR, "learning", `${payload.through}.json`), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(DIR, "nfl-learning.json"), JSON.stringify(payload, null, 2));

  const q = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  const fcols = ["through","market","n","proj_mae","proj_bias","rate_projected","rate_actual","rate_bias",
                 "vol_projected","vol_actual","vol_bias","rate_effect_yds","volume_effect_yds","dominant",
                 "adj_mean","mae_with_adj","mae_without_adj","beat_line_pct","our_mae","line_mae"];
  fs.writeFileSync(path.join(DIR, "learning_factors.csv"), fcols.join(",") + "\n" +
    analyses.map(a => [payload.through, a.market, a.n, a.projection.mae, a.projection.bias,
      a.rate.projected, a.rate.actual, a.rate.bias, a.volume.projected, a.volume.actual, a.volume.bias,
      a.attribution.rate_yards, a.attribution.volume_yards, a.attribution.dominant,
      a.opponent_adjustment.mean, a.opponent_adjustment.mae_with, a.opponent_adjustment.mae_without,
      a.vs_line.beat_pct, a.vs_line.our_mae, a.vs_line.line_mae].map(q).join(",")).join("\n") + "\n");

  fs.writeFileSync(path.join(DIR, "learning_buckets.csv"), "through,market,bucket,n,mae\n" +
    analyses.flatMap(a => a.by_sample.map(b => [payload.through, a.market, b.bucket, b.n, b.mae].map(q).join(","))).join("\n") + "\n");

  fs.writeFileSync(path.join(DIR, "learning_findings.csv"), "market,title,read\n" +
    payload.findings.map(f => [f.market, f.title, f.read].map(q).join(",")).join("\n") + "\n");

  console.log(`\nNFL LEARNING — through ${payload.through}\n${"=".repeat(64)}`);
  for (const a of analyses) {
    console.log(`\n  ${a.label}  (n=${a.n})`);
    console.log(`    projection   MAE ${a.projection.mae}   bias ${a.projection.bias > 0 ? "+" : ""}${a.projection.bias}`);
    console.log(`    ${a.rate_unit.padEnd(18)} projected ${a.rate.projected}  actual ${a.rate.actual}  bias ${a.rate.bias > 0 ? "+" : ""}${a.rate.bias}`);
    console.log(`    ${a.volume_unit.padEnd(18)} projected ${a.volume.projected}  actual ${a.volume.actual}  bias ${a.volume.bias > 0 ? "+" : ""}${a.volume.bias}`);
    console.log(`    error from RATE ${a.attribution.rate_yards} yds  ·  from VOLUME ${a.attribution.volume_yards} yds  ->  ${String(a.attribution.dominant).toUpperCase()} dominates`);
    console.log(`    opp adjustment  with ${a.opponent_adjustment.mae_with}  without ${a.opponent_adjustment.mae_without}  -> ${a.opponent_adjustment.helps ? "helps" : "HURTS"}`);
    console.log(`    vs line         ${a.vs_line.beat}/${a.vs_line.compared} (${a.vs_line.beat_pct}%)   our MAE ${a.vs_line.our_mae} vs line ${a.vs_line.line_mae}`);
    console.log(`    by sample       ${a.by_sample.map(b => `${b.bucket}: ${b.mae} (n=${b.n})`).join("  ·  ")}`);
  }
  console.log("\n" + "=".repeat(64));
  console.log(`  wrote nfl-learning.json, learning_factors.csv, learning_buckets.csv, learning_findings.csv\n`);
}

main();
