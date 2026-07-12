// ============================================================================
// screener.ts — Multi-symbol signal screener.
// ----------------------------------------------------------------------------
// Flow on every CLOSED candle (per symbol):
//
//   1. Run SMC on that symbol's candle buffer → baseSignal (or null)
//   2. Cache the latest baseSignal per symbol (TTL = 1 candle)
//   3. After updating, run a SCREENING PASS across all symbols whose cache
//      is still valid:
//        a. For each candidate, fetch Coinglass metrics (cached, 5min TTL)
//        b. Score confluence → finalConfidence
//        c. Pick the symbol with the highest finalConfidence
//   4. Persist a ScreeningRun row + a Signal row for each candidate
//   5. If the winner is above `minConfidence`, hand it to the risk manager
//
// Why this design:
//   - We don't want to act on EVERY symbol's signal — we want the best one.
//   - Cross-symbol comparison means we trade the strongest setup at any
//     moment, not whichever happened to close first.
//   - Coinglass calls are batched per pass, so a 30-symbol screener costs at
//     most ~30 Coinglass GETs every cache-miss cycle (every 5 min by default).
// ============================================================================

import { prisma } from "../shared/db.js";
import { env } from "../shared/env.js";
import { logger, recordEvent } from "../shared/logger.js";
import { SMCEngine, DEFAULT_SMC_CONFIG } from "../strategy/smc.js";
import { CoinglassClient } from "../external/coinglass.js";
import { scoreConfluence, NEUTRAL_CONFLUENCE, type ConfluenceBreakdown } from "../external/confluence.js";
import type { Candle, TradeSignal } from "../shared/types.js";

interface CachedCandidate {
  signal: TradeSignal;            // SMC-only signal (before Coinglass)
  detectedAt: number;             // ms epoch
}

export interface ScreenerOptions {
  interval: string;
  symbols: string[];
  /** Min FINAL confidence to actually execute. */
  minConfidence: number;
  /** Candidate is dropped if it sits in cache longer than this (ms). */
  candidateTtlMs?: number;
}

export interface ScreeningResult {
  runId: number;
  selected?: {
    signal: TradeSignal;
    confluence: ConfluenceBreakdown;
    finalConfidence: number;
  };
  selectedMany?: Array<{
    signal: TradeSignal;
    confluence: ConfluenceBreakdown;
    finalConfidence: number;
  }>;
  candidates: number;
}

export class Screener {
  private readonly engines = new Map<string, SMCEngine>();
  private readonly candidates = new Map<string, CachedCandidate>();
  private readonly coinglass: CoinglassClient;
  private screeningPassInFlight = false;

  constructor(private readonly opts: ScreenerOptions, coinglass?: CoinglassClient) {
    this.coinglass = coinglass ?? new CoinglassClient();
    for (const s of opts.symbols) {
      this.engines.set(s, new SMCEngine({
        ...DEFAULT_SMC_CONFIG,
        symbol: s,
        interval: opts.interval,
        minConfidence: 0,           // we filter on FINAL confidence in this layer
      }));
    }
  }

  /** Add/replace a symbol at runtime (used when BotConfig watchlist changes). */
  setSymbols(symbols: string[]): void {
    for (const s of symbols) {
      if (!this.engines.has(s)) {
        this.engines.set(s, new SMCEngine({
          ...DEFAULT_SMC_CONFIG, symbol: s, interval: this.opts.interval, minConfidence: 0,
        }));
      }
    }
    for (const existing of this.engines.keys()) {
      if (!symbols.includes(existing)) this.engines.delete(existing);
    }
  }

  /**
   * Called by the engine each time a candle closes for some symbol.
   * Returns the screening result (or undefined if nothing was selected).
   */
  async onClosedCandle(
    symbol: string,
    candles: Candle[],
    excludedSymbols = new Set<string>()
  ): Promise<ScreeningResult | undefined> {
    const engine = this.engines.get(symbol);
    if (!engine) return;

    // 1. SMC evaluation for this symbol
    const baseSignal = engine.evaluate(candles);
    if (baseSignal) {
      this.candidates.set(symbol, { signal: baseSignal, detectedAt: Date.now() });
      logger.info(
        { symbol, kind: baseSignal.kind, side: baseSignal.side, baseConf: baseSignal.confidence },
        "SMC candidate detected"
      );
    }

    // 2. Drop stale candidates
    const ttl = this.opts.candidateTtlMs ?? 5 * 60_000;
    for (const [sym, c] of this.candidates) {
      if (Date.now() - c.detectedAt > ttl) this.candidates.delete(sym);
    }

    // 3. Cross-symbol screening pass will be triggered externally via runScreeningPass()
    return;
  }

  /** Manually trigger a screening pass against the current candidate cache. */
  async runScreeningPass(excludedSymbols = new Set<string>()): Promise<ScreeningResult | undefined> {
    if (this.screeningPassInFlight) return undefined;
    this.screeningPassInFlight = true;
    try {
    const entries = Array.from(this.candidates.entries())
      .filter(([sym]) => !excludedSymbols.has(sym));
    if (entries.length === 0) return undefined;

    const symbols = entries.map(([sym]) => sym);
    const symbolsJson = JSON.stringify(symbols);

    // Score each candidate with Coinglass confluence in parallel.
    const scored = await Promise.all(
      entries.map(async ([sym, c]) => {
        let confluence: ConfluenceBreakdown = NEUTRAL_CONFLUENCE;
        try {
          const m = await this.coinglass.getMetrics(sym);
          confluence = scoreConfluence(c.signal.side, m);
        } catch (e) {
          logger.warn({ sym, err: (e as Error).message }, "Coinglass scoring failed; using neutral");
        }
        const finalConfidence = clamp01(c.signal.confidence * confluence.multiplier);
        const { threshold, reason } = thresholdFor(c.signal, this.opts.minConfidence);
        c.signal.context.dynamicThreshold = threshold;
        c.signal.context.dynamicThresholdReason = reason;
        return { sym, candidate: c, confluence, finalConfidence };
      })
    );

    // Pick the best.
    scored.sort((a, b) => b.finalConfidence - a.finalConfidence);
    const winner = scored[0];
    const eligible = scored.filter((s) => s.finalConfidence >= thresholdFor(s.candidate.signal, this.opts.minConfidence).threshold);

    const run = await prisma.screeningRun.create({
      data: {
        interval: this.opts.interval,
        symbolsScanned: symbolsJson,
        candidateCount: scored.length,
        selectedSymbol: eligible[0]?.sym ?? null,
        selectedSide: eligible[0]?.candidate.signal.side ?? null,
        bestConfidence: winner?.finalConfidence ?? null,
        reason: winner
          ? eligible.length > 0
            ? `Selected ${eligible[0]!.sym} ${eligible[0]!.candidate.signal.side} @ ${eligible[0]!.finalConfidence.toFixed(2)}`
            : `Best candidate ${winner.sym} below threshold (${winner.finalConfidence.toFixed(2)} < ${thresholdFor(winner.candidate.signal, this.opts.minConfidence).threshold})`
          : "No candidates",
      },
    });

    for (const s of scored) {
      const c = s.candidate.signal;
      await prisma.signal.create({
        data: {
          symbol: c.symbol,
          interval: c.interval,
          side: c.side,
          kind: c.kind,
          price: c.entryPrice,
          stopLoss: c.stopLoss,
          takeProfit: c.takeProfit,
          baseConfidence: c.confidence,
          coinglassScore: s.confluence.multiplier,
          confidence: s.finalConfidence,
          payload: JSON.stringify({
            structure: c.context.structure,
            orderBlock: c.context.orderBlock,
            fvg: c.context.fvg,
            fibonacci: c.context.fibonacci,
            trendPullback: c.context.trendPullback,
            multiTimeframe: c.context.multiTimeframe,
            dynamicThreshold: c.context.dynamicThreshold,
            dynamicThresholdReason: c.context.dynamicThresholdReason,
            confluence: s.confluence,
          }),
          screeningRunId: run.id,
        },
      });
    }

    await recordEvent("screener", "info", "Screening pass complete", {
      runId: run.id,
      candidates: scored.length,
      selected: eligible[0]?.sym ?? null,
      bestConfidence: winner?.finalConfidence ?? null,
    });

    if (eligible.length === 0) {
      return { runId: run.id, candidates: scored.length };
    }

    for (const s of eligible) this.candidates.delete(s.sym);

    return {
      runId: run.id,
      candidates: scored.length,
      selected: {
        signal: eligible[0]!.candidate.signal,
        confluence: eligible[0]!.confluence,
        finalConfidence: eligible[0]!.finalConfidence,
      },
      selectedMany: eligible.map((s) => ({
        signal: s.candidate.signal,
        confluence: s.confluence,
        finalConfidence: s.finalConfidence,
      })),
    };
    } finally {
      this.screeningPassInFlight = false;
    }
  }
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }

function thresholdFor(signal: TradeSignal, fallback: number): { threshold: number; reason: string } {
  if (!env.DYNAMIC_CONFIDENCE_ENABLED) return { threshold: fallback, reason: "fixed" };
  const isTrendPullback = signal.kind.startsWith("TREND_PULLBACK_");
  const isFibSetup = signal.kind.includes("_FIB");

  if (!isTrendPullback && isFibSetup) {
    return { threshold: env.FIB_SETUP_MIN_CONFIDENCE, reason: "fib_setup" };
  }

  const adx = signal.context.trendPullback?.adx;
  if (!isTrendPullback) return { threshold: fallback, reason: "default_setup" };
  if (adx === undefined || !Number.isFinite(adx)) {
    return { threshold: env.TREND_PULLBACK_MIN_CONFIDENCE, reason: "trend_pullback_no_adx" };
  }
  if (adx > env.STRONG_TREND_ADX) {
    return { threshold: env.STRONG_TREND_MIN_CONFIDENCE, reason: `trend_pullback_adx>${env.STRONG_TREND_ADX}` };
  }
  if (adx < env.RANGING_ADX) {
    return { threshold: env.RANGING_MIN_CONFIDENCE, reason: `trend_pullback_adx<${env.RANGING_ADX}` };
  }
  return { threshold: env.TREND_PULLBACK_MIN_CONFIDENCE, reason: "trend_pullback_normal" };
}
