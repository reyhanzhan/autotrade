// ============================================================================
// engine.ts — Top-level orchestrator. Glues:
//   WebSocket (live candles)  →  SMCEngine (signal)  →  RiskManager (order)
// ----------------------------------------------------------------------------
// Lifecycle:
//   1. Load BotConfig from DB (decrypts API creds in memory only)
//   2. Build BinanceFuturesClient + RiskManager
//   3. Apply leverage/marginType to the symbol
//   4. Start WS, evaluate on every CLOSED candle, execute high-confidence signals
//
// Failure handling: any exception is logged + persisted to EventLog. The
// stream auto-reconnects; the engine itself keeps running.
// ============================================================================

import { prisma } from "./shared/db.js";
import { env } from "./shared/env.js";
import { logger, recordEvent } from "./shared/logger.js";
import { decryptSecret } from "./shared/crypto.js";
import { BinanceStream } from "./websocket/binanceStream.js";
import { BinanceFuturesClient } from "./execution/binanceClient.js";
import { RiskManager } from "./execution/riskManager.js";
import { SMCEngine, DEFAULT_SMC_CONFIG } from "./strategy/smc.js";
import type { Candle } from "./shared/types.js";

export class TradingEngine {
  private stream?: BinanceStream;
  private smc?: SMCEngine;
  private risk?: RiskManager;
  private lastEvaluatedCandleTime = 0;

  async start(): Promise<void> {
    const cfg = await prisma.botConfig.findFirst({ where: { enabled: true } });
    if (!cfg) {
      logger.warn("No enabled BotConfig row found. Create one via the dashboard, then restart.");
      return;
    }

    // Decrypt credentials in memory only. Never log them.
    const apiKey = decryptSecret({
      cipher: cfg.apiKeyCipher, iv: cfg.apiKeyIv, tag: cfg.apiKeyTag,
    });
    const apiSecret = decryptSecret({
      cipher: cfg.apiSecretCipher, iv: cfg.apiSecretIv, tag: cfg.apiSecretTag,
    });

    const client = new BinanceFuturesClient({ apiKey, apiSecret });

    // Clock-skew sanity (warn if local clock is off by >1s).
    try {
      const serverTime = await client.serverTime();
      const skew = Math.abs(serverTime - Date.now());
      if (skew > 1000) {
        await recordEvent("execution", "warn", "Clock skew >1s vs Binance server", { skewMs: skew });
      }
    } catch (err) {
      await recordEvent("execution", "error", "serverTime() failed — check API keys / network", {
        err: (err as Error).message,
      });
      return;
    }

    this.risk = new RiskManager(client, {
      symbol: cfg.symbol,
      leverage: cfg.leverage,
      marginType: cfg.marginType as "ISOLATED" | "CROSSED",
      riskPercent: cfg.riskPercent,
      maxConcurrent: cfg.maxConcurrent,
    });
    await this.risk.ensureSymbolSettings();

    this.smc = new SMCEngine({
      ...DEFAULT_SMC_CONFIG,
      symbol: cfg.symbol,
      interval: cfg.interval,
    });

    this.stream = new BinanceStream({
      symbol: cfg.symbol,
      interval: cfg.interval,
      bufferSize: env.CANDLE_HISTORY,
    });

    this.stream.on("candle", (closed: Candle, all: Candle[]) => {
      this.onClosedCandle(closed, all).catch(async (err) => {
        await recordEvent("strategy", "error", "onClosedCandle failed", { err: err.message });
      });
    });
    this.stream.on("error", async (err) => {
      await recordEvent("websocket", "error", "Stream error", { err: err.message });
    });

    this.stream.connect();
    await recordEvent("engine", "info", "Engine started", {
      symbol: cfg.symbol, interval: cfg.interval, live: env.LIVE_TRADING, testnet: env.TESTNET,
    });
  }

  private async onClosedCandle(closed: Candle, all: Candle[]): Promise<void> {
    // De-dupe: WS can occasionally re-emit a closed candle.
    if (closed.openTime <= this.lastEvaluatedCandleTime) return;
    this.lastEvaluatedCandleTime = closed.openTime;

    if (!this.smc || !this.risk) return;

    const signal = this.smc.evaluate(all);
    if (!signal) return;

    logger.info(
      { kind: signal.kind, side: signal.side, entry: signal.entryPrice, sl: signal.stopLoss, tp: signal.takeProfit, conf: signal.confidence },
      "Signal produced"
    );
    await this.risk.execute(signal);
  }

  async stop(): Promise<void> {
    this.stream?.close();
    await prisma.$disconnect();
  }
}
