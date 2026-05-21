// ============================================================================
// GET /api/reports — aggregated performance report.
// ----------------------------------------------------------------------------
// Returns:
//   - Overall stats: total trades, win rate, total PnL, avg PnL%
//   - Per-symbol breakdown: trades, wins, losses, net PnL
//   - Per-signal-kind breakdown: which patterns (OB_TAP_LONG etc.) work best
//   - Per-day equity curve
//   - Coinglass attribution: average confluence multiplier by outcome (TP vs SL)
// ============================================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since");
  const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Pull all closed trades since `since`. For a small VPS DB this is fine
  // up to thousands of rows; if you grow beyond that, paginate this endpoint.
  const trades = await prisma.trade.findMany({
    where: { closedAt: { gte: since } },
    orderBy: { closedAt: "asc" },
    include: { signal: { select: { kind: true, coinglassScore: true, confidence: true } } },
  });

  // ----- Overall stats ---------------------------------------------------
  const closed = trades.filter((t) => typeof t.pnl === "number");
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0);
  const losses = closed.filter((t) => (t.pnl ?? 0) < 0);
  const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const avgPnl = closed.length ? totalPnl / closed.length : 0;
  const winRate = closed.length ? wins.length / closed.length : 0;
  const grossProfit = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

  // ----- Per-symbol -------------------------------------------------------
  const bySymbolMap = new Map<string, { trades: number; wins: number; losses: number; pnl: number; }>();
  for (const t of closed) {
    const row = bySymbolMap.get(t.symbol) ?? { trades: 0, wins: 0, losses: 0, pnl: 0 };
    row.trades += 1;
    if ((t.pnl ?? 0) > 0) row.wins += 1;
    if ((t.pnl ?? 0) < 0) row.losses += 1;
    row.pnl += t.pnl ?? 0;
    bySymbolMap.set(t.symbol, row);
  }
  const bySymbol = Array.from(bySymbolMap.entries())
    .map(([symbol, v]) => ({
      symbol, ...v,
      winRate: v.trades ? v.wins / v.trades : 0,
    }))
    .sort((a, b) => b.pnl - a.pnl);

  // ----- Per-signal-kind --------------------------------------------------
  const byKindMap = new Map<string, { trades: number; wins: number; pnl: number; }>();
  for (const t of closed) {
    const kind = t.signal?.kind ?? "UNKNOWN";
    const row = byKindMap.get(kind) ?? { trades: 0, wins: 0, pnl: 0 };
    row.trades += 1;
    if ((t.pnl ?? 0) > 0) row.wins += 1;
    row.pnl += t.pnl ?? 0;
    byKindMap.set(kind, row);
  }
  const byKind = Array.from(byKindMap.entries())
    .map(([kind, v]) => ({ kind, ...v, winRate: v.trades ? v.wins / v.trades : 0 }))
    .sort((a, b) => b.pnl - a.pnl);

  // ----- Coinglass attribution -------------------------------------------
  // Compare average confluence multiplier between winning and losing trades.
  // If wins consistently had higher multipliers, Coinglass is adding value.
  const cgWins = wins.map((t) => t.signal?.coinglassScore).filter((v): v is number => typeof v === "number");
  const cgLosses = losses.map((t) => t.signal?.coinglassScore).filter((v): v is number => typeof v === "number");
  const avg = (xs: number[]) => xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
  const coinglassAttribution = {
    avgMultiplierOnWins: avg(cgWins),
    avgMultiplierOnLosses: avg(cgLosses),
    sampleSize: { wins: cgWins.length, losses: cgLosses.length },
  };

  // ----- Equity curve -----------------------------------------------------
  let running = 0;
  const equityCurve = closed.map((t) => {
    running += t.pnl ?? 0;
    return { at: t.closedAt, pnl: t.pnl ?? 0, equity: Number(running.toFixed(4)) };
  });

  // ----- Per-day breakdown -----------------------------------------------
  const byDayMap = new Map<string, { trades: number; pnl: number; }>();
  for (const t of closed) {
    const day = (t.closedAt ?? t.openedAt).toISOString().slice(0, 10);
    const row = byDayMap.get(day) ?? { trades: 0, pnl: 0 };
    row.trades += 1;
    row.pnl += t.pnl ?? 0;
    byDayMap.set(day, row);
  }
  const byDay = Array.from(byDayMap.entries())
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => a.day.localeCompare(b.day));

  return NextResponse.json({
    since,
    overall: {
      tradeCount: closed.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRate,
      totalPnl,
      avgPnl,
      profitFactor,
      grossProfit,
      grossLoss,
    },
    bySymbol,
    byKind,
    byDay,
    coinglassAttribution,
    equityCurve,
  });
}
