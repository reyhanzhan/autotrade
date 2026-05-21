// GET /api/screening?limit=50&offset=0 — paginated screening runs with the
// signals each run produced and their Coinglass-derived confluence.
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

  const [runs, total] = await Promise.all([
    prisma.screeningRun.findMany({
      orderBy: { runAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        signals: {
          orderBy: { confidence: "desc" },
          select: {
            id: true, symbol: true, side: true, kind: true,
            baseConfidence: true, coinglassScore: true, confidence: true,
            consumed: true,
          },
        },
      },
    }),
    prisma.screeningRun.count(),
  ]);

  return NextResponse.json({
    items: runs.map((r) => ({
      id: r.id,
      runAt: r.runAt,
      interval: r.interval,
      symbolsScanned: safeJson<string[]>(r.symbolsScanned, []),
      candidateCount: r.candidateCount,
      selectedSymbol: r.selectedSymbol,
      selectedSide: r.selectedSide,
      bestConfidence: r.bestConfidence,
      reason: r.reason,
      signals: r.signals,
    })),
    total,
  });
}

function safeJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}
