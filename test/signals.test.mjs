import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reboundFailure, trendSuppression, fundingPressure, positioningShift,
  evaluate, SIGNALS, THRESHOLDS,
} from '../src/engine/signals.mjs';
import { pathFrom, candlesFrom, mirror, ramp, makeSnapshot } from './fixtures.mjs';

/**
 * A decline, a rally that peaks, a pullback, then a lower rally that fails and
 * drops away. The classic bearish rebound failure.
 */
const BEARISH_REBOUND = pathFrom([
  { at: 0, price: 100 }, { at: 30, price: 85 },
  { at: 38, price: 92 }, { at: 46, price: 86 },
  { at: 53, price: 90 }, { at: 60, price: 82 },
]);

/**
 * Three peaks, each lower than the last, with the bounce into each one shorter:
 * 8 points from the first trough, then 2 from the second.
 */
const BEARISH_SUPPRESSION = pathFrom([
  { at: 0, price: 110 }, { at: 20, price: 90 },
  { at: 28, price: 100 }, { at: 38, price: 90 },
  { at: 46, price: 98 }, { at: 54, price: 94 },
  { at: 60, price: 96 }, { at: 68, price: 88 },
]);

/** Flat noise. Nothing should ever fire on this. */
const FLAT = ramp(120, 100, 100).map((p, i) => p + (i % 2 === 0 ? 0.05 : -0.05));

test('rebound failure fires short on a failed lower-high rally', () => {
  const r = reboundFailure(makeSnapshot({ closes: BEARISH_REBOUND }), '1h');
  assert.equal(r.fired, true);
  assert.equal(r.direction, 'short');
  assert.match(r.headline, /failed below the previous high/);
});

test('rebound failure is symmetric — mirroring the path flips the direction', () => {
  const candles = candlesFrom(BEARISH_REBOUND);
  const bear = reboundFailure(makeSnapshot({ candlesOverride: candles }), '1h');
  const bull = reboundFailure(makeSnapshot({ candlesOverride: mirror(candles, 100) }), '1h');

  assert.equal(bear.direction, 'short');
  assert.equal(bull.direction, 'long');
  assert.equal(bear.fired, bull.fired);
  // The same computation, so the conviction should match too.
  const atrOf = (r) => Number(r.evidence.find((e) => e.label === 'ATR').value);
  assert.ok(Math.abs(atrOf(bear) - atrOf(bull)) < 1e-9);
});

test('rebound failure stays quiet on flat noise', () => {
  const r = reboundFailure(makeSnapshot({ closes: FLAT }), '1h');
  assert.equal(r.fired, false);
  assert.equal(r.direction, null);
});

test('rebound failure refuses a stale pivot', () => {
  // Take the firing path and append a long quiet tail, pushing the failed pivot
  // outside the freshness window.
  const stretched = [...BEARISH_REBOUND, ...ramp(THRESHOLDS.maxPivotAge + 12, 82, 82)];
  const r = reboundFailure(makeSnapshot({ closes: stretched }), '1h');
  assert.equal(r.fired, false);
  assert.match(r.headline, /candles ago, beyond the/);
});

test('trend suppression fires on decaying bounces into lower highs', () => {
  const r = trendSuppression(makeSnapshot({ closes: BEARISH_SUPPRESSION }), '1h');
  assert.equal(r.fired, true);
  assert.equal(r.direction, 'short');
  assert.match(r.headline, /Three lower highs/);
  const decay = r.evidence.find((e) => e.label === 'Decay ratio');
  assert.ok(decay, 'decay ratio should be reported');
});

test('trend suppression is symmetric', () => {
  const candles = candlesFrom(BEARISH_SUPPRESSION);
  const bear = trendSuppression(makeSnapshot({ candlesOverride: candles }), '1h');
  const bull = trendSuppression(makeSnapshot({ candlesOverride: mirror(candles, 100) }), '1h');
  assert.equal(bear.direction, 'short');
  assert.equal(bull.direction, 'long');
});

test('trend suppression stays quiet on flat noise', () => {
  assert.equal(trendSuppression(makeSnapshot({ closes: FLAT }), '1h').fired, false);
});

test('funding pressure says nothing when funding is flat', () => {
  const r = fundingPressure(makeSnapshot({ lastFundingRate: 0.000001 }), '1h');
  assert.equal(r.fired, false);
  assert.match(r.headline, /effectively flat/);
  assert.match(r.counterexamples[0].label, /No crowd to squeeze/);
});

test('funding pressure fires short when longs pay while price falls', () => {
  const r = fundingPressure(makeSnapshot({
    closes: ramp(120, 100, 90),
    lastFundingRate: 0.0004,
    fundingSeries: ramp(8, 0.0003, 0.0004),
  }), '1h');
  assert.equal(r.fired, true);
  assert.equal(r.direction, 'short');
  assert.match(r.headline, /Longs are paying/);
});

test('funding pressure fires long when shorts pay while price rises', () => {
  const r = fundingPressure(makeSnapshot({
    closes: ramp(120, 90, 100),
    lastFundingRate: -0.0004,
    fundingSeries: ramp(8, -0.0003, -0.0004),
  }), '1h');
  assert.equal(r.fired, true);
  assert.equal(r.direction, 'long');
  assert.match(r.headline, /Shorts are paying/);
});

test('funding pressure flags a fresh flip as weak evidence', () => {
  const r = fundingPressure(makeSnapshot({
    closes: ramp(120, 100, 90),
    lastFundingRate: 0.0004,
    fundingSeries: ramp(8, -0.0003, -0.0002),
  }), '1h');
  assert.equal(r.fired, true);
  assert.match(
    r.counterexamples.map((c) => c.label).join(' '),
    /just flipped/,
  );
});

test('funding pressure stays quiet when funding and price agree', () => {
  // Longs paying while price rises is just a trend, not a squeeze.
  const r = fundingPressure(makeSnapshot({
    closes: ramp(120, 90, 100),
    lastFundingRate: 0.0004,
    fundingSeries: ramp(8, 0.0003, 0.0004),
  }), '1h');
  assert.equal(r.fired, false);
  assert.match(r.headline, /nobody is paying to be wrong/);
});
