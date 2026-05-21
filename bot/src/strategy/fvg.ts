// ============================================================================
// fvg.ts — Detect Fair Value Gaps (FVGs / "imbalances").
// ----------------------------------------------------------------------------
// An FVG is a three-candle pattern where the wicks of candle[i-2] and
// candle[i] do NOT overlap, leaving a price gap in the middle candle.
//
//   Bullish FVG:  candle[i-2].high  <  candle[i].low
//                 → gap zone = [candle[i-2].high, candle[i].low]
//
//   Bearish FVG:  candle[i-2].low   >  candle[i].high
//                 → gap zone = [candle[i].high, candle[i-2].low]
//
// FVGs act as magnets — price tends to revisit and "fill" them. A bullish
// FVG below current price is a high-probability LONG re-entry zone after a
// confirmed bullish BOS.
//
// `filled` flips to true once price has traded through the entire gap.
// ============================================================================

import type { Candle, FairValueGap, Side } from "../shared/types.js";

export interface FVGOptions {
  /** Minimum gap size as a fraction of the middle-candle range (filters noise). */
  minGapRatio: number;
  /** Don't report FVGs older than this many candles back. */
  maxAgeCandles: number;
}

export const DEFAULT_FVG_OPTS: FVGOptions = {
  minGapRatio: 0.1,
  maxAgeCandles: 150,
};

export function findFairValueGaps(
  candles: Candle[],
  opts: FVGOptions = DEFAULT_FVG_OPTS
): FairValueGap[] {
  const out: FairValueGap[] = [];
  const n = candles.length;
  if (n < 3) return out;

  const oldest = Math.max(2, n - opts.maxAgeCandles);

  for (let i = oldest; i < n; i++) {
    const a = candles[i - 2]!;
    const b = candles[i - 1]!;
    const c = candles[i]!;
    const bRange = Math.max(b.high - b.low, 1e-9);

    // Bullish FVG
    if (a.high < c.low) {
      const gap = c.low - a.high;
      if (gap / bRange >= opts.minGapRatio) {
        out.push(buildGap(i - 2, b.openTime, a.high, c.low, "LONG", candles, i));
      }
    }
    // Bearish FVG
    if (a.low > c.high) {
      const gap = a.low - c.high;
      if (gap / bRange >= opts.minGapRatio) {
        out.push(buildGap(i - 2, b.openTime, c.high, a.low, "SHORT", candles, i));
      }
    }
  }
  return out;
}

/** Return the nearest unfilled FVG on the given side. */
export function nearestUnfilledFVG(gaps: FairValueGap[], side: Side): FairValueGap | undefined {
  return [...gaps]
    .filter((g) => g.side === side && !g.filled)
    .sort((a, b) => b.startIndex - a.startIndex)[0];
}

function buildGap(
  startIdx: number,
  time: number,
  low: number,
  high: number,
  side: Side,
  all: Candle[],
  formedAtIdx: number
): FairValueGap {
  // "Filled" if any later candle wholly engulfed the gap from the opposite side.
  let filled = false;
  for (let j = formedAtIdx + 1; j < all.length; j++) {
    const k = all[j]!;
    if (side === "LONG" && k.low <= low) { filled = true; break; }
    if (side === "SHORT" && k.high >= high) { filled = true; break; }
  }
  return { side, startIndex: startIdx, time, low, high, filled };
}
