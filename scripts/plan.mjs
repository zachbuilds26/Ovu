import { snapshot } from '../src/data/snapshot.mjs';
import { buildPlan } from '../src/engine/plan.mjs';
import { fmtPrice } from '../src/engine/format.mjs';

/**
 * Prints one plan the way it should read to a person.
 *
 *   npm run plan                      BTCUSDT, 1h, 50 stake
 *   npm run plan ETHUSDT 4h 200 3     symbol, timeframe, stake, leverage
 *
 * The counter-case is printed last and never abbreviated. If a plan looks good
 * until you read that section, the section is doing its job.
 */

const [symbolArg, timeframeArg, stakeArg, leverageArg] = process.argv.slice(2);
const symbol = (symbolArg ?? 'BTCUSDT').toUpperCase();
const timeframe = timeframeArg ?? '1h';
const stake = Number(stakeArg ?? 50);
const leverage = Number(leverageArg ?? 3);

const plan = buildPlan(await snapshot(symbol), {
  timeframe, stake, leverage, riskFraction: 0.02,
});

const money = fmtPrice;
const line = (s = '') => console.log(s);

line();
line('─'.repeat(74));
line(`${symbol}   ${timeframe}   mark ${plan.markPrice}`);
line(plan.signalId ? `signal ${plan.signalId}` : 'no setup');
line('─'.repeat(74));

// The signal card: the shareable trade layout, same numbers as below.
{
  const pair = symbol.replace(/USDT$/, '/USDT');
  line();
  if (!plan.direction) {
    line(`${pair} — NO TRADE`);
  } else {
    const side = plan.direction === 'long' ? 'LONG (BUY)' : 'SHORT (SELL)';
    line(`${pair} — ${side}`);
    line(`  Entry   ${money(plan.entry.market)}${plan.entry.retest !== null ? `  (retest ${money(plan.entry.retest)})` : ''}`);
    for (const t of plan.targets) line(`  ${t.label.padEnd(7)} ${money(t.price)}  (${t.r.toFixed(2)}R)`);
    line(`  SL      ${money(plan.invalidation.price)}`);
    if (plan.sizing?.ok) {
      line(`  Size    ${plan.sizing.qty}  (${money(plan.sizing.notional)} @ ${plan.sizing.leverage}x)   Risk ${money(plan.sizing.worstCase)}`);
    } else {
      line('  Size    NOT SIZEABLE');
    }
    line(`  Signal  ${plan.signalId}`);
  }
  line('─'.repeat(74));
}

if (!plan.direction) {
  line();
  line(plan.reason);
} else {
  line();
  line(`${plan.direction.toUpperCase()}${plan.tradeable ? '' : '   NOT SIZEABLE'}`);
  if (plan.reason) line(plan.reason);

  if (plan.entry) {
    line();
    line(`  entry         ${plan.entry.note}`);
    line(`  invalidation  ${money(plan.invalidation.price)}`);
    line(`                ${plan.invalidation.basis}`);
    line(`  risk          ${money(plan.riskDistance)} per unit`);
    for (const t of plan.targets) {
      line(`  ${t.label.padEnd(13)} ${money(t.price)}   ${t.r.toFixed(2)}R   ${t.basis}`);
    }
    line(`  reward/risk   ${plan.riskReward.toFixed(2)}R to first target`);
  }

  if (plan.sizing?.ok) {
    const s = plan.sizing;
    line();
    line(`  size          ${s.qty} (${money(s.notional)} notional at ${s.leverage}x)`);
    line(`  margin        ${money(s.marginRequired)}`);
    line(`  worst case    ${money(s.worstCase)} — ${(s.worstCaseFractionOfStake * 100).toFixed(2)}% of a ${stake} stake`);
    line(`  liquidation   ${money(s.liquidationPrice)} approx (${(s.liquidationDistance * 100).toFixed(2)}% away)`);
    for (const n of s.notes) line(`                ${n}`);
  } else if (plan.sizing) {
    line();
    for (const r of plan.sizing.refusals) line(`  refused       ${r}`);
  }

  if (plan.evidence.length) {
    line();
    line('  evidence');
    for (const e of plan.evidence) line(`    ${e.label}: ${e.value}   (${e.source})`);
  }

  for (const n of plan.notes ?? []) line(`\n  note: ${n}`);
}

line();
line(`  against  (${plan.counterexamples.length})`);
if (plan.counterexamples.length === 0) {
  line('    Nothing in this snapshot argues against the result above.');
}
for (const c of plan.counterexamples) {
  line(`    [${c.from}] ${c.label}`);
  line(`      ${c.detail}`);
}
line();
