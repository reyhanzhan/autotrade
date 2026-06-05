// ============================================================================
// riskManager.ts — Position sizing + bracket order execution (multi-symbol).
// ----------------------------------------------------------------------------
// Responsibilities:
//   - For each symbol on first contact: apply marginType + leverage (idempotent)
//   - Compute position size from (account equity × risk%) ÷ stop-distance
//   - Round qty/price to the exchange's LOT_SIZE / PRICE_FILTER step
//   - Place the entry MARKET order + STOP_MARKET (SL) + TAKE_PROFIT_MARKET (TP)
//   - Persist Order rows + open the Position row
//
// The signal carries the symbol — RiskManager is symbol-agnostic at the
// instance level. The concurrency cap is GLOBAL (across all symbols).
//
// SAFETY:
//   - Refuses orders below the symbol's minQty filter.
//   - Honors LIVE_TRADING=false (dry run; Signal row only).
//   - Global maxConcurrent across all open positions.
// ============================================================================

import { logger, recordEvent } from "../shared/logger.js";
import { prisma } from "../shared/db.js";
import { env } from "../shared/env.js";
import type { TradeSignal } from "../shared/types.js";
import type { BinanceFuturesClient } from "./binanceClient.js";

const MAX_MARGIN_USAGE = 0.8;

export interface RiskConfig {
  leverage: number;
  marginType: "ISOLATED" | "CROSSED";
  riskPercent: number;          // 1.0 = 1% of equity per trade
  maxConcurrent: number;        // global cap across all symbols
}

export class RiskManager {
  /** Symbols that already had setMarginType + setLeverage applied. */
  private readonly prepared = new Set<string>();

  constructor(
    private readonly client: BinanceFuturesClient,
    private readonly cfg: RiskConfig
  ) {}

  /** Idempotent: applies leverage + margin type to a symbol the first time it
   *  is touched. Subsequent calls are no-ops. */
  async ensureSettingsFor(symbol: string): Promise<boolean> {
    if (this.prepared.has(symbol)) return true;
    try {
      await this.client.setMarginType(symbol, this.cfg.marginType);
      await this.client.setLeverage(symbol, this.cfg.leverage);
      this.prepared.add(symbol);
      logger.info({ symbol, leverage: this.cfg.leverage, marginType: this.cfg.marginType }, "Symbol prepared");
      return true;
    } catch (e) {
      await recordEvent("execution", "warn", "Failed to prepare symbol — skipping", {
        symbol, err: (e as Error).message,
      });
      return false;
    }
  }

  /** Execute a signal. The signal carries everything we need. */
  async execute(signal: TradeSignal, signalRowId?: number): Promise<void> {
    const symbol = signal.symbol;

    if (!env.LIVE_TRADING) {
      await recordEvent("execution", "info", "Dry-run signal (LIVE_TRADING=false)", {
        signalRowId, kind: signal.kind, symbol,
      });
      return;
    }

    // GLOBAL concurrency cap. maxConcurrent <= 0 means unlimited internally;
    // Binance margin and the sizing guard still cap what can actually open.
    const open = await prisma.position.count();
    if (this.cfg.maxConcurrent > 0 && open >= this.cfg.maxConcurrent) {
      await recordEvent("execution", "warn", "Global concurrency cap reached; skipping", { open });
      return;
    }

    const existing = await prisma.position.findUnique({ where: { symbol } });
    if (existing) {
      await recordEvent("execution", "warn", "Position already open for symbol; skipping", { symbol });
      return;
    }

    if (!(await this.ensureSettingsFor(symbol))) return;

    const account = await this.client.accountInfo() as Record<string, unknown>;
    const equity = Number(account.totalWalletBalance ?? 0);
    const availableBalance = Number(account.availableBalance ?? equity);
    if (equity <= 0) {
      await recordEvent("execution", "error", "Account equity unavailable or zero", { account });
      return;
    }
    if (availableBalance <= 0) {
      await recordEvent("execution", "error", "Available margin unavailable or zero", { availableBalance, equity });
      return;
    }

    const filters = await this.client.exchangeInfo();
    const sym = filters.get(symbol);
    if (!sym) throw new Error(`Symbol filters missing for ${symbol}`);
    const { qtyStep, minQty, priceStep } = parseFilters(sym);

    const riskUsdt = equity * (this.cfg.riskPercent / 100);
    const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
    if (stopDistance <= 0) {
      await recordEvent("execution", "error", "Invalid stop distance", { signal });
      return;
    }

    const riskQty = riskUsdt / stopDistance;
    const maxNotional = availableBalance * this.cfg.leverage * MAX_MARGIN_USAGE;
    const marginQty = maxNotional / signal.entryPrice;
    const rawQty = Math.min(riskQty, marginQty);
    const qty = roundStep(rawQty, qtyStep);
    if (qty < minQty) {
      await recordEvent("execution", "warn", "Computed qty below minQty; skipping", {
        riskQty, marginQty, qty, minQty, symbol,
      });
      return;
    }
    if (rawQty < riskQty) {
      await recordEvent("execution", "warn", "Position size capped by available margin", {
        symbol,
        riskQty,
        marginQty,
        qty,
        availableBalance,
        leverage: this.cfg.leverage,
        maxMarginUsage: MAX_MARGIN_USAGE,
      });
    }

    const orderSide = signal.side === "LONG" ? "BUY" : "SELL";
    const exitSide = orderSide === "BUY" ? "SELL" : "BUY";
    const clientPrefix = `at-${signalRowId ?? "sig"}-${Date.now().toString(36)}`;

    // 1) Entry MARKET
    const entryResp = await this.client.placeOrder({
      symbol, side: orderSide, type: "MARKET", quantity: qty,
      newClientOrderId: `${clientPrefix}-e`,
    });
    await prisma.order.create({
      data: {
        exchangeOrderId: String(entryResp.orderId ?? ""),
        clientOrderId: `${clientPrefix}-e`,
        symbol, side: orderSide, type: "MARKET",
        status: String(entryResp.status ?? "NEW"),
        quantity: qty, signalId: signalRowId ?? null,
        rawResponse: JSON.stringify(entryResp),
      },
    });

    // 2) Stop-loss (STOP_MARKET, closePosition)
    const slPrice = roundStep(signal.stopLoss, priceStep);
    const slResp = await this.client.placeOrder({
      symbol, side: exitSide, type: "STOP_MARKET",
      stopPrice: slPrice, closePosition: true, workingType: "MARK_PRICE",
      newClientOrderId: `${clientPrefix}-sl`,
    });
    await prisma.order.create({
      data: {
        exchangeOrderId: String(slResp.orderId ?? ""),
        clientOrderId: `${clientPrefix}-sl`,
        symbol, side: exitSide, type: "STOP_MARKET",
        status: String(slResp.status ?? "NEW"),
        stopPrice: slPrice, quantity: qty, closePosition: true,
        signalId: signalRowId ?? null,
        rawResponse: JSON.stringify(slResp),
      },
    });

    // 3) Take-profit (TAKE_PROFIT_MARKET, closePosition)
    const tpPrice = roundStep(signal.takeProfit, priceStep);
    const tpResp = await this.client.placeOrder({
      symbol, side: exitSide, type: "TAKE_PROFIT_MARKET",
      stopPrice: tpPrice, closePosition: true, workingType: "MARK_PRICE",
      newClientOrderId: `${clientPrefix}-tp`,
    });
    await prisma.order.create({
      data: {
        exchangeOrderId: String(tpResp.orderId ?? ""),
        clientOrderId: `${clientPrefix}-tp`,
        symbol, side: exitSide, type: "TAKE_PROFIT_MARKET",
        status: String(tpResp.status ?? "NEW"),
        stopPrice: tpPrice, quantity: qty, closePosition: true,
        signalId: signalRowId ?? null,
        rawResponse: JSON.stringify(tpResp),
      },
    });

    await prisma.position.upsert({
      where: { symbol },
      create: {
        symbol, side: signal.side, entryPrice: signal.entryPrice, quantity: qty,
        leverage: this.cfg.leverage, stopLoss: slPrice, takeProfit: tpPrice,
        signalId: signalRowId ?? null,
      },
      update: {
        side: signal.side, entryPrice: signal.entryPrice, quantity: qty,
        leverage: this.cfg.leverage, stopLoss: slPrice, takeProfit: tpPrice,
        signalId: signalRowId ?? null,
      },
    });

    if (signalRowId) {
      await prisma.signal.update({ where: { id: signalRowId }, data: { consumed: true } });
    }

    await recordEvent("execution", "info", "Bracket order placed", {
      signalId: signalRowId, symbol, side: signal.side, qty,
      entry: signal.entryPrice, sl: slPrice, tp: tpPrice,
    });
  }
}

// ----- filter parsing -----------------------------------------------------

interface ParsedFilters { qtyStep: number; minQty: number; priceStep: number; }

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

function roundStep(n: number, step: number): number {
  if (step <= 0) return n;
  const decimals = (step.toString().split(".")[1] ?? "").length;
  return Number((Math.floor(n / step) * step).toFixed(decimals));
}
