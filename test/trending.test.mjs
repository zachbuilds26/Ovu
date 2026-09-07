import test from 'node:test';
import assert from 'node:assert/strict';
import { rankMovers } from '../src/engine/trending.mjs';
import { MEME_UNIVERSE } from '../src/data/universe.mjs';

/** 30 flat-ish 1h candles ending at `last`, with an optional volume spike. */
/* The spike lands on the last closed candle (index 28): rankMovers reads volume
   off closed candles only, so a spike on the forming candle must not register. */
function candles(last, start = 100, spike = false) {
  return Array.from({ length: 30 }, (_, i) => ({
    openTime: i,
    open: start,
    high: start,
    low: start,
    close: i < 29 ? start : last,
    volume: spike && i === 28 ? 1000 : 100,
  }));
}

test('ranks by absolute 24h move, largest first', () => {
  const ranked = rankMovers([
    { symbol: 'A', tag: 'a', candles: candles(102), oiFirst: null, oiLast: null },
    { symbol: 'B', tag: 'b', candles: candles(90), oiFirst: null, oiLast: null },
  ]);
  assert.equal(ranked[0].symbol, 'B');
  assert.equal(ranked[1].symbol, 'A');
});

test('flags big moves, volume surges and OI direction', () => {
  const [r] = rankMovers([
    {
      symbol: 'M', tag: 'm', candles: candles(112, 100, true),
      oiFirst: 1000, oiLast: 1100,
    },
  ]);
  assert.ok(Math.abs(r.move24 - 0.12) < 1e-9);
  assert.ok(r.flags.includes('big move'));
  assert.ok(r.flags.includes('volume surge'));
  assert.ok(r.flags.includes('fresh positions'));
});

test('a spike on the forming candle does not count as a surge', () => {
  const forming = candles(112, 100, false);
  forming.at(-1).volume = 1000;
  const [r] = rankMovers([
    { symbol: 'M', tag: 'm', candles: forming, oiFirst: null, oiLast: null },
  ]);
  assert.ok(!r.flags.includes('volume surge'));
});

test('missing OI ranks without it and says so', () => {
  const [r] = rankMovers([
    { symbol: 'M', tag: 'm', candles: candles(106), oiFirst: null, oiLast: null },
  ]);
  assert.equal(r.oiChange, null);
  assert.ok(!r.flags.some((f) => f.includes('positions')));
});

test('meme universe is 12 verified perp symbols', () => {
  assert.equal(MEME_UNIVERSE.length, 12);
  for (const m of MEME_UNIVERSE) {
    assert.match(m.symbol, /USDT$/);
    assert.ok(m.tag.length > 0);
  }
});
