// ============================================================================
// GET /api/pnl-calendar?year=2026&month=5
// ----------------------------------------------------------------------------
// Returns daily PnL aggregates for the given month, suitable for rendering
// a calendar heatmap. Days with no trades are included with pnl=0.
// ----------------------------------------------------------------------------
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const now = new Date();
  const year = Number(url.searchParams.get("year") ?? now.getUTCFullYear());
  const month = Number(url.searchParams.get("month") ?? now.getUTCMonth() + 1); // 1-12

  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: "Invalid year/month" }, { status: 400 });
  }

  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));

  const trades = await prisma.trade.findMany({
    where: { closedAt: { gte: start, lt: end } },
    select: { closedAt: true, pnl: true, symbol: true, side: true, pnlPercent: true },
  });

  // Bucket by UTC date string YYYY-MM-DD.
  const map = new Map<string, { pnl: number; trades: number; wins: number; losses: number; symbols: Set<string>; }>();
  for (const t of trades) {
    if (!t.closedAt) continue;
    const key = t.closedAt.toISOString().slice(0, 10);
    const row = map.get(key) ?? { pnl: 0, trades: 0, wins: 0, losses: 0, symbols: new Set<string>() };
    row.pnl += t.pnl ?? 0;
    row.trades += 1;
    if ((t.pnl ?? 0) > 0) row.wins += 1;
    if ((t.pnl ?? 0) < 0) row.losses += 1;
    row.symbols.add(t.symbol);
    map.set(key, row);
  }

  // Build a full month grid (every day, even zero-trade days).
  const days: Array<{ date: string; pnl: number; trades: number; wins: number; losses: number; symbols: string[]; }> = [];
  for (let d = 1; d <= daysInMonth(year, month); d++) {
    const date = new Date(Date.UTC(year, month - 1, d)).toISOString().slice(0, 10);
    const row = map.get(date);
    days.push({
      date,
      pnl: row?.pnl ?? 0,
      trades: row?.trades ?? 0,
      wins: row?.wins ?? 0,
      losses: row?.losses ?? 0,
      symbols: row ? Array.from(row.symbols) : [],
    });
  }

  const total = days.reduce((s, d) => s + d.pnl, 0);
  const tradesTotal = days.reduce((s, d) => s + d.trades, 0);
  const wins = days.reduce((s, d) => s + d.wins, 0);
  const losses = days.reduce((s, d) => s + d.losses, 0);
  const positiveDays = days.filter((d) => d.pnl > 0).length;
  const negativeDays = days.filter((d) => d.pnl < 0).length;

  return NextResponse.json({
    year, month, days,
    summary: {
      totalPnl: total,
      trades: tradesTotal,
      wins, losses,
      winRate: tradesTotal ? wins / tradesTotal : 0,
      positiveDays, negativeDays,
    },
  });
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
