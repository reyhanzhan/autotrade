// ============================================================================
// confluence.ts — Fuse SMC signal with Coinglass derivatives data.
// ----------------------------------------------------------------------------
// Produces a CONFLUENCE MULTIPLIER in roughly [0.4, 1.6] that we apply to the
// SMC `baseConfidence` to get the final score. The bot only places orders
// when `finalConfidence >= cfg.minConfidence`.
//
// Each metric contributes independently, then we average. Missing metrics
// contribute NEUTRAL (1.0) so partial Coinglass outages degrade gracefully
// instead of biasing one direction.
//
// HEURISTICS (LONG side examples; SHORT is symmetric):
//
//   Funding rate
//     positive funding = longs paying shorts = crowded longs
//     LONG signal × positive funding → penalize (squeeze risk).
//     LONG signal × negative funding → reward (shorts crowded → fuel for up).
//
//   OI change 24h
//     LONG signal × OI rising  → reward (fresh money entering with trend).
//     LONG signal × OI falling → penalize (position-unwind, not real demand).
//
//   Long/Short ratio
//     extreme L/S > 2.5 = retail overcrowded long → penalize LONG entries.
//     L/S < 0.6 = retail overcrowded short → reward LONG entries.
//
//   Liquidations 24h
//     If long-side liquidations were much bigger in last 24h, the path of
//     "pain" already cleared longs — a LONG entry has more room. Mild reward.
// ============================================================================

import type { CoinglassMetrics } from "./coinglass.js";
import type { Side } from "../shared/types.js";

export interface ConfluenceBreakdown {
  multiplier: number;          // final multiplier applied to base confidence
  parts: {
    funding?: number;          // each part's own multiplier (1.0 = neutral)
    openInterest?: number;
    longShortRatio?: number;
    liquidations?: number;
  };
  notes: string[];             // human-readable reasoning (shown in reports)
}

/** No-op confluence (e.g. when Coinglass is disabled or fully failed). */
export const NEUTRAL_CONFLUENCE: ConfluenceBreakdown = {
  multiplier: 1.0,
  parts: {},
  notes: ["coinglass: disabled or unavailable — neutral multiplier"],
};

export function scoreConfluence(side: Side, m: CoinglassMetrics | null): ConfluenceBreakdown {
  if (!m) return NEUTRAL_CONFLUENCE;

  const parts: ConfluenceBreakdown["parts"] = {};
  const notes: string[] = [];
  const factors: number[] = [];

  // ---- funding rate ------------------------------------------------------
  if (typeof m.fundingRate === "number") {
    // Binance funding rate is per 8h. Typical range ±0.01% to ±0.05%.
    // We treat anything above |0.05%| as "extreme".
    const f = m.fundingRate;
    const extreme = Math.min(Math.abs(f) / 0.0005, 1); // 0..1 saturating at 0.05%
    let mult = 1.0;
    if (side === "LONG") {
      mult = f > 0 ? 1 - 0.4 * extreme : 1 + 0.4 * extreme;
    } else {
      mult = f > 0 ? 1 + 0.4 * extreme : 1 - 0.4 * extreme;
    }
    parts.funding = round(mult);
    factors.push(mult);
    notes.push(`funding=${(f * 100).toFixed(4)}% → ×${mult.toFixed(2)}`);
  }

  // ---- open interest 24h change -----------------------------------------
  if (typeof m.oiChange24hPct === "number") {
    const oi = m.oiChange24hPct;
    // Saturate beyond ±10%
    const mag = Math.min(Math.abs(oi) / 10, 1);
    let mult = 1.0;
    if (side === "LONG") {
      mult = oi > 0 ? 1 + 0.3 * mag : 1 - 0.3 * mag;
    } else {
      mult = oi < 0 ? 1 + 0.3 * mag : 1 - 0.3 * mag;
    }
    parts.openInterest = round(mult);
    factors.push(mult);
    notes.push(`OI Δ24h=${oi.toFixed(2)}% → ×${mult.toFixed(2)}`);
  }

  // ---- long/short ratio -------------------------------------------------
  if (typeof m.longShortRatio === "number" && m.longShortRatio > 0) {
    const r = m.longShortRatio;
    let mult = 1.0;
    // Contrarian: penalize entries that align with retail crowd extremes.
    if (side === "LONG") {
      if (r > 2.5) mult = 0.65;                   // retail very long → bad for LONG
      else if (r < 0.6) mult = 1.35;              // retail very short → good for LONG
      else mult = 1.0 - 0.15 * ((r - 1.0) / 1.5); // gentle slope around 1.0
    } else {
      if (r < 0.6) mult = 0.65;
      else if (r > 2.5) mult = 1.35;
      else mult = 1.0 + 0.15 * ((r - 1.0) / 1.5);
    }
    parts.longShortRatio = round(mult);
    factors.push(mult);
    notes.push(`L/S=${r.toFixed(2)} → ×${mult.toFixed(2)}`);
  }

  // ---- liquidations 24h imbalance ---------------------------------------
  if (typeof m.liqLong24hUsd === "number" && typeof m.liqShort24hUsd === "number") {
    const total = m.liqLong24hUsd + m.liqShort24hUsd;
    if (total > 0) {
      const longShare = m.liqLong24hUsd / total; // 0..1
      let mult = 1.0;
      // If longs were liquidated more, the "long squeeze" path already played
      // out — a NEW LONG has cleaner room. Mild reward (±15% max).
      if (side === "LONG") mult = 1 + 0.15 * (2 * longShare - 1);    // longShare>0.5 → reward
      else mult = 1 + 0.15 * (2 * (1 - longShare) - 1);
      parts.liquidations = round(mult);
      factors.push(mult);
      notes.push(`liq L/S=${(longShare * 100).toFixed(0)}%/${((1 - longShare) * 100).toFixed(0)}% → ×${mult.toFixed(2)}`);
    }
  }

  if (factors.length === 0) return NEUTRAL_CONFLUENCE;

  // Geometric mean keeps the multiplier bounded and avoids one extreme
  // metric dominating. Clamp to [0.4, 1.6] as a safety rail.
  const geo = Math.exp(factors.reduce((s, v) => s + Math.log(v), 0) / factors.length);
  const multiplier = Math.max(0.4, Math.min(1.6, geo));

  return { multiplier: round(multiplier), parts, notes };
}

function round(n: number): number { return Math.round(n * 100) / 100; }
