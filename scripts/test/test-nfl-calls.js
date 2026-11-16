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
// calls stay once made (DEC-20261115-53): Over 40.5 at 8:54, the line moves to
// 41.5 by 11:54 (Leo 42.9, inside 1.5): the earlier call is kept at 40.5
const r1 = { ...base, captured_at: "2026-11-15T13:54:00Z", proj_total: 42.9, total_line: 40.5 };
const r2 = { ...base, captured_at: "2026-11-15T16:54:00Z", proj_total: 42.9, total_line: 41.5 };
let h = C.held([r2, r1]);
assert.strictEqual(h.total.call, "Over"); assert.strictEqual(h.total.row.total_line, 40.5); assert.strictEqual(h.total.held, true);
// the last read's call wins when it has one, even on another side or line
h = C.held([r1, { ...r2, proj_total: 38 }]);
assert.strictEqual(h.total.call, "Under"); assert.strictEqual(h.total.row.total_line, 41.5); assert.strictEqual(h.total.held, false);
// never a call: none
assert.strictEqual(C.held([{ ...r1, total_line: 42.5 }]).total.call, null);
console.log("nfl-calls: all checks pass");
