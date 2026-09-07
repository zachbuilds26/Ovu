import { createHash } from 'node:crypto';
import { emaSeries, atr, swingHighs, swingLows } from './indicators.mjs';
import { fmtPrice } from './format.mjs';
import { sizePosition } from './risk.mjs';
import { evaluate, THRESHOLDS } from './signals.mjs';

/**
 * Turns a signal report into a plan you could actually place, or refuses and
 * says why.
 *
 * Two things here are deliberate and worth knowing before reading the code:
 *
 * 1. **Levels come from structure, not percentages.** The invalidation is the
 *    price that proves the thesis wrong — the level the failed move gave up —
 *    plus a small ATR buffer. Targets are prior pivots, because that's where
 *    price has actually traded, not round numbers.
 * 2. **The signal ID is derived only from data.** No clock, no randomness. The
 *    same setup read twice produces the same ID, which is the entire point: a
 *    plan you can look up later and be told honestly how it went.
 */

/** Short codes so an ID reads as a sentence: BTC-RF-7a2c. */
const SIGNAL_CODES = {
  'rebound-failure': 'RF',
  'trend-suppression': 'TS',
  'funding-pressure': 'FP',
  'positioning-shift': 'PS',
};

/** How far beyond the broken level the invalidation sits, in ATR. */
export const INVALIDATION_BUFFER_ATR = 0.25;

/** Where the final target lands when structure runs out, as a multiple of risk. */
export const EXTENSION_R_MULTIPLE = 3;

/**
 * Closest a structural target may sit, as a multiple of risk. Without this, the
 * nearest pivot above entry can be a few ticks away and the plan reports a
 * target it would reach by accident.
 */
export const MIN_TARGET_R = 1;

/**
 * How far apart consecutive targets must sit, as a multiple of risk. Two pivots
 * a few ticks apart are one level, and listing both pads the plan without adding
 * information.
 */
export const MIN_TARGET_SEPARATION_R = 0.5;

/** Minimum reward-to-risk worth taking. Below this the plan is reported but flagged. */
export const MIN_RISK_REWARD = 1.5;

/**
 * A stable, human-readable identifier for one setup.
 *
 * Inputs are rounded before hashing so that a tick of noise doesn't mint a new
 * ID for what is obviously the same setup, but a genuinely different level does.
 *
 * @param {{symbol: string, timeframe: string, direction: string, codes: string[], pivotTime: number, invalidation: number, entry: number}} p
 * @returns {string}
 */
export function mintSignalId(p) {
  const round = (n) => Number(n.toPrecision(6));
  const material = [
    p.symbol, p.timeframe, p.direction,
    p.codes.join(''), p.pivotTime,
    round(p.invalidation), round(p.entry),
  ].join('|');

  const digest = createHash('sha256').update(material).digest('hex').slice(0, 4);
  const asset = p.symbol.replace(/USDT$/, '');
  const lead = p.codes[0] ?? 'XX';
  return `${asset}-${lead}-${digest}`;
}

/**
 * The level that would prove one direction wrong: the price the failed move gave
 * up, buffered so ordinary noise doesn't trigger it.
 */
function levelsFor(candles, direction, range) {
  const bearish = direction === 'short';
  const pivots = bearish
    ? swingHighs(candles, THRESHOLDS.swingLookback)
    : swingLows(candles, THRESHOLDS.swingLookback);

  const pivot = pivots.at(-1);
  if (!pivot) return null;

  const buffer = range * INVALIDATION_BUFFER_ATR;
  return { pivot, invalidation: bearish ? pivot.price + buffer : pivot.price - buffer };
}

/**
 * Prior pivots beyond entry, nearest first, but only those far enough away to be
 * worth planning around. Needs riskDistance, which is why it can't live inside
 * {@link levelsFor}.
 */
function selectTargets(candles, direction, entry, riskDistance) {
  const bearish = direction === 'short';
  const pivots = bearish
    ? swingLows(candles, THRESHOLDS.swingLookback)
    : swingHighs(candles, THRESHOLDS.swingLookback);

  const floor = riskDistance * MIN_TARGET_R;
  const beyond = pivots
    .map((p) => p.price)
    .filter((price) => (bearish ? entry - price >= floor : price - entry >= floor));

  const ordered = bearish
    ? [...new Set(beyond)].sort((a, b) => b - a)
    : [...new Set(beyond)].sort((a, b) => a - b);

  // Collapse clusters: keep the first of any group sitting within the separation
  // floor of an already-chosen level.
  const separation = riskDistance * MIN_TARGET_SEPARATION_R;
  const kept = [];
  for (const price of ordered) {
    if (kept.length === 0 || Math.abs(price - kept.at(-1)) >= separation) kept.push(price);
  }
  return kept;
}

/**
 * Fill out to three targets. Structure first; when it runs out, extend by a
 * multiple of the risk taken and say so rather than inventing a pivot.
 */
function buildTargets(structural, entry, riskDistance, direction) {
  const bearish = direction === 'short';
  const targets = [...structural];
  const notes = [];

  if (targets.length >= 3) return { targets: targets.slice(0, 3), notes };

  const extension = bearish
    ? entry - riskDistance * EXTENSION_R_MULTIPLE
    : entry + riskDistance * EXTENSION_R_MULTIPLE;

  // Only append the extension if it actually reaches past the last structural
  // level. Otherwise structure already goes further, and inserting the extension
  // would put the target list out of order.
  const reachesFurther = targets.length === 0
    || (bearish ? extension < targets.at(-1) : extension > targets.at(-1));

  if (reachesFurther) {
    targets.push(extension);
    notes.push(
      structural.length === 1
        ? 'only one prior pivot sits beyond entry, so the final target is a '
          + `${EXTENSION_R_MULTIPLE}R extension rather than a level price has traded`
        : `${structural.length === 0 ? 'no' : structural.length} prior pivots sit beyond entry, `
          + `so the final target is a ${EXTENSION_R_MULTIPLE}R extension rather than a level price has traded`,
    );
  } else {
    notes.push(
      `structure already reaches past the ${EXTENSION_R_MULTIPLE}R extension, so no synthetic target was added`,
    );
  }

  return { targets: targets.slice(0, 3), notes };
}

/**
 * Build a plan from a snapshot, or explain why there isn't one.
 *
 * @param {import('../data/snapshot.mjs').Snapshot} snap
 * @param {{timeframe?: string, stake?: number, riskFraction?: number, leverage?: number}} [opts]
 */
export function buildPlan(snap, opts = {}) {
  const timeframe = opts.timeframe ?? '1h';
  const stake = opts.stake ?? 50;
  const riskFraction = opts.riskFraction ?? 0.02;
  const leverage = opts.leverage ?? 3;

  const report = evaluate(snap, timeframe);
  const candles = snap.candles[timeframe];

  /** @type {any} */
  const plan = {
    signalId: null,
    symbol: snap.symbol,
    timeframe,
    direction: null,
    markPrice: snap.markPrice,
    readAt: snap.fetchedAt,
    tradeable: false,
    reason: '',
    agreement: {
      fired: report.signals.filter((s) => s.fired).map((s) => s.id),
      quiet: report.signals.filter((s) => !s.fired).map((s) => s.id),
      conflicted: report.conflicted,
    },
    evidence: report.signals.filter((s) => s.fired).flatMap((s) => s.evidence),
    // Counterexamples come from every signal, not just the ones that fired —
    // a quiet signal explaining why it stayed quiet is the most useful objection
    // there is.
    counterexamples: report.signals.flatMap((s) =>
      s.counterexamples
        .filter((c) => c.label !== 'None found')
        .map((c) => ({ ...c, from: s.id }))),
    signals: report.signals,
  };

  if (report.conflicted) {
    plan.reason = 'Signals point in both directions on this timeframe. No plan — a setup nobody agrees on is not a setup.';
    return plan;
  }
  if (!report.direction) {
    plan.reason = `Nothing fired on ${timeframe}. ${report.signals.map((s) => s.headline).find(Boolean) ?? ''}`.trim();
    return plan;
  }

  const range = atr(candles, THRESHOLDS.atrPeriod);
  if (range === null) {
    plan.reason = 'Not enough history to measure ATR, so no invalidation level can be set.';
    return plan;
  }

  const structure = levelsFor(candles, report.direction, range);
  if (!structure) {
    plan.reason = 'No confirmed pivot to place an invalidation against.';
    return plan;
  }

  const bearish = report.direction === 'short';
  const entry = snap.markPrice;
  const { invalidation, pivot } = structure;

  // If price has already run past the level that would prove this wrong, there
  // is no trade left — the risk gate would refuse it anyway, but saying so here
  // is more useful than a list of refusals.
  const riskDistance = bearish ? invalidation - entry : entry - invalidation;
  if (riskDistance <= 0) {
    plan.direction = report.direction;
    plan.reason = `Price (${fmtPrice(entry)}) has already passed the invalidation level (${fmtPrice(invalidation)}). The setup is spent.`;
    return plan;
  }

  const structuralTargets = selectTargets(candles, report.direction, entry, riskDistance).slice(0, 2);
  const { targets, notes: targetNotes } = buildTargets(
    structuralTargets, entry, riskDistance, report.direction,
  );

  const firstTargetDistance = Math.abs(targets[0] - entry);
  const riskReward = firstTargetDistance / riskDistance;

  const fast = emaSeries(candles.map((c) => c.close), THRESHOLDS.emaFast).at(-1);
  const sizing = sizePosition({
    entry,
    stop: invalidation,
    direction: report.direction,
    stake,
    riskFraction,
    leverage,
    filters: snap.filters,
  });

  const codes = plan.agreement.fired.map((id) => SIGNAL_CODES[id] ?? 'XX');

  plan.direction = report.direction;
  plan.tradeable = sizing.ok;
  plan.signalId = mintSignalId({
    symbol: snap.symbol,
    timeframe,
    direction: report.direction,
    codes,
    pivotTime: pivot.time,
    invalidation,
    entry,
  });

  // A zone rather than a single price: the mark is where it trades now, the fast
  // EMA is where a retest would fill better.
  plan.entry = {
    market: entry,
    retest: fast === null ? null : fast,
    note: fast === null
      ? 'no EMA reference available, market entry only'
      : `market at ${fmtPrice(entry)}, or a retest toward the ${THRESHOLDS.emaFast} EMA at ${fmtPrice(fast)}`,
  };
  plan.invalidation = {
    price: invalidation,
    basis: `${bearish ? 'above' : 'below'} the ${bearish ? 'failed high' : 'defended low'} of ${pivot.price}, buffered by ${INVALIDATION_BUFFER_ATR} ATR (${fmtPrice(range * INVALIDATION_BUFFER_ATR)})`,
  };
  plan.targets = targets.map((price, i) => ({
    label: `T${i + 1}`,
    price,
    r: Math.abs(price - entry) / riskDistance,
    basis: i < structuralTargets.length ? 'prior pivot' : `${EXTENSION_R_MULTIPLE}R extension`,
  }));
  plan.riskDistance = riskDistance;
  plan.riskReward = riskReward;
  plan.sizing = sizing;
  plan.notes = targetNotes;

  if (!sizing.ok) {
    plan.reason = `The setup is valid but not sizeable on a ${stake} stake: ${sizing.refusals.join('; ')}`;
  }

  if (riskReward < MIN_RISK_REWARD) {
    plan.counterexamples.push({
      from: 'plan',
      label: 'Reward does not justify the risk',
      detail: `The first target is only ${riskReward.toFixed(2)}R away, under the ${MIN_RISK_REWARD}R minimum. The structure is there but the geometry is poor.`,
    });
  }

  return plan;
}
