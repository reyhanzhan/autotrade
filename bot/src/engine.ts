// ============================================================================
// engine.ts — Top-level orchestrator. Wires together:
//   WebSocket (multi-symbol candles) → Screener (SMC + Coinglass) → RiskManager
//   PositionReconciler (background poll → PnL booking in Trade table)
// ----------------------------------------------------------------------------
// Lifecycle:
//   1. Load BotConfig from DB (decrypts API creds in memory only)
//   2. Resolve the watchlist (DB > env)
//   3. Build BinanceFuturesClient, RiskManager, CoinglassClient, Screener
//   4. Apply leverage/marginType per-symbol lazily on first execution
//   5. Start multi-stream WS; on each closed candle hand it to the screener
//   6. Screener picks best symbol across the watchlist and emits a winning
//      signal (or none); winners are executed by the risk manager
//   7. PositionReconciler ticks every RECONCILER_INTERVAL_MS to detect
//      closes and book Trade rows
// ============================================================================

import { prisma } from "./shared/db.js";
import { env } from "./shared/env.js";
import { logger, recordEvent } from "./shared/logger.js";
import { decryptSecret } from "./shared/crypto.js";
import { BinanceStream } from "./websocket/binanceStream.js";
import { BinanceFuturesClient } from "./execution/binanceClient.js";
import { RiskManager } from "./execution/riskManager.js";
import { Screener } from "./screener/screener.js";
import { resolveExchangeUniverse, resolveWatchlist } from "./screener/symbols.js";
import { CoinglassClient } from "./external/coinglass.js";
import { PositionReconciler } from "./reconciler/positionReconciler.js";
import { BalancePoller } from "./reconciler/balancePoller.js";
import type { Candle, Side, StructureState, TradeSignal } from "./shared/types.js";
import { analyzeStructure, DEFAULT_STRUCTURE_OPTS } from "./strategy/structure.js";

export class TradingEngine {
  private stream?: BinanceStream;
  private screener?: Screener;
  private risk?: RiskManager;
  private client?: BinanceFuturesClient;
  private reconciler?: PositionReconciler;
  private balancePoller?: BalancePoller;
  private lastEvaluatedAt = new Map<string, number>(); // symbol → last candle openTime
  private executionCooldownUntil = new Map<string, number>();
  private globalExecutionCooldownUntil = 0;
  private executionInFlight = false;

  async start(): Promise<void> {
    const cfg = await prisma.botConfig.findFirst({ where: { enabled: true } });
    if (!cfg) {
      logger.warn("No enabled BotConfig row found. POST /api/config and set enabled:true.");
      return;
    }

    // Decrypt credentials in memory only — never logged.
    const apiKey = decryptSecret({ cipher: cfg.apiKeyCipher, iv: cfg.apiKeyIv, tag: cfg.apiKeyTag });
    const apiSecret = decryptSecret({ cipher: cfg.apiSecretCipher, iv: cfg.apiSecretIv, tag: cfg.apiSecretTag });

    const client = new BinanceFuturesClient({ apiKey, apiSecret }, { testnet: cfg.testnet });
    this.client = client;

    // Clock-skew sanity.
    try {
      const offset = await client.syncTime();
      const skew = Math.abs(offset);
      if (skew > 1000) {
        await recordEvent("execution", "warn", "Clock skew >1s vs Binance server; using synced timestamp offset", {
          skewMs: skew,
        });
      }
    } catch (err) {
      await recordEvent("execution", "error", "serverTime() failed - check Binance network access", {
        err: (err as Error).message,
      });
      return;
    }

    const watchlist = env.AUTO_DISCOVER_SYMBOLS
      ? resolveExchangeUniverse(await client.exchangeInfo())
      : resolveWatchlist(cfg);
    if (watchlist.length === 0) {
      await recordEvent("engine", "error", "No symbols resolved for screener", {
        autoDiscover: env.AUTO_DISCOVER_SYMBOLS,
      });
      return;
    }
    const interval = cfg.interval;
    const minConfidence = cfg.minConfidence ?? env.MIN_CONFIDENCE;

    this.risk = new RiskManager(client, {
      leverage: cfg.leverage,
      marginType: cfg.marginType as "ISOLATED" | "CROSSED",
      riskPercent: cfg.riskPercent,
      maxConcurrent: cfg.maxConcurrent,
    });

    const coinglass = new CoinglassClient();
    this.screener = new Screener({ interval, symbols: watchlist, minConfidence }, coinglass);

    if (env.ENABLE_RECONCILER) {
      this.reconciler = new PositionReconciler(client);
      this.reconciler.start();
    } else {
      await recordEvent("reconciler", "warn", "Position reconciler disabled by env");
    }

    if (env.ENABLE_BALANCE_POLLER) {
      this.balancePoller = new BalancePoller(client, cfg.testnet);
      this.balancePoller.start();
    } else {
      await recordEvent("balance", "warn", "Balance poller disabled by env");
    }

    this.stream = new BinanceStream({
      subscriptions: watchlist.map((s) => ({ symbol: s, interval })),
      bufferSize: env.CANDLE_HISTORY,
      testnet: cfg.testnet,
    });

    await this.warmupStreamBuffers(client, watchlist, interval);

    this.stream.on("candle", (symbol: string, closed: Candle, all: Candle[]) => {
      this.onClosedCandle(symbol, closed, all).catch(async (err) => {
        await recordEvent("strategy", "error", "onClosedCandle failed", {
          symbol, err: err.message,
        });
      });
    });
    this.stream.on("error", async (err) => {
      await recordEvent("websocket", "error", "Stream error", { err: err.message });
    });

    this.stream.connect();
    await recordEvent("engine", "info", "Engine started", {
      symbols: watchlist, interval, live: env.LIVE_TRADING, testnet: cfg.testnet,
      coinglass: env.hasCoinglass, minConfidence,
    });
  }

  private async onClosedCandle(symbol: string, closed: Candle, all: Candle[]): Promise<void> {
    // De-dupe: WS can re-emit a closed candle.
    if ((this.lastEvaluatedAt.get(symbol) ?? 0) >= closed.openTime) return;
    this.lastEvaluatedAt.set(symbol, closed.openTime);

    if (!this.screener || !this.risk) return;
    if (Date.now() < this.globalExecutionCooldownUntil || this.executionInFlight) return;

    const result = await this.screener.onClosedCandle(symbol, all, this.cooldownSymbols());
    if (!result?.selected) return;

    const { signal, confluence, finalConfidence } = result.selected;
    logger.info(
      {
        symbol: signal.symbol, kind: signal.kind, side: signal.side,
        entry: signal.entryPrice, sl: signal.stopLoss, tp: signal.takeProfit,
        baseConf: signal.confidence, conf: finalConfidence,
        coinglass: confluence.multiplier,
      },
      "Winning signal — executing"
    );

    // Find the just-persisted Signal row to link orders/trades to it.
    const sigRow = await prisma.signal.findFirst({
      where: {
        symbol: signal.symbol,
        screeningRunId: result.runId,
      },
      orderBy: { id: "desc" },
    });

    this.executionInFlight = true;
    try {
      const mtf = await this.confirmMultiTimeframe(signal);
      if (!mtf.accepted) {
        await this.attachMtfToSignal(sigRow?.id, mtf.confirmations);
        await recordEvent("strategy", "warn", "MTF confirmation rejected signal", {
          signalId: sigRow?.id,
          symbol: signal.symbol,
          side: signal.side,
          requiredTrend: mtf.requiredTrend,
          confirmations: mtf.confirmations,
          reason: mtf.reason,
        });
        this.setExecutionCooldown(
          signal.symbol,
          env.FAILED_TRADE_COOLDOWN_MS,
          "Skipped execution cooldown started",
          { reason: mtf.reason }
        );
        return;
      }
      await this.attachMtfToSignal(sigRow?.id, mtf.confirmations);

      const placed = await this.risk.execute(
        {
          ...signal,
          confidence: finalConfidence,
          context: {
            ...signal.context,
            multiTimeframe: mtf.confirmations,
          },
        },
        sigRow?.id
      );
      this.setExecutionCooldown(
        signal.symbol,
        placed ? env.TRADE_SYMBOL_COOLDOWN_MS : env.FAILED_TRADE_COOLDOWN_MS,
        placed ? "Trade execution cooldown started" : "Skipped execution cooldown started"
      );
    } catch (err) {
      const cooldownMs = cooldownMsForError(err, env.FAILED_TRADE_COOLDOWN_MS);
      const globalUntil = globalCooldownUntilForError(err);
      if (globalUntil) {
        this.globalExecutionCooldownUntil = globalUntil;
        void recordEvent("execution", "warn", "Global execution backoff started", {
          cooldownUntil: new Date(globalUntil).toISOString(),
          err: (err as Error).message,
        });
      }
      this.setExecutionCooldown(signal.symbol, cooldownMs, "Failed execution cooldown started", {
        err: (err as Error).message,
      });
      throw err;
    } finally {
      this.executionInFlight = false;
    }
  }

  private async attachMtfToSignal(
    signalId: number | undefined,
    confirmations: Array<{ interval: string; trend: StructureState["trend"]; requiredTrend: StructureState["trend"] }>
  ): Promise<void> {
    if (!signalId) return;
    const row = await prisma.signal.findUnique({ where: { id: signalId }, select: { payload: true } });
    if (!row) return;
    let payload: Record<string, unknown> = {};
    try {
      payload = row.payload ? JSON.parse(row.payload) as Record<string, unknown> : {};
    } catch {
      payload = {};
    }
    await prisma.signal.update({
      where: { id: signalId },
      data: { payload: JSON.stringify({ ...payload, multiTimeframe: confirmations }) },
    });
  }

  private async confirmMultiTimeframe(signal: TradeSignal): Promise<{
    accepted: boolean;
    requiredTrend: StructureState["trend"];
    confirmations: Array<{ interval: string; trend: StructureState["trend"]; requiredTrend: StructureState["trend"] }>;
    reason?: string;
  }> {
    const intervals = env.ENABLE_MTF_CONFIRMATION ? env.mtfConfirmationIntervals : [];
    const requiredTrend = trendForSide(signal.side);
    if (intervals.length === 0) {
      return { accepted: true, requiredTrend, confirmations: [] };
    }

    if (!this.client) {
      return {
        accepted: false,
        requiredTrend,
        confirmations: [],
        reason: "Binance client unavailable for MTF confirmation",
      };
    }

    const confirmations: Array<{ interval: string; trend: StructureState["trend"]; requiredTrend: StructureState["trend"] }> = [];
    for (const interval of intervals) {
      const candles = await this.client.klines(signal.symbol, interval, Math.min(env.WARMUP_CANDLES, env.CANDLE_HISTORY));
      const structure = analyzeStructure(candles, DEFAULT_STRUCTURE_OPTS);
      confirmations.push({ interval, trend: structure.trend, requiredTrend });
      if (structure.trend !== requiredTrend) {
        return {
          accepted: false,
          requiredTrend,
          confirmations,
          reason: `${interval} trend ${structure.trend} does not confirm ${signal.side}`,
        };
      }
    }

    await recordEvent("strategy", "info", "MTF confirmation accepted signal", {
      symbol: signal.symbol,
      side: signal.side,
      confirmations,
    });
    return { accepted: true, requiredTrend, confirmations };
  }

  async stop(): Promise<void> {
    this.balancePoller?.stop();
    this.reconciler?.stop();
    this.stream?.close();
    await prisma.$disconnect();
  }

  private async warmupStreamBuffers(
    client: BinanceFuturesClient,
    symbols: string[],
    interval: string
  ): Promise<void> {
    if (!this.stream || env.WARMUP_CANDLES === 0) return;

    const limit = Math.min(env.WARMUP_CANDLES, env.CANDLE_HISTORY);
    let loaded = 0;
    let failed = 0;

    for (const symbol of symbols) {
      try {
        const candles = await client.klines(symbol, interval, limit);
        this.stream.seedCandles(symbol, candles);
        loaded++;
      } catch (err) {
        failed++;
        const message = (err as Error).message;
        logger.warn({ symbol, err: message }, "Historical candle warmup failed");
        if (/status=418|code=-1003|rate-limited/i.test(message)) break;
      }
    }

    await recordEvent(failed ? "engine" : "websocket", failed ? "warn" : "info", "Historical candle warmup complete", {
      loaded,
      failed,
      symbols: symbols.length,
      interval,
      limit,
    });
  }

  private cooldownSymbols(): Set<string> {
    const now = Date.now();
    const symbols = new Set<string>();
    for (const [symbol, until] of this.executionCooldownUntil) {
      if (until > now) symbols.add(symbol);
      else this.executionCooldownUntil.delete(symbol);
    }
    return symbols;
  }

  private setExecutionCooldown(
    symbol: string,
    ms: number,
    message: string,
    meta: Record<string, unknown> = {}
  ): void {
    const until = Date.now() + ms;
    this.executionCooldownUntil.set(symbol, until);
    void recordEvent("execution", "info", message, {
      symbol,
      cooldownUntil: new Date(until).toISOString(),
      ...meta,
    });
  }
}

function cooldownMsForError(err: unknown, fallbackMs: number): number {
  const message = err instanceof Error ? err.message : String(err);
  const banUntil = message.match(/banned until (\d{13})/i)?.[1];
  if (banUntil) {
    const ts = Number(banUntil);
    if (Number.isFinite(ts) && ts > Date.now()) {
      return Math.min(ts + 30_000 - Date.now(), 86_400_000);
    }
  }
  const isoUntil = message.match(/until (\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/i)?.[1];
  if (isoUntil) {
    const ts = Date.parse(isoUntil);
    if (Number.isFinite(ts) && ts > Date.now()) {
      return Math.min(ts + 30_000 - Date.now(), 86_400_000);
    }
  }
  return fallbackMs;
}

function globalCooldownUntilForError(err: unknown): number | undefined {
  const ms = cooldownMsForError(err, 0);
  return ms > 0 ? Date.now() + ms : undefined;
}

function trendForSide(side: Side): StructureState["trend"] {
  return side === "LONG" ? "BULLISH" : "BEARISH";
}
