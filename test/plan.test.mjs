import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlan, mintSignalId,
  MIN_TARGET_R, MIN_TARGET_SEPARATION_R, MIN_RISK_REWARD, EXTENSION_R_MULTIPLE,
} from '../src/engine/plan.mjs';
import { pathFrom, candlesFrom, mirror, ramp, makeSnapshot } from './fixtures.mjs';

/**
 * A failed lower-high rally with prior lows far below to serve as targets.
 * Long enough for a 20-period EMA and a 14-period ATR to be real, since the
 * signals refuse to judge on less than 60 candles.
 */
const SHORT_SETUP = pathFrom([
  { at: 0, price: 100 }, { at: 22, price: 70 },
  { at: 30, price: 84 }, { at: 38, price: 76 },
  { at: 46, price: 92 }, { at: 54, price: 84 },
  { at: 62, price: 90 }, { at: 70, price: 86 },
]);

const FLAT = ramp(120, 100, 100).map((p, i) => p + (i % 2 === 0 ? 0.05 : -0.05));

const opts = { timeframe: '1h', stake: 1000, riskFraction: 0.02, leverage: 3 };
const shortPlan = () => buildPlan(makeSnapshot({ closes: SHORT_SETUP }), opts);

test('mintSignalId is stable for identical input', () => {
  const p = {
    symbol: 'BTCUSDT', timeframe: '1h', direction: 'short',
    codes: ['RF', 'TS'], pivotTime: 123, invalidation: 80000, entry: 79000,
  };
  assert.equal(mintSignalId(p), mintSignalId({ ...p }));
});

test('mintSignalId ignores noise below six significant figures', () => {
  const base = {
    symbol: 'BTCUSDT', timeframe: '1h', direction: 'short',
    codes: ['RF'], pivotTime: 123, invalidation: 80000.0000001, entry: 79000,
  };
  assert.equal(
    mintSignalId(base),
    mintSignalId({ ...base, invalidation: 80000.0000002 }),
  );
});

test('mintSignalId changes when the setup actually changes', () => {
  const base = {
    symbol: 'BTCUSDT', timeframe: '1h', direction: 'short',
    codes: ['RF'], pivotTime: 123, invalidation: 80000, entry: 79000,
  };
  const id = mintSignalId(base);
  assert.notEqual(id, mintSignalId({ ...base, invalidation: 81000 }));
  assert.notEqual(id, mintSignalId({ ...base, direction: 'long' }));
  assert.notEqual(id, mintSignalId({ ...base, pivotTime: 456 }));
  assert.notEqual(id, mintSignalId({ ...base, timeframe: '4h' }));
});

test('signal ids read as asset, signal, digest', () => {
  const id = shortPlan().signalId;
  assert.match(id, /^TEST-(RF|TS|FP|PS)-[0-9a-f]{4}$/);
});

test('building the same plan twice gives the same id — no clock in the hash', () => {
  const snap = makeSnapshot({ closes: SHORT_SETUP });
  const first = buildPlan(snap, opts);
  const second = buildPlan({ ...snap, fetchedAt: snap.fetchedAt + 999_999 }, opts);
  assert.equal(first.signalId, second.signalId);
});

test('a short plan puts invalidation above entry, targets below', () => {
  const p = shortPlan();
  assert.equal(p.direction, 'short');
  assert.ok(p.invalidation.price > p.markPrice, 'invalidation should sit above entry');
  for (const t of p.targets) {
    assert.ok(t.price < p.markPrice, `${t.label} should sit below entry`);
  }
});

test('a long plan is the mirror image', () => {
  const candles = mirror(candlesFrom(SHORT_SETUP), 100);
  const p = buildPlan(makeSnapshot({ candlesOverride: candles }), opts);
  assert.equal(p.direction, 'long');
  assert.ok(p.invalidation.price < p.markPrice, 'invalidation should sit below entry');
  for (const t of p.targets) {
    assert.ok(t.price > p.markPrice, `${t.label} should sit above entry`);
  }
});

test('targets are ordered away from entry and never double back', () => {
  const p = shortPlan();
  const distances = p.targets.map((t) => Math.abs(t.price - p.markPrice));
  for (let i = 1; i < distances.length; i++) {
    assert.ok(distances[i] > distances[i - 1], `T${i + 1} is not further out than T${i}`);
  }
});

test('no target sits closer than the minimum, or clustered against another', () => {
  const p = shortPlan();
  assert.ok(p.targets[0].r >= MIN_TARGET_R, `T1 at ${p.targets[0].r}R is too close`);
  for (let i = 1; i < p.targets.length; i++) {
    const gap = Math.abs(p.targets[i].price - p.targets[i - 1].price) / p.riskDistance;
    assert.ok(gap >= MIN_TARGET_SEPARATION_R, `T${i + 1} is clustered against T${i}`);
  }
});

test('risk-reward is the first target measured against the invalidation', () => {
  const p = shortPlan();
  const expected = Math.abs(p.targets[0].price - p.markPrice) / p.riskDistance;
  assert.ok(Math.abs(p.riskReward - expected) < 1e-9);
  assert.ok(Math.abs(p.targets[0].r - expected) < 1e-9);
});

test('a synthetic target is labelled as one, never as a real level', () => {
  const p = shortPlan();
  for (const t of p.targets) {
    assert.ok(
      t.basis === 'prior pivot' || t.basis === `${EXTENSION_R_MULTIPLE}R extension`,
      `unexpected basis: ${t.basis}`,
    );
  }
  const synthetic = p.targets.filter((t) => t.basis !== 'prior pivot');
  if (synthetic.length) assert.ok(p.notes.length > 0, 'an extension should be explained in notes');
});

test('no plan on flat noise, and it says why', () => {
  const p = buildPlan(makeSnapshot({ closes: FLAT }), opts);
  assert.equal(p.tradeable, false);
  assert.equal(p.signalId, null);
  assert.equal(p.direction, null);
  assert.match(p.reason, /Nothing fired/);
});

test('counterexamples carry the signal they came from, including quiet ones', () => {
  const p = shortPlan();
  assert.ok(p.counterexamples.length > 0);
  for (const c of p.counterexamples) {
    assert.ok(c.from, 'every counterexample should name its source');
    assert.notEqual(c.label, 'None found');
  }
  // A quiet signal explaining its silence is the most useful objection there is.
  const fromQuiet = p.counterexamples.filter((c) => p.agreement.quiet.includes(c.from));
  assert.ok(fromQuiet.length > 0, 'expected an objection raised by a signal that did not fire');
});

test('poor geometry is reported as an objection rather than hidden', () => {
  const p = shortPlan();
  const flagged = p.counterexamples.some((c) => c.from === 'plan');
  if (p.riskReward < MIN_RISK_REWARD) {
    assert.ok(flagged, 'a sub-minimum R:R should raise a plan-level objection');
  } else {
    assert.equal(flagged, false, 'nothing to object to when the geometry is fine');
  }
});

test('a valid setup that cannot be sized is not tradeable, and explains itself', () => {
  const p = buildPlan(makeSnapshot({ closes: SHORT_SETUP }), { ...opts, stake: 0.5 });
  assert.equal(p.tradeable, false);
  assert.ok(p.signalId, 'the setup still exists and still gets an id');
  assert.match(p.reason, /not sizeable/);
  assert.equal(p.sizing.ok, false);
  assert.ok(p.sizing.refusals.length > 0);
});

test('a plan carries no aggregate score', () => {
  const p = shortPlan();
  assert.equal(p.score, undefined);
  assert.equal(p.confidence, undefined);
});
