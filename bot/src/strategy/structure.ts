// ============================================================================
// structure.ts — Market structure analysis (swing points + BOS/CHoCH).
// ----------------------------------------------------------------------------
// CONCEPTS (Smart Money Concepts):
//
//   Swing High / Low: a fractal pivot. A swing high at index `i` is a candle
//   whose high is strictly greater than the highs of the `lookback` candles
//   on either side. (Symmetric for swing low.)
//
//   BOS (Break of Structure): in an uptrend, price closes ABOVE the most
//   recent swing high — continuation. (Symmetric in a downtrend below the
//   most recent swing low.)
//
//   CHoCH (Change of Character): in an uptrend, price closes BELOW the most
//   recent swing low — earliest hint of a reversal. (Symmetric in downtrend.)
//
// We classify a trend as BULLISH if the last two confirmed swing highs and
// swing lows are both ascending; BEARISH if both descending; otherwise
// RANGING. This is a deliberately conservative definition.
// ============================================================================

import type { Candle, StructureState, SwingPoint } from "../shared/types.js";

export interface StructureOptions {
  /** How many candles on each side a swing must dominate. 2 is classic. */
  swingLookback: number;
  /** Use wick (true) or body (false) for swing detection. Wicks are standard SMC. */
  useWick: boolean;
}

export const DEFAULT_STRUCTURE_OPTS: StructureOptions = {
  swingLookback: 2,
  useWick: true,
};

/**
 * Detect all confirmed swing points in a candle array. Note: a swing at
 * index `i` can only be confirmed once `lookback` candles after it have
 * formed — so the most recent swing may lag the latest candle.
 */
export function findSwings(
  candles: Candle[],
  opts: StructureOptions = DEFAULT_STRUCTURE_OPTS
): SwingPoint[] {
  const out: SwingPoint[] = [];
  const lb = opts.swingLookback;
  if (candles.length < lb * 2 + 1) return out;

  for (let i = lb; i < candles.length - lb; i++) {
    const center = candles[i]!;
    let isHigh = true;
    let isLow = true;
    const centerHigh = opts.useWick ? center.high : Math.max(center.open, center.close);
    const centerLow = opts.useWick ? center.low : Math.min(center.open, center.close);

    for (let j = i - lb; j <= i + lb; j++) {
      if (j === i) continue;
      const c = candles[j]!;
      const h = opts.useWick ? c.high : Math.max(c.open, c.close);
      const l = opts.useWick ? c.low : Math.min(c.open, c.close);
      if (h >= centerHigh) isHigh = false;
      if (l <= centerLow) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) out.push({ index: i, time: center.openTime, price: centerHigh, kind: "HIGH" });
    if (isLow) out.push({ index: i, time: center.openTime, price: centerLow, kind: "LOW" });
  }
  return out;
}

/**
 * Compute the current market structure given the candle array. Classifies
 * trend and reports any BOS/CHoCH that the most recent CLOSED candle just
 * produced.
 */
export function analyzeStructure(
  candles: Candle[],
  opts: StructureOptions = DEFAULT_STRUCTURE_OPTS
): StructureState {
  const swings = findSwings(candles, opts);
  const highs = swings.filter((s) => s.kind === "HIGH");
  const lows = swings.filter((s) => s.kind === "LOW");

  // Need at least the last 2 highs and 2 lows to make a trend call.
  if (highs.length < 2 || lows.length < 2) {
    return { trend: "RANGING" };
  }

  const lastHigh = highs.at(-1)!;
  const prevHigh = highs.at(-2)!;
  const lastLow = lows.at(-1)!;
  const prevLow = lows.at(-2)!;

  const hh = lastHigh.price > prevHigh.price;          // higher high
  const hl = lastLow.price > prevLow.price;            // higher low
  const lh = lastHigh.price < prevHigh.price;          // lower high
  const ll = lastLow.price < prevLow.price;            // lower low

  let trend: StructureState["trend"] = "RANGING";
  if (hh && hl) trend = "BULLISH";
  else if (lh && ll) trend = "BEARISH";

  // Detect break events using the LAST CLOSED candle.
  // A BOS/CHoCH is only valid on a closed candle — we ignore live wicks.
  const lastClosedIdx = findLastClosedIndex(candles);
  if (lastClosedIdx < 0) return { trend, lastSwingHigh: lastHigh, lastSwingLow: lastLow };
  const close = candles[lastClosedIdx]!.close;

  let bos: StructureState["bos"];
  let choch: StructureState["choch"];

  if (trend === "BULLISH") {
    if (close > lastHigh.price && lastHigh.index < lastClosedIdx) bos = "LONG";
    if (close < lastLow.price && lastLow.index < lastClosedIdx) choch = "SHORT";
  } else if (trend === "BEARISH") {
    if (close < lastLow.price && lastLow.index < lastClosedIdx) bos = "SHORT";
    if (close > lastHigh.price && lastHigh.index < lastClosedIdx) choch = "LONG";
  }

  return {
    trend,
    lastSwingHigh: lastHigh,
    lastSwingLow: lastLow,
    bos,
    choch,
  };
}

function findLastClosedIndex(candles: Candle[]): number {
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i]!.isClosed) return i;
  }
  return -1;
}
