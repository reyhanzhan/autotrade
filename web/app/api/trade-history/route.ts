// GET /api/trade-history?limit=50&offset=0 — paginated closed trades.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  const [items, total] = await Promise.all([
    prisma.trade.findMany({
      orderBy: { openedAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.trade.count(),
  ]);

  const stats = await prisma.trade.aggregate({
    _sum: { pnl: true },
    _avg: { pnlPercent: true },
    _count: { _all: true },
  });

  return NextResponse.json({
    items,
    total,
    summary: {
      totalPnl: stats._sum.pnl ?? 0,
      avgPnlPercent: stats._avg.pnlPercent ?? 0,
      tradeCount: stats._count._all,
    },
  });
}
