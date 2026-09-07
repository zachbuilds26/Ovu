/**
 * Adaptive price formatting, shared by the engine, the MCP tools and the
 * terminal scripts so a number reads the same everywhere.
 *
 * `toFixed(2)` was built for BTC-sized numbers and prints a meme price like
 * 0.003165 as "0.00" — correct arithmetic, unreadable display. Amounts at or
 * above 1 keep the old two-decimal shape; sub-dollar prices get enough
 * decimals to show their significant digits, capped at 8.
 *
 * Ratios, percentages and R-multiples are NOT prices and keep their own
 * `toFixed(2)` where they are — only pass actual prices here.
 *
 * @param {number} n
 * @returns {string}
 */
export function fmtPrice(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  const a = Math.abs(n);
  if (a >= 1) return n.toFixed(2);
  if (a === 0) return '0.00';
  const decimals = Math.min(8, Math.max(4, -Math.floor(Math.log10(a)) + 3));
  return n.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
