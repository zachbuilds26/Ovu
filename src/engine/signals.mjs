import {
  emaSeries, atr, swingHighs, swingLows, baselineVolume, change,
} from './indicators.mjs';
import { fmtPrice } from './format.mjs';

/**
 * The four signals.
 *
 * Three rules hold throughout:
 *
 * 1. Every signal is a pure function of a snapshot. No network, no clock.
 * 2. Every signal is symmetric. A failed rally below resistance and a failed
 *    breakdown above support are the same computation with the sign flipped, so
 *    no market condition leaves OVU with nothing to say.
 * 3. Every signal reports its counterexamples — the readings that argue against
 *    it — with numbers. A result with an empty counter-case is a bug, so
 *    `normalise` refuses to let one through silently.
 */

/**
 * Every threshold in one place, named, so they can be argued with. These are
 * starting values chosen to be defensible, not values fitted to past data —
 * there is no backtest behind them and the README says so.
 */
export const THRESHOLDS = {
  swingLookback: 3,
  emaFast: 20,
  emaSlow: 50,
  atrPeriod: 14,
  volumeBaseline: 20,

  /** How far price must close back through the level, in ATR, to count as rejected. */
  rejectionMinAtr: 0.25,
  /**
   * How many candles ago the failed pivot may be. Without this, "a rally that
   * failed" quietly becomes "a rally that failed at some point in history, and
   * price is now nowhere near it" — which is not a tradeable observation.
   */
  maxPivotAge: 10,
  /** Each successive bounce must be at most this fraction of the previous one. */
  decayRatioMax: 0.8,
  /** Funding below this magnitude means neither side is crowded (per interval). */
  fundingMeaningful: 0.00005,
  /** Minimum open-interest move over the window to carry information. */
  oiMoveMin: 0.005,
  /** Minimum price move over the window to carry information. */
  priceMoveMin: 0.005,
};

const pct = (n) => `${(n * 100).toFixed(2)}%`;
const fpct = (n) => `${(n * 100).toFixed(4)}%`;

const finding = (label, value, source) => ({ label, value, source });
const against = (label, detail) => ({ label, detail });

/**
 * Guarantees the contract: a signal either lists what argues against it, or
 * says plainly that nothing does.
 */
function normalise(result) {
  if (!result.counterexamples || result.counterexamples.length === 0) {
    result.counterexamples = [
      against('None found', 'No reading in this snapshot argues against the result above.'),
    ];
  }
  return result;
}

/** Lowest low between two indices, inclusive. */
function lowestBetween(candles, from, to) {
  let low = Infinity;
  for (let i = from; i <= to; i++) low = Math.min(low, candles[i].low);
  return low;
}

/** Highest high between two indices, inclusive. */
function highestBetween(candles, from, to) {
  let high = -Infinity;
  for (let i = from; i <= to; i++) high = Math.max(high, candles[i].high);
  return high;
}

/**
 * Reads the same rebound-failure shape in one direction. Called twice, once per
 * side, so the logic exists in exactly one place.
 *
 * Bearish reading: price made a lower high, poked above the fast EMA doing it,
 * and has since closed back below that EMA by a meaningful multiple of ATR.
 * Bullish reading is the mirror.
 */
function readReboundFailure(candles, side) {
  const closes = candles.map((c) => c.close);
  const fast = emaSeries(closes, THRESHOLDS.emaFast);
  const range = atr(candles, THRESHOLDS.atrPeriod);
  const emaNow = fast.at(-1);
  const closeNow = closes.at(-1);

  if (emaNow === null || range === null) return null;

  const bearish = side === 'short';
  const pivots = bearish
    ? swingHighs(candles, THRESHOLDS.swingLookback)
    : swingLows(candles, THRESHOLDS.swingLookback);

  if (pivots.length < 2) return null;

  const last = pivots.at(-1);
  const prior = pivots.at(-2);
  const emaAtPivot = fast[last.index];
  if (emaAtPivot === null) return null;

  // A lower high (bearish) or a higher low (bullish).
  const structureHolds = bearish ? last.price < prior.price : last.price > prior.price;
  // The rally poked through the EMA before failing.
  const pokedThrough = bearish ? last.price > emaAtPivot : last.price < emaAtPivot;
  // And price has since closed back on the other side of it.
  const distanceAtr = bearish ? (emaNow - closeNow) / range : (closeNow - emaNow) / range;
  const closedBack = distanceAtr >= THRESHOLDS.rejectionMinAtr;
  // The failure has to be recent, or it isn't news.
  const age = candles.length - 1 - last.index;
  const fresh = age <= THRESHOLDS.maxPivotAge;

  return {
    last, prior, emaNow, closeNow, range, age,
    structureHolds, pokedThrough, distanceAtr, closedBack, fresh,
    fired: structureHolds && pokedThrough && closedBack && fresh,
  };
}

/**
 * Signal 1 — Rebound failure.
 * A rally that made a lower high, poked above the fast EMA, and closed back
 * below it. Or the mirror on the way up.
 *
 * @param {import('../data/snapshot.mjs').Snapshot} snap
 * @param {string} timeframe
 */
export function reboundFailure(snap, timeframe = '1h') {
  const candles = snap.candles[timeframe];
  const base = {
    id: 'rebound-failure',
    name: 'Rebound failure',
    timeframe,
    fired: false,
    direction: null,
    headline: '',
    evidence: [],
    counterexamples: [],
  };

  if (!candles || candles.length < 60) {
    base.headline = `Not enough ${timeframe} history to judge.`;
    return normalise(base);
  }

  const short = readReboundFailure(candles, 'short');
  const long = readReboundFailure(candles, 'long');
  const hit = [short, long].filter((r) => r && r.fired);

  if (hit.length === 0) {
    const closest = short && long
      ? (short.distanceAtr > long.distanceAtr ? short : long)
      : (short ?? long);
    base.headline = closest
      ? `No rebound failure on ${timeframe}. ${
        !closest.structureHolds ? 'The last pivot did not extend the structure.'
          : !closest.pokedThrough ? 'The last pivot never reached the fast EMA.'
            : !closest.fresh ? `The last failed pivot was ${closest.age} candles ago, beyond the ${THRESHOLDS.maxPivotAge}-candle window — price has moved on.`
              : `Price has only closed ${closest.distanceAtr.toFixed(2)} ATR back through the EMA, under the ${THRESHOLDS.rejectionMinAtr} needed.`
      }`
      : `Not enough confirmed pivots on ${timeframe} to judge.`;
    return normalise(base);
  }

  const r = hit.length === 1 ? hit[0] : (short.distanceAtr >= long.distanceAtr ? short : long);
  const bearish = r === short;
  const pivotCandle = candles[r.last.index];
  const volumeBase = baselineVolume(candles, THRESHOLDS.volumeBaseline);

  base.fired = true;
  base.direction = bearish ? 'short' : 'long';
  base.headline = bearish
    ? `Rally to ${r.last.price} failed below the previous high of ${r.prior.price}, and price has closed ${r.distanceAtr.toFixed(2)} ATR back under the ${THRESHOLDS.emaFast} EMA.`
    : `Dip to ${r.last.price} held above the previous low of ${r.prior.price}, and price has closed ${r.distanceAtr.toFixed(2)} ATR back over the ${THRESHOLDS.emaFast} EMA.`;

  const turn = bearish ? 'rejection' : 'defence';

  base.evidence = [
    finding(bearish ? 'Lower high' : 'Higher low', `${r.last.price} vs ${r.prior.price}`, `${timeframe} swing pivots`),
    finding(bearish ? 'Rejection level' : 'Defended level', `${THRESHOLDS.emaFast} EMA at ${fmtPrice(r.emaNow)}`, `${timeframe} closes`),
    finding('Close relative to level', `${fmtPrice(r.closeNow)} (${r.distanceAtr.toFixed(2)} ATR through)`, `${timeframe} close`),
    finding('Pivot age', `${r.age} candles ago`, `${timeframe} swing pivots`),
    finding('ATR', fmtPrice(r.range), `${timeframe}, ${THRESHOLDS.atrPeriod} period`),
  ];

  if (volumeBase !== null && pivotCandle.volume < volumeBase) {
    base.counterexamples.push(against(
      `The ${turn} lacked volume`,
      `The pivot candle traded ${pivotCandle.volume.toFixed(0)} against a ${THRESHOLDS.volumeBaseline}-candle baseline of ${volumeBase.toFixed(0)}. A turn nobody participated in is weak evidence.`,
    ));
  }

  // The next coarser timeframe disagreeing is the strongest single objection.
  const coarser = timeframe === '15m' ? '1h' : timeframe === '1h' ? '4h' : null;
  if (coarser && snap.candles[coarser]) {
    const cCloses = snap.candles[coarser].map((c) => c.close);
    const cEma = emaSeries(cCloses, THRESHOLDS.emaFast).at(-1);
    const cClose = cCloses.at(-1);
    if (cEma !== null && (bearish ? cClose > cEma : cClose < cEma)) {
      base.counterexamples.push(against(
        `${coarser} disagrees`,
        `On ${coarser}, price (${fmtPrice(cClose)}) is still ${bearish ? 'above' : 'below'} its ${THRESHOLDS.emaFast} EMA (${fmtPrice(cEma)}), so the higher timeframe has not confirmed this.`,
      ));
    }
  }

  const swingLow = lowestBetween(candles, r.prior.index, r.last.index);
  const swingHigh = highestBetween(candles, r.prior.index, r.last.index);
  base.evidence.push(finding(
    'Range travelled since prior pivot',
    `${swingLow} to ${swingHigh}`,
    `${timeframe} highs and lows`,
  ));

  return normalise(base);
}

/** Reads the trend-suppression shape in one direction. */
function readSuppression(candles, side) {
  const bearish = side === 'short';
  const pivots = bearish
    ? swingHighs(candles, THRESHOLDS.swingLookback)
    : swingLows(candles, THRESHOLDS.swingLookback);

  if (pivots.length < 3) return null;
  const [p1, p2, p3] = pivots.slice(-3);

  const structureHolds = bearish
    ? p3.price < p2.price && p2.price < p1.price
    : p3.price > p2.price && p2.price > p1.price;

  // How far each counter-move travelled before failing.
  const amp = (a, b) => (bearish
    ? b.price - lowestBetween(candles, a.index, b.index)
    : highestBetween(candles, a.index, b.index) - b.price);

  const first = amp(p1, p2);
  const second = amp(p2, p3);
  const ratio = first === 0 ? Infinity : second / first;
  const decaying = second <= first * THRESHOLDS.decayRatioMax;

  return { p1, p2, p3, first, second, ratio, structureHolds, decaying, fired: structureHolds && decaying };
}

/**
 * Signal 2 — Trend suppression.
 * Successive lower highs where each bounce travels less than the one before, or
 * the mirror: higher lows with shrinking pullbacks.
 *
 * @param {import('../data/snapshot.mjs').Snapshot} snap
 * @param {string} timeframe
 */
export function trendSuppression(snap, timeframe = '1h') {
  const candles = snap.candles[timeframe];
  const base = {
    id: 'trend-suppression',
    name: 'Trend suppression',
    timeframe,
    fired: false,
    direction: null,
    headline: '',
    evidence: [],
    counterexamples: [],
  };

  if (!candles || candles.length < 60) {
    base.headline = `Not enough ${timeframe} history to judge.`;
    return normalise(base);
  }

  const short = readSuppression(candles, 'short');
  const long = readSuppression(candles, 'long');
  const hit = [short, long].filter((r) => r && r.fired);

  if (hit.length === 0) {
    const seen = short ?? long;
    if (!seen) {
      base.headline = `Fewer than three confirmed pivots on ${timeframe}.`;
      return normalise(base);
    }
    base.headline = !seen.structureHolds
      ? `No suppression on ${timeframe}: the last three pivots are not in sequence.`
      : `Structure is in sequence on ${timeframe}, but the last counter-move was ${(seen.ratio * 100).toFixed(0)}% of the one before it, above the ${(THRESHOLDS.decayRatioMax * 100).toFixed(0)}% needed to call it decaying.`;

    // A counter-move that grew is the objection to a suppression read, so it
    // belongs here even when nothing fired.
    if (seen.structureHolds && seen.ratio > 1) {
      base.counterexamples.push(against(
        'Counter-moves are growing',
        `The most recent move travelled ${fmtPrice(seen.second)} against ${fmtPrice(seen.first)} before it. Pressure is easing, not building.`,
      ));
    }
    return normalise(base);
  }

  const r = hit.length === 1 ? hit[0] : (short.ratio <= long.ratio ? short : long);
  const bearish = r === short;

  base.fired = true;
  base.direction = bearish ? 'short' : 'long';
  base.headline = bearish
    ? `Three lower highs (${r.p1.price} → ${r.p2.price} → ${r.p3.price}) with each bounce shorter: ${fmtPrice(r.first)} then ${fmtPrice(r.second)}.`
    : `Three higher lows (${r.p1.price} → ${r.p2.price} → ${r.p3.price}) with each pullback shallower: ${fmtPrice(r.first)} then ${fmtPrice(r.second)}.`;

  base.evidence = [
    finding(bearish ? 'Lower highs' : 'Higher lows', `${r.p1.price} → ${r.p2.price} → ${r.p3.price}`, `${timeframe} swing pivots`),
    finding('Counter-move sizes', `${fmtPrice(r.first)} then ${fmtPrice(r.second)}`, `${timeframe} highs and lows`),
    finding('Decay ratio', `${(r.ratio * 100).toFixed(0)}% of the previous move`, 'derived'),
  ];

  if (r.ratio > THRESHOLDS.decayRatioMax * 0.9) {
    base.counterexamples.push(against(
      'Decay is marginal',
      `At ${(r.ratio * 100).toFixed(0)}% the latest move only just clears the ${(THRESHOLDS.decayRatioMax * 100).toFixed(0)}% bar. One larger bounce breaks this read.`,
    ));
  }

  return normalise(base);
}

/**
 * Signal 3 — Funding pressure.
 * Which side is paying to hold its position, and whether that agrees with what
 * price is doing. Longs paying while price falls is the bearish reading; shorts
 * paying while price rises is the bullish one.
 *
 * @param {import('../data/snapshot.mjs').Snapshot} snap
 * @param {string} timeframe
 */
export function fundingPressure(snap, timeframe = '1h') {
  const base = {
    id: 'funding-pressure',
    name: 'Funding pressure',
    timeframe,
    fired: false,
    direction: null,
    headline: '',
    evidence: [],
    counterexamples: [],
  };

  const candles = snap.candles[timeframe];
  const current = snap.lastFundingRate;
  const recent = snap.fundingHistory.slice(-8);

  if (!candles || candles.length < 25 || recent.length === 0) {
    base.headline = 'Not enough funding or price history to judge.';
    return normalise(base);
  }

  const mean = recent.reduce((a, r) => a + r.fundingRate, 0) / recent.length;
  const closes = candles.map((c) => c.close);
  const priceChange = change(closes.at(-25), closes.at(-1));

  base.evidence = [
    finding('Current funding', fpct(current), '/fapi/v1/premiumIndex'),
    finding(`Mean of last ${recent.length} prints`, fpct(mean), '/fapi/v1/fundingRate'),
    finding(`Price change over 24 ${timeframe} candles`, pct(priceChange), `${timeframe} closes`),
  ];

  const meaningful = Math.abs(current) >= THRESHOLDS.fundingMeaningful;
  if (!meaningful) {
    base.headline = `Funding is effectively flat at ${fpct(current)}, so neither side is crowded. Nothing to read here.`;
    base.counterexamples.push(against(
      'No crowd to squeeze',
      `Funding magnitude is below the ${fpct(THRESHOLDS.fundingMeaningful)} floor at which it carries information. Any directional story built on positioning cost is unsupported right now.`,
    ));
    return normalise(base);
  }

  const longsPaying = current > 0;
  const priceFalling = priceChange < -THRESHOLDS.priceMoveMin;
  const priceRising = priceChange > THRESHOLDS.priceMoveMin;

  if (longsPaying && priceFalling) {
    base.fired = true;
    base.direction = 'short';
    base.headline = `Longs are paying ${fpct(current)} to hold while price is down ${pct(priceChange)}. The crowded side is the losing side.`;
  } else if (!longsPaying && priceRising) {
    base.fired = true;
    base.direction = 'long';
    base.headline = `Shorts are paying ${fpct(Math.abs(current))} to hold while price is up ${pct(priceChange)}. The crowded side is the losing side.`;
  } else {
    base.headline = `Funding at ${fpct(current)} and a ${pct(priceChange)} price move point the same way, so nobody is paying to be wrong. No signal.`;
    return normalise(base);
  }

  // Funding that just flipped is a weak basis for a positioning argument.
  if (Math.sign(current) !== Math.sign(mean)) {
    base.counterexamples.push(against(
      'Funding just flipped',
      `The current print is ${fpct(current)} but the mean of the last ${recent.length} is ${fpct(mean)}. This is a change of state, not an established imbalance.`,
    ));
  }

  if (Math.abs(current) < THRESHOLDS.fundingMeaningful * 2) {
    base.counterexamples.push(against(
      'Imbalance is small',
      `At ${fpct(current)} funding only just clears the ${fpct(THRESHOLDS.fundingMeaningful)} floor. The cost of holding is real but not painful.`,
    ));
  }

  // Large accounts sitting on the same side as the signal weakens it — the
  // people with the most information are not the crowd being squeezed.
  const ratio = snap.topTraderRatio.at(-1);
  if (ratio) {
    const bigAccountsShort = ratio.longShortRatio < 1;
    if ((base.direction === 'short' && bigAccountsShort) || (base.direction === 'long' && !bigAccountsShort)) {
      base.counterexamples.push(against(
        'Large accounts already positioned this way',
        `Top traders are ${(ratio.longAccount * 100).toFixed(1)}% long (ratio ${ratio.longShortRatio}), on the same side as this signal. Less room for them to push it further.`,
      ));
    }
  }

  return normalise(base);
}

/**
 * Signal 4 — Positioning shift.
 * Open interest against price direction. Rising open interest into a move means
 * new positions are funding it; falling open interest means the move is people
 * leaving, which is exhaustion rather than conviction.
 *
 * @param {import('../data/snapshot.mjs').Snapshot} snap
 * @param {string} timeframe
 */
export function positioningShift(snap, timeframe = '1h') {
  const base = {
    id: 'positioning-shift',
    name: 'Positioning shift',
    timeframe,
    fired: false,
    direction: null,
    headline: '',
    evidence: [],
    counterexamples: [],
  };

  const history = snap.openInterestHistory;
  const candles = snap.candles[timeframe];

  if (!history || history.length < 4 || !candles || candles.length < history.length) {
    base.headline = 'Not enough open-interest history to judge.';
    return normalise(base);
  }

  const oiChange = change(history[0].openInterest, history.at(-1).openInterest);
  const closes = candles.map((c) => c.close);
  const priceChange = change(closes.at(-history.length), closes.at(-1));
  const taker = snap.takerFlow.at(-1);
  const ratio = snap.topTraderRatio.at(-1);

  base.evidence = [
    finding('Open interest change', pct(oiChange), '/futures/data/openInterestHist'),
    finding('Price change, same window', pct(priceChange), `${timeframe} closes`),
    finding('Window length', `${history.length} periods`, 'snapshot'),
  ];
  if (taker) base.evidence.push(finding('Taker buy/sell', String(taker.buySellRatio), '/futures/data/takerlongshortRatio'));
  if (ratio) base.evidence.push(finding('Top trader long share', `${(ratio.longAccount * 100).toFixed(1)}%`, '/futures/data/topLongShortPositionRatio'));

  const priceMoved = Math.abs(priceChange) >= THRESHOLDS.priceMoveMin;
  const oiRising = oiChange >= THRESHOLDS.oiMoveMin;
  const oiFalling = oiChange <= -THRESHOLDS.oiMoveMin;

  if (!priceMoved) {
    base.headline = `Price has only moved ${pct(priceChange)} over the window, which is too little to read positioning against.`;
    base.counterexamples.push(against(
      'No move to explain',
      `A ${pct(priceChange)} move is inside noise. Open interest changing by ${pct(oiChange)} against it means nothing directional.`,
    ));
    return normalise(base);
  }

  if (oiFalling) {
    // This is the exhaustion case. It never fires — it argues against whatever
    // the price move looks like it's doing.
    base.headline = `Open interest fell ${pct(oiChange)} while price moved ${pct(priceChange)}. Positions are being closed, not opened — that reads as exhaustion rather than conviction.`;
    base.counterexamples.push(against(
      'Falling open interest into the move',
      `Down ${pct(oiChange)} over ${history.length} periods. A move funded by people leaving tends not to continue, which argues against any continuation trade in the direction of the ${pct(priceChange)} move.`,
    ));
    return normalise(base);
  }

  if (!oiRising) {
    base.headline = `Open interest is flat at ${pct(oiChange)} against a ${pct(priceChange)} price move. No positioning story either way.`;
    return normalise(base);
  }

  base.fired = true;
  base.direction = priceChange < 0 ? 'short' : 'long';
  base.headline = `Open interest rose ${pct(oiChange)} while price moved ${pct(priceChange)}. New positions are funding the move.`;

  if (taker) {
    const takersBuying = taker.buySellRatio > 1;
    if ((base.direction === 'short' && takersBuying) || (base.direction === 'long' && !takersBuying)) {
      base.counterexamples.push(against(
        'Aggressive flow runs the other way',
        `Taker buy/sell is ${taker.buySellRatio}, meaning the market orders are ${takersBuying ? 'buying' : 'selling'} — against the direction this signal points.`,
      ));
    }
  }

  if (ratio) {
    const bigLong = ratio.longShortRatio > 1;
    if ((base.direction === 'short' && bigLong) || (base.direction === 'long' && !bigLong)) {
      base.counterexamples.push(against(
        'Large accounts positioned against this',
        `Top traders sit ${(ratio.longAccount * 100).toFixed(1)}% long at a ratio of ${ratio.longShortRatio}. Either they are wrong, or this signal is early.`,
      ));
    }
  }

  return normalise(base);
}

/** Every signal, in a fixed order. */
export const SIGNALS = [reboundFailure, trendSuppression, fundingPressure, positioningShift];

/**
 * Run all four signals over one snapshot.
 *
 * Agreement is reported, never scored. If three signals point short and one
 * argues exhaustion, the caller sees exactly that — there is no weighted number
 * hiding the disagreement.
 *
 * @param {import('../data/snapshot.mjs').Snapshot} snap
 * @param {string} [timeframe]
 */
export function evaluate(snap, timeframe = '1h') {
  const results = SIGNALS.map((fn) => fn(snap, timeframe));
  const fired = results.filter((r) => r.fired);
  const short = fired.filter((r) => r.direction === 'short').length;
  const long = fired.filter((r) => r.direction === 'long').length;

  let direction = null;
  if (short > 0 && long === 0) direction = 'short';
  else if (long > 0 && short === 0) direction = 'long';

  return {
    symbol: snap.symbol,
    timeframe,
    markPrice: snap.markPrice,
    fetchedAt: snap.fetchedAt,
    direction,
    firedCount: fired.length,
    conflicted: short > 0 && long > 0,
    signals: results,
    counterexampleCount: results.reduce(
      (n, r) => n + r.counterexamples.filter((c) => c.label !== 'None found').length,
      0,
    ),
  };
}

