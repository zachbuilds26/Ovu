import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtPrice } from '../src/engine/format.mjs';

test('majors keep two decimals', () => {
  assert.equal(fmtPrice(79931.5), '79931.50');
  assert.equal(fmtPrice(103.91), '103.91');
});

test('sub-dollar prices show significant digits', () => {
  assert.equal(fmtPrice(0.00316509), '0.003165');
  assert.equal(fmtPrice(0.09056), '0.09056');
  assert.equal(fmtPrice(0.0004408), '0.0004408');
});

test('no longer prints meme prices as 0.00', () => {
  assert.notEqual(fmtPrice(0.003231), '0.00');
  assert.notEqual(fmtPrice(0.0000894), '0.00');
});

test('non-numbers pass through', () => {
  assert.equal(fmtPrice('x'), 'x');
  assert.equal(fmtPrice(0), '0.00');
});
