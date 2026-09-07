/**
 * Fixture builders for signal tests.
 *
 * Signals are pure functions of a snapshot, which is the whole reason this file
 * can exist: a snapshot from a real fetch and one built here are the same shape,
 * so a test can pin down exactly what should and should not fire.
 */

/**
 * Straight-line interpolation between waypoints, giving a price path with
 * deliberate peaks and troughs.
 * @param {{at: number, price: number}[]} waypoints  Must be ordered by `at`.
 * @returns {number[]}
 */
export function pathFrom(waypoints) {
  const closes = [];
  for (let w = 0; w < waypoints.length - 1; w++) {
    const from = waypoints[w];
    const to = waypoints[w + 1];
    const span = to.at - from.at;
    for (let i = 0; i < span; i++) {
      closes.push(from.price + ((to.price - from.price) * i) / span);
    }
  }
  closes.push(waypoints.at(-1).price);
  return closes;
}

/**
 * Candles whose highs and lows hug the close, so the highest high sits on the
 * highest close and swing detection lands exactly on the intended peak.
 * @param {number[]} closes
 * @param {{wiggle?: number, volume?: number|number[]}} [opts]
 */
export function candlesFrom(closes, opts = {}) {
  const wiggle = opts.wiggle ?? 0.2;
  const volume = opts.volume ?? 1000;
  return closes.map((close, i) => ({
    openTime: i * 3_600_000,
    open: i === 0 ? close : closes[i - 1],
    high: close + wiggle,
    low: close - wiggle,
    close,
    volume: Array.isArray(volume) ? volume[i] ?? 1000 : volume,
  }));
}

/**
 * Reflect a candle series around a price, turning any bullish shape into the
 * exact bearish equivalent. Highs become lows and vice versa.
 *
 * This is what makes the symmetry claim testable rather than aspirational.
 * @param {object[]} candles
 * @param {number} mid
 */
export function mirror(candles, mid) {
  const flip = (p) => 2 * mid - p;
  return candles.map((c) => ({
    ...c,
    open: flip(c.open),
    close: flip(c.close),
    high: flip(c.low),
    low: flip(c.high),
  }));
}

/** A series of `n` evenly spaced readings ending at `to`, starting at `from`. */
export function ramp(n, from, to) {
  return Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
}

/**
 * A snapshot with sane neutral defaults, so each test only states the readings
 * it actually cares about.
 * @param {object} [overrides]
 */
export function makeSnapshot(overrides = {}) {
  const closes = overrides.closes ?? ramp(120, 100, 100);
  const candles = overrides.candlesOverride ?? candlesFrom(closes);
  const oi = overrides.oiSeries ?? ramp(48, 1000, 1000);

  return {
    symbol: 'TESTUSDT',
    fetchedAt: 1_700_000_000_000,
    markPrice: candles.at(-1).close,
    indexPrice: candles.at(-1).close,
    lastFundingRate: 0,
    nextFundingTime: 1_700_003_600_000,
    candles: { '4h': candles, '1h': candles, '15m': candles },
    fundingHistory: (overrides.fundingSeries ?? ramp(8, 0, 0)).map((fundingRate, i) => ({
      fundingTime: i * 28_800_000,
      fundingRate,
      markPrice: 100,
    })),
    openInterest: oi.at(-1),
    openInterestHistory: oi.map((openInterest, i) => ({
      timestamp: i * 3_600_000,
      openInterest,
      openInterestValue: openInterest * 100,
    })),
    topTraderRatio: [{
      timestamp: 0, longAccount: 0.5, shortAccount: 0.5, longShortRatio: 1,
    }],
    takerFlow: [{ timestamp: 0, buySellRatio: 1, buyVol: 100, sellVol: 100 }],
    filters: { stepSize: 0.001, minQty: 0.001, minNotional: 5 },
    ...stripHelpers(overrides),
  };
}

function stripHelpers(o) {
  const { closes, candlesOverride, oiSeries, fundingSeries, ...rest } = o;
  return rest;
}
