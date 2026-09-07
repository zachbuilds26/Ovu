import { z } from 'zod';
import { SYMBOLS, klines, openInterestHistory } from '../data/futures.mjs';
import { MEME_UNIVERSE } from '../data/universe.mjs';
import { rankMovers } from '../engine/trending.mjs';
import { snapshot } from '../data/snapshot.mjs';
import { fmtPrice } from '../engine/format.mjs';
import { evaluate } from '../engine/signals.mjs';
import { buildPlan } from '../engine/plan.mjs';
import * as log from '../store/signals.mjs';

/**
 * The six tools. Thin wrappers: every one of them fetches a snapshot, calls into
 * the engine, and formats the result. No analysis happens in this file.
 *
 * What OVU deliberately does not have is a tool that places an order. It holds
 * no credentials and has no code path to a Binance trading endpoint — execution
 * belongs to `binance-mcp-server`, which asks the user to confirm every write.
 */

const SymbolArg = z.string().describe('Perpetual symbol, e.g. BTCUSDT');
const TimeframeArg = z.enum(['15m', '1h', '4h']).default('1h')
  .describe('Candle timeframe to read');

const text = (s) => ({ content: [{ type: 'text', text: s }] });
/** Display prices — see src/engine/format.mjs. Ratios/percents keep toFixed(2) inline. */
const money = fmtPrice;

/**
 * Closes every market answer. Always present, always the same words, so no
 * agent paraphrase can soften it into "do your own research ;)" energy.
 */
const NFA = [
  '_Not financial advice. Trading perpetual futures — especially with leverage — can lose more than you put in. '
  + 'Never trade money you cannot afford to lose, and treat every signal above as an unvalidated starting point, not a prediction._',
];

/**
 * Every tool reads live Binance data, and live data sometimes doesn't answer.
 * Without this, a timeout surfaces as a raw error dump and a sloppy agent
 * paraphrases it into something that sounds like a result. With this, failure
 * reads as failure: what was attempted, why it stopped, and explicit notice
 * that nothing below is data.
 */
const safe = (name, fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    // Logged server-side with the tool name: without this, a non-network bug
    // (e.g. in formatting) would disguise itself as a market-read failure.
    console.error(`[ovu:${name}] handler threw:`, err?.message ?? err);
    const why = String(err?.message ?? err).slice(0, 160);
    return text([
      `# ${name} — couldn't read the market`,
      '',
      `Attempted a live pull from Binance public futures data and it failed: ${why}`,
      '',
      'Say exactly this to the user: the read failed, try again in a minute. '
      + 'Do not describe what the market "looks like" — no numbers were returned, '
      + 'so there is nothing to summarise and nothing was invented for this response.',
    ].join('\n'));
  }
};

function formatSignal(s) {
  const lines = [`### ${s.name} — ${s.fired ? `FIRED ${s.direction}` : 'quiet'}`, s.headline];
  if (s.evidence.length) {
    lines.push('', 'Evidence:');
    for (const e of s.evidence) lines.push(`- ${e.label}: ${e.value}  _(${e.source})_`);
  }
  lines.push('', 'Against:');
  for (const c of s.counterexamples) lines.push(`- **${c.label}** — ${c.detail}`);
  return lines.join('\n');
}

/**
 * The signal card: the classic trader layout (pair, side, entry, TPs, SL,
 * leverage, risk, id) up front, in the exact words trading groups use.
 * Everything below it — evidence, sizing maths, counter-case — is unchanged;
 * the card is a shop window, not a replacement.
 */
function signalCard(plan) {
  const pair = plan.symbol.replace(/USDT$/, '/USDT');
  if (!plan.direction) {
    return [
      `**${pair} — NO TRADE**`,
      '',
      plan.reason,
    ];
  }

  const side = plan.direction === 'long' ? 'LONG (BUY)' : 'SHORT (SELL)';
  const tps = plan.targets.map((t) => `- ${t.label}: ${money(t.price)} (${t.r.toFixed(2)}R)`).join('\n');
  const sizeLine = plan.sizing?.ok
    ? `- Size: ${plan.sizing.qty} — ${money(plan.sizing.notional)} notional at ${plan.sizing.leverage}x`
    : '- Size: NOT SIZEABLE (see refusal below)';
  const riskLine = plan.sizing?.ok
    ? `- Risk: ${money(plan.sizing.worstCase)} if SL hits`
    : `- Risk: unknown — position could not be sized`;

  return [
    `**${pair} — ${side}**`,
    '',
    `- Entry: ${money(plan.entry.market)}${plan.entry.retest !== null ? ` (or retest ${money(plan.entry.retest)})` : ''}`,
    tps,
    `- SL: ${money(plan.invalidation.price)}`,
    sizeLine,
    riskLine,
    `- Signal: \`${plan.signalId}\` — read at ${new Date(plan.readAt).toISOString()}`,
    plan.tradeable ? '' : '_Not tradeable as sized — read the full plan before touching this._',
  ].filter((l) => l !== '');
}

function formatPlan(plan) {
  const out = [
    ...signalCard(plan),
    '',
    '---',
    '',
    `# ${plan.symbol} ${plan.timeframe} — ${plan.direction ? plan.direction.toUpperCase() : 'no setup'}`,
    plan.signalId ? `Signal \`${plan.signalId}\`` : '',
    `Mark ${plan.markPrice} — read at ${new Date(plan.readAt).toISOString()} (live, not a quote)`,
    '',
  ];

  if (!plan.direction) {
    out.push(plan.reason);
  } else {
    if (plan.reason) out.push(`_${plan.reason}_`, '');
    out.push(
      `- Entry: ${plan.entry.note}`,
      `- Invalidation: **${money(plan.invalidation.price)}** — ${plan.invalidation.basis}`,
      `- Risk per unit: ${money(plan.riskDistance)}`,
      ...plan.targets.map((t) => `- ${t.label}: ${money(t.price)} (${t.r.toFixed(2)}R, ${t.basis})`),
      `- Reward/risk to first target: ${plan.riskReward.toFixed(2)}R`,
    );

    if (plan.sizing?.ok) {
      const s = plan.sizing;
      out.push(
        '',
        `- Size: ${s.qty} — ${money(s.notional)} notional at ${s.leverage}x`,
        `- Margin: ${money(s.marginRequired)}`,
        `- Worst case at invalidation: **${money(s.worstCase)}**`,
        `- Approximate liquidation: ${money(s.liquidationPrice)} (${(s.liquidationDistance * 100).toFixed(2)}% away)`,
        ...s.notes.map((n) => `- Note: ${n}`),
      );
    } else if (plan.sizing) {
      out.push('', '**Not sizeable:**', ...plan.sizing.refusals.map((r) => `- ${r}`));
    }

    out.push('', ...(plan.notes ?? []).map((n) => `_Note: ${n}_`));
  }

  out.push('', `## Against (${plan.counterexamples.length})`);
  if (plan.counterexamples.length === 0) {
    out.push('Nothing in this snapshot argues against the result above.');
  }
  for (const c of plan.counterexamples) {
    out.push(`- **${c.label}** _(${c.from})_ — ${c.detail}`);
  }
  out.push(
    '',
    '---',
    'OVU does not place orders. To act on this, hand the levels to `binance-mcp-server`,',
    'which will ask you to confirm before anything is sent.',
    '',
    ...NFA,
  );
  return out.join('\n');
}

/**
 * Register all six tools on a server.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerTools(server) {
  server.registerTool('scan', {
    title: 'Scan all covered perpetuals',
    description:
      'Read BTC, ETH and SOL perpetuals for all four structural patterns and report which are '
      + 'firing, in which direction, and how many objections each carries. Start here.',
    inputSchema: { timeframe: TimeframeArg },
  }, safe('scan', async ({ timeframe }) => {
    const reports = await Promise.all(
      SYMBOLS.map(async (symbol) => evaluate(await snapshot(symbol), timeframe)),
    );

    const rows = reports.map((r) => {
      const verdict = r.conflicted ? 'conflicted' : (r.direction ?? 'nothing');
      const names = r.signals.filter((s) => s.fired).map((s) => s.id).join(', ') || '—';
      return `| ${r.symbol} | ${r.markPrice} | ${verdict} | ${r.firedCount}/4 | ${r.counterexampleCount} | ${names} |`;
    });

    const lead = [...reports].sort(
      (a, b) => b.firedCount - a.firedCount || b.counterexampleCount - a.counterexampleCount,
    )[0];
    const next = lead && lead.conflicted
      ? `Conflicted: ${lead.symbol} has signals firing both ways (${lead.firedCount}/4). No direction to follow — \`analyze\` ${lead.symbol} to read the disagreement itself.`
      : lead && lead.firedCount > 0
        ? `Lead: ${lead.symbol} — ${lead.firedCount}/4 firing ${lead.direction}, ${lead.counterexampleCount} objections. Next: \`analyze\` ${lead.symbol}.`
        : 'Nothing firing on any symbol this timeframe. Say so and stop — do not go fishing on other timeframes unasked.';

    return text([
      `# Scan — ${timeframe}`,
      '',
      '| Symbol | Mark | Verdict | Fired | Against | Signals |',
      '|---|---|---|---|---|---|',
      ...rows,
      '',
      next,
      'A verdict of "nothing" means no pattern is present — not that nothing is happening.',
      '',
      ...NFA,
    ].join('\n'));
  }));

  server.registerTool('analyze', {
    title: 'Analyse one perpetual in full',
    description:
      'Every signal for one symbol with the numbers behind it, the endpoint each number came '
      + 'from, and everything that argues against each reading.',
    inputSchema: { symbol: SymbolArg, timeframe: TimeframeArg },
  }, safe('analyze', async ({ symbol, timeframe }) => {
    const report = evaluate(await snapshot(symbol.toUpperCase()), timeframe);
    const verdict = report.conflicted
      ? 'Signals disagree — no single direction'
      : report.direction
        ? `Direction: ${report.direction}`
        : 'No pattern present';
    const next = report.conflicted
      ? 'No plan while signals point both ways. Say so and stop.'
      : report.direction
        ? `Next: \`plan\` ${report.symbol} on ${timeframe} for entry, invalidation, targets and a size — or leave it here if the objections above already kill it.`
        : 'Nothing to plan. Say so and stop.';

    return text([
      `# ${report.symbol} ${timeframe} — mark ${report.markPrice}`,
      '',
      `${verdict}. ${report.firedCount} of 4 signals fired, ${report.counterexampleCount} objections raised.`,
      '',
      ...report.signals.map(formatSignal),
      '',
      next,
      '',
      ...NFA,
    ].join('\n\n'));
  }));

  server.registerTool('plan', {
    title: 'Build a trading plan',
    description:
      'Turn a setup into entry, invalidation, targets, reward/risk and a position size — or '
      + 'refuse and explain why. Leads with a signal card (pair, LONG/BUY or SHORT/SELL, entry, '
      + 'TPs, SL, leverage, risk, signal ID) followed by the full evidence and counter-case. '
      + 'Records the plan under a signal ID so it can be checked later. '
      + 'Repeat its levels verbatim; they are computed from structure, never round or adjust them. '
      + 'Places no orders.',
    inputSchema: {
      symbol: SymbolArg,
      timeframe: TimeframeArg,
      stake: z.number().positive().default(50)
        .describe('Collateral to risk, in USDT. A ceiling, not a target.'),
      leverage: z.number().min(1).max(20).default(3),
      riskFraction: z.number().positive().max(0.25).default(0.02)
        .describe('Fraction of stake to lose if the invalidation is hit'),
    },
  }, safe('plan', async ({ symbol, timeframe, stake, leverage, riskFraction }) => {
    const plan = buildPlan(await snapshot(symbol.toUpperCase()), {
      timeframe, stake, leverage, riskFraction,
    });

    let recorded = '';
    if (plan.signalId) {
      const { recorded: isNew } = log.record(plan);
      recorded = isNew
        ? `\n\n_Recorded as \`${plan.signalId}\`. Ask \`resolve\` later to find out how it went._`
        : `\n\n_Already logged as \`${plan.signalId}\` — same setup, same id._`;
    }

    return text(formatPlan(plan) + recorded);
  }));

  server.registerTool('trending', {
    title: 'Which memes are moving now',
    description:
      'Rank the 12-meme universe by 24h move with volume and open-interest context. '
      + 'Discovery, not a setup — feed anything interesting into analyze and plan. '
      + 'Works on any symbol those tools accept.',
    inputSchema: {},
  }, safe('trending', async () => {
    const rows = [];
    const skipped = [];
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // Sequential across symbols with a breath between them: 12 rapid bursts
    // from a shared hosting IP read as abuse. 300ms costs ~4s, saves 418s.
    for (const m of MEME_UNIVERSE) {
      try {
        const [candles, oi] = await Promise.all([
          klines(m.symbol, '1h', 30),
          openInterestHistory(m.symbol, '1h', 24).catch(() => null),
        ]);
        rows.push({
          symbol: m.symbol, tag: m.tag, candles,
          oiFirst: oi?.[0]?.openInterest ?? null,
          oiLast: oi?.at(-1)?.openInterest ?? null,
        });
      } catch (err) {
        skipped.push(`${m.symbol} (${err.message.slice(0, 80)})`);
      }
      await wait(300);
    }

    const ranked = rankMovers(rows);
    const pct = (n) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;
    const lines = [
      '# Trending memes — 1h, 24h window',
      '',
      '| # | Meme | Last | 24h | Volume vs base | OI 24h | Flags |',
      '|---|---|---|---|---|---|---|',
      ...ranked.map((r, i) => [
        `| ${i + 1}`, r.tag, r.last,
        pct(r.move24),
        r.volMultiple === null ? '—' : `${r.volMultiple.toFixed(1)}x`,
        r.oiChange === null ? '—' : pct(r.oiChange),
        r.flags.join(', ') || '—',
      ].join(' | ') + ' |'),
    ];
    if (skipped.length) lines.push('', `_Skipped: ${skipped.join('; ')}_`);
    const top = ranked[0];
    const lead = !top
      ? 'No meme returned data. Say the read failed and stop.'
      : Math.abs(top.move24) >= 0.05
        ? `Lead: ${top.tag} moved most (${pct(top.move24)}${top.oiChange !== null ? `, OI ${pct(top.oiChange)}` : ''}). Next: \`analyze\` ${top.symbol} — movement is not a setup.`
        : `Quiet board — the largest move is ${top.tag} at ${pct(top.move24)}. Say so and stop; do not manufacture interest.`;
    lines.push(
      '',
      lead,
      'A big move with a volume surge and rising OI is new money. A big move on flat volume with falling OI is people leaving.',
      'OVU does not place orders. To act, hand levels to `binance-mcp-server`.',
      '',
      ...NFA,
    );
    return text(lines.join('\n'));
  }));

  server.registerTool('positioning', {
    title: 'Funding, open interest and flow',
    description:
      'The positioning picture on its own: what funding costs, whether open interest is growing '
      + 'or shrinking, how large accounts are positioned, and which way aggressive orders are going.',
    inputSchema: { symbol: SymbolArg, timeframe: TimeframeArg },
  }, safe('positioning', async ({ symbol, timeframe }) => {
    const snap = await snapshot(symbol.toUpperCase());
    const oi = snap.openInterestHistory;
    const oiChange = (oi.at(-1).openInterest / oi[0].openInterest - 1) * 100;
    const ratio = snap.topTraderRatio.at(-1);
    const taker = snap.takerFlow.at(-1);
    const funding = snap.fundingHistory.slice(-8);
    const meanFunding = funding.reduce((a, f) => a + f.fundingRate, 0) / funding.length;

    return text([
      `# ${snap.symbol} positioning`,
      '',
      `- Mark: ${snap.markPrice} (index ${snap.indexPrice})`,
      `- Funding now: ${(snap.lastFundingRate * 100).toFixed(4)}% per interval`,
      `- Funding, mean of last ${funding.length}: ${(meanFunding * 100).toFixed(4)}%`,
      `- Next funding: ${new Date(snap.nextFundingTime).toISOString()}`,
      `- Open interest: ${snap.openInterest.toLocaleString()} base units`,
      `- Open interest change over ${oi.length} periods: ${oiChange >= 0 ? '+' : ''}${oiChange.toFixed(2)}%`,
      ratio ? `- Top traders: ${(ratio.longAccount * 100).toFixed(1)}% long, ratio ${ratio.longShortRatio}` : '',
      taker ? `- Taker buy/sell: ${taker.buySellRatio} (buy ${taker.buyVol}, sell ${taker.sellVol})` : '',
      '',
      'Rising open interest into a move means new positions are funding it. Falling open interest',
      'means the move is people leaving, which historically continues less often — read the',
      `\`positioning-shift\` signal in \`analyze ${snap.symbol}\` for how OVU treats this.`,
      '',
      ...NFA,
    ].filter(Boolean).join('\n'));
  }));

  server.registerTool('signal', {
    title: 'Look up a signal by id',
    description:
      'Retrieve a recorded plan by its signal ID and check it against price since: still open, '
      + 'invalidated, or target reached. Outcomes come from candle history only.',
    inputSchema: {
      signalId: z.string().describe('A signal id such as BTC-RF-75ad'),
    },
  }, safe('signal', async ({ signalId }) => {
    const entry = log.get(signalId);
    if (!entry) {
      return text(`No signal recorded under \`${signalId}\`. Ask \`resolve\` for everything on file.`);
    }

    const candles = await klines(entry.symbol, entry.timeframe, 500);
    const updated = log.applyResolution(signalId, candles) ?? entry;

    return text([
      `# \`${updated.signalId}\` — ${updated.status}`,
      '',
      `- ${updated.symbol} ${updated.timeframe} ${updated.direction}`,
      `- Made at ${new Date(updated.createdAt).toISOString()} with mark ${updated.entryPrice}`,
      `- Invalidation ${money(updated.invalidation)}`,
      ...updated.targets.map((t) => `- ${t.label} ${money(t.price)} (${t.r.toFixed(2)}R)`),
      `- Reward/risk at the time: ${updated.riskReward?.toFixed(2) ?? '—'}R`,
      `- Objections raised when it was made: ${updated.counterexampleCount}`,
      '',
      updated.outcome
        ? `**Outcome:** ${updated.outcome.note}, at ${new Date(updated.outcome.at).toISOString()}.`
        : `**Still open.** ${updated.note ?? ''}`,
      '',
      ...NFA,
    ].join('\n'));
  }));

  server.registerTool('resolve', {
    title: 'The track record so far',
    description:
      'Every plan OVU has recorded and what became of it, checked against price. Reports counts, '
      + 'not a win rate — the sample is far too small for a percentage to mean anything.',
    inputSchema: {
      refresh: z.boolean().default(true)
        .describe('Re-check open signals against current price before reporting'),
    },
  }, safe('resolve', async ({ refresh }) => {
    let entries = log.list();

    if (refresh) {
      const open = entries.filter((e) => e.status === 'open');
      const needed = [...new Set(open.map((e) => `${e.symbol}|${e.timeframe}`))];
      const candlesFor = new Map(
        await Promise.all(needed.map(async (key) => {
          const [symbol, timeframe] = key.split('|');
          return [key, await klines(symbol, timeframe, 500)];
        })),
      );
      for (const e of open) {
        log.applyResolution(e.signalId, candlesFor.get(`${e.symbol}|${e.timeframe}`) ?? []);
      }
      entries = log.list();
    }

    const counts = log.tally();
    if (counts.total === 0) {
      return text([
        '# Track record',
        '',
        'Nothing recorded yet. Every `plan` call writes its setup here under a signal id, and',
        'this tool reports what became of each one — including the ones that were wrong.',
      ].join('\n'));
    }

    return text([
      '# Track record',
      '',
      `${counts.total} recorded since ${new Date(counts.since).toISOString()}: `
        + `${counts['target-hit'] ?? 0} reached a target, ${counts.invalidated ?? 0} invalidated, `
        + `${counts.open ?? 0} still open.`,
      '',
      '| Signal | Symbol | Dir | Made | Status | Outcome |',
      '|---|---|---|---|---|---|',
      ...entries.map((e) => [
        `| \`${e.signalId}\``, e.symbol, e.direction,
        new Date(e.createdAt).toISOString().slice(0, 16).replace('T', ' '),
        e.status, e.outcome?.note ?? (e.note ?? '—'),
      ].join(' | ') + ' |'),
      '',
      `_${counts.note}_`,
    ].join('\n'));
  }));
}
