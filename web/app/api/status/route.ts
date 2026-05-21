// GET /api/status — bot health snapshot.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;

  const [cfg, lastEvent, openPositions, recentSignal] = await Promise.all([
    prisma.botConfig.findFirst({ where: { enabled: true } }),
    prisma.eventLog.findFirst({ orderBy: { createdAt: "desc" } }),
    prisma.position.count(),
    prisma.signal.findFirst({ orderBy: { createdAt: "desc" } }),
  ]);

  return NextResponse.json({
    enabled: !!cfg?.enabled,
    testnet: cfg?.testnet ?? null,
    symbol: cfg?.symbol ?? null,
    interval: cfg?.interval ?? null,
    leverage: cfg?.leverage ?? null,
    openPositions,
    lastEvent: lastEvent
      ? { level: lastEvent.level, source: lastEvent.source, message: lastEvent.message, at: lastEvent.createdAt }
      : null,
    lastSignal: recentSignal
      ? { side: recentSignal.side, kind: recentSignal.kind, price: recentSignal.price, at: recentSignal.createdAt }
      : null,
    serverTime: new Date().toISOString(),
  });
}
