import { klines, openInterestHistory } from '../src/data/futures.mjs';
import { MEME_UNIVERSE } from '../src/data/universe.mjs';
import { rankMovers } from '../src/engine/trending.mjs';

/**
 * Lightweight sweep of the meme universe: which ones are actually moving.
 * Run: npm run trending
 *
 * Two requests per coin, sequential across coins to stay under the rate
 * limit. Anything interesting goes to `analyze` / `plan` next — movement is
 * not a setup.
 */

const pct = (n) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;

const rows = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (const m of MEME_UNIVERSE) {
  try {
    const [candles, oi] = await Promise.all([
      klines(m.symbol, '1h', 30),
      openInterestHistory(m.symbol, '1h', 24).catch(() => null),
    ]);
    rows.push({
      symbol: m.symbol, tag: m.tag, candles,
      oiFirst: oi?.[0]?.openInterest ?? null,
      oiLast: oi?.at(-1)?.openInterest ?? null,
    });
    console.log(`ok   ${m.tag.padEnd(12)} last ${candles.at(-1).close}`);
  } catch (err) {
    console.log(`skip ${m.tag.padEnd(12)} ${err.message.slice(0, 90)}`);
  }
  await wait(300);
}

console.log(`\n${'='.repeat(72)}`);
console.log('TRENDING MEMES — 1h, 24h window');
console.log('='.repeat(72));
for (const [i, r] of rankMovers(rows).entries()) {
  console.log(
    `${String(i + 1).padStart(2)}. ${r.tag.padEnd(12)} ${String(r.last).padEnd(14)} `
    + `${pct(r.move24).padStart(8)}  vol ${r.volMultiple === null ? '—' : `${r.volMultiple.toFixed(1)}x`}  `
    + `OI ${r.oiChange === null ? '—' : pct(r.oiChange)}  ${r.flags.join(', ')}`,
  );
}
console.log('');
