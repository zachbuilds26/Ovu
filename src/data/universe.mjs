/**
 * Symbol universes. The engine itself works on any symbol — `snapshot()` takes
 * a string and the signals are pure functions of what comes back — so this
 * file is just the curated lists the tools scan by default.
 *
 * All entries verified live as USDⓈ-M perpetuals. Note the 1000-denominated
 * contracts: low-price memes trade as 1000SHIB, 1000PEPE, etc. on Binance.
 */

import { SYMBOLS as MAJORS } from './futures.mjs';

/** The three majors OVU was built on. Unchanged. */
export const MAJOR_UNIVERSE = [...MAJORS];

/**
 * The memetrader dozen: OG memes plus current hype runners.
 * Each entry: { symbol, tag } where tag is the human name.
 */
export const MEME_UNIVERSE = [
  { symbol: 'DOGEUSDT', tag: 'DOGE' },
  { symbol: '1000SHIBUSDT', tag: 'SHIB (1000)' },
  { symbol: '1000PEPEUSDT', tag: 'PEPE (1000)' },
  { symbol: '1000BONKUSDT', tag: 'BONK (1000)' },
  { symbol: '1000FLOKIUSDT', tag: 'FLOKI (1000)' },
  { symbol: 'WIFUSDT', tag: 'WIF' },
  { symbol: 'POPCATUSDT', tag: 'POPCAT' },
  { symbol: 'TURBOUSDT', tag: 'TURBO' },
  { symbol: 'MEWUSDT', tag: 'MEW' },
  { symbol: 'BRETTUSDT', tag: 'BRETT' },
  { symbol: 'MEMEUSDT', tag: 'MEME' },
  { symbol: 'PNUTUSDT', tag: 'PNUT' },
];

export const MEME_SYMBOLS = MEME_UNIVERSE.map((m) => m.symbol);
