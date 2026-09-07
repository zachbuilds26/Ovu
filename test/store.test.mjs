import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  record, list, get, resolveEntry, applyResolution, tally,
} from '../src/store/signals.mjs';

function tempLog() {
  const dir = mkdtempSync(join(tmpdir(), 'ovu-log-'));
  return { path: join(dir, 'signals.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const shortPlan = (id = 'BTC-RF-aaaa') => ({
  signalId: id,
  symbol: 'BTCUSDT',
  timeframe: '1h',
  direction: 'short',
  markPrice: 100,
  readAt: 1_000_000,
  tradeable: true,
  riskReward: 2,
  agreement: { fired: ['rebound-failure'], quiet: [], conflicted: false },
  invalidation: { price: 110, basis: 'above the failed high' },
  targets: [
    { label: 'T1', price: 90, r: 1, basis: 'prior pivot' },
    { label: 'T2', price: 80, r: 2, basis: 'prior pivot' },
  ],
  counterexamples: [{ from: 'funding-pressure', label: 'x', detail: 'y' }],
});

const candle = (openTime, high, low) => ({ openTime, high, low, close: (high + low) / 2 });

test('record writes a plan and is idempotent on the same id', () => {
  const { path, cleanup } = tempLog();
  try {
    const first = record(shortPlan(), path);
    assert.equal(first.recorded, true);
    assert.ok(existsSync(path));

    const second = record(shortPlan(), path);
    assert.equal(second.recorded, false, 'the same setup must not be logged twice');
    assert.equal(list(path).length, 1);
  } finally { cleanup(); }
});

test('record refuses a plan with no signal id', () => {
  const { path, cleanup } = tempLog();
  try {
    assert.throws(() => record({ ...shortPlan(), signalId: null }, path), /no signalId/);
  } finally { cleanup(); }
});

test('a recorded entry keeps the levels it was made with', () => {
  const { path, cleanup } = tempLog();
  try {
    record(shortPlan(), path);
    const e = get('BTC-RF-aaaa', path);
    assert.equal(e.invalidation, 110);
    assert.deepEqual(e.targets.map((t) => t.price), [90, 80]);
    assert.equal(e.status, 'open');
    assert.equal(e.outcome, null);
    assert.equal(e.counterexampleCount, 1);
  } finally { cleanup(); }
});

test('resolution stays open when no candle exists since the plan', () => {
  const r = resolveEntry(toEntry(shortPlan()), [candle(999_999, 105, 95)]);
  assert.equal(r.status, 'open');
  assert.match(r.note, /no candles since/);
});

test('a short is invalidated when price trades through the level above', () => {
  const r = resolveEntry(toEntry(shortPlan()), [
    candle(1_000_000, 105, 99),
    candle(1_003_600, 111, 104),
  ]);
  assert.equal(r.status, 'invalidated');
  assert.equal(r.outcome.level, 110);
  assert.equal(r.outcome.at, 1_003_600);
});

test('a short reaches its target when price trades down to it', () => {
  const r = resolveEntry(toEntry(shortPlan()), [
    candle(1_000_000, 101, 95),
    candle(1_003_600, 96, 89),
  ]);
  assert.equal(r.status, 'target-hit');
  assert.equal(r.outcome.label, 'T1');
});

test('the furthest target reached in one candle is the one reported', () => {
  const r = resolveEntry(toEntry(shortPlan()), [candle(1_000_000, 101, 79)]);
  assert.equal(r.status, 'target-hit');
  assert.equal(r.outcome.label, 'T2');
  assert.equal(r.outcome.r, 2);
});

test('when both levels fall inside one candle, the loss is reported', () => {
  // Intra-candle order is unknowable, so the pessimistic reading is the honest one.
  const r = resolveEntry(toEntry(shortPlan()), [candle(1_000_000, 115, 85)]);
  assert.equal(r.status, 'invalidated');
});

test('a long is the mirror image', () => {
  const longEntry = {
    ...toEntry(shortPlan()),
    direction: 'long',
    invalidation: 90,
    targets: [{ label: 'T1', price: 110, r: 1 }],
  };
  assert.equal(resolveEntry(longEntry, [candle(1_000_000, 101, 89)]).status, 'invalidated');
  assert.equal(resolveEntry(longEntry, [candle(1_000_000, 111, 99)]).status, 'target-hit');
  assert.equal(resolveEntry(longEntry, [candle(1_000_000, 105, 95)]).status, 'open');
});

test('applyResolution persists the outcome', () => {
  const { path, cleanup } = tempLog();
  try {
    record(shortPlan(), path);
    const updated = applyResolution('BTC-RF-aaaa', [candle(1_003_600, 111, 104)], path);
    assert.equal(updated.status, 'invalidated');
    assert.ok(updated.resolvedAt);
    // And it survives a reload.
    assert.equal(get('BTC-RF-aaaa', path).status, 'invalidated');
  } finally { cleanup(); }
});

test('applyResolution on an unknown id returns null rather than inventing one', () => {
  const { path, cleanup } = tempLog();
  try {
    assert.equal(applyResolution('NOPE-XX-0000', [], path), null);
  } finally { cleanup(); }
});

test('tally counts outcomes and refuses to report a win rate', () => {
  const { path, cleanup } = tempLog();
  try {
    record(shortPlan('BTC-RF-aaaa'), path);
    record(shortPlan('BTC-RF-bbbb'), path);
    applyResolution('BTC-RF-bbbb', [candle(1_003_600, 111, 104)], path);

    const t = tally(path);
    assert.equal(t.total, 2);
    assert.equal(t.open, 1);
    assert.equal(t.invalidated, 1);
    assert.equal(t.winRate, undefined);
    assert.match(t.note, /No win rate/);
  } finally { cleanup(); }
});

test('list returns newest first', () => {
  const { path, cleanup } = tempLog();
  try {
    record({ ...shortPlan('OLD-RF-0001'), readAt: 1 }, path);
    record({ ...shortPlan('NEW-RF-0002'), readAt: 2 }, path);
    assert.deepEqual(list(path).map((e) => e.signalId), ['NEW-RF-0002', 'OLD-RF-0001']);
  } finally { cleanup(); }
});

/** The shape `record` stores, built without touching the filesystem. */
function toEntry(plan) {
  return {
    signalId: plan.signalId,
    symbol: plan.symbol,
    timeframe: plan.timeframe,
    direction: plan.direction,
    entryPrice: plan.markPrice,
    invalidation: plan.invalidation.price,
    targets: plan.targets.map((t) => ({ label: t.label, price: t.price, r: t.r })),
    createdAt: plan.readAt,
    status: 'open',
  };
}
