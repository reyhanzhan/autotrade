// GET /api/positions — current open positions.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;

  const positions = await prisma.position.findMany({ orderBy: { openedAt: "desc" } });
  return NextResponse.json({ positions });
}
