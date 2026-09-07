import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

/**
 * The signal log — the thing that makes a plan auditable rather than just
 * confident.
 *
 * Every plan with an ID gets written down once. Later, resolution reads what
 * price actually did and reports the outcome, including when the plan was wrong.
 * The one rule this file exists to enforce: an outcome is only ever reported if
 * candle history shows it. There is no path here that infers, estimates, or
 * assumes a result.
 */

const DEFAULT_PATH = resolvePath(process.env.OVU_LOG ?? 'signals.json');

/** @returns {{version: number, entries: object[]}} */
function load(path = DEFAULT_PATH) {
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { version: parsed.version ?? 1, entries: parsed.entries ?? [] };
  } catch (err) {
    throw new Error(`signal log at ${path} is not readable JSON: ${err.message}`);
  }
}

function save(log, path = DEFAULT_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
}

/**
 * Write a plan to the log. Idempotent: recording the same setup twice does not
 * create a second entry, which is the whole reason signal IDs are derived from
 * data rather than the clock.
 *
 * @param {object} plan  A plan from buildPlan with a signalId.
 * @param {string} [path]
 * @returns {{recorded: boolean, entry: object}}
 */
export function record(plan, path = DEFAULT_PATH) {
  if (!plan.signalId) throw new Error('cannot record a plan with no signalId');

  const log = load(path);
  const existing = log.entries.find((e) => e.signalId === plan.signalId);
  if (existing) return { recorded: false, entry: existing };

  const entry = {
    signalId: plan.signalId,
    symbol: plan.symbol,
    timeframe: plan.timeframe,
    direction: plan.direction,
    firedSignals: plan.agreement.fired,
    entryPrice: plan.markPrice,
    invalidation: plan.invalidation.price,
    targets: plan.targets.map((t) => ({ label: t.label, price: t.price, r: t.r })),
    riskReward: plan.riskReward,
    tradeable: plan.tradeable,
    counterexampleCount: plan.counterexamples.length,
    createdAt: plan.readAt,
    status: 'open',
    resolvedAt: null,
    outcome: null,
  };

  log.entries.push(entry);
  save(log, path);
  return { recorded: true, entry };
}

/** Every entry, newest first. */
export function list(path = DEFAULT_PATH) {
  return [...load(path).entries].sort((a, b) => b.createdAt - a.createdAt);
}

/** One entry by ID, or null. */
export function get(signalId, path = DEFAULT_PATH) {
  return load(path).entries.find((e) => e.signalId === signalId) ?? null;
}

/**
 * Work out what actually happened, from candles only.
 *
 * Walks forward from the moment the plan was made and reports whichever came
 * first: price trading through the invalidation, or reaching a target. If
 * neither has happened it stays open — it does not guess which is more likely.
 *
 * @param {object} entry
 * @param {{openTime:number, high:number, low:number}[]} candles
 */
export function resolveEntry(entry, candles) {
  const after = candles.filter((c) => c.openTime >= entry.createdAt);
  if (after.length === 0) {
    return { status: 'open', outcome: null, note: 'no candles since the plan was made' };
  }

  const short = entry.direction === 'short';
  const hitInvalidation = (c) => (short ? c.high >= entry.invalidation : c.low <= entry.invalidation);
  const hitTarget = (c, price) => (short ? c.low <= price : c.high >= price);

  for (const c of after) {
    // Invalidation is checked first. Within a single candle we cannot know the
    // order, so the pessimistic reading is the honest one.
    if (hitInvalidation(c)) {
      return {
        status: 'invalidated',
        outcome: {
          at: c.openTime,
          level: entry.invalidation,
          note: 'price traded through the invalidation level',
        },
      };
    }
    const reached = entry.targets.filter((t) => hitTarget(c, t.price));
    if (reached.length) {
      const best = reached.at(-1);
      return {
        status: 'target-hit',
        outcome: {
          at: c.openTime,
          label: best.label,
          level: best.price,
          r: best.r,
          note: `price reached ${best.label} at ${best.price}`,
        },
      };
    }
  }

  return {
    status: 'open',
    outcome: null,
    note: `${after.length} candles since the plan was made, neither level touched`,
  };
}

/**
 * Resolve one entry against fresh candles and persist the result.
 * @param {string} signalId
 * @param {object[]} candles
 * @param {string} [path]
 */
export function applyResolution(signalId, candles, path = DEFAULT_PATH) {
  const log = load(path);
  const entry = log.entries.find((e) => e.signalId === signalId);
  if (!entry) return null;

  const result = resolveEntry(entry, candles);
  entry.status = result.status;
  entry.outcome = result.outcome;
  entry.note = result.note ?? null;
  entry.resolvedAt = result.status === 'open' ? null : Date.now();

  save(log, path);
  return entry;
}

/**
 * A plain count of outcomes. Deliberately not a win rate: with a handful of
 * entries collected over days, a percentage would imply a confidence the data
 * cannot support.
 */
export function tally(path = DEFAULT_PATH) {
  const entries = load(path).entries;
  const counts = { open: 0, invalidated: 0, 'target-hit': 0 };
  for (const e of entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
  return {
    total: entries.length,
    ...counts,
    since: entries.length ? Math.min(...entries.map((e) => e.createdAt)) : null,
    note: 'Counts only. No win rate is reported — the sample is far too small to support one.',
  };
}
