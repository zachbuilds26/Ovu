import { SYMBOLS } from '../src/data/futures.mjs';
import { snapshot } from '../src/data/snapshot.mjs';
import { evaluate } from '../src/engine/signals.mjs';

/**
 * Runs the engine over live data for all three symbols and prints what it finds,
 * including everything that argues against each result. Run: npm run scan
 *
 * This is the fastest honest check on whether the signals are any good. A signal
 * that fires on all three symbols in every market is not a signal.
 */

const timeframe = process.argv[2] ?? '1h';
const only = process.argv[3];
const symbols = only ? [only.toUpperCase()] : SYMBOLS;

for (const symbol of symbols) {
  let report;
  try {
    report = evaluate(await snapshot(symbol), timeframe);
  } catch (err) {
    console.log(`\n${symbol}  —  could not evaluate: ${err.message}`);
    continue;
  }

  const verdict = report.conflicted
    ? 'CONFLICTED'
    : report.direction
      ? report.direction.toUpperCase()
      : 'NOTHING';

  console.log(`\n${'='.repeat(72)}`);
  console.log(`${symbol} @ ${report.markPrice}   ${timeframe}   ${verdict}`);
  console.log(`${report.firedCount}/4 signals fired, ${report.counterexampleCount} counterexamples raised`);
  console.log('='.repeat(72));

  for (const s of report.signals) {
    const mark = s.fired ? `FIRED ${s.direction}` : 'quiet';
    console.log(`\n  ${s.name}  [${mark}]`);
    console.log(`  ${s.headline}`);

    if (s.evidence.length) {
      console.log('    evidence:');
      for (const e of s.evidence) console.log(`      ${e.label}: ${e.value}   (${e.source})`);
    }

    console.log('    against:');
    for (const c of s.counterexamples) console.log(`      ${c.label} — ${c.detail}`);
  }
}

console.log('');
