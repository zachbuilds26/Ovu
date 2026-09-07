import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reboundFailure, trendSuppression, fundingPressure, positioningShift,
  evaluate, SIGNALS,
} from '../src/engine/signals.mjs';
import { pathFrom, candlesFrom, ramp, makeSnapshot } from './fixtures.mjs';

const BEARISH_REBOUND = pathFrom([
  { at: 0, price: 100 }, { at: 30, price: 85 },
  { at: 38, price: 92 }, { at: 46, price: 86 },
  { at: 53, price: 90 }, { at: 60, price: 82 },
]);

const FLAT = ramp(120, 100, 100).map((p, i) => p + (i % 2 === 0 ? 0.05 : -0.05));

test('positioning shift fires short on rising open interest into falling price', () => {
  const r = positioningShift(makeSnapshot({
    closes: ramp(120, 100, 90),
    oiSeries: ramp(48, 1000, 1100),
  }), '1h');
  assert.equal(r.fired, true);
  assert.equal(r.direction, 'short');
  assert.match(r.headline, /New positions are funding the move/);
});

test('positioning shift fires long on rising open interest into rising price', () => {
  const r = positioningShift(makeSnapshot({
    closes: ramp(120, 90, 100),
    oiSeries: ramp(48, 1000, 1100),
  }), '1h');
  assert.equal(r.fired, true);
  assert.equal(r.direction, 'long');
});

test('positioning shift never fires on falling open interest, and says why', () => {
  const r = positioningShift(makeSnapshot({
    closes: ramp(120, 100, 90),
    oiSeries: ramp(48, 1100, 1000),
  }), '1h');
  assert.equal(r.fired, false);
  assert.match(r.headline, /exhaustion rather than conviction/);
  assert.match(
    r.counterexamples.map((c) => c.label).join(' '),
    /Falling open interest/,
  );
});

test('positioning shift refuses to read a move too small to matter', () => {
  const r = positioningShift(makeSnapshot({
    closes: ramp(120, 100, 100.1),
    oiSeries: ramp(48, 1000, 1100),
  }), '1h');
  assert.equal(r.fired, false);
  assert.match(r.headline, /too little to read positioning against/);
});

test('positioning shift raises taker flow running the other way', () => {
  const r = positioningShift(makeSnapshot({
    closes: ramp(120, 100, 90),
    oiSeries: ramp(48, 1000, 1100),
    takerFlow: [{ timestamp: 0, buySellRatio: 1.4, buyVol: 140, sellVol: 100 }],
  }), '1h');
  assert.equal(r.direction, 'short');
  assert.match(
    r.counterexamples.map((c) => c.label).join(' '),
    /Aggressive flow runs the other way/,
  );
});

test('positioning shift raises large accounts positioned against it', () => {
  const r = positioningShift(makeSnapshot({
    closes: ramp(120, 100, 90),
    oiSeries: ramp(48, 1000, 1100),
    topTraderRatio: [{
      timestamp: 0, longAccount: 0.68, shortAccount: 0.32, longShortRatio: 2.11,
    }],
  }), '1h');
  assert.equal(r.direction, 'short');
  assert.match(
    r.counterexamples.map((c) => c.label).join(' '),
    /Large accounts positioned against this/,
  );
});

test('every signal always returns a counter-case, fired or not', () => {
  const snapshots = [
    makeSnapshot({ closes: BEARISH_REBOUND }),
    makeSnapshot({ closes: FLAT }),
    makeSnapshot({ closes: ramp(120, 100, 90), oiSeries: ramp(48, 1000, 1100) }),
    makeSnapshot({ closes: ramp(120, 90, 100), lastFundingRate: -0.0004 }),
  ];

  for (const snap of snapshots) {
    for (const signal of SIGNALS) {
      const r = signal(snap, '1h');
      assert.ok(
        Array.isArray(r.counterexamples) && r.counterexamples.length > 0,
        `${r.id} returned no counterexamples`,
      );
      for (const c of r.counterexamples) {
        assert.ok(c.label && c.detail, `${r.id} counterexample missing label or detail`);
      }
    }
  }
});

test('every signal reports its evidence with a source', () => {
  const snap = makeSnapshot({ closes: ramp(120, 100, 90), oiSeries: ramp(48, 1000, 1100) });
  for (const signal of SIGNALS) {
    for (const e of signal(snap, '1h').evidence) {
      assert.ok(e.label && e.value !== undefined && e.source, `${e.label} is missing a field`);
    }
  }
});

test('nothing fires on flat noise — a signal that always fires is broken', () => {
  const report = evaluate(makeSnapshot({ closes: FLAT }), '1h');
  assert.equal(report.firedCount, 0);
  assert.equal(report.direction, null);
  assert.equal(report.conflicted, false);
});

test('evaluate reports disagreement instead of averaging it away', () => {
  // Price falling with open interest rising is short; shorts paying to hold
  // while price falls is not a long, so build the conflict explicitly.
  const snap = makeSnapshot({
    closes: ramp(120, 100, 90),
    oiSeries: ramp(48, 1000, 1100),
  });
  const report = evaluate(snap, '1h');

  assert.equal(report.symbol, 'TESTUSDT');
  assert.equal(report.signals.length, 4);
  assert.ok(report.firedCount >= 1);
  assert.equal(typeof report.conflicted, 'boolean');
  // No aggregate score anywhere — that is the point.
  assert.equal(report.score, undefined);
});

test('evaluate counts real counterexamples, not the placeholder', () => {
  const report = evaluate(makeSnapshot({ closes: FLAT }), '1h');
  const all = report.signals.flatMap((s) => s.counterexamples);
  const placeholders = all.filter((c) => c.label === 'None found');
  const real = all.filter((c) => c.label !== 'None found');

  // Flat noise leaves some signals with nothing to object to, which is exactly
  // when the placeholder appears — and it must not be counted as an objection.
  assert.ok(placeholders.length > 0, 'expected at least one placeholder on flat noise');
  assert.equal(report.counterexampleCount, real.length);
});
