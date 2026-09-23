import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionStatistics } from '../public/sql-query.js';

test('selection statistics match decimal amounts without floating-point tails', () => {
  const result = selectionStatistics(['0.300000000', '0.54', 0.54, '0.104000000', '0.968', 0, '0.6435', 0, 0, '0.6435']);
  assert.deepEqual(result, { count: 10, nonEmptyCount: 10, numericCount: 10, unavailable: false, sum: '3.739', average: '0.3739', min: '0', max: '0.968', approximate: false });
  assert.equal(selectionStatistics([0.1, 0.2]).sum, '0.3');
  assert.equal(selectionStatistics(['1e-7', '2e-7', '-.0000003']).sum, '0');
});

test('selection statistics preserve large SQL decimals and clearly mark rounded averages', () => {
  const result = selectionStatistics(['9007199254740993', '0.01', -1]);
  assert.equal(result.sum, '9007199254740992.01'); assert.equal(result.average, '3002399751580330.67');
  assert.equal(result.max, '9007199254740993'); assert.equal(result.min, '-1');
  assert.equal(selectionStatistics(['12345678901234567890.123456789', '.000000001']).sum, '12345678901234567890.12345679');
  const recurring = selectionStatistics([1, 0, 0]);
  assert.equal(recurring.average, '0.333333333333'); assert.equal(recurring.approximate, true);
  assert.equal(selectionStatistics([-2, 0, 0]).average, '-0.666666666667');
});

test('selection statistics exclude NULL, text, booleans and blanks without silently producing partial aggregates', () => {
  const result = selectionStatistics([null, undefined, '', ' ', false, true, {}, 'NULL', '2026-09-22', '1,000', '50%', '12x', Infinity, NaN, 0, '-2.5', ' +1e2 ']);
  assert.equal(result.count, 17); assert.equal(result.numericCount, 3); assert.equal(result.nonEmptyCount, 13);
  assert.equal(result.sum, '97.5'); assert.equal(result.average, '32.5');
  for (const values of [[], [null, 'text']]) { const empty = selectionStatistics(values); assert.equal(empty.sum, null); assert.equal(empty.average, null); }
  const oversized = selectionStatistics([1, '1e100000']);
  assert.equal(oversized.unavailable, true); assert.equal(oversized.numericCount, 2); assert.equal(oversized.sum, null);
});
