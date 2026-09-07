import { getJson } from './http.mjs';

/**
 * Binance public futures data. No API key, no account, no authentication —
 * every endpoint below is open. Each function does one thing and returns
 * numbers rather than the strings Binance sends, so nothing downstream has to
 * remember to parse.
 */

const FAPI = 'fapi.binance.com';

/** The three assets OVU covers. */
export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

/** Periods the /futures/data/* endpoints accept. */
export const PERIODS = ['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];

const num = (v) => Number(v);

function qs(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
}

function assertPeriod(period) {
  if (!PERIODS.includes(period)) {
    throw new Error(`period must be one of ${PERIODS.join(', ')} — got "${period}"`);
  }
}

/**
 * Candles. Binance returns arrays; this returns objects.
 * `takerBuyBase` is included because aggressive-buy share is useful on its own.
 */
export async function klines(symbol, interval, limit = 200) {
  const rows = await getJson(FAPI, `/fapi/v1/klines?${qs({ symbol, interval, limit })}`);
  return rows.map((r) => ({
    openTime: r[0],
    open: num(r[1]),
    high: num(r[2]),
    low: num(r[3]),
    close: num(r[4]),
    volume: num(r[5]),
    closeTime: r[6],
    trades: r[8],
    takerBuyBase: num(r[9]),
  }));
}

/** Mark price, index price, and the funding rate currently accruing. */
export async function markAndFunding(symbol) {
  const d = await getJson(FAPI, `/fapi/v1/premiumIndex?${qs({ symbol })}`);
  return {
    symbol: d.symbol,
    markPrice: num(d.markPrice),
    indexPrice: num(d.indexPrice),
    lastFundingRate: num(d.lastFundingRate),
    interestRate: num(d.interestRate),
    nextFundingTime: d.nextFundingTime,
    time: d.time,
  };
}

/** Settled funding history, oldest first. */
export async function fundingHistory(symbol, limit = 30) {
  const rows = await getJson(FAPI, `/fapi/v1/fundingRate?${qs({ symbol, limit })}`);
  return rows.map((r) => ({
    fundingTime: r.fundingTime,
    fundingRate: num(r.fundingRate),
    markPrice: num(r.markPrice),
  }));
}

/** Open interest right now, in base units. */
export async function openInterest(symbol) {
  const d = await getJson(FAPI, `/fapi/v1/openInterest?${qs({ symbol })}`);
  return { symbol: d.symbol, openInterest: num(d.openInterest), time: d.time };
}

/** Open interest over time — the "holdings changes" input. Oldest first. */
export async function openInterestHistory(symbol, period = '1h', limit = 48) {
  assertPeriod(period);
  const rows = await getJson(FAPI, `/futures/data/openInterestHist?${qs({ symbol, period, limit })}`);
  return rows.map((r) => ({
    timestamp: r.timestamp,
    openInterest: num(r.sumOpenInterest),
    openInterestValue: num(r.sumOpenInterestValue),
  }));
}

/**
 * How the largest accounts are positioned, by position size.
 * `longShortRatio` above 1 means more long exposure than short.
 */
export async function topTraderPositionRatio(symbol, period = '1h', limit = 48) {
  assertPeriod(period);
  const rows = await getJson(
    FAPI,
    `/futures/data/topLongShortPositionRatio?${qs({ symbol, period, limit })}`,
  );
  return rows.map((r) => ({
    timestamp: r.timestamp,
    longAccount: num(r.longAccount),
    shortAccount: num(r.shortAccount),
    longShortRatio: num(r.longShortRatio),
  }));
}

/** Aggressive (taker) buy vs sell volume. Above 1 means buyers are lifting offers. */
export async function takerFlow(symbol, period = '1h', limit = 48) {
  assertPeriod(period);
  const rows = await getJson(
    FAPI,
    `/futures/data/takerlongshortRatio?${qs({ symbol, period, limit })}`,
  );
  return rows.map((r) => ({
    timestamp: r.timestamp,
    buySellRatio: num(r.buySellRatio),
    buyVol: num(r.buyVol),
    sellVol: num(r.sellVol),
  }));
}

/** Order book. Bids descending, asks ascending, as [price, qty] number pairs.
 * Proven by `npm run smoke`; the signal engine does not consume it — positioning
 * reads OI, ratios and taker flow instead. */
export async function depth(symbol, limit = 100) {
  const d = await getJson(FAPI, `/fapi/v1/depth?${qs({ symbol, limit })}`);
  const level = (l) => ({ price: num(l[0]), qty: num(l[1]) });
  return { bids: d.bids.map(level), asks: d.asks.map(level), time: d.T ?? d.E };
}

let exchangeInfoCache = null;
let exchangeInfoFetchedAt = 0;

/** Trading filters refresh hourly — tick rules barely change, but "barely" is not "never". */
const EXCHANGE_INFO_TTL_MS = 60 * 60 * 1000;

/**
 * Trading filters for one symbol: tick size, quantity step, and minimum
 * notional. The risk engine needs these to refuse orders the exchange would
 * reject anyway. exchangeInfo covers every symbol, so it's fetched once.
 */
export async function symbolFilters(symbol) {
  if (!exchangeInfoCache || Date.now() - exchangeInfoFetchedAt > EXCHANGE_INFO_TTL_MS) {
    exchangeInfoCache = await getJson(FAPI, '/fapi/v1/exchangeInfo');
    exchangeInfoFetchedAt = Date.now();
  }

  const s = exchangeInfoCache.symbols.find((x) => x.symbol === symbol);
  if (!s) throw new Error(`${symbol} is not a listed USDⓈ-M perpetual`);

  const filter = (type) => s.filters.find((f) => f.filterType === type) ?? {};
  const price = filter('PRICE_FILTER');
  const lot = filter('LOT_SIZE');
  const notional = filter('MIN_NOTIONAL');

  return {
    symbol: s.symbol,
    pricePrecision: s.pricePrecision,
    quantityPrecision: s.quantityPrecision,
    tickSize: num(price.tickSize),
    stepSize: num(lot.stepSize),
    minQty: num(lot.minQty),
    minNotional: notional.notional !== undefined ? num(notional.notional) : 0,
  };
}
