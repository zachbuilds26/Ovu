import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools.mjs';

/**
 * Shared OVU server factory — one definition, two transports.
 * stdio (`server.mjs`) for Claude Code, Streamable HTTP (`http.mjs`)
 * for Agent OS custom connectors. No logic lives here, just identity.
 */
export function createOvuServer() {
  const server = new McpServer(
    { name: 'ovu', version: '0.1.0' },
    {
      instructions: [
        'OVU is a research desk for BTC, ETH and SOL perpetual futures on Binance, plus a 12-coin meme desk (DOGE, SHIB, PEPE, BONK, FLOKI, WIF, POPCAT, TURBO, MEW, BRETT, MEME, PNUT).',
        '',
        'It reads four structural patterns — rebound failure, trend suppression, funding',
        'pressure and positioning shift — from public Binance futures data, and every result',
        'it returns includes the readings that argue against it.',
        '',
        'Start with `scan` for the majors or `trending` for memes. Use `analyze` for one symbol in depth, `plan` to get levels and a',
        'size, `positioning` for funding and open interest alone, `signal` to check one recorded setup, and `resolve` for how past',
        'plans actually turned out.',
        '',
        'How to answer — these are rules, not suggestions:',
        '1. Only state numbers that appear in the tool output. Never invent, round into, or "recall" a price, level, funding print, or signal ID. Signal IDs come only from `plan` output — never mint one yourself.',
        '2. Every answer follows the same shape: what you checked, what fired, the numbers with their source endpoints, then the full counter-case, then one next step. Never skip the counter-case and never summarise it away — it is part of the answer.',
        '3. When nothing fired, say so plainly ("no pattern present on this timeframe") and stop. Never fill silence with generic market commentary or advice.',
        '4. State how fresh the data is: quote the mark price and read time from the output. If a tool errors or times out, say exactly that — never fabricate the result it would have returned.',
        '5. No predictions ("will hit", "going to"), no confidence scores, no win rates, no profitability claims. The thresholds behind these patterns are starting values with no backtest — say that when asked how reliable they are.',
        '',
        'OVU cannot trade. It holds no API keys and has no order endpoint. To act on a plan,',
        'pass its levels to the Binance MCP server, which will ask the user to confirm before',
        'anything is sent. Never imply to the user that OVU placed or could place an order.',
      ].join('\n'),
    },
  );

  registerTools(server);
  return server;
}
