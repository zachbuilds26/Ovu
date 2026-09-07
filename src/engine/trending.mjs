import { change, baselineVolume } from './indicators.mjs';

/**
 * Trending — "which memes are moving right now", ranked, with the numbers
 * attached and no invented score.
 *
 * Deliberately dumber than the four signals: this is discovery, not a setup.
 * It answers "where is the action" so `analyze` and `plan` can answer "is it
 * tradeable". Like everything in the engine it is pure: rows in, ranking out,
 * no network.
 *
 * A row is `{ symbol, tag, candles, oiFirst, oiLast }` where candles are 1h
 * klines oldest-first (at least 25) and oiFirst/oiLast bracket the same
 * window. OI is optional — when absent the row is ranked without it and says so.
 */

/**
 * @param {{symbol:string, tag:string, candles:object[], oiFirst:number|null, oiLast:number|null}[]} rows
 */
export function rankMovers(rows) {
  const out = rows.map((row) => {
    const closes = row.candles.map((c) => c.close);
    const move24 = change(closes.at(-25), closes.at(-1));
    // Volume is read off the last CLOSED candle, against a baseline that
    // excludes it. The forming candle's partial volume would print 0.0x
    // most of the hour and read as "nobody participating" when the hour
    // simply isn't over — that artifact is why this slices twice.
    const closed = row.candles.slice(0, -1);
    const base = baselineVolume(closed, 20);
    const lastVol = closed.at(-1).volume;
    const volMultiple = base && base > 0 ? lastVol / base : null;
    const oiChange = row.oiFirst != null && row.oiLast != null && row.oiFirst !== 0
      ? change(row.oiFirst, row.oiLast)
      : null;

    const flags = [];
    if (Math.abs(move24) >= 0.05) flags.push(Math.abs(move24) >= 0.1 ? 'big move' : 'moving');
    if (volMultiple !== null && volMultiple >= 2) flags.push('volume surge');
    if (oiChange !== null && Math.abs(oiChange) >= 0.05) {
      flags.push(oiChange > 0 ? 'fresh positions' : 'positions closing');
    }

    return {
      symbol: row.symbol,
      tag: row.tag,
      last: closes.at(-1),
      move24,
      volMultiple,
      oiChange,
      flags,
    };
  });

  // Order by absolute 24h move, largest first. No weights, no composite —
  // the components are shown next to each rank so the ordering can be argued with.
  out.sort((a, b) => Math.abs(b.move24) - Math.abs(a.move24));
  return out;
}
