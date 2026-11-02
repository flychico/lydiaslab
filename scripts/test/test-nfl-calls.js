// Pins the NFL call rules (DEC-20261102-01). node scripts/test/test-nfl-calls.js
const assert = require("assert");
const C = require("../lib/nfl-calls");
const base = { away: "BAL", home: "BUF", pick: "BUF", model_prob: 0.63, price: -162, exp_margin: 5.7, spread_line: 3, proj_total: 55.7, total_line: 54.5 };
let c = C.calls(base);
assert.strictEqual(c.ml.call, "BUF");
assert.strictEqual(c.spread.label, "BUF -3");          // home favoured by 3, Leo by 5.7
assert.strictEqual(c.total.call, null);                 // 1.2 off, under the 1.5 floor
assert.strictEqual(C.calls({ ...base, price: -230 }).ml.call, null, "-230 is a pass");
assert.strictEqual(C.calls({ ...base, price: -229 }).ml.call, "BUF", "-229 is a call");
assert.strictEqual(C.calls({ ...base, model_prob: 0.60 }).ml.call, null, "60% exactly is a pass");
assert.strictEqual(C.calls({ ...base, price: "" }).ml.call, null, "no price, no call");
// margin model says the away team wins while the win chance picks home: spread pass
assert.strictEqual(C.calls({ ...base, exp_margin: -0.2 }).spread.call, null);
// underdog getting points: Leo has home by 0.2, line home -6 -> away +6
c = C.calls({ ...base, away: "PHI", home: "WAS", pick: "WAS", exp_margin: 0.2, spread_line: 6 });
assert.strictEqual(c.spread.label, "PHI +6");
assert.strictEqual(C.calls({ ...base, proj_total: 50 }).total.label, "Under 54.5");
assert.strictEqual(C.calls({ ...base, proj_total: 62 }).total.call, null, "7+ off is too far to trust");
// grading
assert.strictEqual(C.grade("spread", base, { home_score: 27, away_score: 20 }), "W");
assert.strictEqual(C.grade("spread", base, { home_score: 23, away_score: 20 }), "P");
assert.strictEqual(C.grade("ml", base, { home_score: 17, away_score: 20 }), "L");
assert.strictEqual(C.grade("total", { ...base, proj_total: 50 }, { home_score: 20, away_score: 17 }), "W");
console.log("nfl-calls: all checks pass");
