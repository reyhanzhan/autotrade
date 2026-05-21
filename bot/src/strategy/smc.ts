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
//      computed as `riskReward × risk` (default 2.0 → 1:2 RR).
//
// This is a CONSERVATIVE skeleton — extend with: multi-timeframe confluence,
// liquidity sweeps, optimal-trade-entry (OTE) fib pullbacks, killzone time
// filters, etc. The strategy logs every signal whether or not it was acted
// upon, so you can iterate using the EventLog/Signal tables.
// ============================================================================

import type { Candle, TradeSignal } from "../shared/types.js";
import { analyzeStructure, DEFAULT_STRUCTURE_OPTS } from "./structure.js";
import { findOrderBlocks, nearestUnmitigatedOB, DEFAULT_OB_OPTS } from "./orderBlock.js";
import { findFairValueGaps, nearestUnfilledFVG, DEFAULT_FVG_OPTS } from "./fvg.js";

export interface SMCConfig {
  symbol: string;
  interval: string;
  /** Risk-to-reward ratio for TP. Default 2.0 = 1:2 RR. */
  riskReward: number;
  /** Stop-loss buffer expressed as a fraction of ATR. */
  slBufferAtrMult: number;
  /** ATR period. */
  atrPeriod: number;
  /** Minimum confidence (0..1) required to emit a signal. */
  minConfidence: number;
}

export const DEFAULT_SMC_CONFIG: SMCConfig = {
  symbol: "BTCUSDT",
  interval: "15m",
  riskReward: 2.0,
  slBufferAtrMult: 0.5,
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

    // We only act on a fresh BOS in the trend direction.
    if (!structure.bos) return;
    const side = structure.bos;
    if (
      (side === "LONG" && structure.trend !== "BULLISH") ||
      (side === "SHORT" && structure.trend !== "BEARISH")
    ) {
      return;
    }

    const obs = findOrderBlocks(candles, DEFAULT_OB_OPTS);
    const gaps = findFairValueGaps(candles, DEFAULT_FVG_OPTS);
    const ob = nearestUnmitigatedOB(obs, side);
    const fvg = nearestUnfilledFVG(gaps, side);

    const lastClosed = candles.findLast((c) => c.isClosed) ?? candles.at(-1)!;
    const lastPrice = lastClosed.close;

    // Pick the entry zone: prefer OB; fall back to FVG. Both must sit between
    // the last swing point and current price for a valid retracement entry.
    const zone = pickEntryZone(side, lastPrice, ob, fvg);
    if (!zone) return;

    const atr = computeATR(candles, this.cfg.atrPeriod);
    if (!atr) return;
    const buffer = atr * this.cfg.slBufferAtrMult;

    let entryPrice: number, stopLoss: number, takeProfit: number;
    if (side === "LONG") {
      entryPrice = zone.high;                 // limit-style tap on the upper edge
      stopLoss = zone.low - buffer;
      const risk = entryPrice - stopLoss;
      if (risk <= 0) return;
      takeProfit = entryPrice + risk * this.cfg.riskReward;
    } else {
      entryPrice = zone.low;
      stopLoss = zone.high + buffer;
      const risk = stopLoss - entryPrice;
      if (risk <= 0) return;
      takeProfit = entryPrice - risk * this.cfg.riskReward;
    }

    const confidence = scoreConfidence({ structure, hasOB: !!ob, hasFVG: !!fvg });
    if (confidence < this.cfg.minConfidence) return;

    const kind =
      ob && (!fvg || ob.index >= fvg.startIndex)
        ? `OB_TAP_${side}`
        : `FVG_TAP_${side}`;

    return {
      symbol: this.cfg.symbol,
      interval: this.cfg.interval,
      side,
      kind,
      entryPrice,
      stopLoss,
      takeProfit,
      confidence,
      context: { structure, orderBlock: ob, fvg },
    };
  }
}

// ----- helpers ------------------------------------------------------------

function pickEntryZone(
  side: "LONG" | "SHORT",
  lastPrice: number,
  ob: { low: number; high: number; index: number } | undefined,
  fvg: { low: number; high: number; startIndex: number } | undefined
): { low: number; high: number } | undefined {
  const valid = (zoneLow: number, zoneHigh: number) =>
    side === "LONG" ? zoneHigh < lastPrice : zoneLow > lastPrice;

  if (ob && valid(ob.low, ob.high)) return { low: ob.low, high: ob.high };
  if (fvg && valid(fvg.low, fvg.high)) return { low: fvg.low, high: fvg.high };
  return undefined;
}

/** Wilder-style ATR. */
function computeATR(candles: Candle[], period: number): number | undefined {
  if (candles.length < period + 1) return;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]!) / period;
  return atr;
}

function scoreConfidence(parts: {
  structure: { trend: string; bos?: string };
  hasOB: boolean;
  hasFVG: boolean;
}): number {
  let score = 0;
  if (parts.structure.bos) score += 0.4;                       // confirmed structure
  if (parts.hasOB && parts.hasFVG) score += 0.4;                // confluence
  else if (parts.hasOB || parts.hasFVG) score += 0.25;
  if (parts.structure.trend !== "RANGING") score += 0.2;
  return Math.min(1, score);
}
