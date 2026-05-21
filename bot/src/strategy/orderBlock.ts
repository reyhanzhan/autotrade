// ============================================================================
// orderBlock.ts — Detect Order Blocks (OBs).
// ----------------------------------------------------------------------------
// DEFINITION used here (one of several variants — keep it consistent):
//
//   Bullish OB: the LAST bearish (down-close) candle that immediately
//   precedes a strong bullish impulse which breaks the most recent swing
//   high (i.e. produces BOS_LONG).
//
//   Bearish OB: the LAST bullish (up-close) candle that immediately precedes
//   a strong bearish impulse which breaks the most recent swing low.
//
// "Strong impulse" = the move from the OB candle to the impulse-confirming
// candle covers at least `impulseMinRatio` × the OB's own range.
//
// The OB zone is the candle's full range (low → high). Some practitioners use
// the body (open → close); switch via `useBody`.
//
// `mitigated` flips to true once price has revisited the zone — most setups
// fade once mitigated, so unmitigated zones are usually the highest-quality.
// ============================================================================

import type { Candle, OrderBlock, Side } from "../shared/types.js";

export interface OrderBlockOptions {
  /** Min impulse move size as a multiple of the OB candle's range. */
  impulseMinRatio: number;
  /** Max candles to look forward for the impulse to complete. */
  impulseMaxLookahead: number;
  /** Use body (open/close) instead of full range. */
  useBody: boolean;
  /** Don't report OBs older than this many candles back from the latest one. */
  maxAgeCandles: number;
}

export const DEFAULT_OB_OPTS: OrderBlockOptions = {
  impulseMinRatio: 1.5,
  impulseMaxLookahead: 5,
  useBody: false,
  maxAgeCandles: 100,
};

export function findOrderBlocks(
  candles: Candle[],
  opts: OrderBlockOptions = DEFAULT_OB_OPTS
): OrderBlock[] {
  const out: OrderBlock[] = [];
  const n = candles.length;
  if (n < 10) return out;

  const lastIdx = n - 1;
  const oldest = Math.max(0, lastIdx - opts.maxAgeCandles);

  for (let i = oldest; i < n - opts.impulseMaxLookahead - 1; i++) {
    const c = candles[i]!;
    const isBearish = c.close < c.open;
    const isBullish = c.close > c.open;

    // Candidate bullish OB: bearish candle followed by strong up-impulse
    if (isBearish) {
      const impulse = scanImpulse(candles, i + 1, opts.impulseMaxLookahead, "UP");
      if (impulse && exceedsRatio(c, impulse.price - c.low, opts.impulseMinRatio)) {
        out.push(makeOB(c, i, "LONG", candles, opts.useBody));
      }
    }
    // Candidate bearish OB
    if (isBullish) {
      const impulse = scanImpulse(candles, i + 1, opts.impulseMaxLookahead, "DOWN");
      if (impulse && exceedsRatio(c, c.high - impulse.price, opts.impulseMinRatio)) {
        out.push(makeOB(c, i, "SHORT", candles, opts.useBody));
      }
    }
  }
  return out;
}

/** Return the nearest unmitigated OB on the given side, sorted by recency. */
export function nearestUnmitigatedOB(obs: OrderBlock[], side: Side): OrderBlock | undefined {
  return [...obs]
    .filter((o) => o.side === side && !o.mitigated)
    .sort((a, b) => b.index - a.index)[0];
}

// ----- internals ----------------------------------------------------------

function scanImpulse(
  candles: Candle[],
  fromIdx: number,
  maxLookahead: number,
  direction: "UP" | "DOWN"
): { price: number; atIdx: number } | undefined {
  let extremum = direction === "UP" ? -Infinity : Infinity;
  let atIdx = -1;
  for (let j = fromIdx; j < Math.min(fromIdx + maxLookahead, candles.length); j++) {
    const c = candles[j]!;
    if (direction === "UP" && c.high > extremum) { extremum = c.high; atIdx = j; }
    if (direction === "DOWN" && c.low < extremum) { extremum = c.low; atIdx = j; }
  }
  if (atIdx < 0) return undefined;
  return { price: extremum, atIdx };
}

function exceedsRatio(ob: Candle, moveSize: number, ratio: number): boolean {
  const range = Math.max(ob.high - ob.low, 1e-9);
  return moveSize >= range * ratio;
}

function makeOB(
  c: Candle,
  idx: number,
  side: Side,
  all: Candle[],
  useBody: boolean
): OrderBlock {
  const low = useBody ? Math.min(c.open, c.close) : c.low;
  const high = useBody ? Math.max(c.open, c.close) : c.high;
  // mitigated if any subsequent candle traded inside the zone
  let mitigated = false;
  for (let j = idx + 1; j < all.length; j++) {
    const k = all[j]!;
    if (k.low <= high && k.high >= low) { mitigated = true; break; }
  }
  return { side, index: idx, time: c.openTime, low, high, mitigated };
}
