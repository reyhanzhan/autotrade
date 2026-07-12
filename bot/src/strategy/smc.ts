// ============================================================================
// smc.ts — SMC/ICT strategy orchestrator.
// ----------------------------------------------------------------------------
// CORE PLAYBOOK (high-probability setup):
//
//   1. The most recent CLOSED candle produces a BOS in the trend direction.
//      → This confirms the smart-money flow we want to trade WITH.
//
//   2. After the BOS, we look for an unmitigated Order Block OR an unfilled
//      Fair Value Gap on the same side, BEHIND current price (i.e. a
//      retracement zone, not a chase entry).
//
//   3. We wait for price to TAP that zone, then enter MARKET in the trend
//      direction (the bot's execution layer handles this — we just emit
//      the signal with entry/SL/TP).
//
//   4. Stop-loss is placed beyond the zone (1 ATR buffer); take-profit is
//      computed as a Fibonacci risk extension (default 1.618R).
//
// This is a CONSERVATIVE skeleton — extend with: multi-timeframe confluence,
// liquidity sweeps, optimal-trade-entry (OTE) fib pullbacks, killzone time
// filters, etc. The strategy logs every signal whether or not it was acted
// upon, so you can iterate using the EventLog/Signal tables.
// ============================================================================

import type { Candle, FairValueGap, OrderBlock, StructureState, TradeSignal } from "../shared/types.js";
import { analyzeStructure, DEFAULT_STRUCTURE_OPTS } from "./structure.js";
import { findOrderBlocks, DEFAULT_OB_OPTS } from "./orderBlock.js";
import { findFairValueGaps, DEFAULT_FVG_OPTS } from "./fvg.js";
import { computeATR, computeEMA, computeADX } from "./indicators.js";

export interface SMCConfig {
  symbol: string;
  interval: string;
  /** Minimum risk-to-reward ratio for TP. Default 2.0 = 1:2 RR. */
  riskReward: number;
  /** Fallback trend-following RR. Lower than the main SMC target. */
  trendPullbackRiskReward: number;
  /** Stop-loss buffer expressed as a fraction of ATR. */
  slBufferAtrMult: number;
  /** Trend-pullback stop distance expressed as ATR. */
  trendPullbackSlAtrMult: number;
  /** ATR period. */
  atrPeriod: number;
  /** Minimum confidence (0..1) required to emit a signal. */
  minConfidence: number;
}

export const DEFAULT_SMC_CONFIG: SMCConfig = {
  symbol: "BTCUSDT",
  interval: "15m",
  riskReward: 2.0,
  trendPullbackRiskReward: 1.75,
  slBufferAtrMult: 0.5,
  trendPullbackSlAtrMult: 1.5,
  atrPeriod: 14,
  minConfidence: 0.55,
};

export class SMCEngine {
  constructor(public readonly cfg: SMCConfig = DEFAULT_SMC_CONFIG) {}

  /**
   * Evaluate the current candle array and produce at most ONE trade signal.
   * Returns undefined when no high-confidence setup is present.
   *
   * IMPORTANT: only call this on a freshly CLOSED candle. Calling on every
   * tick produces unstable signals (structure/OB/FVG flip mid-bar).
   */
  evaluate(candles: Candle[]): TradeSignal | undefined {
    if (candles.length < 50) return;

    const structure = analyzeStructure(candles, DEFAULT_STRUCTURE_OPTS);
    if (structure.trend === "RANGING") return;

    const side = structure.trend === "BULLISH" ? "LONG" : "SHORT";
    if ((side === "LONG" && structure.choch === "SHORT") || (side === "SHORT" && structure.choch === "LONG")) return;

    const lastClosed = candles.findLast((c: Candle) => c.isClosed) ?? candles.at(-1)!;
    const preTapCandles = candles.filter((c) => c.openTime < lastClosed.openTime);
    if (preTapCandles.length < 50) return;

    const atr = computeATR(candles, this.cfg.atrPeriod);
    if (!atr) return;

    const obs = findOrderBlocks(preTapCandles, DEFAULT_OB_OPTS);
    const gaps = findFairValueGaps(preTapCandles, DEFAULT_FVG_OPTS);
    const lastPrice = lastClosed.close;

    const zone = pickTappedEntryZone(side, lastClosed, obs, gaps);
    if (zone) {
      const buffer = atr * this.cfg.slBufferAtrMult;
      const fibPlan = buildFibTradePlan(side, zone, structure, buffer, this.cfg.riskReward, lastPrice);
      if (fibPlan) {
        const confidence = scoreConfidence({
          structure,
          hasOB: zone.source === "OB",
          hasFVG: zone.source === "FVG",
          hasFib: true,
        });

        let dynamicThreshold = this.cfg.minConfidence;
        const adx = computeADX(preTapCandles, 14);
        if (adx !== undefined) {
          if (adx > 25) dynamicThreshold = Math.max(0, this.cfg.minConfidence - 0.03); // e.g. 0.65
          else if (adx < 20) dynamicThreshold = Math.min(1, this.cfg.minConfidence + 0.07); // e.g. 0.75
        }

        if (confidence >= dynamicThreshold) {
          const kind = `${zone.source}_TAP_${side}`;

          return {
            symbol: this.cfg.symbol,
            interval: this.cfg.interval,
            side,
            kind: `${kind}_FIB`,
            entryPrice: fibPlan.entryPrice,
            stopLoss: fibPlan.stopLoss,
            takeProfit: fibPlan.takeProfit,
            confidence,
            context: {
              structure,
              orderBlock: zone.source === "OB" ? zone.raw : undefined,
              fvg: zone.source === "FVG" ? zone.raw : undefined,
              fibonacci: fibPlan.fibonacci,
              dynamicThreshold,
            },
          };
        }
      }
    }

    const trendPullback = buildTrendPullbackSignal({
      candles,
      structure,
      side,
      atr,
      symbol: this.cfg.symbol,
      interval: this.cfg.interval,
      riskReward: this.cfg.trendPullbackRiskReward,
      slAtrMult: this.cfg.trendPullbackSlAtrMult,
    });
    
    if (trendPullback) {
      let dynamicThreshold = this.cfg.minConfidence;
      const adx = computeADX(candles.filter((c) => c.openTime < lastClosed.openTime), 14);
      if (adx !== undefined) {
        if (adx > 25) dynamicThreshold = Math.max(0, this.cfg.minConfidence - 0.03);
        else if (adx < 20) dynamicThreshold = Math.min(1, this.cfg.minConfidence + 0.07);
      }
      
      if (trendPullback.confidence >= dynamicThreshold) {
        trendPullback.context.dynamicThreshold = dynamicThreshold;
        return trendPullback;
      }
    }
  }
}

// ----- helpers ------------------------------------------------------------

type TappedZone =
  | { low: number; high: number; source: "OB"; raw: OrderBlock; index: number }
  | { low: number; high: number; source: "FVG"; raw: FairValueGap; index: number };

function pickTappedEntryZone(
  side: "LONG" | "SHORT",
  candle: Candle,
  obs: OrderBlock[],
  fvgs: FairValueGap[]
): TappedZone | undefined {
  const zones: TappedZone[] = [
    ...obs
      .filter((z) => z.side === side && !z.mitigated)
      .map((z) => ({ low: z.low, high: z.high, source: "OB" as const, raw: z, index: z.index })),
    ...fvgs
      .filter((z) => z.side === side && !z.filled)
      .map((z) => ({ low: z.low, high: z.high, source: "FVG" as const, raw: z, index: z.startIndex })),
  ];

  return zones
    .filter((z) => candle.low <= z.high && candle.high >= z.low)
    .sort((a, b) => {
      if (a.source !== b.source) return a.source === "OB" ? -1 : 1;
      return b.index - a.index;
    })[0];
}

interface FibTradePlan {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  fibonacci: {
    impulseLow: number;
    impulseHigh: number;
    goldenLow: number;
    goldenHigh: number;
    invalidation: number;
    structureTarget: number;
    riskReward: number;
  };
}

function buildFibTradePlan(
  side: "LONG" | "SHORT",
  zone: { low: number; high: number },
  structure: {
    lastSwingHigh?: { price: number };
    lastSwingLow?: { price: number };
  },
  buffer: number, // In ATR
  riskReward: number,
  marketEntry: number
): FibTradePlan | undefined {
  const high = structure.lastSwingHigh?.price;
  const low = structure.lastSwingLow?.price;
  if (!high || !low || high <= low) return;

  const range = high - low;
  if (range <= 0) return;

  if (side === "LONG") {
    const fib50 = high - range * 0.5;
    const fib618 = high - range * 0.618;
    const fib786 = high - range * 0.786;
    const goldenLow = Math.min(fib50, fib618);
    const goldenHigh = Math.max(fib50, fib618);
    const entryPrice = marketEntry;
    if (entryPrice < goldenLow || entryPrice > goldenHigh) return;

    let stopLoss = Math.min(zone.low - buffer, fib786 - buffer);
    const rawDist = entryPrice - stopLoss;
    const minDist = Math.max(buffer * 3, entryPrice * 0.005); // buffer is atr * 0.5, so buffer * 3 = 1.5 * atr
    if (rawDist < minDist) stopLoss = entryPrice - minDist;

    const risk = entryPrice - stopLoss;
    if (risk <= 0) return;

    const takeProfit = entryPrice + risk * riskReward;
    if (takeProfit > high) return;

    return {
      entryPrice,
      stopLoss,
      takeProfit,
      fibonacci: {
        impulseLow: low,
        impulseHigh: high,
        goldenLow,
        goldenHigh,
        invalidation: fib786,
        structureTarget: high,
        riskReward,
      },
    };
  }

  const fib50 = low + range * 0.5;
  const fib618 = low + range * 0.618;
  const fib786 = low + range * 0.786;
  const goldenLow = Math.min(fib50, fib618);
  const goldenHigh = Math.max(fib50, fib618);
  const entryPrice = marketEntry;
  if (entryPrice < goldenLow || entryPrice > goldenHigh) return;

  let stopLoss = Math.max(zone.high + buffer, fib786 + buffer);
  const rawDist = stopLoss - entryPrice;
  const minDist = Math.max(buffer * 3, entryPrice * 0.005); // buffer is atr * 0.5, so buffer * 3 = 1.5 * atr
  if (rawDist < minDist) stopLoss = entryPrice + minDist;

  const risk = stopLoss - entryPrice;
  if (risk <= 0) return;

  const takeProfit = entryPrice - risk * riskReward;
  if (takeProfit < low) return;

  return {
    entryPrice,
    stopLoss,
    takeProfit,
    fibonacci: {
      impulseLow: low,
      impulseHigh: high,
      goldenLow,
      goldenHigh,
      invalidation: fib786,
      structureTarget: low,
      riskReward,
    },
  };
}

interface TrendPullbackInput {
  candles: Candle[];
  structure: StructureState;
  side: "LONG" | "SHORT";
  atr: number;
  symbol: string;
  interval: string;
  riskReward: number;
  slAtrMult: number;
}

function buildTrendPullbackSignal(input: TrendPullbackInput): TradeSignal | undefined {
  const closed = input.candles.filter((c) => c.isClosed);
  if (closed.length < 205) return;

  const last = closed.at(-1)!;
  const prev = closed.at(-2)!;
  const pullbackWindow = closed.slice(-4);
  const ema20 = computeEMA(closed, 20);
  const ema50 = computeEMA(closed, 50);
  const ema200 = computeEMA(closed, 200);
  if (!ema20 || !ema50 || !ema200) return;

  const pullbackLow = Math.min(...pullbackWindow.map((c) => c.low));
  const pullbackHigh = Math.max(...pullbackWindow.map((c) => c.high));
  const entryPrice = last.close;

  if (input.side === "LONG") {
    const trendAligned = input.structure.trend === "BULLISH" && ema50 > ema200 && entryPrice > ema50 && entryPrice > ema200;
    const pulledBack = pullbackLow <= ema20 || pullbackLow <= ema50;
    const resumed = last.close > ema20 && last.close > last.open && last.close > prev.close;
    const notOverextended = entryPrice - ema20 <= input.atr * 2.5;
    if (!trendAligned || !pulledBack || !resumed || !notOverextended) return;

    let stopLoss = Math.min(pullbackLow - input.atr * 0.25, entryPrice - input.atr * input.slAtrMult);
    const minDist = Math.max(input.atr * 1.5, entryPrice * 0.005);
    if (entryPrice - stopLoss < minDist) stopLoss = entryPrice - minDist;

    const risk = entryPrice - stopLoss;
    if (risk <= 0) return;

    return {
      symbol: input.symbol,
      interval: input.interval,
      side: "LONG",
      kind: "TREND_PULLBACK_LONG",
      entryPrice,
      stopLoss,
      takeProfit: entryPrice + risk * input.riskReward,
      confidence: scoreTrendPullbackConfidence(input.structure, ema20, ema50, ema200, input.side),
      context: {
        structure: input.structure,
        trendPullback: {
          ema20,
          ema50,
          ema200,
          atr: input.atr,
          pullbackLow,
          pullbackHigh,
          riskReward: input.riskReward,
        },
      },
    };
  }

  const trendAligned = input.structure.trend === "BEARISH" && ema50 < ema200 && entryPrice < ema50 && entryPrice < ema200;
  const pulledBack = pullbackHigh >= ema20 || pullbackHigh >= ema50;
  const resumed = last.close < ema20 && last.close < last.open && last.close < prev.close;
    const notOverextended = ema20 - entryPrice <= input.atr * 2.5;
  if (!trendAligned || !pulledBack || !resumed || !notOverextended) return;

  let stopLoss = Math.max(pullbackHigh + input.atr * 0.25, entryPrice + input.atr * input.slAtrMult);
  const minDist = Math.max(input.atr * 1.5, entryPrice * 0.005);
  if (stopLoss - entryPrice < minDist) stopLoss = entryPrice + minDist;

  const risk = stopLoss - entryPrice;
  if (risk <= 0) return;

  return {
    symbol: input.symbol,
    interval: input.interval,
    side: "SHORT",
    kind: "TREND_PULLBACK_SHORT",
    entryPrice,
    stopLoss,
    takeProfit: entryPrice - risk * input.riskReward,
    confidence: scoreTrendPullbackConfidence(input.structure, ema20, ema50, ema200, input.side),
    context: {
      structure: input.structure,
      trendPullback: {
        ema20,
        ema50,
        ema200,
        atr: input.atr,
        pullbackLow,
        pullbackHigh,
        riskReward: input.riskReward,
      },
    },
  };
}



function scoreConfidence(parts: {
  structure: { trend: string; bos?: string };
  hasOB: boolean;
  hasFVG: boolean;
  hasFib: boolean;
}): number {
  let score = 0;
  if (parts.hasFib) score += 0.3;
  if (parts.structure.bos) score += 0.1;
  if (parts.hasOB && parts.hasFVG) score += 0.35;
  else if (parts.hasOB || parts.hasFVG) score += 0.25;
  if (parts.structure.trend !== "RANGING") score += 0.2;
  return Math.min(1, score);
}

function scoreTrendPullbackConfidence(
  structure: { bos?: string },
  ema20: number,
  ema50: number,
  ema200: number,
  side: "LONG" | "SHORT"
): number {
  let score = 0.6;
  const emaSpread = side === "LONG"
    ? (ema50 - ema200) / ema200
    : (ema200 - ema50) / ema200;
  if (emaSpread > 0.002) score += 0.02;
  if (emaSpread > 0.006) score += 0.02;
  if ((side === "LONG" && ema20 > ema50) || (side === "SHORT" && ema20 < ema50)) score += 0.02;
  if (structure.bos === side) score += 0.02;
  return Math.min(0.68, score);
}
