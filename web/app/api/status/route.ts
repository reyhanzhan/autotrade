// GET /api/status — bot health snapshot (multi-symbol aware).
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;

  const [cfg, lastEvent, openPositions, recentSignal, lastScreeningRun] = await Promise.all([
    prisma.botConfig.findFirst({ where: { enabled: true } }),
    prisma.eventLog.findFirst({ orderBy: { createdAt: "desc" } }),
    prisma.position.count(),
    prisma.signal.findFirst({ orderBy: { createdAt: "desc" } }),
    prisma.screeningRun.findFirst({ orderBy: { runAt: "desc" } }),
  ]);

  let watchlist: string[] = [];
  try { if (cfg?.watchlist) watchlist = JSON.parse(cfg.watchlist); } catch { /* noop */ }

  return NextResponse.json({
    enabled: !!cfg?.enabled,
    testnet: cfg?.testnet ?? null,
    watchlist,
    symbol: cfg?.symbol ?? null,
    interval: cfg?.interval ?? null,
    leverage: cfg?.leverage ?? null,
    minConfidence: cfg?.minConfidence ?? null,
    openPositions,
    lastEvent: lastEvent
      ? { level: lastEvent.level, source: lastEvent.source, message: lastEvent.message, at: lastEvent.createdAt }
      : null,
    lastSignal: recentSignal
      ? {
          symbol: recentSignal.symbol, side: recentSignal.side, kind: recentSignal.kind,
          price: recentSignal.price, baseConfidence: recentSignal.baseConfidence,
          coinglassScore: recentSignal.coinglassScore, confidence: recentSignal.confidence,
          at: recentSignal.createdAt,
        }
      : null,
    lastScreening: lastScreeningRun
      ? {
          at: lastScreeningRun.runAt, candidates: lastScreeningRun.candidateCount,
          selected: lastScreeningRun.selectedSymbol, side: lastScreeningRun.selectedSide,
          bestConfidence: lastScreeningRun.bestConfidence,
        }
      : null,
    serverTime: new Date().toISOString(),
  });
}
