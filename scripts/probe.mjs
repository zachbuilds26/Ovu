import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Talks to OVU the way a real MCP client does — spawns the server over stdio,
 * lists its tools, and calls each one. Run: npm run probe
 *
 * This is the check that matters before wiring OVU into Claude Code: if a tool
 * throws here, it throws there.
 */

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/mcp/server.mjs'],
  // Probe `plan` calls record to the signal log by design. Point the spawned
  // server at a throwaway log so test runs never pollute the real track record.
  env: {
    ...process.env,
    OVU_LOG: join(mkdtempSync(join(tmpdir(), 'ovu-probe-')), 'signals.json'),
  },
});

const client = new Client({ name: 'ovu-probe', version: '0.1.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`connected — ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}\n`);

const calls = [
  ['scan', { timeframe: '1h' }],
  ['trending', {}],
  ['analyze', { symbol: 'BTCUSDT', timeframe: '1h' }],
  ['positioning', { symbol: 'ETHUSDT', timeframe: '1h' }],
  ['plan', { symbol: 'BTCUSDT', timeframe: '1h', stake: 50, leverage: 3 }],
  ['resolve', { refresh: true }],
  ['signal', { signalId: 'DOES-NOT-EXIST' }],
];

let failures = 0;

for (const [name, args] of calls) {
  try {
    const res = await client.callTool({ name, arguments: args });
    const body = res.content.map((c) => c.text ?? '').join('');
    const first = body.split('\n').find((l) => l.trim()) ?? '';
    console.log(`ok    ${name.padEnd(12)} ${body.length} chars — ${first.slice(0, 74)}`);
    if (res.isError) {
      console.log(`      ^ returned isError`);
      failures += 1;
    }
  } catch (err) {
    console.log(`FAIL  ${name.padEnd(12)} ${err.message}`);
    failures += 1;
  }
}

// Show one full result so the formatting can be eyeballed, not just counted.
const plan = await client.callTool({
  name: 'plan',
  arguments: { symbol: 'BTCUSDT', timeframe: '1h', stake: 50, leverage: 3 },
});
console.log(`\n${'─'.repeat(74)}\n${plan.content.map((c) => c.text).join('')}\n`);

await client.close();
console.log(failures === 0 ? 'All tools responded.' : `${failures} tool call(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
