// Pins the NFL call rules (DEC-20261102-01). node scripts/test/test-nfl-calls.js
const assert = require("assert");
const C = require("../lib/nfl-calls");
const base = { away: "BAL", home: "BUF", pick: "BUF", model_prob: 0.63, price: -162, exp_margin: 5.7, spread_line: 3, proj_total: 55.7, total_line: 54.5 };
// DEC-20261119-01: totals are information only, never a call, and not a graded market.
assert.deepStrictEqual(C.MARKETS, ["ml", "spread"]);
{ const t = C.calls({ ...base, proj_total: 50 }).total; assert.strictEqual(t.call, null); assert.strictEqual(t.info, true); assert.strictEqual(t.gap, -4.5); }
assert.strictEqual(C.grade("total", { ...base, proj_total: 50 }, { home_score: 20, away_score: 17 }), "");
assert.strictEqual(C.held([{ ...base, captured_at: "2026-11-15T13:54:00Z", proj_total: 42.9, total_line: 40.5 }]).total.call, null);
{ const cur = C.current({ ml: { call: "BUF" }, spread: { call: null }, total: { call: "Over", label: "Over 40.5" }, count: 2 }, { proj_total: 44, total_line: 40.5 });
  assert.strictEqual(cur.total.info, true); assert.strictEqual(cur.count, 1); assert.strictEqual(cur.total.proj, 44); }
// The rules below are the old total rules, kept tested in case totals return.
C.RULES.TOTAL_CALLS = true;
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
// Tuesday spread lock (from 2026-11-25): the locked side and line win over the read's own numbers
const t0 = { date: "2026-11-29", away: "A", home: "H", pick: "H", model_prob: 0.65, price: -150, exp_margin: 0, spread_line: 7,
  spread_lock_status: "locked", spread_lock_side: "H", spread_lock_line: 2.5 };
assert.strictEqual(C.calls(t0).spread.call, "H"); assert.strictEqual(C.calls(t0).spread.label, "H -2.5");
assert.strictEqual(C.grade("spread", t0, { home_score: 24, away_score: 21 }), "W");   // graded at 2.5, not 7
assert.strictEqual(C.calls({ ...t0, spread_lock_status: "removed", spread_lock_reason: "QB" }).spread.call, null);
assert.strictEqual(C.calls({ ...t0, spread_lock_status: "" }).spread.call, null);      // no lock: no game-day call
// held(): a removal on the last read is not overridden by an earlier locked read
assert.strictEqual(C.held([{ ...t0, captured_at: "1" }, { ...t0, captured_at: "2", spread_lock_status: "removed" }]).spread.call, null);
assert.strictEqual(C.held([{ ...t0, captured_at: "1" }]).spread.lineValue, 2.5);
// before the lock date nothing changes
assert.strictEqual(C.calls({ ...t0, date: "2026-11-23", exp_margin: 10 }).spread.label, "H -7");
console.log("nfl-calls: all checks pass");
