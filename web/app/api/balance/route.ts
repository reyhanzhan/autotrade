// GET /api/balance — current balance + last N snapshots (default 200).
// Powers the balance card on the dashboard and the equity-curve chart.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);

  const [current, history] = await Promise.all([
    prisma.balanceSnapshot.findFirst({ orderBy: { capturedAt: "desc" } }),
    prisma.balanceSnapshot.findMany({
      orderBy: { capturedAt: "desc" },
      take: limit,
    }),
  ]);

  // Previous snapshot from ~24h ago (for "today's change" pill).
  const dayAgo = await prisma.balanceSnapshot.findFirst({
    where: { capturedAt: { lte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    orderBy: { capturedAt: "desc" },
  });

  const change24h = current && dayAgo
    ? {
        delta: current.totalWalletBalance - dayAgo.totalWalletBalance,
        deltaPct: dayAgo.totalWalletBalance > 0
          ? ((current.totalWalletBalance - dayAgo.totalWalletBalance) / dayAgo.totalWalletBalance) * 100
          : 0,
      }
    : null;

  return NextResponse.json({
    current,
    change24h,
    history: history.reverse(), // oldest → newest for charting
  });
}
