/**
 * Indicators, written out rather than pulled from a library, so every number a
 * signal reports can be traced to arithmetic you can read. No dependencies, no
 * network, no state — everything here is a pure function of its inputs.
 *
 * A candle is `{ openTime, open, high, low, close, volume }`.
 */

/**
 * Simple moving average of the last `period` values.
 * @param {number[]} values
 * @param {number} period
 * @returns {number}
 */
export function sma(values, period) {
  if (values.length < period) throw new Error(`sma needs ${period} values, got ${values.length}`);
  const window = values.slice(-period);
  return window.reduce((a, b) => a + b, 0) / period;
}

/**
 * Exponential moving average series, aligned to `values`. Entries before the
 * seed window are `null` rather than a guess, so callers can't accidentally
 * treat warmup output as real.
 * @param {number[]} values
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function emaSeries(values, period) {
  if (period < 1) throw new Error('ema period must be at least 1');
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  let prev = sma(values.slice(0, period), period);
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Latest EMA value, or null if there isn't enough history.
 * @param {number[]} values
 * @param {number} period
 * @returns {number|null}
 */
export function ema(values, period) {
  return emaSeries(values, period).at(-1) ?? null;
}

/**
 * True range of one candle against the previous close.
 * @param {{high: number, low: number}} candle
 * @param {number} prevClose
 * @returns {number}
 */
export function trueRange(candle, prevClose) {
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - prevClose),
    Math.abs(candle.low - prevClose),
  );
}

/**
 * Average true range using Wilder's smoothing — the standard definition, not
 * a plain average of ranges.
 * @param {{high:number,low:number,close:number}[]} candles
 * @param {number} [period]
 * @returns {number|null}
 */
export function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    ranges.push(trueRange(candles[i], candles[i - 1].close));
  }

  let value = sma(ranges.slice(0, period), period);
  for (let i = period; i < ranges.length; i++) {
    value = (value * (period - 1) + ranges[i]) / period;
  }
  return value;
}

/**
 * Pivot highs: bars whose high is the highest within `lookback` bars either
 * side. Bars too close to the edges can't be confirmed and are skipped, which
 * is why the most recent `lookback` bars never appear here.
 * @param {{high:number, openTime:number}[]} candles
 * @param {number} [lookback]
 * @returns {{index:number, price:number, time:number}[]}
 */
export function swingHighs(candles, lookback = 3) {
  const out = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const price = candles[i].high;
    let isPivot = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && candles[j].high >= price) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) out.push({ index: i, price, time: candles[i].openTime });
  }
  return out;
}

/**
 * Pivot lows — the mirror of {@link swingHighs}.
 * @param {{low:number, openTime:number}[]} candles
 * @param {number} [lookback]
 * @returns {{index:number, price:number, time:number}[]}
 */
export function swingLows(candles, lookback = 3) {
  const out = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const price = candles[i].low;
    let isPivot = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && candles[j].low <= price) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) out.push({ index: i, price, time: candles[i].openTime });
  }
  return out;
}

/**
 * Average volume over the last `period` candles, excluding the most recent one
 * so a candle can be compared against its own baseline without polluting it.
 * @param {{volume:number}[]} candles
 * @param {number} [period]
 * @returns {number|null}
 */
export function baselineVolume(candles, period = 20) {
  if (candles.length < period + 1) return null;
  const window = candles.slice(-(period + 1), -1);
  return window.reduce((a, c) => a + c.volume, 0) / window.length;
}

/**
 * Percentage change from `from` to `to`, as a fraction (0.02 = +2%).
 *
 * Written as `(to - from) / from` rather than `to / from - 1`. The two are
 * equivalent in algebra but not in floating point — the second form makes
 * 110/100 come out as 0.10000000000000009, and these numbers get shown to
 * people.
 *
 * @param {number} from
 * @param {number} to
 * @returns {number}
 */
export function change(from, to) {
  if (from === 0) throw new Error('change() from zero is undefined');
  return (to - from) / from;
}
