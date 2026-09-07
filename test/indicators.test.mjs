import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sma, ema, emaSeries, trueRange, atr,
  swingHighs, swingLows, baselineVolume, change,
} from '../src/engine/indicators.mjs';

const candle = (high, low, close, volume = 0, openTime = 0) => ({
  openTime, open: close, high, low, close, volume,
});

test('sma averages the last period values', () => {
  assert.equal(sma([1, 2, 3, 4], 2), 3.5);
  assert.equal(sma([5, 5, 5], 3), 5);
  assert.throws(() => sma([1, 2], 3), /needs 3 values/);
});

test('emaSeries seeds from an sma and leaves warmup null', () => {
  // period 3 over [1,2,3,4,5]: seed = 2, k = 0.5, then 3, then 4.
  assert.deepEqual(emaSeries([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('ema returns the latest value, or null without enough history', () => {
  assert.equal(ema([1, 2, 3, 4, 5], 3), 4);
  assert.equal(ema([1, 2], 5), null);
});

test('emaSeries of a flat series is that value', () => {
  assert.deepEqual(emaSeries([7, 7, 7, 7], 2), [null, 7, 7, 7]);
});

test('trueRange accounts for gaps against the previous close', () => {
  // Range is 2, but the gap down from 12 makes the true range 4.
  assert.equal(trueRange(candle(10, 8, 9), 12), 4);
  // No gap: plain high-low.
  assert.equal(trueRange(candle(10, 8, 9), 9), 2);
});

test('atr uses Wilder smoothing and needs period+1 candles', () => {
  const candles = [
    candle(10, 8, 9), candle(11, 9, 10), candle(12, 10, 11), candle(13, 11, 12),
  ];
  assert.equal(atr(candles, 2), 2);
  assert.equal(atr(candles.slice(0, 2), 2), null);
});

test('swingHighs finds confirmed pivot highs only', () => {
  const candles = [1, 5, 2, 8, 3].map((h) => candle(h, 0, h));
  assert.deepEqual(
    swingHighs(candles, 1).map((p) => [p.index, p.price]),
    [[1, 5], [3, 8]],
  );
});

test('swingLows mirrors swingHighs', () => {
  const candles = [5, 1, 4, 0, 6].map((l) => candle(10, l, l));
  assert.deepEqual(
    swingLows(candles, 1).map((p) => [p.index, p.price]),
    [[1, 1], [3, 0]],
  );
});

test('swings cannot be confirmed at the edges', () => {
  // The highest bar is last, so it has no right-hand confirmation yet.
  const candles = [1, 2, 3, 99].map((h) => candle(h, 0, h));
  assert.deepEqual(swingHighs(candles, 1), []);
});

test('baselineVolume excludes the most recent candle', () => {
  const candles = [10, 20, 30, 40].map((v) => candle(1, 1, 1, v));
  // Compares the last candle against the two before it, not against itself.
  assert.equal(baselineVolume(candles, 2), 25);
  assert.equal(baselineVolume(candles.slice(0, 2), 2), null);
});

test('change returns a fraction and refuses a zero base', () => {
  assert.equal(change(100, 110), 0.1);
  assert.equal(change(100, 90), -0.1);
  assert.throws(() => change(0, 5), /from zero/);
});
