/**
 * The risk gate. Everything here is arithmetic — no network, no state — so it
 * can be tested exhaustively, which matters because this is the code standing
 * between a plan and real money.
 *
 * It is a gate, not an adviser: it either returns a size or it returns the
 * reasons it refused. There is no partial success.
 */

import { fmtPrice } from './format.mjs';

/** Lowest maintenance margin tier on BTCUSDT. Higher tiers apply to larger positions. */
export const DEFAULT_MAINTENANCE_MARGIN_RATE = 0.004;

/** Most of the stake we will ever risk on a single trade. */
export const MAX_RISK_FRACTION = 0.25;

/**
 * Approximate isolated-margin liquidation price.
 *
 * Derived from: initial margin minus unrealised loss equals maintenance margin.
 * Long:  P = entry(1 - 1/L) / (1 - mmr)
 * Short: P = entry(1 + 1/L) / (1 + mmr)
 *
 * Approximate on purpose, and labelled as such wherever it surfaces: it ignores
 * trading fees, accrued funding, and the fact that the maintenance margin rate
 * steps up with position size. Treat it as a floor on how much room you have,
 * never as an exact number.
 *
 * @param {{entry:number, leverage:number, direction:'long'|'short', maintenanceMarginRate?:number}} p
 * @returns {number}
 */
export function liquidationPrice({ entry, leverage, direction, maintenanceMarginRate }) {
  const mmr = maintenanceMarginRate ?? DEFAULT_MAINTENANCE_MARGIN_RATE;
  return direction === 'long'
    ? (entry * (1 - 1 / leverage)) / (1 - mmr)
    : (entry * (1 + 1 / leverage)) / (1 + mmr);
}

/**
 * Round down to a multiple of `step`. Rounding down, never up — rounding up can
 * push a position past a limit the caller already agreed to.
 *
 * Steps may arrive in exponent form (e.g. 1e-7 on sub-satoshi coins), where a
 * naive string split finds no decimal point — so the precision is found by
 * round-tripping instead. Every live symbol today uses plain decimals; this is
 * future-proofing.
 * @param {number} value
 * @param {number} step
 * @returns {number}
 */
export function roundDownToStep(value, step) {
  if (!step || step <= 0) return value;
  // Smallest decimal count that round-trips the step exactly. Works for plain
  // decimals (0.001 → 3) and exponent-form steps (1e-7 → 7) alike, with no
  // string parsing of float noise.
  let decimals = 0;
  while (decimals < 20 && Number(step.toFixed(decimals)) !== step) decimals += 1;
  return Number((Math.floor(value / step) * step).toFixed(decimals));
}

/**
 * @typedef {object} SizeRequest
 * @property {number} entry
 * @property {number} stop
 * @property {'long'|'short'} direction
 * @property {number} stake              Collateral committed, in quote currency.
 * @property {number} riskFraction       Fraction of stake to lose if stopped (0.02 = 2%).
 * @property {number} leverage
 * @property {{stepSize:number, minQty:number, minNotional:number}} filters
 * @property {number} [maintenanceMarginRate]
 */

/**
 * Size a position, or refuse and say why.
 * @param {SizeRequest} req
 */
export function sizePosition(req) {
  const {
    entry, stop, direction, stake, riskFraction, leverage, filters,
    maintenanceMarginRate,
  } = req;

  /** @type {string[]} */
  const refusals = [];
  const finite = (n) => typeof n === 'number' && Number.isFinite(n);

  if (!finite(entry) || entry <= 0) refusals.push('entry must be a positive number');
  if (!finite(stop) || stop <= 0) refusals.push('stop must be a positive number');
  if (!finite(stake) || stake <= 0) refusals.push('stake must be a positive number');
  if (!finite(leverage) || leverage < 1) refusals.push('leverage must be at least 1');
  if (direction !== 'long' && direction !== 'short') {
    refusals.push("direction must be 'long' or 'short'");
  }
  if (!finite(riskFraction) || riskFraction <= 0) {
    refusals.push('riskFraction must be greater than zero');
  } else if (riskFraction > MAX_RISK_FRACTION) {
    refusals.push(
      `riskFraction ${(riskFraction * 100).toFixed(1)}% exceeds the ${(MAX_RISK_FRACTION * 100).toFixed(0)}% ceiling`,
    );
  }
  if (refusals.length) return { ok: false, refusals };

  if (direction === 'long' && stop >= entry) {
    refusals.push(`long stop ${stop} must sit below entry ${entry}`);
  }
  if (direction === 'short' && stop <= entry) {
    refusals.push(`short stop ${stop} must sit above entry ${entry}`);
  }
  if (refusals.length) return { ok: false, refusals };

  const liquidation = liquidationPrice({ entry, leverage, direction, maintenanceMarginRate });

  // If liquidation is reached before the stop, the stop is decoration.
  if (direction === 'long' && liquidation >= stop) {
    refusals.push(
      `at ${leverage}x, approximate liquidation ${fmtPrice(liquidation)} is above the stop ${fmtPrice(stop)} — ` +
        'the position would be liquidated before the stop triggers. Reduce leverage or widen the stop.',
    );
  }
  if (direction === 'short' && liquidation <= stop) {
    refusals.push(
      `at ${leverage}x, approximate liquidation ${fmtPrice(liquidation)} is below the stop ${fmtPrice(stop)} — ` +
        'the position would be liquidated before the stop triggers. Reduce leverage or widen the stop.',
    );
  }

  const riskPerUnit = Math.abs(entry - stop);
  const riskAmount = stake * riskFraction;

  const notes = [];
  let qty = riskAmount / riskPerUnit;

  const maxQtyByLeverage = (stake * leverage) / entry;
  if (qty > maxQtyByLeverage) {
    qty = maxQtyByLeverage;
    notes.push(
      `size capped by ${leverage}x leverage on a ${stake} stake, so the actual risk at stop is ` +
        'below the requested fraction',
    );
  }

  qty = roundDownToStep(qty, filters.stepSize);
  const notional = qty * entry;

  if (qty <= 0 || qty < filters.minQty) {
    refusals.push(
      `size ${qty} is below the exchange minimum quantity ${filters.minQty} — ` +
        'increase the stake, widen the risk, or use a wider stop',
    );
  }
  if (notional < filters.minNotional) {
    refusals.push(
      `notional ${notional.toFixed(2)} is below the exchange minimum ${filters.minNotional}`,
    );
  }
  if (refusals.length) return { ok: false, refusals };

  const worstCase = qty * riskPerUnit;

  return {
    ok: true,
    direction,
    entry,
    stop,
    qty,
    notional,
    marginRequired: notional / leverage,
    leverage,
    riskPerUnit,
    worstCase,
    worstCaseFractionOfStake: worstCase / stake,
    liquidationPrice: liquidation,
    liquidationDistance: Math.abs(entry - liquidation) / entry,
    liquidationIsApproximate: true,
    notes,
  };
}
