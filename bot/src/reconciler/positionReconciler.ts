// ============================================================================
// positionReconciler.ts — Periodic Binance ⇄ DB position sync + PnL booking.
// ----------------------------------------------------------------------------
// Every RECONCILER_INTERVAL_MS we:
//
//   1. Fetch live positions from Binance (/fapi/v2/positionRisk)
//   2. For each `Position` row in our DB:
//        - If still open on Binance → update unrealizedPnl + price refs
//        - If no longer open on Binance → it just closed. We:
//            a) pull recent user trades for that symbol
//            b) compute realized PnL (sum of trade-level realizedPnl)
//            c) infer the exit reason (TP / SL / MANUAL) by which protective
//               order is now FILLED while the other is CANCELED
//            d) create a Trade row, delete the Position row
//
// This is intentionally lightweight (REST polling) rather than the User Data
// Stream (which needs listenKey management + keepalive). For 15m/1h trading
// the 30s polling latency is irrelevant.
// ============================================================================

import { prisma } from "../shared/db.js";
import { recordEvent } from "../shared/logger.js";
import { env } from "../shared/env.js";
import type { BinanceFuturesClient } from "../execution/binanceClient.js";

export class PositionReconciler {
  private timer?: NodeJS.Timeout;
  private inFlight = false;

  constructor(private readonly client: BinanceFuturesClient) {}

  start(): void {
    if (this.timer) return;
    // Run once immediately, then on interval.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), env.RECONCILER_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;       // skip overlap if previous tick is slow
    this.inFlight = true;
    try {
      await this.reconcile();
    } catch (e) {
      await recordEvent("reconciler", "error", "Reconciliation tick failed", {
        err: (e as Error).message,
      });
    } finally {
      this.inFlight = false;
    }
  }

  private async reconcile(): Promise<void> {
    const ourPositions = await prisma.position.findMany();
    if (ourPositions.length === 0) return;

    const live = await this.client.positionRisk();
    const liveBySym = new Map<string, Record<string, unknown>>();
    for (const p of live) liveBySym.set(String(p.symbol), p);

    for (const ours of ourPositions) {
      const lp = liveBySym.get(ours.symbol);
      const liveQty = lp ? Number((lp as Record<string, unknown>).positionAmt ?? 0) : 0;
      const liveAbs = Math.abs(liveQty);

      if (liveAbs > 0) {
        // Still open — refresh unrealized PnL and SL/TP-relevant numbers.
        const unrealized = Number((lp as Record<string, unknown>).unRealizedProfit ?? 0);
        const markPrice = Number((lp as Record<string, unknown>).markPrice ?? 0);
        await prisma.position.update({
          where: { id: ours.id },
          data: {
            unrealizedPnl: unrealized,
            quantity: liveAbs,
            ...(markPrice > 0 ? { entryPrice: Number((lp as Record<string, unknown>).entryPrice ?? ours.entryPrice) } : {}),
          },
        });
        continue;
      }

      // Position closed on exchange — book it as a Trade.
      await this.closeAndBookTrade(ours);
    }
  }

  private async closeAndBookTrade(pos: { id: number; symbol: string; side: string; entryPrice: number; quantity: number; leverage: number; signalId: number | null; openedAt: Date; stopLoss: number | null; takeProfit: number | null; }): Promise<void> {
    // Pull user trades since the position opened to get realized PnL + exit fill.
    const trades = await this.client.userTrades(pos.symbol, pos.openedAt.getTime());
    const exitTrades = trades.filter((t) => Math.abs(Number(t.qty ?? 0)) > 0 && Number(t.realizedPnl ?? 0) !== 0);

    const pnl = exitTrades.reduce((sum, t) => sum + Number(t.realizedPnl ?? 0), 0);
    const lastFill = exitTrades.at(-1);
    const exitPrice = lastFill ? Number(lastFill.price) : null;

    // Margin-based PnL%: PnL ÷ (entry × qty ÷ leverage) × 100
    const notional = pos.entryPrice * pos.quantity;
    const margin = notional / pos.leverage;
    const pnlPercent = margin > 0 ? (pnl / margin) * 100 : null;

    // Infer the exit reason from which protective order filled.
    const reason = await this.inferExitReason(pos.symbol, pos.signalId);

    await prisma.trade.create({
      data: {
        symbol: pos.symbol,
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice,
        quantity: pos.quantity,
        leverage: pos.leverage,
        pnl,
        pnlPercent,
        reason,
        openedAt: pos.openedAt,
        closedAt: new Date(),
        signalId: pos.signalId,
      },
    });

    // Cancel any leftover protective orders (the unfilled one of SL/TP).
    try { await this.client.cancelAllOpenOrders(pos.symbol); } catch { /* tolerate */ }
    try { await this.client.cancelAllOpenAlgoOrders(pos.symbol); } catch { /* tolerate */ }

    await prisma.position.delete({ where: { id: pos.id } });

    await recordEvent("reconciler", "info", "Position closed — trade booked", {
      symbol: pos.symbol, side: pos.side, pnl, pnlPercent, reason, exitPrice,
    });
  }

  private async inferExitReason(symbol: string, signalId: number | null): Promise<string> {
    if (!signalId) return "MANUAL";
    // Look up the SL / TP order rows for this signal — whichever is FILLED won.
    const orders = await prisma.order.findMany({
      where: { signalId, symbol, OR: [{ type: "STOP_MARKET" }, { type: "TAKE_PROFIT_MARKET" }] },
    });
    // Refresh statuses against Binance (we only have stale `NEW` from creation).
    for (const o of orders) {
      if (!o.exchangeOrderId) continue;
      try {
        const live = await this.client.queryAlgoOrder(Number(o.exchangeOrderId));
        await prisma.order.update({
          where: { id: o.id },
          data: { status: String(live.status ?? o.status), rawResponse: JSON.stringify(live) },
        });
        if (String(live.status) === "FILLED") {
          if (o.type === "STOP_MARKET") return "SL";
          if (o.type === "TAKE_PROFIT_MARKET") return "TP";
        }
      } catch { /* tolerate */ }
    }
    return "MANUAL";
  }
}
