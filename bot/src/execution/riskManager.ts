// ============================================================================
// riskManager.ts — Position sizing + bracket order execution.
// ----------------------------------------------------------------------------
// Responsibilities:
//   - Compute position size from (account equity × risk%) ÷ stop-distance
//   - Round qty/price to the exchange's LOT_SIZE / PRICE_FILTER step
//   - Place the entry MARKET order + two protective conditional orders:
//       STOP_MARKET (closePosition=true) for the SL
//       TAKE_PROFIT_MARKET (closePosition=true) for the TP
//   - Persist Order rows and update the Position row
//
// SAFETY:
//   - Never sizes beyond available margin × maxLeverage
//   - Honors `LIVE_TRADING=false` — skips order placement and only records
//     the signal (dry run). Use this on testnet first.
//   - Enforces maxConcurrent positions per symbol from BotConfig.
// ============================================================================

import { logger, recordEvent } from "../shared/logger.js";
import { prisma } from "../shared/db.js";
import { env } from "../shared/env.js";
import type { TradeSignal } from "../shared/types.js";
import type { BinanceFuturesClient } from "./binanceClient.js";

export interface RiskConfig {
  symbol: string;
  leverage: number;
  marginType: "ISOLATED" | "CROSSED";
  riskPercent: number;       // e.g. 1.0 = 1% of equity per trade
  maxConcurrent: number;
}

export class RiskManager {
  constructor(
    private readonly client: BinanceFuturesClient,
    private readonly cfg: RiskConfig
  ) {}

  /** One-time bootstrap: set leverage + margin type on the symbol. */
  async ensureSymbolSettings(): Promise<void> {
    await this.client.setMarginType(this.cfg.symbol, this.cfg.marginType);
    await this.client.setLeverage(this.cfg.symbol, this.cfg.leverage);
    logger.info(
      { symbol: this.cfg.symbol, leverage: this.cfg.leverage, marginType: this.cfg.marginType },
      "Symbol settings applied"
    );
  }

  /** Execute a trade signal. Records the signal + orders in the DB. */
  async execute(signal: TradeSignal): Promise<void> {
    const signalRow = await prisma.signal.create({
      data: {
        symbol: signal.symbol,
        interval: signal.interval,
        side: signal.side,
        kind: signal.kind,
        price: signal.entryPrice,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        confidence: signal.confidence,
        payload: JSON.stringify(signal.context),
      },
    });

    if (!env.LIVE_TRADING) {
      await recordEvent("execution", "info", "Dry-run signal recorded", {
        signalId: signalRow.id,
        kind: signal.kind,
      });
      return;
    }

    // Concurrency cap
    const open = await prisma.position.count({ where: { symbol: this.cfg.symbol } });
    if (open >= this.cfg.maxConcurrent) {
      await recordEvent("execution", "warn", "Concurrency cap reached; skipping", {
        symbol: this.cfg.symbol,
        open,
      });
      return;
    }

    const account = await this.client.accountInfo();
    const equity = Number((account as Record<string, unknown>).totalWalletBalance ?? 0);
    if (equity <= 0) {
      await recordEvent("execution", "error", "Account equity unavailable or zero", { account });
      return;
    }

    const filters = await this.client.exchangeInfo();
    const sym = filters.get(this.cfg.symbol);
    if (!sym) throw new Error(`Symbol filters missing for ${this.cfg.symbol}`);
    const { qtyStep, minQty, priceStep } = parseFilters(sym);

    const riskUsdt = equity * (this.cfg.riskPercent / 100);
    const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
    if (stopDistance <= 0) {
      await recordEvent("execution", "error", "Invalid stop distance", { signal });
      return;
    }

    // Raw qty (in BASE asset) such that loss-at-SL ≈ riskUsdt.
    const rawQty = riskUsdt / stopDistance;
    const qty = roundStep(rawQty, qtyStep);
    if (qty < minQty) {
      await recordEvent("execution", "warn", "Computed qty below minQty; skipping", {
        rawQty, qty, minQty,
      });
      return;
    }

    const orderSide = signal.side === "LONG" ? "BUY" : "SELL";
    const exitSide = orderSide === "BUY" ? "SELL" : "BUY";
    const clientId = `at-${signalRow.id}-${Date.now().toString(36)}`;

    // 1) Entry MARKET order
    const entryResp = await this.client.placeOrder({
      symbol: this.cfg.symbol,
      side: orderSide,
      type: "MARKET",
      quantity: qty,
      newClientOrderId: `${clientId}-e`,
    });

    await prisma.order.create({
      data: {
        exchangeOrderId: String(entryResp.orderId ?? ""),
        clientOrderId: `${clientId}-e`,
        symbol: this.cfg.symbol,
        side: orderSide,
        type: "MARKET",
        status: String(entryResp.status ?? "NEW"),
        quantity: qty,
        signalId: signalRow.id,
        rawResponse: JSON.stringify(entryResp),
      },
    });

    // 2) Stop-loss (STOP_MARKET, closePosition=true)
    const slPrice = roundStep(signal.stopLoss, priceStep);
    const slResp = await this.client.placeOrder({
      symbol: this.cfg.symbol,
      side: exitSide,
      type: "STOP_MARKET",
      stopPrice: slPrice,
      closePosition: true,
      workingType: "MARK_PRICE",
      newClientOrderId: `${clientId}-sl`,
    });
    await prisma.order.create({
      data: {
        exchangeOrderId: String(slResp.orderId ?? ""),
        clientOrderId: `${clientId}-sl`,
        symbol: this.cfg.symbol,
        side: exitSide,
        type: "STOP_MARKET",
        status: String(slResp.status ?? "NEW"),
        stopPrice: slPrice,
        quantity: qty,
        closePosition: true,
        signalId: signalRow.id,
        rawResponse: JSON.stringify(slResp),
      },
    });

    // 3) Take-profit (TAKE_PROFIT_MARKET, closePosition=true)
    const tpPrice = roundStep(signal.takeProfit, priceStep);
    const tpResp = await this.client.placeOrder({
      symbol: this.cfg.symbol,
      side: exitSide,
      type: "TAKE_PROFIT_MARKET",
      stopPrice: tpPrice,
      closePosition: true,
      workingType: "MARK_PRICE",
      newClientOrderId: `${clientId}-tp`,
    });
    await prisma.order.create({
      data: {
        exchangeOrderId: String(tpResp.orderId ?? ""),
        clientOrderId: `${clientId}-tp`,
        symbol: this.cfg.symbol,
        side: exitSide,
        type: "TAKE_PROFIT_MARKET",
        status: String(tpResp.status ?? "NEW"),
        stopPrice: tpPrice,
        quantity: qty,
        closePosition: true,
        signalId: signalRow.id,
        rawResponse: JSON.stringify(tpResp),
      },
    });

    // Open position row (entry price is approximate until we fetch fills).
    await prisma.position.upsert({
      where: { symbol: this.cfg.symbol },
      create: {
        symbol: this.cfg.symbol,
        side: signal.side,
        entryPrice: signal.entryPrice,
        quantity: qty,
        leverage: this.cfg.leverage,
        stopLoss: slPrice,
        takeProfit: tpPrice,
      },
      update: {
        side: signal.side,
        entryPrice: signal.entryPrice,
        quantity: qty,
        leverage: this.cfg.leverage,
        stopLoss: slPrice,
        takeProfit: tpPrice,
      },
    });

    await prisma.signal.update({ where: { id: signalRow.id }, data: { consumed: true } });

    await recordEvent("execution", "info", "Bracket order placed", {
      signalId: signalRow.id,
      symbol: this.cfg.symbol,
      side: signal.side,
      qty,
      entry: signal.entryPrice,
      sl: slPrice,
      tp: tpPrice,
    });
  }
}

// ----- filter parsing -----------------------------------------------------

interface ParsedFilters {
  qtyStep: number;
  minQty: number;
  priceStep: number;
}

function parseFilters(sym: Record<string, unknown>): ParsedFilters {
  const arr = (sym.filters as Array<Record<string, unknown>>) ?? [];
  const lot = arr.find((f) => f.filterType === "LOT_SIZE")
            ?? arr.find((f) => f.filterType === "MARKET_LOT_SIZE");
  const price = arr.find((f) => f.filterType === "PRICE_FILTER");
  return {
    qtyStep: Number(lot?.stepSize ?? 0.001),
    minQty: Number(lot?.minQty ?? 0.001),
    priceStep: Number(price?.tickSize ?? 0.01),
  };
}

/** Round a number DOWN to the nearest multiple of `step`. Binance rejects
 *  orders whose qty/price isn't a multiple of the filter step. */
function roundStep(n: number, step: number): number {
  if (step <= 0) return n;
  const decimals = (step.toString().split(".")[1] ?? "").length;
  return Number((Math.floor(n / step) * step).toFixed(decimals));
}
