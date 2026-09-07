import {
  SYMBOLS,
  klines,
  markAndFunding,
  fundingHistory,
  openInterest,
  openInterestHistory,
  topTraderPositionRatio,
  takerFlow,
  depth,
  symbolFilters,
} from '../src/data/futures.mjs';

/**
 * Proves every endpoint in the data layer responds with real data, and prints
 * enough of each to eyeball. Run: npm run smoke
 *
 * Covers the three majors by default. Pass MEMES to cover the 12-coin meme
 * desk instead, or a single symbol: `npm run smoke -- MEMES`,
 * `npm run smoke -- 1000BONKUSDT`.
 *
 * This exists so nothing downstream is ever debugged against a broken feed.
 */

const pct = (n) => `${(n * 100).toFixed(4)}%`;

async function check(label, fn) {
  try {
    const value = await fn();
    console.log(`  ok    ${label.padEnd(26)} ${value}`);
    return true;
  } catch (err) {
    console.log(`  FAIL  ${label.padEnd(26)} ${err.message}`);
    return false;
  }
}

let failures = 0;

const arg = (process.argv[2] ?? '').toUpperCase();
const { MEME_SYMBOLS } = await import('../src/data/universe.mjs');
const symbols = arg === 'MEMES' ? MEME_SYMBOLS : arg ? [arg] : SYMBOLS;

for (const symbol of symbols) {
  console.log(`\n${symbol}`);

  const results = await Promise.all([
    check('klines 1h', async () => {
      const k = await klines(symbol, '1h', 5);
      return `${k.length} candles, last close ${k.at(-1).close}`;
    }),
    check('mark + funding', async () => {
      const m = await markAndFunding(symbol);
      return `mark ${m.markPrice}, funding ${pct(m.lastFundingRate)}`;
    }),
    check('funding history', async () => {
      const f = await fundingHistory(symbol, 5);
      return `${f.length} prints, last ${pct(f.at(-1).fundingRate)}`;
    }),
    check('open interest', async () => {
      const oi = await openInterest(symbol);
      return `${oi.openInterest.toLocaleString()} base units`;
    }),
    check('open interest history', async () => {
      const h = await openInterestHistory(symbol, '1h', 6);
      const change = (h.at(-1).openInterest / h[0].openInterest - 1) * 100;
      return `${h.length} points, ${change >= 0 ? '+' : ''}${change.toFixed(2)}% over window`;
    }),
    check('top trader ratio', async () => {
      const t = await topTraderPositionRatio(symbol, '1h', 6);
      const last = t.at(-1);
      return `${(last.longAccount * 100).toFixed(1)}% long, ratio ${last.longShortRatio}`;
    }),
    check('taker flow', async () => {
      const t = await takerFlow(symbol, '1h', 6);
      return `buy/sell ${t.at(-1).buySellRatio}`;
    }),
    check('depth', async () => {
      const d = await depth(symbol, 20);
      const spread = d.asks[0].price - d.bids[0].price;
      const { fmtPrice } = await import('../src/engine/format.mjs');
      return `${d.bids.length}x${d.asks.length} levels, spread ${fmtPrice(spread)}`;
    }),
    check('symbol filters', async () => {
      const f = await symbolFilters(symbol);
      return `tick ${f.tickSize}, step ${f.stepSize}, min notional ${f.minNotional}`;
    }),
  ]);

  failures += results.filter((ok) => !ok).length;
}

console.log(
  failures === 0
    ? '\nAll endpoints responding.'
    : `\n${failures} endpoint check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
