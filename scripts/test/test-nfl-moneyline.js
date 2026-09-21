#!/usr/bin/env node
const assert = require('assert');
const {
  PICK_THRESHOLD, buildQbRatings, h2hRecord, fitLogistic, predict, classifyPick
} = require('../lib/nfl-moneyline');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`not ok - ${name}`); throw e; }
}

test('pick threshold is exactly 60%', () => assert.strictEqual(PICK_THRESHOLD, 0.60));
test('60.0% is Too Close to Call', () => assert.strictEqual(classifyPick(.60, 'H', 'A').pick, null));
test('60.1% home is a Leo Pick', () => assert.strictEqual(classifyPick(.601, 'H', 'A').pick, 'H'));
test('39.9% home means 60.1% away is a Leo Pick', () => assert.strictEqual(classifyPick(.399, 'H', 'A').pick, 'A'));
test('40.0% home is Too Close to Call', () => assert.strictEqual(classifyPick(.40, 'H', 'A').pick, null));

test('H2H excludes the current game, future games, and games older than 3 years', () => {
  const games = [
    {gameday:'2021-09-01',game_type:'REG',home_team:'A',away_team:'B',home_score:'30',away_score:'10'}, // too old
    {gameday:'2022-10-01',game_type:'REG',home_team:'A',away_team:'B',home_score:'20',away_score:'10'}, // A win
    {gameday:'2023-10-01',game_type:'REG',home_team:'B',away_team:'A',home_score:'24',away_score:'21'}, // B win
    {gameday:'2024-10-01',game_type:'REG',home_team:'A',away_team:'B',home_score:'27',away_score:'17'}, // A win
    {gameday:'2025-10-01',game_type:'REG',home_team:'A',away_team:'B',home_score:'99',away_score:'0'},  // current, exclude
    {gameday:'2025-12-01',game_type:'REG',home_team:'A',away_team:'B',home_score:'99',away_score:'0'}   // future, exclude
  ];
  const h = h2hRecord(games, 'B', 'A', '2025-10-01', 3);
  assert.deepStrictEqual([h.home_wins,h.away_wins,h.ties,h.games],[2,1,0,3]);
  assert(Math.abs(h.pct_edge - 1/3) < 1e-9);
});

test('H2H direction is from the current home team perspective', () => {
  const games = [
    {gameday:'2024-01-01',game_type:'REG',home_team:'B',away_team:'A',home_score:'31',away_score:'10'}
  ];
  const h = h2hRecord(games, 'B', 'A', '2025-01-01', 3);
  assert.strictEqual(h.home_wins, 0);
  assert.strictEqual(h.away_wins, 1);
  assert.strictEqual(h.pct_edge, -1);
});

test('QB rating is player-specific, not one team value', () => {
  const prior = [];
  const current = [
    {position:'QB',player_display_name:'Good QB',team:'A',attempts:'30',sacks_suffered:'1',passing_epa:'12',passing_cpoe:'8',passing_tds:'3',passing_interceptions:'0'},
    {position:'QB',player_display_name:'Bad QB',team:'A',attempts:'30',sacks_suffered:'4',passing_epa:'-8',passing_cpoe:'-7',passing_tds:'0',passing_interceptions:'3'}
  ];
  const r = buildQbRatings(current, prior);
  assert(r['Good QB']);
  assert(r['Bad QB']);
  assert(r['Good QB'].rating > r['Bad QB'].rating);
});

test('regularized logistic fit learns a positive feature relationship', () => {
  const rows = [];
  for (let i=-20;i<=20;i++) {
    rows.push({x:i/5, home_win:i>0?1:0});
  }
  const m = fitLogistic(rows,['x'],{lambda:.1,iterations:2500,learningRate:.1});
  assert(m.coefficients.x > 0);
  assert(predict(m,{x:3}) > .8);
  assert(predict(m,{x:-3}) < .2);
});

console.log(`\n1..${passed}`);
console.log(`${passed} tests passed`);
