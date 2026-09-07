import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sizePosition, liquidationPrice, roundDownToStep,
  MAX_RISK_FRACTION, DEFAULT_MAINTENANCE_MARGIN_RATE,
} from '../src/engine/risk.mjs';

/** BTCUSDT's real filters, from /fapi/v1/exchangeInfo. */
const BTC = { stepSize: 0.001, minQty: 0.001, minNotional: 50 };

const base = {
  entry: 80000, stop: 78000, direction: 'long',
  stake: 1000, riskFraction: 0.02, leverage: 5, filters: BTC,
};

test('roundDownToStep never rounds up', () => {
  assert.equal(roundDownToStep(0.12399, 0.001), 0.123);
  assert.equal(roundDownToStep(1.9, 0.5), 1.5);
  assert.equal(roundDownToStep(5, 1), 5);
  assert.equal(roundDownToStep(0.0009, 0.001), 0);
});

test('roundDownToStep handles exponent-form steps', () => {
  assert.equal(roundDownToStep(0.00000015, 1e-7), 0.0000001);
  assert.equal(roundDownToStep(2.5e-7, 1e-7), 0.0000002);
});

test('liquidationPrice sits below entry for a long, above for a short', () => {
  const long = liquidationPrice({ entry: 100, leverage: 10, direction: 'long' });
  const short = liquidationPrice({ entry: 100, leverage: 10, direction: 'short' });
  assert.ok(long < 100 && long > 90, `expected just above 90, got ${long}`);
  assert.ok(short > 100 && short < 111, `expected just under 111, got ${short}`);
  // With no maintenance margin it is exactly the leverage boundary.
  assert.equal(
    liquidationPrice({ entry: 100, leverage: 10, direction: 'long', maintenanceMarginRate: 0 }),
    90,
  );
});

test('higher leverage moves liquidation closer to entry', () => {
  const at5 = liquidationPrice({ entry: 100, leverage: 5, direction: 'long' });
  const at25 = liquidationPrice({ entry: 100, leverage: 25, direction: 'long' });
  assert.ok(at25 > at5);
});

test('sizes a valid long from risk per unit', () => {
  const r = sizePosition(base);
  assert.equal(r.ok, true);
  // Risking 2% of 1000 = 20, over a 2000 stop distance, is 0.01 BTC.
  assert.equal(r.qty, 0.01);
  assert.equal(r.notional, 800);
  assert.equal(r.worstCase, 20);
  assert.equal(r.worstCaseFractionOfStake, 0.02);
  assert.equal(r.marginRequired, 160);
  assert.deepEqual(r.notes, []);
});

test('the worst case is always reported and always approximate on liquidation', () => {
  const r = sizePosition(base);
  assert.equal(r.liquidationIsApproximate, true);
  assert.ok(r.liquidationPrice < base.stop);
});

test('refuses a long stop above entry', () => {
  const r = sizePosition({ ...base, stop: 82000 });
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /must sit below entry/);
});

test('refuses a short stop below entry', () => {
  const r = sizePosition({ ...base, direction: 'short', stop: 78000 });
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /must sit above entry/);
});

test('refuses when leverage puts liquidation inside the stop', () => {
  // At 50x, liquidation lands around 78,715 — above the 78,000 stop.
  const r = sizePosition({ ...base, leverage: 50 });
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /liquidated before the stop/);
});

test('refuses a risk fraction above the ceiling', () => {
  const r = sizePosition({ ...base, riskFraction: MAX_RISK_FRACTION + 0.01 });
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /exceeds the 25% ceiling/);
});

test('refuses a size below the exchange minimum quantity', () => {
  const r = sizePosition({ ...base, stake: 10, stop: 79000 });
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /below the exchange minimum quantity/);
});

test('refuses a notional below the exchange minimum', () => {
  // 0.001 BTC at 80,000 is 80 — fine for BTC, refused if the floor were 100.
  const r = sizePosition({
    ...base, stake: 50, stop: 79000, filters: { ...BTC, minNotional: 100 },
  });
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /below the exchange minimum 100/);
});

test('caps size at what leverage allows, and says so', () => {
  const r = sizePosition({ ...base, entry: 80000, stop: 79900, stake: 100, leverage: 2 });
  assert.equal(r.ok, true);
  // 2x on a 100 stake allows 0.0025 BTC, which rounds down to the 0.001 step.
  assert.equal(r.qty, 0.002);
  assert.match(r.notes.join(' '), /capped by 2x leverage/);
  // Actual risk is now below the 2% asked for, which is the safe direction.
  assert.ok(r.worstCaseFractionOfStake < 0.02);
});

test('rejects nonsense inputs before doing any maths', () => {
  for (const bad of [
    { entry: 0 }, { stop: -1 }, { stake: 0 }, { leverage: 0.5 },
    { riskFraction: 0 }, { direction: 'sideways' },
  ]) {
    const r = sizePosition({ ...base, ...bad });
    assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(bad)}`);
    assert.ok(r.refusals.length > 0);
  }
});

test('maintenance margin default is the documented BTC tier', () => {
  assert.equal(DEFAULT_MAINTENANCE_MARGIN_RATE, 0.004);
});
