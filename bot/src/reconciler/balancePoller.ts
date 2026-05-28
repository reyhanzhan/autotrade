// ============================================================================
// balancePoller.ts — Periodic account-equity snapshot.
// ----------------------------------------------------------------------------
// Every BALANCE_POLLER_INTERVAL_MS (default 60s) we capture totalWalletBalance,
// availableBalance, marginBalance and unrealizedProfit into BalanceSnapshot.
// The dashboard balance card reads the latest row; the equity chart reads
// the time series.
//
// We skip rows whose totalWalletBalance equals the most recent one AND has
// zero unrealizedProfit movement — so the table doesn't bloat on idle days.
// ============================================================================

import { prisma } from "../shared/db.js";
import { env } from "../shared/env.js";
import { recordEvent } from "../shared/logger.js";
import type { BinanceFuturesClient } from "../execution/binanceClient.js";

const POLL_INTERVAL_MS = 60_000;
/** Minimum delta vs. previous snapshot to bother writing a new row. */
const DEDUPE_EPSILON = 0.0001;

export class BalancePoller {
  private timer?: NodeJS.Timeout;
  private inFlight = false;

  constructor(private readonly client: BinanceFuturesClient) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.snapshot();
    } catch (e) {
      await recordEvent("balance", "warn", "Balance snapshot failed", { err: (e as Error).message });
    } finally {
      this.inFlight = false;
    }
  }

  private async snapshot(): Promise<void> {
    const info = await this.client.accountInfo() as Record<string, unknown>;
    const totalWalletBalance = Number(info.totalWalletBalance ?? 0);
    const availableBalance = Number(info.availableBalance ?? 0);
    const marginBalance = Number(info.totalMarginBalance ?? info.marginBalance ?? totalWalletBalance);
    const unrealizedProfit = Number(info.totalUnrealizedProfit ?? info.unrealizedProfit ?? 0);

    if (!Number.isFinite(totalWalletBalance)) return;

    const last = await prisma.balanceSnapshot.findFirst({ orderBy: { capturedAt: "desc" } });
    if (
      last &&
      Math.abs(last.totalWalletBalance - totalWalletBalance) < DEDUPE_EPSILON &&
      Math.abs(last.unrealizedProfit - unrealizedProfit) < DEDUPE_EPSILON
    ) {
      // No meaningful change — skip to keep table small.
      return;
    }

    await prisma.balanceSnapshot.create({
      data: {
        totalWalletBalance,
        availableBalance,
        marginBalance,
        unrealizedProfit,
        testnet: env.TESTNET,
      },
    });
  }
}
