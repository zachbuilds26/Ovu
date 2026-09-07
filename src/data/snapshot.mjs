import {
  klines, markAndFunding, fundingHistory, openInterest,
  openInterestHistory, topTraderPositionRatio, takerFlow, symbolFilters,
} from './futures.mjs';

/**
 * One fetch, one plain object, everything the signals need.
 *
 * The point of this file is that signals never touch the network. They are pure
 * functions of a snapshot, which means they can be tested against fixtures that
 * pin down exactly what should and shouldn't fire — and a snapshot from a real
 * fetch and a snapshot from a fixture are the same shape.
 */

/** Timeframes the engine reads. Coarse for context, fine for the trigger. */
export const TIMEFRAMES = ['4h', '1h', '15m'];

/**
 * Candles per timeframe. 300 covers the slowest input the engine actually uses
 * (the 50-period EMA plus swing-pivot confirmation room) with margin to spare.
 */
const CANDLE_LIMIT = 300;

/**
 * @typedef {object} Snapshot
 * @property {string} symbol
 * @property {number} fetchedAt
 * @property {number} markPrice
 * @property {number} indexPrice
 * @property {number} lastFundingRate
 * @property {number} nextFundingTime
 * @property {Record<string, object[]>} candles      Keyed by timeframe, oldest first.
 * @property {object[]} fundingHistory               Oldest first.
 * @property {number} openInterest
 * @property {object[]} openInterestHistory          Oldest first.
 * @property {object[]} topTraderRatio               Oldest first.
 * @property {object[]} takerFlow                    Oldest first.
 * @property {object} filters
 */

/**
 * Fetch a full snapshot for one symbol. Requests go out in parallel; a single
 * failure fails the whole snapshot rather than producing a half-populated one
 * that a signal might quietly read around.
 *
 * @param {string} symbol
 * @param {{ period?: string, historyLimit?: number }} [opts]
 * @returns {Promise<Snapshot>}
 */
export async function snapshot(symbol, opts = {}) {
  const period = opts.period ?? '1h';
  const historyLimit = opts.historyLimit ?? 48;

  const [
    mark, funding, oi, oiHistory, ratio, taker, filters, ...candleSets
  ] = await Promise.all([
    markAndFunding(symbol),
    fundingHistory(symbol, 30),
    openInterest(symbol),
    openInterestHistory(symbol, period, historyLimit),
    topTraderPositionRatio(symbol, period, historyLimit),
    takerFlow(symbol, period, historyLimit),
    symbolFilters(symbol),
    ...TIMEFRAMES.map((tf) => klines(symbol, tf, CANDLE_LIMIT)),
  ]);

  /** @type {Record<string, object[]>} */
  const candles = {};
  TIMEFRAMES.forEach((tf, i) => {
    candles[tf] = candleSets[i];
  });

  return {
    symbol,
    fetchedAt: Date.now(),
    markPrice: mark.markPrice,
    indexPrice: mark.indexPrice,
    lastFundingRate: mark.lastFundingRate,
    nextFundingTime: mark.nextFundingTime,
    candles,
    fundingHistory: funding,
    openInterest: oi.openInterest,
    openInterestHistory: oiHistory,
    topTraderRatio: ratio,
    takerFlow: taker,
    filters,
  };
}
